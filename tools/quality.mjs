#!/usr/bin/env node
/**
 * Deterministic quality/speed report for the parts of the pipeline that can be
 * measured without a model or the network:
 *
 *   - the chunker: chunk boundaries against known topic changes, and how much
 *     text is sent to the model twice because of overlap.

 * The non-AI summariser was removed in 1.6.0; its lead/heading report went with
 * it, and what remains is the part of the pipeline that is still measurable
 * offline.
 *
 * The transcript is synthetic but labelled: every sentence belongs to a known
 * topic, and filler lines ("you are going to hear…") imitate spoken captions.
 * That makes “a heading made of pronouns” and “a chunk boundary inside a topic”
 * measurable numbers instead of opinions. It is not a substitute for a real
 * video fixture — nothing here proves YouTube or a provider works.
 *
 *   npm run quality
 *   npm run quality -- --json
 */

import { buildBlocks, buildChunks, estimateTokens, topicBoundaries } from '../src/ai/chunking.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value === undefined ? true : value];
  }),
);

/**
 * Topic vocabulary. Each topic is a short newsy passage; the filler lines are
 * exactly the kind of throat-clearing that used to become the TL;DR.
 */
const TOPICS = [
  {
    id: 'court',
    lines: [
      'The court sealed the case files after the prosecutor asked for a delay.',
      'The judge said the documents will stay closed until the appeal is heard.',
      'Lawyers for the defendant filed a motion to unseal the record.',
      'The prosecutor argued the witnesses could be endangered by publication.',
      'A second hearing is scheduled for March in the same courthouse.',
    ],
  },
  {
    id: 'bank',
    lines: [
      'The bank reported a loss of 300 million dollars in the third quarter.',
      'Regulators fined the bank for failing to report suspicious transfers.',
      'The bank said it will close forty branches before the end of the year.',
      'Depositors moved their savings to smaller regional lenders.',
      'The finance ministry asked for a review of the bank licence.',
    ],
  },
  {
    id: 'agency',
    lines: [
      'The intelligence agency denied any connection to the consulting firm.',
      'A former officer described the meeting in a sworn statement.',
      'The agency refused to confirm the name of the station chief.',
      'The oversight committee requested the internal audit report.',
      'The report names three companies and two foreign banks.',
    ],
  },
  {
    id: 'election',
    lines: [
      'The election commission certified the results after a recount.',
      'Turnout in the northern districts was higher than in the previous vote.',
      'Two candidates challenged the count in the regional court.',
      'The observers said the ballot boxes were sealed correctly.',
      'The new parliament convenes for the first session in April.',
    ],
  },
  {
    id: 'climate',
    lines: [
      'The climate panel measured a record temperature in the Arctic.',
      'Ice loss accelerated over the last two decades, the report says.',
      'Coastal cities are testing flood barriers ahead of the storm season.',
      'The ministry promised funding for the restoration of the wetlands.',
      'Researchers warn that the groundwater level keeps falling.',
    ],
  },
  {
    id: 'software',
    lines: [
      'The engineering team replaced the cache with a smaller in-memory store.',
      'Response time dropped from 800 to 40 milliseconds after the change.',
      'The database migration removed the duplicate index on the orders table.',
      'A regression test caught the broken pagination before the release.',
      'The next sprint will cover the export format and the retention policy.',
    ],
  },
  {
    id: 'hospital',
    lines: [
      'The hospital opened a second emergency ward for the winter season.',
      'Nurses reported a shortage of beds in the paediatric department.',
      'The health ministry promised extra funding for rural clinics.',
      'Doctors asked patients to book vaccinations before the end of October.',
    ],
  },
  {
    id: 'airline',
    lines: [
      'The airline cancelled sixty flights because of the storm warning.',
      'Passengers waited at the terminal while the crew checked the runway.',
      'The carrier offered refunds and hotel rooms for the stranded travellers.',
      'Airport staff reopened two gates after the wind dropped.',
    ],
  },
  {
    id: 'university',
    lines: [
      'The university senate approved a new programme in applied statistics.',
      'Tuition for the evening courses will rise by four percent next year.',
      'Students protested the closure of the campus library on Sundays.',
      'The rector promised to publish the budget before the spring term.',
    ],
  },
  {
    id: 'factory',
    lines: [
      'The factory will retool the assembly line for electric motors.',
      'Union representatives negotiated a retraining plan for the workers.',
      'The plant manager said production resumes in the second quarter.',
      'Local suppliers expect orders for cables and sensors to grow.',
    ],
  },
];

/** Spoken filler: no facts, but high word frequency and many pronouns. */
const FILLER = [
  "You're going to hear a lot of things in this interview.",
  'They are saying the same thing again and again.',
  'You are watching the second part of the conversation.',
  'They are not telling you what the documents actually contain.',
  "You're going to see how the story developed over the year.",
  'We are going to talk about all of that in a moment.',
];

const FILLER_EVERY = 6;

function syntheticTranscript() {
  const segments = [];
  const label = []; // topic id per segment
  let at = 0;
  let n = 0;
  // Three rounds: a long video returns to the same topics, which is exactly
  // where a size-only chunker splits an argument and a heading list repeats.
  for (let round = 0; round < 3; round++) {
    for (const topic of TOPICS) {
      // Each topic runs for ~40 segments (3-4 minutes) — like a section of a
      // real long video, so a 30-second block is much shorter than a topic.
      for (let pass = 0; pass < 10; pass++) {
        for (const line of topic.lines) {
          segments.push({ start: at, dur: 5, text: line });
          label.push(topic.id);
          at += 5;
          n++;
          if (n % FILLER_EVERY === 0) {
            segments.push({ start: at, dur: 5, text: FILLER[(n / FILLER_EVERY) % FILLER.length] });
            label.push('filler');
            at += 5;
          }
        }
      }
    }
  }
  return { segments, label };
}

/**
 * Chunk boundaries are compared to the known topic of every block. A boundary
 * that falls where the topic changes keeps a topic inside one request; a
 * boundary in the middle of a topic splits one argument across two requests.
 */
const TOPIC_WORDS = {
  court: /\b(court|judge|prosecutor|appeal|hearing|courthouse)\b/i,
  bank: /\b(bank|depositors|branch|regulators|lenders|ministry)\b/i,
  agency: /\b(agency|officer|station chief|oversight|audit|companies)\b/i,
  election: /\b(election|turnout|ballot|candidates|parliament|vote)\b/i,
  climate: /\b(climate|arctic|ice|flood|wetlands|groundwater)\b/i,
  software: /\b(engineering|cache|database|regression|sprint|response time)\b/i,
  filler: /^(you|they|we)\b/i,
};

function topicOf(text) {
  const scores = Object.entries(TOPIC_WORDS).map(([id, re]) => [id, (String(text).match(new RegExp(re.source, 'gi')) || []).length]);
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 ? scores[0][0] : 'unknown';
}

function chunkReport(segments, label, maxTokens, { semantic = true, overlapBlocks = 1 } = {}) {
  const blocks = buildBlocks(segments);
  const chunks = buildChunks(segments, { maxTokens, semantic, overlapBlocks });
  // The block that has no topic word of its own belongs to the previous topic.
  const blockTopic = [];
  for (const block of blocks) {
    const id = topicOf(block.text);
    blockTopic.push(id === 'unknown' || id === 'filler' ? blockTopic[blockTopic.length - 1] || id : id);
  }
  let boundaries = 0;
  let onTopicChange = 0;
  const indexOfBlock = (block) => blocks.findIndex((b) => b.at === block.at && b.text === block.text);
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1].blocks;
    const next = chunks[i].blocks;
    const prevTopic = blockTopic[indexOfBlock(prev[prev.length - 1])];
    const nextTopic = blockTopic[indexOfBlock(next[0])];
    if (prevTopic == null || nextTopic == null) continue;
    boundaries++;
    if (prevTopic !== nextTopic) onTopicChange++;
  }
  if (args.debug) {
    const bounds = topicBoundaries(blocks);
    console.log(`\n[debug] maxTokens ${maxTokens}`);
    console.log(`  block topics: ${blockTopic.join(' ')}`);
    console.log(`  detected boundaries: ${[...bounds].join(' ')}`);
    console.log(`  cuts: ${chunks.map((c) => `${Math.round(c.startAt / 60)}min:${c.cut}@${blockTopic[indexOfBlock(c.blocks[0])] || '?'}`).join(' ')}`);
  }
  const sent = chunks.reduce((a, c) => a + c.tokens, 0);
  const unique = new Set(chunks.flatMap((c) => c.blocks.map((b) => b.at))).size;
  const uniqueTokens = chunks
    .flatMap((c) => c.blocks)
    .filter((b, i, list) => list.findIndex((x) => x.at === b.at) === i)
    .reduce((a, b) => a + b.tokens, 0);
  return {
    maxTokens,
    blocks: blocks.length,
    chunks: chunks.length,
    boundaryOnTopicChange: boundaries ? Number((onTopicChange / boundaries).toFixed(2)) : null,
    overlapTokenShare: sent ? Number(((sent - uniqueTokens) / sent).toFixed(3)) : 0,
    tokensSent: sent,
    transcriptTokens: estimateTokens(segments.map((s) => s.text).join(' ')),
    coveredBlocks: unique,
  };
}

const { segments, label } = syntheticTranscript();
const chunkSmall = chunkReport(segments, label, 3000);
const chunkLarge = chunkReport(segments, label, 6000);
const oldSmall = chunkReport(segments, label, 3000, { semantic: false, overlapBlocks: 2 });
const oldLarge = chunkReport(segments, label, 6000, { semantic: false, overlapBlocks: 2 });
// Same overlap one block, size-only: the fair comparison for the semantic cut.
const sizeSmall = chunkReport(segments, label, 3000, { semantic: false, overlapBlocks: 1 });
const sizeLarge = chunkReport(segments, label, 6000, { semantic: false, overlapBlocks: 1 });

if (args.json) {
  console.log(JSON.stringify({ segments: segments.length, chunkSmall, chunkLarge, oldSmall, oldLarge, sizeSmall, sizeLarge }, null, 2));
} else {
  const line = (k, v) => console.log(`  ${String(k).padEnd(26)} ${v}`);
  console.log(`
Chunking — ${segments.length} segments`);
  const pct = (value) => (value == null ? 'n/a' : `${Math.round(value * 100)}%`);
  for (const [report, old, size] of [[chunkSmall, oldSmall, sizeSmall], [chunkLarge, oldLarge, sizeLarge]]) {
    console.log(`
maxTokens ${report.maxTokens}`);
    line('blocks', report.blocks);
    line('chunks semantic/size-only', `${report.chunks} / ${size.chunks} (old default ${old.chunks})`);
    line('boundaries on a topic change', `${pct(report.boundaryOnTopicChange)} / ${pct(size.boundaryOnTopicChange)} (old ${pct(old.boundaryOnTopicChange)})`);
    line('rescanned tokens', `${pct(report.overlapTokenShare)} / ${pct(size.overlapTokenShare)} (old ${pct(old.overlapTokenShare)})`);
    line('tokens sent', `${report.tokensSent} / ${size.tokensSent} (old ${old.tokensSent}, transcript ${report.transcriptTokens})`);
  }
  console.log('');
}
