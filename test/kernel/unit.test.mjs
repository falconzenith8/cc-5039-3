// Node unit tests for kernel pieces that need no browser.
// Run: node test/kernel/unit.test.mjs
import assert from 'node:assert/strict';
import {
  continuousFrom,
  intersectRanges,
  evictablePrefix,
  totalBuffered,
  mergeRanges,
  containsTime,
} from '../../public/js/kernel/buffered-ranges.js';
import { SourceBufferQueue } from '../../public/js/kernel/source-buffer-queue.js';
import { DownloadManager } from '../../public/js/kernel/download-manager.js';
import { MsePlayer, PlayerState } from '../../public/js/kernel/mse-player.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};
const atest = (name, fn) => asyncTests.push(
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok - ${name}`);
    })
    .catch((err) => {
      console.error(`  FAIL - ${name}: ${err.message}`);
      process.exitCode = 1;
    }),
);
const asyncTests = [];

// --------------------------------------------------------- buffered-ranges
test('continuousFrom follows adjacent ranges and stops at gaps', () => {
  const ranges = [
    { start: 0, end: 2 },
    { start: 2, end: 4.5 },
    { start: 6, end: 8 }, // 1.5s gap
  ];
  assert.equal(continuousFrom(ranges, 0), 4.5);
  assert.equal(continuousFrom(ranges, 1), 3.5);
  assert.equal(continuousFrom(ranges, 6.5), 1.5);
  assert.equal(continuousFrom(ranges, 9), 0);
});

test('intersectRanges computes only jointly covered time', () => {
  const v = [{ start: 0, end: 5 }, { start: 6, end: 10 }];
  const a = [{ start: 2, end: 7 }];
  const got = intersectRanges(v, a);
  assert.deepEqual(got, [
    { start: 2, end: 5 },
    { start: 6, end: 7 },
  ]);
});

test('evictablePrefix cuts at the guard line without crossing it', () => {
  const ranges = [{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 9, end: 12 }];
  // keepFrom=7.5: first range fully old, [4,8] straddles -> cut exactly at 7.5
  assert.equal(evictablePrefix(ranges, 7.5), 7.5);
  // keepFrom=3: [0,4] straddles -> cut at 3
  assert.equal(evictablePrefix(ranges, 3), 3);
  // keepFrom=8.5: first two ranges fully old; next range starts at 9
  assert.equal(evictablePrefix(ranges, 8.5), 9);
  assert.equal(evictablePrefix(ranges, 12), 12);
  // A single continuous range straddling the line is cut at the line
  assert.equal(evictablePrefix([{ start: 0, end: 18 }], 3.88), 3.88);
});

test('totalBuffered / mergeRanges / containsTime', () => {
  assert.equal(totalBuffered([{ start: 0, end: 3 }, { start: 4, end: 6 }]), 5);
  assert.deepEqual(mergeRanges([{ start: 0, end: 2 }, { start: 2.02, end: 4 }]), [
    { start: 0, end: 4 },
  ]);
  assert.equal(containsTime([{ start: 1, end: 3 }], 2), true);
  assert.equal(containsTime([{ start: 1, end: 3 }], 4), false);
});

// --------------------------------------------------------- SourceBufferQueue
// Minimal fake SourceBuffer implementing the updating flag + events.
class FakeSB {
  constructor() {
    this.updating = false;
    this.listeners = new Map();
    this.ops = [];
    this.failNext = false;
  }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) {
    this.listeners.get(t)?.delete(fn);
  }
  emit(t) {
    for (const fn of this.listeners.get(t) ?? []) fn({ type: t });
  }
  appendBuffer(data) {
    if (this.updating) throw new Error('busy');
    this.updating = true;
    this.ops.push(['append', data]);
    queueMicrotask(() => {
      this.updating = false;
      if (this.failNext) {
        this.failNext = false;
        this.emit('error');
      }
      this.emit('updateend');
    });
  }
  remove(s, e) {
    if (this.updating) throw new Error('busy');
    this.updating = true;
    this.ops.push(['remove', s, e]);
    queueMicrotask(() => {
      this.updating = false;
      this.emit('updateend');
    });
  }
  abort() {
    this.updating = false;
    this.ops.push(['abort']);
  }
}

test('SourceBufferQueue serializes appends (no concurrent updating)', async () => {
  const sb = new FakeSB();
  const q = new SourceBufferQueue(sb, 'test');
  let sawConcurrent = false;
  const results = await Promise.all(
    [1, 2, 3].map(async (n) => {
      if (sb.updating) sawConcurrent = true;
      await q.appendBuffer(new Uint8Array([n]));
      if (sb.updating) sawConcurrent = true;
      return n;
    }),
  );
  assert.deepEqual(results, [1, 2, 3]);
  assert.equal(sawConcurrent, false);
  assert.deepEqual(sb.ops.map((o) => o[0]), ['append', 'append', 'append']);
  assert.equal(q.pendingCount, 0);
});

test('SourceBufferQueue survives a failed append and keeps processing', async () => {
  const sb = new FakeSB();
  const q = new SourceBufferQueue(sb, 'test');
  sb.failNext = true;
  await assert.rejects(q.appendBuffer(new Uint8Array([1])), /appendBuffer failed/);
  // queue must remain usable; next append succeeds
  await q.appendBuffer(new Uint8Array([2]));
  assert.equal(sb.ops.length, 2);
  assert.equal(q.pendingCount, 0);
});

test('SourceBufferQueue refuses races when externally busy', async () => {
  const sb = new FakeSB();
  const q = new SourceBufferQueue(sb, 'test');
  sb.updating = true; // simulate external mutation
  await assert.rejects(q.appendBuffer(new Uint8Array([9])), /externally busy/);
  sb.updating = false;
});

// --------------------------------------------------------- DownloadManager
test('DownloadManager retries with backoff then fails terminally', async () => {
  let calls = 0;
  const dm = new DownloadManager({
    maxRetries: 2,
    baseBackoffMs: 5,
    fetchImpl: async () => {
      calls++;
      throw new Error('boom');
    },
  });
  await assert.rejects(dm.fetch('v:1', 'http://x/1'), /failed after 3 attempt/);
  assert.equal(calls, 3);
  assert.equal(dm.stats.retried, 2);
  assert.equal(dm.stats.failed, 1);
});

test('DownloadManager succeeds after a transient failure', async () => {
  let calls = 0;
  const dm = new DownloadManager({
    maxRetries: 2,
    baseBackoffMs: 5,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    },
  });
  const buf = await dm.fetch('a:2', 'http://x/2');
  assert.equal(buf.byteLength, 3);
  assert.equal(dm.stats.succeeded, 1);
  assert.equal(dm.stats.retried, 1);
});

test('DownloadManager rejects duplicate in-flight keys and supports abort', async () => {
  const dm = new DownloadManager({
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
  });
  const first = dm.fetch('v:9', 'http://x/9');
  assert.rejects(dm.fetch('v:9', 'http://x/9'), /duplicate/);
  dm.abortKey('v:9');
  await assert.rejects(first, /aborted/);
  assert.equal(dm.inflightKeys.length, 0);
});

// ------------------------------------------------- append-queue seek races
// Controllable fakes: append completion and fetch resolution are gated so the
// test decides the exact interleaving (append in flight -> seek -> settle),
// instead of relying on timer luck.
const SEG_N = 16;
const raceSeg = (i) => ({ index: i, url: `${i}.webm`, timeStart: i, duration: 1, timeEnd: i + 1 });
const raceManifest = {
  durationSec: SEG_N,
  mimeType: { video: 'video/webm', audio: 'audio/webm' },
  tracks: {
    video: { initUrl: 'v-init', segments: Array.from({ length: SEG_N }, (_, i) => raceSeg(i)) },
    audio: { initUrl: 'a-init', segments: Array.from({ length: SEG_N }, (_, i) => raceSeg(i)) },
  },
};

function insertRange(ranges, r) {
  const out = [...ranges, r].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const x of out) {
    const last = merged[merged.length - 1];
    if (last && x.start <= last.end + 0.05) last.end = Math.max(last.end, x.end);
    else merged.push({ ...x });
  }
  return merged;
}

class GatedSourceBuffer {
  constructor(label, { gated = true } = {}) {
    this.label = label;
    this.gated = gated;
    this.mode = 'segments';
    this.updating = false;
    this._listeners = new Map();
    this._ranges = [];
    this.pending = [];
    this.appended = [];
    this.removed = [];
    this.failNext = false;
  }
  addEventListener(t, fn) {
    if (!this._listeners.has(t)) this._listeners.set(t, new Set());
    this._listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) { this._listeners.get(t)?.delete(fn); }
  _emit(t, payload) { for (const fn of this._listeners.get(t) ?? []) fn(payload ?? { type: t }); }
  get buffered() {
    const ranges = this._ranges;
    return { length: ranges.length, start: (i) => ranges[i].start, end: (i) => ranges[i].end };
  }
  appendBuffer(data) {
    if (this.updating) throw new Error(`SB ${this.label} busy — serialization lost`);
    this.updating = true;
    const idx = data.__segIndex ?? -1;
    const finish = () => {
      this.updating = false;
      if (this.failNext) {
        this.failNext = false;
        const err = new Error(`simulated decode failure on ${this.label}`);
        err.name = 'InvalidStateError';
        queueMicrotask(() => { this._emit('error', { type: 'error', error: err }); this._emit('updateend'); });
        return;
      }
      if (idx >= 0) {
        this.appended.push(idx);
        this._ranges = insertRange(this._ranges, { start: idx, end: idx + 1 });
      }
      this._emit('updateend');
    };
    if (this.gated) new Promise((resolve) => this.pending.push(resolve)).then(finish);
    else queueMicrotask(finish);
  }
  flushOne() {
    const resolve = this.pending.shift();
    if (!resolve) throw new Error(`no gated append pending on ${this.label}`);
    resolve();
  }
  remove(s, e) {
    if (this.updating) throw new Error(`SB ${this.label} busy on remove`);
    this.updating = true;
    this.removed.push([s, e]);
    queueMicrotask(() => {
      this.updating = false;
      this._ranges = this._ranges
        .map((r) => ({ start: Math.max(r.start, e), end: r.end }))
        .filter((r) => r.end - r.start > 0.01);
      this._emit('updateend');
    });
  }
  abort() { this.updating = false; }
}

class GatedFetcher {
  constructor() { this.holding = new Map(); this.abortedUrls = []; }
  hold(url) {
    const gate = { promise: null };
    gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
    this.holding.set(url, gate);
  }
  fetchImpl = (url, init) => {
    const gate = this.holding.get(url);
    const respond = () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        const m = url.match(/(\d+)\.webm/);
        const buf = new ArrayBuffer(4);
        if (m) buf.__segIndex = Number(m[1]);
        return buf;
      },
    });
    if (gate) {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          this.abortedUrls.push(url);
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
        gate.promise.then(() => resolve(respond()));
      });
    }
    return Promise.resolve(respond());
  };
}

function makeFakeVideo() {
  return {
    currentTime: 0, paused: true, seeking: false, ended: false, readyState: 0,
    addEventListener() {}, removeEventListener() {},
    play() { return Promise.resolve(); }, pause() {}, load() {}, removeAttribute() {},
  };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function buildRacePlayer({ gatedVideo = true, fetcher = new GatedFetcher() } = {}) {
  const video = makeFakeVideo();
  const player = new MsePlayer(video, {
    aheadLimitSec: 4, retentionSec: 2, highWatermarkSec: 1000,
    download: { maxRetries: 0, baseBackoffMs: 1, fetchImpl: fetcher.fetchImpl },
  });
  player.manifest = raceManifest;
  player.setManifestUrl('http://test.local/media/manifest.json');
  player.mediaSource = { readyState: 'open', endOfStream() {} };
  player.queues.video = new SourceBufferQueue(new GatedSourceBuffer('video', { gated: gatedVideo }), 'video');
  player.queues.audio = new SourceBufferQueue(new GatedSourceBuffer('audio', { gated: false }), 'audio');
  return { player, video, vSB: player.queues.video.sb, aSB: player.queues.audio.sb, fetcher };
}

async function settleGated(player, vSB) {
  for (let i = 0; i < 60; i++) {
    while (vSB.pending.length) vSB.flushOne();
    await tick(2);
    if (!vSB.updating && player._appendQueue.length === 0 &&
        player.downloads.inflightKeys.length === 0 && !player._draining) {
      return;
    }
  }
  throw new Error('player did not settle after seek scheduling');
}

atest('seek while an append is in flight: stale append never drives post-seek cursor', async () => {
  const { player, vSB } = await buildRacePlayer();
  player._pump();
  await tick(20);
  assert.equal(vSB.updating, true, 'precondition: a video append owns the buffer at seek time');

  player.seekTo(8);
  assert.equal(player.state, PlayerState.SEEKING);
  assert.deepEqual(player._appendQueue, []);
  assert.equal(player._seekEpoch, 1);

  // Controlled ordering: the pre-seek append completes strictly after the seek.
  vSB.flushOne();
  await tick(5);
  // The stale segment physically landed and is remembered for dedupe...
  assert.ok(player._appended.has('video:0'), 'stale append still recorded for dedupe');
  // ...but the cursor stays at the seek target instead of advancing to 1.
  assert.equal(player._cursor.video, 8, `cursor must not move on stale data, got ${player._cursor.video}`);

  await settleGated(player, vSB);
  const ranges = vSB._ranges;
  assert.ok(ranges.some((g) => g.start <= 8 && g.end >= 9),
    'real buffered range must cover the seek target: ' + JSON.stringify(ranges));
  assert.ok(player._appended.has('video:8'), 'target segment must be appended after the seek');
  assert.equal(player.state, PlayerState.SEEKING);
  assert.equal(player._fatal, null);
});

atest('failing head append is counted once even when pumps overlap (no retry storm)', async () => {
  const { player, vSB } = await buildRacePlayer();
  player._pump();
  await tick(20);
  // Force the in-flight append to fail; hammer the scheduler the way UI events
  // and ticks do, so overlapping drain chains are exercised.
  vSB.failNext = true;
  for (let i = 0; i < 5; i++) player._pump();
  vSB.flushOne();
  await tick(30);
  assert.equal(player.state, PlayerState.ERROR, 'decode failure must enter ERROR');
  assert.equal(player._stats.appendErrors, 1,
    `one failed append must produce exactly one error, got ${player._stats.appendErrors}`);
  const again = player._stats.appendErrors;
  await tick(20);
  assert.equal(player._stats.appendErrors, again, 'error count must not keep growing');
});

atest('seek aborts in-flight downloads outside the new window in both directions', async () => {
  // --- backward direction: held fetches end up behind the seek target ---
  {
    const fetcher = new GatedFetcher();
    const { player } = await buildRacePlayer({ gatedVideo: false, fetcher });
    for (const i of [2, 3]) fetcher.hold(`http://test.local/media/${i}.webm`);
    player._pump();
    await tick(30);
    assert.ok(player.downloads.inflightKeys.some((k) => [2, 3].includes(Number(k.split(':')[1]))),
      'precondition: held fetches in flight: ' + JSON.stringify(player.downloads.inflightKeys));
    player.seekTo(10);
    await tick(10);
    assert.deepEqual(
      player.downloads.inflightKeys.filter((k) => Number(k.split(':')[1]) < 10), [],
      'backward seek must abort old-window downloads: ' + JSON.stringify(player.downloads.inflightKeys),
    );
    assert.ok(fetcher.abortedUrls.length > 0, 'abort must reach the fetch layer');
  }

  // --- forward-window direction: an in-flight fetch beyond the new window ---
  // Fresh player whose prefetch window at t=7 is [7,11). Hold segment 10 (its
  // far edge) in flight, then seek to t=7 with a shorter aheadLimit so the new
  // window [7,9) excludes segment 10. The old cursor-only rule kept downloads
  // ahead of the cursor; the window rule must abort the now-outside fetch.
  {
    const fetcher = new GatedFetcher();
    const video = makeFakeVideo();
    const player = new MsePlayer(video, {
      aheadLimitSec: 4, retentionSec: 2, highWatermarkSec: 1000,
      download: { maxRetries: 0, baseBackoffMs: 1, fetchImpl: fetcher.fetchImpl },
    });
    player.manifest = raceManifest;
    player.setManifestUrl('http://test.local/media/manifest.json');
    player.mediaSource = { readyState: 'open', endOfStream() {} };
    player.queues.video = new SourceBufferQueue(new GatedSourceBuffer('video', { gated: false }), 'video');
    player.queues.audio = new SourceBufferQueue(new GatedSourceBuffer('audio', { gated: false }), 'audio');

    player.seekTo(7); // window [7,11) under aheadLimitSec=4
    fetcher.hold('http://test.local/media/10.webm');
    player._pump();
    await tick(40);
    const held = player.downloads.inflightKeys.filter((k) => Number(k.split(':')[1]) === 10);
    assert.ok(held.length > 0,
      'precondition: far-edge fetch in flight: ' + JSON.stringify(player.downloads.inflightKeys));

    // Shrink the prefetch window so segment 10 falls outside, then re-seek.
    player.options.aheadLimitSec = 2; // new window [7,9)
    player.seekTo(7);
    await tick(10);
    assert.deepEqual(
      player.downloads.inflightKeys.filter((k) => Number(k.split(':')[1]) >= 9), [],
      'beyond-window fetch must be aborted: ' + JSON.stringify(player.downloads.inflightKeys),
    );
    assert.ok(fetcher.abortedUrls.some((u) => /10\.webm/.test(u)),
      'abort must reach the beyond-window fetch: ' + JSON.stringify(fetcher.abortedUrls));
  }
});

atest('overlapping pump cycles never enqueue the same segment twice', async () => {
  const { player, vSB } = await buildRacePlayer();
  player._pump();
  await tick(20);
  player.seekTo(6);
  // Several pumps while the first post-seek drain is still gated.
  for (let i = 0; i < 4; i++) player._pump();
  await tick(5);
  await settleGated(player, vSB);
  const keys = player._appendQueue.map((i) => `${i.kind}:${i.index}`);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dupes, [], 'append queue must not contain duplicate keys');
  // Every segment 6..9 on video is appended exactly once.
  for (const i of [6, 7, 8, 9]) {
    const count = vSB.appended.filter((x) => x === i).length;
    assert.equal(count, 1, `video segment ${i} appended ${count} times`);
  }
  assert.equal(player.state !== PlayerState.ERROR, true);
});

atest('seek is rejected from terminal states without mutating scheduling', async () => {
  const { player } = await buildRacePlayer({ gatedVideo: false });
  player._fatalNow('boom');
  const epoch = player._seekEpoch;
  assert.equal(player.seekTo(8), undefined);
  assert.equal(player._seekEpoch, epoch, 'ERROR state must ignore seek');
  assert.equal(player.state, PlayerState.ERROR);
});

await Promise.all(asyncTests);

console.log(`\n${passed} unit assertions groups passed`);
