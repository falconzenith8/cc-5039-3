// MSE segmented playback kernel.
//
// Responsibilities:
//   - own the MediaSource + two SourceBuffers (video/audio) and the object URL;
//   - serialize every buffer mutation through SourceBufferQueue (no appends and
//     removes can ever run concurrently on the same buffer);
//   - schedule short segment downloads ahead of the playhead, keeping the two
//     tracks in lockstep (audio never runs far ahead of video);
//   - treat the browser-reported `buffered` TimeRanges as the only playable
//     truth — downloaded-but-not-decoded bytes are not counted as buffered;
//   - recover QuotaExceededError by evicting a defined retention window behind
//     the playhead, then retrying the same append exactly once;
//   - expose an explicit state machine and events so the UI reflects reality
//     and failures surface as explainable states instead of retry storms.
import { Evented } from './evented.js';
import { SourceBufferQueue } from './source-buffer-queue.js';
import { DownloadManager } from './download-manager.js';
import {
  snapshotRanges,
  continuousFrom,
  intersectRanges,
  evictablePrefix,
  totalBuffered,
  containsTime,
} from './buffered-ranges.js';

export const PlayerState = Object.freeze({
  IDLE: 'IDLE',
  OPENING: 'OPENING',
  BUFFERING: 'BUFFERING',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  SEEKING: 'SEEKING',
  ENDED: 'ENDED',
  ERROR: 'ERROR',
  DISPOSED: 'DISPOSED',
});

const MAX_APPEND_RETRIES = 1; // quota recovery permits exactly one re-append
const TICK_MS = 250;
const STALL_GRACE_MS = 600;

export class MsePlayer extends Evented {
  constructor(video, options = {}) {
    super();
    this.video = video;
    this.options = {
      aheadLimitSec: 15,        // how far ahead of playhead to schedule
      retentionSec: 8,          // kept behind playhead during eviction
      highWatermarkSec: 30,     // proactive eviction threshold
      stallTimeoutMs: 4000,     // no time advance while playing => stall
      ...options,
    };

    this.state = PlayerState.IDLE;
    this.manifest = null;
    this.mediaSource = null;
    this.objectUrl = null;
    this.queues = {};                 // kind -> SourceBufferQueue
    this.downloads = new DownloadManager(options.download || {});
    this._downloaded = new Set();     // keys successfully fetched
    this._appended = new Set();       // keys durably inside a SourceBuffer
    this._appendQueue = [];           // {kind, index, data} awaiting append
    this._cursor = { video: 0, audio: 0 }; // next index each track needs
    this._demandAnchor = 0; // seek target while SEEKING; otherwise mirrors currentTime
    this._pumpScheduled = false;
    this._tickTimer = null;
    this._lastCurrentTime = 0;
    this._lastProgressAt = 0;
    this._stallCount = 0;
    this._fatal = null;
    this._endOfStreamed = false;
    this._disposed = false;
    this._stats = {
      appends: 0,
      appendErrors: 0,
      evictions: 0,
      quotaRecoveries: 0,
      quotaFailures: 0,
      stalls: 0,
      continuityBreaks: 0,
    };
    this._bindMediaEvents();
    this._bindDownloadEvents();
  }

  // ---------------------------------------------------------------- load
  async load(manifestUrl) {
    this._transition(PlayerState.OPENING);
    // Resolve against the document URL so relative manifest paths become absolute;
    // every segment URL is later derived from this base.
    this.setManifestUrl(new URL(manifestUrl, document.baseURI).href);
    const res = await fetch(manifestUrl);
    if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
    this.manifest = await res.json();

    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported) {
      throw new Error('MediaSource Extensions unavailable in this browser');
    }
    for (const kind of ['video', 'audio']) {
      const mime = this.manifest.mimeType[kind];
      if (!MediaSource.isTypeSupported(mime)) {
        throw new Error(`browser refuses codec for ${kind}: ${mime}`);
      }
    }

    const ms = new MediaSource();
    this.mediaSource = ms;
    this.objectUrl = URL.createObjectURL(ms);
    this.video.src = this.objectUrl;

    await new Promise((resolve, reject) => {
      ms.addEventListener('sourceopen', resolve, { once: true });
      ms.addEventListener('sourceended', () => this.emit('sourceended'), { once: true });
      ms.addEventListener('sourceclose', () => {
        if (!this._disposed) this._fatalNow('MediaSource closed unexpectedly');
      });
      setTimeout(() => reject(new Error('MediaSource open timeout')), 10000);
    });

    for (const kind of ['video', 'audio']) {
      const sb = ms.addSourceBuffer(this.manifest.mimeType[kind]);
      sb.mode = 'segments';
      this.queues[kind] = new SourceBufferQueue(sb, kind);
    }

    // Initialization segments first, both tracks, before any media data.
    for (const kind of ['video', 'audio']) {
      const initUrl = new URL(this.manifest.tracks[kind].initUrl, this._manifestUrl).href;
      const data = await this.downloads.fetch(`${kind}:init`, initUrl);
      await this.queues[kind].appendBuffer(data);
      this._appended.add(`${kind}:init`);
    }

    this._startTick();
    this._transition(PlayerState.BUFFERING);
    this._pump();
  }

  // ------------------------------------------------------ playback control
  async play() {
    if (this.state === PlayerState.ENDED) {
      this.video.currentTime = 0;
    }
    try {
      await this.video.play();
      // currentTime only advances once the intersection of A/V ranges covers it.
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
  }

  pause() {
    this.video.pause();
  }

  // Seek moves the demand window. In-flight downloads outside the new window
  // are aborted; buffered data is retained and reused where it overlaps.
  seekTo(time) {
    if (this._disposed) return;
    const clamped = Math.max(0, Math.min(time, this.manifest.durationSec));
    this._transition(PlayerState.SEEKING);
    this._endOfStreamed = false;
    this._appendQueue = [];

    for (const kind of ['video', 'audio']) {
      const segs = this.manifest.tracks[kind].segments;
      const idx = segs.findIndex((s) => clamped >= s.timeStart && clamped < s.timeEnd);
      this._cursor[kind] = idx === -1 ? segs.length - 1 : idx;
    }
    // Abort downloads that no longer belong to the post-seek window.
    for (const key of this.downloads.inflightKeys) {
      const [kind, raw] = key.split(':');
      if (raw === 'init') continue;
      const index = Number(raw);
      if (!Number.isInteger(index) || index < this._cursor[kind]) {
        this.downloads.abortKey(key);
      }
    }
    this.video.currentTime = clamped;
    this._demandAnchor = clamped;
    this._lastCurrentTime = clamped;
    this._lastProgressAt = performance.now();
    this._pump();
  }

  // Re-arm after a recoverable ERROR: clear the fatal flag and resume scheduling.
  resume() {
    if (this.state !== PlayerState.ERROR) return;
    this._fatal = null;
    this._transition(PlayerState.BUFFERING);
    this._pump();
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    clearInterval(this._tickTimer);
    this._tickTimer = null;
    this.downloads.abortAll();
    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    } catch {
      /* element may already be detached */
    }
    for (const kind of Object.keys(this.queues)) {
      try {
        const sb = this.queues[kind].sb;
        if (this.mediaSource?.readyState === 'open' && sb.updating) {
          this.queues[kind].abort();
        }
        this.queues[kind].close();
      } catch {
        /* teardown best effort */
      }
    }
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch {
        /* already closing */
      }
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this._transition(PlayerState.DISPOSED);
    this.emit('disposed');
  }

  // ------------------------------------------------------------- scheduling
  _pump = () => {
    if (this._disposed || this.state === PlayerState.ERROR || this.state === PlayerState.DISPOSED) return;
    if (this._pumpScheduled) return;
    this._pumpScheduled = true;
    queueMicrotask(async () => {
      this._pumpScheduled = false;
      try {
        await this._runPump();
      } catch (err) {
        this._fatalNow(`scheduler error: ${err.message}`, err);
      }
    });
  };

  async _runPump() {
    if (!this.manifest) return;
    await this._drainAppendQueue();
    if (this.state === PlayerState.ERROR) return;

    const plan = this._planDownloads();
    if (plan.length === 0) {
      this._maybeEndStream();
      return;
    }
    await this._downloadAndAppend(plan);
    if (this.state !== PlayerState.ERROR) {
      await this._enforceHighWatermark();
      this._maybeEndStream();
    }
  }

  // Decide which segment indices to fetch. Video leads; audio is paired to the
  // same demand window so one track cannot drift far from the other.
  _planDownloads() {
    const { aheadLimitSec } = this.options;
    // While seeking, currentTime may still report the old (buffered) position
    // because nothing is decodable at the target yet. The demand anchor holds
    // the requested position so the scheduler fetches the right window.
    const playhead = this.state === PlayerState.SEEKING
      ? this._demandAnchor
      : this.video.currentTime || 0;
    const horizon = playhead + aheadLimitSec;
    const plan = [];

    const vSegs = this.manifest.tracks.video.segments;
    const aSegs = this.manifest.tracks.audio.segments;
    const needed = (kind, segs) => {
      const out = [];
      for (let i = this._cursor[kind]; i < segs.length; i++) {
        const seg = segs[i];
        if (seg.timeStart >= horizon) break;
        const key = `${kind}:${i}`;
        if (this._appended.has(key) || this.downloads.isInflight(key)) continue;
        out.push({ kind, index: i, seg });
      }
      return out;
    };

    const videoNeeded = needed('video', vSegs);
    const audioNeeded = needed('audio', aSegs);
    const maxPairs = Math.max(videoNeeded.length, audioNeeded.length);

    // Interleave by demand position: video first, then its audio counterpart.
    for (let i = 0; i < maxPairs; i++) {
      if (videoNeeded[i]) plan.push(videoNeeded[i]);
      if (audioNeeded[i]) plan.push(audioNeeded[i]);
    }
    return plan;
  }

  async _downloadAndAppend(plan) {
    const downloads = plan.map(async (item) => {
      const key = `${item.kind}:${item.index}`;
      const url = new URL(item.seg.url, this._manifestUrl).href;
      try {
        const data = await this.downloads.fetch(key, url);
        this._downloaded.add(key);
        return { ...item, data };
      } catch (err) {
        if (err.name === 'AbortError') return null; // seek superseded this fetch
        this._fatalNow(err.message, err);
        return null;
      }
    });
    const settled = (await Promise.all(downloads)).filter(Boolean);
    // Append in deterministic index order per track even if downloads resolved
    // out of order; appendBuffer with sequence-agnostic fMP4 tolerates this,
    // but ordered appends keep decode dependencies intact.
    settled.sort((a, b) => a.index - b.index || a.kind.localeCompare(b.kind));
    for (const item of settled) this._appendQueue.push(item);
    await this._drainAppendQueue();
    this._pump();
  }

  async _drainAppendQueue() {
    while (this._appendQueue.length) {
      const item = this._appendQueue[0];
      const key = `${item.kind}:${item.index}`;
      try {
        await this._appendWithQuotaRecovery(item);
        this._appendQueue.shift();
        this._appended.add(key);
        this._cursor[item.kind] = Math.max(this._cursor[item.kind], item.index + 1);
        this._stats.appends++;
        this.emit('bufferedchange', this.getRanges());
      } catch (err) {
        // Keep the failing item at the head so state stays explainable; enter
        // ERROR rather than silently dropping or endlessly retrying.
        this._stats.appendErrors++;
        this._fatalNow(err.message, err);
        return;
      }
    }
  }

  async _appendWithQuotaRecovery(item) {
    const queue = this.queues[item.kind];
    for (let attempt = 0; attempt <= MAX_APPEND_RETRIES; attempt++) {
      try {
        await queue.appendBuffer(item.data);
        if (attempt > 0) this._stats.quotaRecoveries++;
        return;
      } catch (err) {
        const isQuota = err.name === 'QuotaExceededError';
        if (!isQuota || attempt === MAX_APPEND_RETRIES) {
          if (isQuota) this._stats.quotaFailures++;
          throw err;
        }
        // One explicit, bounded recovery pass: evict a defined prefix on BOTH
        // tracks (preserving A/V correspondence), then retry the same append.
        const recovered = await this._evictForQuota(item.kind);
        this.emit('eviction', { reason: 'quota', recovered, ranges: this.getRanges() });
        if (!recovered) {
          this._stats.quotaFailures++;
          throw err;
        }
      }
    }
  }

  // Evict everything safely behind the playhead minus the retention window.
  // Runs on both tracks so their buffered ranges stay corresponding.
  async _evictForQuota(demandingKind) {
    const keepFrom = Math.max(0, this.video.currentTime - this.options.retentionSec);
    let removedAny = false;
    for (const kind of ['video', 'audio']) {
      const ranges = snapshotRanges(this.queues[kind].sb.buffered);
      const end = evictablePrefix(ranges, keepFrom);
      if (end > 0.05) {
        await this.queues[kind].remove(0, end);
        removedAny = true;
        this._stats.evictions++;
        // Forget appended keys whose segments are fully before the cut point.
        for (const key of [...this._appended]) {
          const [k, raw] = key.split(':');
          if (raw === 'init' || k !== kind) continue;
          const seg = this.manifest.tracks[kind].segments[Number(raw)];
          if (seg && seg.timeEnd <= end) this._appended.delete(key);
        }
      }
    }
    return removedAny;
  }

  // Proactive cap so an always-open stream cannot accumulate without bound,
  // even when the browser never raises QuotaExceededError.
  async _enforceHighWatermark() {
    const ranges = this.getRanges();
    // Cap total accumulation (all ranges across the timeline), not just the
    // forward lead: a steady-state stream keeps lead ~= aheadLimit even while
    // its retained past grows without bound. Evict only when a real prefix
    // older than the retention window exists.
    const bufferedTotal = Math.max(
      ranges.bufferedSeconds.video,
      ranges.bufferedSeconds.audio,
    );
    if (bufferedTotal <= this.options.highWatermarkSec) return;
    const keepFrom = Math.max(0, this.video.currentTime - this.options.retentionSec);
    let changed = false;
    for (const kind of ['video', 'audio']) {
      const end = evictablePrefix(snapshotRanges(this.queues[kind].sb.buffered), keepFrom);
      if (end > 0.05) {
        await this.queues[kind].remove(0, end);
        changed = true;
        this._stats.evictions++;
        for (const key of [...this._appended]) {
          const [k, raw] = key.split(':');
          if (raw === 'init' || k !== kind) continue;
          const seg = this.manifest.tracks[kind].segments[Number(raw)];
          if (seg && seg.timeEnd <= end) this._appended.delete(key);
        }
      }
    }
    if (changed) this.emit('eviction', { reason: 'watermark', ranges: this.getRanges() });
  }

  _maybeEndStream() {
    if (this._endOfStreamed || !this.manifest) return;
    const vDone = this._cursor.video >= this.manifest.tracks.video.segments.length;
    const aDone = this._cursor.audio >= this.manifest.tracks.audio.segments.length;
    const queuesIdle = Object.values(this.queues).every((q) => !q.updating);
    const noInflight = this.downloads.inflightKeys.length === 0;
    if (vDone && aDone && queuesIdle && noInflight && this._appendQueue.length === 0) {
      this._endOfStreamed = true;
      try {
        this.mediaSource.endOfStream();
        this.emit('endofstream');
      } catch (err) {
        this._fatalNow(`endOfStream failed: ${err.message}`, err);
      }
    }
  }

  // ------------------------------------------------------------ media glue
  _bindMediaEvents() {
    const v = this.video;
    v.addEventListener('playing', () => {
      if (this.state !== PlayerState.SEEKING) this._transition(PlayerState.PLAYING);
      this._lastProgressAt = performance.now();
    });
    v.addEventListener('pause', () => {
      if (this.state === PlayerState.PLAYING) this._transition(PlayerState.PAUSED);
    });
    v.addEventListener('waiting', () => {
      if (this.state === PlayerState.PLAYING || this.state === PlayerState.BUFFERING) {
        this._transition(PlayerState.BUFFERING);
      }
    });
    v.addEventListener('seeking', () => {
      if (this.state !== PlayerState.SEEKING) this._transition(PlayerState.SEEKING);
    });
    v.addEventListener('seeked', () => {
      // The element reached the target; future planning tracks currentTime again.
      this._demandAnchor = this.video.currentTime;
      this._lastProgressAt = performance.now();
      if (this.state === PlayerState.SEEKING) {
        this._transition(this.video.paused ? PlayerState.PAUSED : PlayerState.BUFFERING);
      }
      this._pump();
    });
    v.addEventListener('ended', () => this._transition(PlayerState.ENDED));
    v.addEventListener('error', () => {
      const err = v.error;
      this._fatalNow(
        err ? `media element error ${err.code}: ${err.message || 'decode failure'}` : 'unknown media error',
      );
    });
  }

  _bindDownloadEvents() {
    for (const type of ['taskstart', 'taskdone', 'taskretry', 'taskerror']) {
      this.downloads.on(type, (payload) => this.emit(type, payload));
    }
  }

  _startTick() {
    this._lastProgressAt = performance.now();
    this._tickTimer = setInterval(() => this._tick(), TICK_MS);
  }

  _tick() {
    if (this._disposed) return;
    const now = performance.now();
    const t = this.video.currentTime;

    // Stall detection: PLAYING but currentTime frozen beyond the grace window.
    if (this.state === PlayerState.PLAYING && !this.video.paused && !this.video.ended) {
      if (Math.abs(t - this._lastCurrentTime) < 1e-4) {
        if (now - this._lastProgressAt > STALL_GRACE_MS) {
          this._stallCount++;
          this._stats.stalls++;
          this._transition(PlayerState.BUFFERING);
          this.emit('stall', { currentTime: t, stalls: this._stallCount });
        }
      } else {
        if (now - this._lastProgressAt > this.options.stallTimeoutMs) {
          this._stats.continuityBreaks++;
        }
        this._lastProgressAt = now;
      }
    } else {
      this._lastProgressAt = now;
    }
    this._lastCurrentTime = t;

    // A seek issued before the target was buffered gets pinned by the element
    // at the old position and is not retried automatically. Once the A/V
    // intersection covers the demand anchor, re-issue the seek to complete it.
    if (this.state === PlayerState.SEEKING && this.video.seeking) {
      const intersection = this.getRanges().intersection;
      if (containsTime(intersection, this._demandAnchor)) {
        this.video.currentTime = this._demandAnchor;
      }
    }

    // Resume play once the A/V intersection actually covers the playhead.
    if (this.state === PlayerState.BUFFERING) {
      const intersection = this.getRanges().intersection;
      if (containsTime(intersection, t) && continuousFrom(intersection, t) > 0.25) {
        if (!this.video.paused) {
          this.video.play().then(() => this._transition(PlayerState.PLAYING)).catch(() => {});
        } else {
          this._transition(PlayerState.PAUSED);
        }
      }
    }

    this._enforceHighWatermark().catch((err) => this._fatalNow(err.message, err));
    this._pump();
    this.emit('tick', this.getState());
  }

  // --------------------------------------------------------------- state
  _transition(next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.emit('statechange', { from: prev, to: next });
  }

  _fatalNow(message, cause) {
    if (this.state === PlayerState.ERROR || this._disposed) return;
    this._fatal = { message, cause: cause?.name || null, at: new Date().toISOString() };
    this.downloads.abortAll();
    this._transition(PlayerState.ERROR);
    this.emit('fatal', this._fatal);
  }

  get manifestUrl() {
    return this._manifestUrl;
  }

  // The load() entry stores the base URL for resolving segment paths.
  setManifestUrl(url) {
    this._manifestUrl = url;
  }

  getRanges() {
    const empty = [];
    const video = this.queues.video ? snapshotRanges(this.queues.video.sb.buffered) : empty;
    const audio = this.queues.audio ? snapshotRanges(this.queues.audio.sb.buffered) : empty;
    return {
      video,
      audio,
      intersection: intersectRanges(video, audio),
      playableAhead: this.video
        ? continuousFrom(intersectRanges(video, audio), this.video.currentTime || 0)
        : 0,
      bufferedSeconds: {
        video: totalBuffered(video),
        audio: totalBuffered(audio),
      },
    };
  }

  getQueueView() {
    return {
      appendQueue: this._appendQueue.map((i) => `${i.kind}:${i.index}`),
      inflight: this.downloads.inflightKeys,
      downloaded: [...this._downloaded].sort(),
      appended: [...this._appended].filter((k) => !k.endsWith(':init')).sort(),
      cursor: { ...this._cursor },
      bufferUpdating: Object.fromEntries(
        Object.entries(this.queues).map(([k, q]) => [k, q.updating]),
      ),
    };
  }

  getState() {
    return {
      state: this.state,
      fatal: this._fatal,
      currentTime: this.video?.currentTime ?? 0,
      duration: this.manifest?.durationSec ?? 0,
      readyState: this.video?.readyState ?? 0,
      paused: this.video?.paused ?? true,
      stallCount: this._stallCount,
      stats: { ...this._stats, downloads: this.downloads.stats },
      ranges: this.getRanges(),
      queue: this.getQueueView(),
    };
  }
}
