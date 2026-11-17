// Minimal EBML/WebM reader: enough to extract Cluster timecode and block
// timestamps from ffmpeg-produced webm_chunk segments so the manifest can
// record each segment's real timeStart/duration instead of assuming 1.0s.
import { readFileSync } from 'node:fs';

// Element IDs we care about (full EBML ID bytes).
const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMESCALE: 0x2ad7b1,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
};

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = 0;
  }

  // VINT: leading marker bit determines width; numeric value excludes it.
  vint(pos, keepMarker = false) {
    const first = this.buf[pos];
    let width = 0;
    for (let mask = 0x80; mask; mask >>= 1) {
      width++;
      if (first & mask) break;
    }
    let value = keepMarker ? first : first ^ (0x80 >> (width - 1));
    for (let i = 1; i < width; i++) value = value * 256 + this.buf[pos + i];
    return { value, width };
  }

  element(pos) {
    const start = pos;
    const { value: id, width: idLen } = this.vint(pos, true);
    const sizeInfo = this.vint(pos + idLen, false);
    const headerLen = idLen + sizeInfo.width;
    const dataStart = start + headerLen;
    return { id, dataStart, end: dataStart + sizeInfo.value, headerLen, next: start + headerLen + sizeInfo.value };
  }

  uint(pos, end) {
    let v = 0;
    for (let i = pos; i < end; i++) v = v * 256 + this.buf[i];
    return v;
  }

  float(pos, end) {
    if (end - pos === 4) return this.view.getFloat32(pos);
    if (end - pos === 8) return this.view.getFloat64(pos);
    return 0;
  }
}

// Walk the children of an element; returns top-level element list.
function children(r, start, end) {
  const out = [];
  let p = start;
  while (p < end) {
    const el = r.element(p);
    if (!el.id || el.end > end) break;
    out.push(el);
    p = el.next;
  }
  return out;
}

// Read the first block's relative timestamp (track varint then int16 delta).
function blockTimestamp(r, dataStart) {
  const track = r.vint(dataStart); // track number
  const relPos = dataStart + track.width;
  return r.view.getInt16(relPos); // int16 big-endian
}

export function probeWebm(filePath) {
  const r = new Reader(readFileSync(filePath));
  const top = children(r, 0, r.buf.length);
  const segment = top.find((e) => e.id === ID.SEGMENT);
  // webm_chunk media files are bare Cluster elements; the Segment shell with
  // Info/timecodeScale lives in the init header.
  const containerKids = segment ? children(r, segment.dataStart, segment.end) : top;

  let timecodeScale = 1_000_000; // ns per tick, default 1ms
  const info = containerKids.find((e) => e.id === ID.INFO);
  if (info) {
    for (const e of children(r, info.dataStart, info.end)) {
      if (e.id === ID.TIMESCALE) timecodeScale = r.uint(e.dataStart, e.end);
    }
  }

  let clusterTimecode = null;
  let firstBlockTick = null;
  let lastBlockEndTick = null;
  for (const e of containerKids) {
    if (e.id !== ID.CLUSTER) continue;
    let clusterTc = 0;
    const cKids = children(r, e.dataStart, e.end);
    for (const c of cKids) {
      if (c.id === ID.TIMECODE) {
        clusterTc = r.uint(c.dataStart, c.end);
        if (clusterTimecode === null) clusterTimecode = clusterTc;
      } else if (c.id === ID.SIMPLE_BLOCK) {
        const rel = blockTimestamp(r, c.dataStart);
        const tick = clusterTc + rel;
        if (firstBlockTick === null || tick < firstBlockTick) firstBlockTick = tick;
        // Approximate block end as next block start; refined by caller via neighbor.
        lastBlockEndTick = tick;
      } else if (c.id === ID.BLOCK_GROUP) {
        const block = children(r, c.dataStart, c.end).find((b) => b.id === ID.BLOCK);
        if (block) {
          const rel = blockTimestamp(r, block.dataStart);
          const tick = clusterTc + rel;
          if (firstBlockTick === null || tick < firstBlockTick) firstBlockTick = tick;
          lastBlockEndTick = tick;
        }
      }
    }
  }
  const tickToSec = (tick) => (tick * timecodeScale) / 1_000_000_000;
  return {
    timecodeScale,
    firstBlockSec: firstBlockTick === null ? null : tickToSec(firstBlockTick),
    firstTick: firstBlockTick,
  };
}
