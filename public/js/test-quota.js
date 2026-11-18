// QuotaExceededError recovery tests using an injectable SourceBuffer.
// Real browsers rarely raise quota in a short demo; this harness drives the
// kernel's exact recovery branch deterministically.
import { MsePlayer, PlayerState } from './kernel/mse-player.js';

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake SourceBuffer whose appendBuffer can be forced to raise quota once.
class FakeSourceBuffer {
  constructor(label) {
    this.label = label;
    this.mode = 'segments';
    this.updating = false;
    this._listeners = new Map();
    this._ranges = [];
    this.failQuotaOnce = 0; // number of upcoming appends that fail with quota
    this.removed = [];
    this.appends = 0;
  }
  addEventListener(t, fn) {
    if (!this._listeners.has(t)) this._listeners.set(t, new Set());
    this._listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) { this._listeners.get(t)?.delete(fn); }
  _emit(t, payload) { for (const fn of this._listeners.get(t) ?? []) fn(payload ?? { type: t }); }
  _quotaError() {
    const err = new Error('simulated quota exceeded');
    err.name = 'QuotaExceededError';
    return err;
  }
  get buffered() {
    // Mirror a minimal TimeRanges over the stored ranges.
    const ranges = this._ranges;
    return {
      length: ranges.length,
      start: (i) => ranges[i].start,
      end: (i) => ranges[i].end,
    };
  }
  appendBuffer(data) {
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      if (this.failQuotaOnce > 0) {
        this.failQuotaOnce--;
        const err = this._quotaError();
        queueMicrotask(() => {
          this._emit('error', { type: 'error', error: err });
          this._emit('updateend');
        });
        return;
      }
      this.appends++;
      // Grow a synthetic range by 1s per append.
      const end = this.appends;
      this._ranges = [{ start: 0, end }];
      this._emit('updateend');
    });
  }
  remove(start, end) {
    this.updating = true;
    this.removed.push([start, end]);
    queueMicrotask(() => {
      this.updating = false;
      this._ranges = this._ranges
        .map((r) => ({ start: Math.max(r.start, end), end: r.end }))
        .filter((r) => r.end - r.start > 0.01);
      this._emit('updateend');
    });
  }
  abort() { this.updating = false; }
}

const results = [];
const record = (name, fn) => {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', `${name}: ${e.message}`]); }
};

// Minimal stand-in: construct player and bypass MediaSource by wiring fakes.
function buildPlayerWithFakeBuffers() {
  const video = {
    currentTime: 0, paused: true, seeking: false, readyState: 0,
    addEventListener() {}, removeEventListener() {},
    play() { return Promise.resolve(); }, pause() {}, load() {},
    removeAttribute() {},
  };
  const p = new MsePlayer(video, { retentionSec: 2, highWatermarkSec: 5, aheadLimitSec: 10 });
  p.manifest = {
    durationSec: 60,
    mimeType: { video: 'video/webm; codecs="vp9"', audio: 'audio/webm; codecs="opus"' },
    tracks: {
      video: { segments: Array.from({ length: 60 }, (_, i) => ({ index: i, timeStart: i, duration: 1, timeEnd: i + 1 })) },
      audio: { segments: Array.from({ length: 60 }, (_, i) => ({ index: i, timeStart: i, duration: 1, timeEnd: i + 1 })) },
    },
  };
  const fakeV = new FakeSourceBuffer('video');
  const fakeA = new FakeSourceBuffer('audio');
  // Re-instantiate queues over the fake buffers.
  p.queues = {};
  // Lazy import avoids circular concerns at module top.
  return { p, fakeV, fakeA };
}

const { SourceBufferQueue } = await import('./kernel/source-buffer-queue.js');

async function main() {
  // Case A: quota on first append, eviction frees space, retry succeeds once.
  {
    const { p, fakeV, fakeA } = buildPlayerWithFakeBuffers();
    p.queues.video = new SourceBufferQueue(fakeV, 'video');
    p.queues.audio = new SourceBufferQueue(fakeA, 'audio');
    // Pretend 8s is already buffered so an evictable prefix exists behind t=5.
    fakeV._ranges = [{ start: 0, end: 8 }];
    fakeA._ranges = [{ start: 0, end: 8 }];
    fakeV.appends = 8; fakeA.appends = 8;
    p.video.currentTime = 5;
    fakeV.failQuotaOnce = 1;
    p._appendQueue.push({ kind: 'video', index: 8, data: new Uint8Array([1]), epoch: p._seekEpoch });
    await p._drainAppendQueue();
    record('配额错误：回收后同片重试一次成功', () => {
      assert(p.state !== PlayerState.ERROR, '不应进入 ERROR，实际 ' + p.state);
      assert(p._stats.quotaRecoveries === 1, 'quotaRecoveries 应为 1');
      assert(fakeV.removed.length >= 1, '应执行 remove 回收');
      assert(fakeV.appends === 9, '失败后应完成追加，appends=' + fakeV.appends);
    });
  }

  // Case B: no evictable prefix (playhead at 0) -> quota cannot recover -> ERROR.
  {
    const { p, fakeV, fakeA } = buildPlayerWithFakeBuffers();
    p.queues.video = new SourceBufferQueue(fakeV, 'video');
    p.queues.audio = new SourceBufferQueue(fakeA, 'audio');
    p.video.currentTime = 0;
    fakeV.failQuotaOnce = 1;
    p._appendQueue.push({ kind: 'video', index: 0, data: new Uint8Array([1]), epoch: p._seekEpoch });
    await p._drainAppendQueue();
    record('无法回收时：配额失败进入可解释 ERROR', () => {
      assert(p.state === PlayerState.ERROR, '应进入 ERROR，实际 ' + p.state);
      assert(p._stats.quotaFailures === 1, 'quotaFailures 应为 1');
      assert(p._fatal && /quota/i.test(p._fatal.message), 'fatal 应说明配额');
    });
  }

  // Case C: non-quota append error must not trigger eviction retry.
  {
    const { p, fakeV, fakeA } = buildPlayerWithFakeBuffers();
    p.queues.video = new SourceBufferQueue(fakeV, 'video');
    p.queues.audio = new SourceBufferQueue(fakeA, 'audio');
    fakeV._ranges = [{ start: 0, end: 8 }];
    p.video.currentTime = 5;
    const orig = fakeV.appendBuffer.bind(fakeV);
    fakeV.appendBuffer = function (data) {
      this.updating = true;
      queueMicrotask(() => {
        this.updating = false;
        const err = new Error('decode failure');
        err.name = 'InvalidStateError';
        queueMicrotask(() => { this._emit('error'); this._emit('updateend'); });
      });
    };
    p._appendQueue.push({ kind: 'video', index: 9, data: new Uint8Array([1]), epoch: p._seekEpoch });
    await p._drainAppendQueue();
    record('非配额错误：不回收、直接 ERROR', () => {
      assert(p.state === PlayerState.ERROR, '应进入 ERROR');
      assert(p._stats.evictions === 0, '不应触发回收');
      assert(fakeV.removed.length === 0, '不应调用 remove');
    });
  }

  const el = document.getElementById('quota-results');
  el.innerHTML = results.map(([s, n]) => `<div class="${s.toLowerCase()}">${s} ${n}</div>`).join('');
  window.__quotaResult = {
    passed: results.filter(([s]) => s === 'PASS').length,
    total: results.length,
    done: true,
    results,
  };
}

main();
