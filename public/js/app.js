// UI controller: the MSE kernel drives every control; failures are rendered
// back from the kernel's ERROR state rather than papered over in the UI.
import { MsePlayer, PlayerState } from './kernel/mse-player.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const player = new MsePlayer(video, {
  aheadLimitSec: 12,
  retentionSec: 6,
  highWatermarkSec: 25,
});

const oneShot = { fail: false, truncate: false };
// Wrap fetch so a one-shot injection only affects the next media segment.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('.webm') && (oneShot.fail || oneShot.truncate)) {
    const params = new URL(url, location.href);
    if (oneShot.fail) {
      params.searchParams.set('fail', '1');
      oneShot.fail = false;
      log('one-shot fail 注入 → ' + params.pathname, 'warn');
    } else if (oneShot.truncate) {
      params.searchParams.set('truncate', '1');
      oneShot.truncate = false;
      log('one-shot truncate 注入 → ' + params.pathname, 'warn');
    }
    return nativeFetch(params.toString(), init);
  }
  return nativeFetch(input, init);
};

// --------------------------------------------------------------- logging
const MAX_LOG = 250;
function log(msg, cls = '') {
  const ol = $('event-log');
  const li = document.createElement('li');
  if (cls) li.className = `ev-${cls}`;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false }) +
    '.' + String(new Date().getMilliseconds()).padStart(3, '0');
  li.innerHTML = `<span class="t">${t}</span>${msg}`;
  ol.prepend(li);
  while (ol.children.length > MAX_LOG) ol.lastChild.remove();
}

// --------------------------------------------------------------- timeline
const canvas = $('timeline');
function drawTimeline(state) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 800;
  canvas.width = cssW * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = cssW, H = 110, pad = 10;
  ctx.clearRect(0, 0, W, H);
  const duration = state.duration || 60;
  const x = (t) => pad + (t / duration) * (W - pad * 2);
  const lanes = [
    { ranges: state.ranges.video, color: getCss('--video'), y: 18, label: 'V' },
    { ranges: state.ranges.audio, color: getCss('--audio'), y: 44, label: 'A' },
    { ranges: state.ranges.intersection, color: getCss('--inter'), y: 70, label: '∩' },
  ];
  ctx.font = '11px monospace';
  for (const lane of lanes) {
    ctx.fillStyle = '#93a1bd';
    ctx.fillText(lane.label, 2, lane.y + 11);
    ctx.strokeStyle = '#2a3856';
    ctx.beginPath();
    ctx.moveTo(x(0), lane.y + 8);
    ctx.lineTo(x(duration), lane.y + 8);
    ctx.stroke();
    ctx.fillStyle = lane.color;
    for (const r of lane.ranges) {
      ctx.fillRect(x(r.start), lane.y, Math.max(2, x(r.end) - x(r.start)), 16);
    }
  }
  // playhead
  const px = x(state.currentTime);
  ctx.strokeStyle = getCss('--head');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px, 12);
  ctx.lineTo(px, 96);
  ctx.stroke();
  ctx.lineWidth = 1;
  // second ticks
  ctx.fillStyle = '#44536f';
  for (let s = 0; s <= duration; s += 5) ctx.fillText(String(s), x(s) - 6, 108);
}
function getCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// --------------------------------------------------------------- panels
function render(state) {
  drawTimeline(state);
  $('seek-label').textContent = `${state.currentTime.toFixed(1)} / ${state.duration.toFixed(1)} s`;
  if (!seeking) $('seek').value = state.currentTime;

  const stateClass = state.state === PlayerState.ERROR ? 'err'
    : state.state === PlayerState.PLAYING ? 'ok'
    : state.state === PlayerState.BUFFERING || state.state === PlayerState.SEEKING ? 'warn' : '';
  const grid = [
    ['状态机', state.state, stateClass],
    ['播放头', state.currentTime.toFixed(2) + ' s'],
    ['readyState', state.readyState],
    ['卡顿次数', state.stallCount],
    ['视频缓冲', state.ranges.bufferedSeconds.video.toFixed(1) + ' s'],
    ['音频缓冲', state.ranges.bufferedSeconds.audio.toFixed(1) + ' s'],
    ['交集可播(前向)', state.ranges.playableAhead.toFixed(2) + ' s'],
    ['视频范围', fmtRanges(state.ranges.video)],
    ['音频范围', fmtRanges(state.ranges.audio)],
  ];
  $('state-grid').innerHTML = grid.map(([k, v, cls]) =>
    `<div class="stat"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div></div>`).join('');

  $('queue-view').textContent = JSON.stringify(state.queue, null, 2);
  $('stats-view').textContent = JSON.stringify(state.stats, null, 2);

  const fatalBox = $('fatal-box');
  if (state.fatal) {
    fatalBox.classList.remove('hidden');
    $('fatal-msg').textContent = `${state.fatal.message}（${state.fatal.cause || 'n/a'} @ ${state.fatal.at}）`;
  } else {
    fatalBox.classList.add('hidden');
  }
}
function fmtRanges(ranges) {
  if (!ranges.length) return '∅';
  return ranges.map((r) => `${r.start.toFixed(1)}–${r.end.toFixed(1)}`).join('  ');
}

// --------------------------------------------------------------- controls
let seeking = false;
$('btn-play').addEventListener('click', () => player.play().catch((e) => log('play() 拒绝: ' + e.message, 'error')));
$('btn-pause').addEventListener('click', () => player.pause());
$('btn-seek0').addEventListener('click', () => player.seekTo(0));
$('btn-resume').addEventListener('click', () => {
  log('手动 resume()：清除 ERROR 并重新调度', 'ok');
  player.resume();
});
$('seek').addEventListener('pointerdown', () => { seeking = true; });
$('seek').addEventListener('input', (e) => {
  $('seek-label').textContent = `${Number(e.target.value).toFixed(1)} / ${player.getState().duration.toFixed(1)} s`;
});
$('seek').addEventListener('change', (e) => {
  const t = Number(e.target.value);
  seeking = false;
  log(`UI seek → ${t.toFixed(1)}s（内核中止窗口外下载，保留重叠缓冲）`);
  player.seekTo(t);
});
$('btn-clear-log').addEventListener('click', () => { $('event-log').innerHTML = ''; });

async function postKnobs(payload) {
  const res = await fetch('/api/knobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  log('服务器 knobs 更新: ' + JSON.stringify(body.changed), 'ok');
}
$('btn-apply-knobs').addEventListener('click', () => postKnobs({
  latencyBaseMs: Number($('latency-base').value) || 0,
  latencyJitterMs: Number($('latency-jitter').value) || 0,
  failRate: Number($('fail-rate').value) || 0,
  truncateRate: Number($('truncate-rate').value) || 0,
}));
$('btn-reset-knobs').addEventListener('click', () => {
  for (const id of ['latency-base', 'latency-jitter', 'fail-rate', 'truncate-rate']) $(id).value = 0;
  postKnobs({ latencyBaseMs: 0, latencyJitterMs: 0, failRate: 0, truncateRate: 0 });
});
$('btn-one-fail').addEventListener('click', () => { oneShot.fail = true; log('已装填：下一分片请求 fail=1', 'warn'); });
$('btn-one-truncate').addEventListener('click', () => { oneShot.truncate = true; log('已装填：下一分片请求 truncate=1', 'warn'); });

// --------------------------------------------------------------- kernel events
player.on('statechange', ({ from, to }) => log(`状态 ${from} → ${to}`, to === 'ERROR' ? 'error' : ''));
player.on('taskretry', (p) => log(`下载重试 ${p.key} 第${p.attempt}次 (${p.delay}ms): ${p.error}`, 'warn'));
player.on('taskerror', (p) => log(`下载终态失败 ${p.key}: ${p.error}`, 'error'));
player.on('eviction', (p) => log(`缓冲回收 reason=${p.reason}（保留窗口之外的前缀，两轨同步）`, 'warn'));
player.on('stall', (p) => log(`播放卡顿 @${p.currentTime.toFixed(2)}s，第 ${p.stalls} 次`, 'warn'));
player.on('endofstream', () => log('全部分片入列并 endOfStream()', 'ok'));
player.on('fatal', (f) => log(`FATAL: ${f.message}`, 'fatal'));
player.on('disposed', () => log('资源已释放（objectURL revoke + buffer 关闭）', 'ok'));
player.on('tick', render);

// --------------------------------------------------------------- boot
async function boot() {
  try {
    log('加载 manifest 并创建 MediaSource…');
    await player.load('/media/manifest.json');
    log('双 SourceBuffer 就绪，init 分片已追加，调度泵启动', 'ok');
    await player.play();
  } catch (err) {
    log('启动失败: ' + err.message, 'fatal');
  }
}
boot();

window.addEventListener('beforeunload', () => player.dispose());
