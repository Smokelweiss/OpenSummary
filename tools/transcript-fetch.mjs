#!/usr/bin/env node
/**
 * Pulls a real YouTube transcript and writes a timecoded file for `bench.mjs`.
 *
 * Routes, in order (the same order the extension uses):
 *   1. web watch page caption track (plain URL, works when the track is not
 *      PO-token protected);
 *   2. legacy /timedtext;
 *   3. InnerTube ANDROID/IOS player → track without PO-token.
 *
 * Today (2026-10) the web track of most videos is PO-protected and the
 * InnerTube routes are ASR tracks that respond from this route. If every route
 * answers POT_REQUIRED, capture the transcript in the page context of a real
 * browser session on that machine (same origin, cookies, visitorData):
 * InnerTube `player` with clientName=ANDROID → captionTracks[0].baseUrl with
 * fmt=json3 → parse events (tStartMs/tDurationMs + segs.utf8), save
 * {start,dur,text} in milliseconds and let this file convert and trim them.
 *
 *   node tools/transcript-fetch.mjs VIDEO_ID [out.txt]
 *   npm run bench -- --live --transcript=out.txt
 */
import { writeFileSync } from 'node:fs';
import {
  getTranscript,
  getVideoData,
  fetchTimedText,
} from '../src/transcript/youtube.js';

const videoId = process.argv[2] || '';
const outPath = process.argv[3] || 'bench-transcript.txt';
if (!/^[\w-]{6,20}$/.test(videoId)) {
  console.error('usage: node tools/transcript-fetch.mjs VIDEO_ID [out.txt]');
  process.exit(2);
}

const fmt = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
};

async function main() {
  try {
    // Whole production path: page → InnerTube → timedtext/format fallbacks.
    const res = await getTranscript(videoId, { hl: 'en', onStage: (s) => console.error('stage:', s.stage || '') });
    const lines = res.segments.map((s) => `[${fmt(s.start)}] ${String(s.text).replace(/\s+/g, ' ').trim()}`);
    writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
    const words = res.segments.reduce((a, s) => a + String(s.text || '').split(/\s+/).filter(Boolean).length, 0);
    console.log(`ok: ${res.segments.length} segments, ${words} words -> ${outPath}`);
    return;
  } catch (err) {
    console.error(`production routes failed: ${err?.code || ''} ${err?.message || err}`.trim());
  }

  // The player data is still useful: a non-PO track from an app client works
  // even when the web track does not.
  try {
    const video = await getVideoData(videoId, { hl: 'en' });
    const track = (video.tracks || []).find((t) => !/potc=|pot=/.test(t.baseUrl || ''));
    if (!track) throw new Error('POT_REQUIRED: every known track is PO-token protected');
    const body = await fetchTimedText(track, { fmt: 'json3' });
    // parseTimedText applied the production trim (rolling captions) already.
    const segments = body.segments || [];
    const lines = segments.map((s) => `[${fmt(s.start)}] ${String(s.text).replace(/\s+/g, ' ').trim()}`);
    writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
    console.log(`ok (app-client track): ${lines.length} lines -> ${outPath}`);
  } catch (err) {
    console.error(`fallback failed: ${err?.message || err}`);
    console.error('See the file header for the browser page-context recipe.');
    process.exit(1);
  }
}

await main();
