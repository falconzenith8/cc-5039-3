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

console.log(`\n${passed} unit assertions groups passed`);
