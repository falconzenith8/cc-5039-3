// Generates public/media/manifest.json for the WebM (VP9/Opus) segmented asset.
// Segment timeStart values come from parsing each chunk's EBML Cluster/Block
// timestamps; durations are the difference to the next chunk's start, with the
// final chunk ending at the known asset duration. This keeps the manifest
// truthful about audio priming and non-integer boundaries.
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeWebm } from './webm-probe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mediaDir = join(here, '..', 'public', 'media');
const durationSec = 60;

const listChunks = (kind) =>
  readdirSync(join(mediaDir, kind))
    .filter((f) => f.endsWith('.webm') && f !== 'init.webm')
    .sort();

const buildTrack = (kind) => {
  const files = listChunks(kind);
  if (!files.length) throw new Error(`no chunks found for ${kind}`);
  const starts = files.map((f) => probeWebm(join(mediaDir, kind, f)).firstBlockSec);
  const segments = files.map((file, i) => {
    const timeStart = Number(starts[i].toFixed(6));
    const nextStart = i + 1 < starts.length ? starts[i + 1] : durationSec;
    const timeEnd = Number(nextStart.toFixed(6));
    return {
      index: i,
      url: `${kind}/${file}`,
      timeStart,
      duration: Number((timeEnd - timeStart).toFixed(6)),
      timeEnd,
    };
  });
  return {
    kind,
    initUrl: `${kind}/init.webm`,
    segmentUrlTemplate: `${kind}/${kind}-{index:05}.webm`,
    segments,
  };
};

const video = buildTrack('video');
const audio = buildTrack('audio');

const manifest = {
  version: 1,
  container: 'webm',
  generatedAt: new Date().toISOString(),
  durationSec,
  mimeType: {
    video: 'video/webm; codecs="vp9"',
    audio: 'audio/webm; codecs="opus"',
  },
  tracks: { video, audio },
};

for (const track of [video, audio]) {
  readFileSync(join(mediaDir, track.initUrl));
  for (const seg of track.segments) readFileSync(join(mediaDir, seg.url));
  const last = track.segments.at(-1);
  if (Math.abs(last.timeEnd - durationSec) > 0.05) {
    throw new Error(`${track.kind} ends at ${last.timeEnd}, expected ${durationSec}`);
  }
}

writeFileSync(join(mediaDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `manifest: video=${video.segments.length} segs (start ${video.segments[0].timeStart}s), ` +
    `audio=${audio.segments.length} segs (start ${audio.segments[0].timeStart}s, end ${audio.segments.at(-1).timeEnd}s)`,
);
