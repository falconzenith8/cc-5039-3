// Runs the in-browser E2E suite (/test.html) against the real headless Chromium.
// Uses the arm64 headless shell plus the locally extracted shared libs.
import { chromium } from '../../vendor/node_modules/playwright-core/index.mjs';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.DEMO_BASE || 'http://127.0.0.1:8080';
const shellCandidates = [
  process.env.HEADLESS_SHELL,
  `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell`,
].filter(Boolean);
const executablePath = shellCandidates.find((p) => p && existsSync(p));
if (!executablePath) {
  console.error('headless_shell not found; set HEADLESS_SHELL or run playwright install');
  process.exit(2);
}
const libRoot = new URL('../../vendor/chromelibs/root/', import.meta.url).pathname;
const ldPaths = [
  `${libRoot}usr/lib/aarch64-linux-gnu`,
  `${libRoot}lib/aarch64-linux-gnu`,
].join(':');

const timeoutMs = Number(process.env.E2E_TIMEOUT_MS || 180000);

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ],
  env: { ...process.env, LD_LIBRARY_PATH: `${ldPaths}:${process.env.LD_LIBRARY_PATH || ''}` },
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

async function resetKnobs() {
  await page.request.post(`${BASE}/api/knobs`, {
    data: { latencyBaseMs: 0, latencyJitterMs: 0, failRate: 0, truncateRate: 0 },
  });
}

let exitCode = 0;
try {
  await resetKnobs();
  await page.goto(`${BASE}/test.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__testReady === true, { timeout: 10000 });
  await page.click('#run');

  await page.waitForFunction(
    () => window.__testResult && window.__testResult.done === true,
    { timeout: timeoutMs },
  );
  const result = await page.evaluate(() => window.__testResult);
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('.case')].map((el) => ({
      name: el.querySelector('h3').textContent,
      status: el.querySelector('.status').textContent,
      detail: el.querySelector('.detail').textContent,
    })),
  );
  console.log('\n=== MSE 内核端到端测试结果 ===');
  for (const c of cards) {
    console.log(`${c.status === 'PASS' ? 'PASS' : 'FAIL'}  ${c.name}`);
    if (c.status !== 'PASS') {
      console.log(`      ${c.detail.split('\n').slice(0, 4).join('\n      ')}`);
      exitCode = 1;
    }
  }
  console.log(`\n汇总: ${result.passed}/${result.total} 通过`);

  // Deterministic QuotaExceededError recovery via injectable SourceBuffers.
  await page.goto(`${BASE}/quota-test.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__quotaResult && window.__quotaResult.done === true, { timeout: 20000 });
  const quota = await page.evaluate(() => window.__quotaResult);
  console.log('\n=== 配额回收专项测试 ===');
  for (const [status, name] of quota.results) {
    console.log(`${status === 'PASS' ? 'PASS' : 'FAIL'}  ${name}`);
    if (status !== 'PASS') exitCode = 1;
  }
  console.log(`配额汇总: ${quota.passed}/${quota.total} 通过`);
  if (quota.passed !== quota.total) exitCode = 1;

  // Also smoke the graphical player page and capture a real buffer snapshot.
  await resetKnobs();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const el = document.getElementById('stats-view');
      return el && el.textContent.includes('"appends"');
    },
    { timeout: 15000 },
  );
  await page.waitForTimeout(3500);
  const snapshot = await page.evaluate(() => ({
    stateGrid: document.getElementById('state-grid').innerText,
    queue: document.getElementById('queue-view').textContent,
    stats: document.getElementById('stats-view').textContent,
    log: [...document.querySelectorAll('#event-log li')].slice(0, 8).map((li) => li.textContent),
  }));
  console.log('\n=== 图形播放器冒烟（真实浏览器缓冲快照）===');
  console.log(snapshot.stateGrid);
  console.log('\n最近事件:');
  for (const line of snapshot.log) console.log('  ' + line);
  const fatalVisible = await page.evaluate(() => !document.getElementById('fatal-box').classList.contains('hidden'));
  if (fatalVisible) {
    console.error('\n图形播放器进入 ERROR 状态');
    exitCode = 1;
  }
} catch (err) {
  console.error('E2E 运行器异常:', err.message);
  exitCode = 1;
} finally {
  if (consoleErrors.length) {
    console.log('\n浏览器 console 错误（去重前 %d 条）:', consoleErrors.length);
    for (const e of [...new Set(consoleErrors)].slice(0, 10)) console.log('  - ' + e);
  }
  await page.screenshot({ path: new URL('../screenshot-player.png', import.meta.url).pathname, fullPage: true }).catch(() => {});
  await browser.close();
}
process.exit(exitCode);
