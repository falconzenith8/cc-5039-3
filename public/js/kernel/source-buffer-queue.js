// Serializes every appendBuffer/remove/abort call against one SourceBuffer.
//
// SourceBuffer allows only one mutating operation at a time: while `updating`
// is true, calling appendBuffer or remove throws synchronously. Rather than
// retrying on that exception (which turns races into busy loops), every
// operation is enqueued and started only when the previous one has settled.
// A failed operation rejects its own task and leaves the queue usable for the
// next one, so the player can move into a well-defined error state instead of
// hammering the same failing append.
export class SourceBufferQueue {
  constructor(sourceBuffer, label) {
    this.sb = sourceBuffer;
    this.label = label;
    this._chain = Promise.resolve();
    this._pending = 0;
    this._closed = false;

    this.sb.addEventListener('error', (e) => {
      // Async decode/network errors on the buffer surface here too; the task
      // promise is rejected via the updateend path below, this is for logging.
      console.error(`[SourceBufferQueue:${label}] buffer error event`, e);
    });
  }

  get updating() {
    return this.sb.updating || this._pending > 0;
  }

  get pendingCount() {
    return this._pending;
  }

  // Internal: attach the operation's completion to the queue chain.
  _enqueue(run) {
    if (this._closed) {
      return Promise.reject(new Error(`SourceBuffer "${this.label}" queue is closed`));
    }
    this._pending++;
    const task = this._chain.then(() => {
      if (this._closed) throw new Error(`SourceBuffer "${this.label}" queue is closed`);
      // Defensive guard: if the browser still reports updating here, something
      // outside the queue mutated the buffer. Fail loudly instead of racing.
      if (this.sb.updating) {
        throw new Error(`SourceBuffer "${this.label}" externally busy; refusing to race`);
      }
      return run();
    });
    // Keep the chain alive even when a task rejects; the next task still runs.
    this._chain = task.then(
      () => undefined,
      () => undefined,
    );
    const done = () => this._pending--;
    task.then(done, done);
    return task;
  }

  appendBuffer(data) {
    return this._enqueue(
      () =>
        new Promise((resolve, reject) => {
          const cleanup = () => {
            this.sb.removeEventListener('updateend', onEnd);
            this.sb.removeEventListener('error', onError);
            this.sb.removeEventListener('abort', onAbort);
          };
          const onEnd = () => {
            cleanup();
            resolve();
          };
          const onError = (event) => {
            cleanup();
            // Preserve the underlying error type (e.g. QuotaExceededError) so
            // the player's recovery logic can branch on err.name. The browser
            // error event does not always carry the DOMException directly, so
            // fall back to the SourceBuffer's last error when available.
            const cause = event?.error || this.sb?.error;
            const err = cause
              ? cause
              : new Error(`appendBuffer failed on "${this.label}" (decode/network error)`);
            if (cause && !cause.message) err.message = `appendBuffer failed on "${this.label}"`;
            reject(err);
          };
          const onAbort = () => {
            cleanup();
            reject(new Error(`appendBuffer aborted on "${this.label}"`));
          };
          this.sb.addEventListener('updateend', onEnd, { once: true });
          this.sb.addEventListener('error', onError, { once: true });
          this.sb.addEventListener('abort', onAbort, { once: true });
          try {
            this.sb.appendBuffer(data);
          } catch (err) {
            cleanup();
            reject(err);
          }
        }),
    );
  }

  remove(start, end) {
    const s = Math.max(0, start);
    const e = Math.max(s, end);
    return this._enqueue(
      () =>
        new Promise((resolve, reject) => {
          const cleanup = () => {
            this.sb.removeEventListener('updateend', onEnd);
            this.sb.removeEventListener('error', onError);
          };
          const onEnd = () => {
            cleanup();
            resolve();
          };
          const onError = () => {
            cleanup();
            reject(new Error(`remove(${s}, ${e}) failed on "${this.label}"`));
          };
          this.sb.addEventListener('updateend', onEnd, { once: true });
          this.sb.addEventListener('error', onError, { once: true });
          try {
            this.sb.remove(s, e);
          } catch (err) {
            cleanup();
            reject(err);
          }
        }),
    );
  }

  // abort() is a synchronous no-op-when-idle cancellation. It is NOT enqueued:
  // during teardown an in-flight append already owns the buffer, and queueing
  // abort behind it would deadlock while that append can no longer finish.
  abort() {
    if (this._closed) return;
    if (this.sb.updating) {
      try {
        this.sb.abort();
      } catch {
        /* buffer may be detached */
      }
    }
  }

  // Closure is immediate: pending tasks settle via their own events while the
  // player tears down, so nothing here may await an unsettled append.
  close() {
    this._closed = true;
  }
}
