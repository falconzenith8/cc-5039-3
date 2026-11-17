// Helpers over TimeRanges. The browser's buffered ranges are the single source
// of truth for "what is actually playable": downloaded bytes that failed to
// decode never appear here and must not be counted as playable.
export const snapshotRanges = (timeRanges) => {
  if (!timeRanges) return [];
  const out = [];
  for (let i = 0; i < timeRanges.length; i++) {
    out.push({ start: timeRanges.start(i), end: timeRanges.end(i) });
  }
  return out;
};

export const containsTime = (ranges, t) =>
  ranges.some((r) => t + 1e-6 >= r.start && t - 1e-6 <= r.end);

// Length of continuous buffered coverage starting at (or before) time t.
// Returns 0 when nothing around t is buffered.
export const continuousFrom = (ranges, t) => {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let cursor = t;
  let found = false;
  for (const r of sorted) {
    if (r.end < t) continue;
    if (r.start > cursor + 0.25) break; // gap larger than typical audio frame
    cursor = Math.max(cursor, r.end);
    found = true;
  }
  return found ? Math.max(0, cursor - t) : 0;
};

export const totalBuffered = (ranges) =>
  ranges.reduce((sum, r) => sum + (r.end - r.start), 0);

// Merge overlapping/adjacent ranges for timeline rendering.
export const mergeRanges = (ranges) => {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 0.05) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
};

// Intersection of two track's ranges — the A/V region that can actually play.
export const intersectRanges = (a, b) => {
  const out = [];
  for (const ra of a) {
    for (const rb of b) {
      const start = Math.max(ra.start, rb.start);
      const end = Math.min(ra.end, rb.end);
      if (end - start > 1e-6) out.push({ start, end });
    }
  }
  return mergeRanges(out);
};

// Compute the prefix [0, cut) that is safe to evict, never crossing into the
// current play position's guard window. A range fully before keepFrom is
// removed entirely; a range straddling keepFrom is cut exactly at keepFrom so
// the retained tail still covers the playhead.
export const evictablePrefix = (ranges, keepFrom) => {
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    if (r.end <= keepFrom) continue; // whole range is old; keep scanning
    if (r.start < keepFrom) return keepFrom; // straddling range: cut at the guard line
    return r.start; // next range begins after the guard line
  }
  return keepFrom;
};
