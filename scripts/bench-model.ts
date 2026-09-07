/**
 * What the amp costs, as a share of one core.
 *
 * This is the number that decides whether the product is playable. In an
 * AudioWorklet the quantum is fixed at 128 frames, so there is no dial that
 * trades latency for CPU: going over budget does not produce lateness, it
 * produces a dropout, and dropouts are what make a player put the guitar down.
 *
 * Two things about the method, both learned the hard way on the floor machine:
 *
 * - **Interleaved, minimum of several runs.** A 2017 U-series laptop settles
 *   about 40 % below its turbo within seconds of sustained load, and stays
 *   there. A sequential A/B ranks builds by the order they ran in. Alternating
 *   and keeping the fastest run of each removes that — for *comparisons*. It
 *   does nothing for the absolute number, which on this class of machine moves
 *   by a factor of 1.8 between a cold laptop and a warm one. Both are real; the
 *   warm one is the one a player lives in. Say which you measured.
 * - **128-frame blocks, the size the audio thread is actually handed.** Larger
 *   blocks amortise the per-call work and flatter the result.
 *
 * Usage:  npm run bench:model
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Model } from '../render/model.ts';
import { readWav } from '../render/wav-read.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48_000;
const SECONDS = 2;
const ROUNDS = 7;
/** PRODUCT.md section 5, for the whole chain. */
const BUDGET = 25;

const di = readWav(path.join(ROOT, 'public/di/demo-di.wav')).data;
const model = await Model.load();
const N = model.blockFrames;
const signal = di.slice(SR, SR + N);
const blocks = Math.floor((SECONDS * SR) / N);

const files = fs.readdirSync(path.join(ROOT, 'public/models')).filter((f) => f.endsWith('.tcnm')).sort();
const best = new Map<string, number>();

for (const f of files) {
  model.loadBlob(path.join(ROOT, 'public/models', f));
  best.set(f, Infinity);
}

// Warm, then alternate: every capture is measured in every round.
for (const f of files) {
  model.loadBlob(path.join(ROOT, 'public/models', f));
  for (let i = 0; i < 400; i++) model.render(signal);
}
for (let r = 0; r < ROUNDS; r++) {
  for (const f of files) {
    model.loadBlob(path.join(ROOT, 'public/models', f));
    for (let i = 0; i < 200; i++) model.render(signal);      // settle after the load
    const t0 = performance.now();
    for (let i = 0; i < blocks; i++) model.render(signal);
    const pct = (performance.now() - t0) / (SECONDS * 10);
    if (pct < best.get(f)!) best.set(f, pct);
  }
}

console.log(`\nAmp cost — ${N}-frame blocks, best of ${ROUNDS} interleaved ${SECONDS} s runs\n`);
for (const [f, pct] of best) {
  const over = pct > BUDGET ? '  over budget' : '';
  console.log(`  ${f.replace(/\.tcnm$/, '').padEnd(38)} ${pct.toFixed(1).padStart(6)} % of one core${over}`);
}
console.log(`\n  budget for the whole chain: ${BUDGET} %\n`);
