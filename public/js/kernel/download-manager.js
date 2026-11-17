// Download layer: bounded retries with backoff, abort support, explicit
// success/failure events. A segment that exhausts its retries fails once with
// a terminal error — nothing retries forever or hides a broken response.
import { Evented } from './evented.js';

export class DownloadTask {
  constructor(key, url) {
    this.key = key; // e.g. "video:12"
    this.url = url;
    this.controller = new AbortController();
    this.attempt = 0;
    this.aborted = false;
  }
}

export class DownloadManager extends Evented {
  constructor({ maxRetries = 3, baseBackoffMs = 300, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    super();
    this.maxRetries = maxRetries;
    this.baseBackoffMs = baseBackoffMs;
    this.fetchImpl = fetchImpl;
    this._inflight = new Map();
    this._stats = { started: 0, succeeded: 0, failed: 0, retried: 0, aborted: 0, bytes: 0 };
  }

  get stats() {
    return { ...this._stats, inflight: this._inflight.size };
  }

  get inflightKeys() {
    return [...this._inflight.keys()];
  }

  isInflight(key) {
    return this._inflight.has(key);
  }

  abortKey(key) {
    const task = this._inflight.get(key);
    if (task && !task.aborted) {
      task.aborted = true;
      task.controller.abort();
      this._stats.aborted++;
    }
  }

  abortAll() {
    for (const task of this._inflight.values()) {
      if (!task.aborted) {
        task.aborted = true;
        task.controller.abort();
        this._stats.aborted++;
      }
    }
  }

  // Returns the ArrayBuffer on success; rejects with a terminal Error after
  // maxRetries+1 total attempts. Abort rejects immediately without retry.
  async fetch(key, url) {
    if (this._inflight.has(key)) {
      throw new Error(`duplicate download request for "${key}" refused`);
    }
    const task = new DownloadTask(key, url);
    this._inflight.set(key, task);
    this._stats.started++;
    this.emit('taskstart', { key, url });

    let lastError;
    try {
      while (task.attempt <= this.maxRetries) {
        task.attempt++;
        try {
          const res = await this.fetchImpl(url, { signal: task.controller.signal });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} for ${url}`);
          }
          const buf = await res.arrayBuffer();
          // A truncated body still resolves in fetch; callers verify sizes
          // against the manifest where exact sizes matter.
          this._stats.succeeded++;
          this._stats.bytes += buf.byteLength;
          this.emit('taskdone', { key, url, bytes: buf.byteLength, attempt: task.attempt });
          return buf;
        } catch (err) {
          if (task.aborted || err.name === 'AbortError') {
            const abortErr = new Error(`download "${key}" aborted`);
            abortErr.name = 'AbortError';
            throw abortErr;
          }
          lastError = err;
          if (task.attempt > this.maxRetries) break;
          this._stats.retried++;
          const delay = this.baseBackoffMs * 2 ** (task.attempt - 1);
          this.emit('taskretry', { key, url, attempt: task.attempt, delay, error: err.message });
          await new Promise((r) => setTimeout(r, delay));
          if (task.aborted) {
            const abortErr = new Error(`download "${key}" aborted during backoff`);
            abortErr.name = 'AbortError';
            throw abortErr;
          }
        }
      }
      this._stats.failed++;
      const terminal = new Error(
        `download "${key}" failed after ${task.attempt} attempt(s): ${lastError?.message ?? lastError}`,
      );
      terminal.cause = lastError;
      this.emit('taskerror', { key, url, error: terminal.message, attempts: task.attempt });
      throw terminal;
    } finally {
      this._inflight.delete(key);
    }
  }
}
