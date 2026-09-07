/**
 * Lines up the level of every embedded capture.
 *
 * The captures from pelennor2170/NAM_models carry no `loudness` metadata.
 * Uncorrected, their levels span 8.8 dB — changing capture makes the sound
 * jump, which is unpleasant on a laptop and genuinely unpleasant in headphones.
 *
 * So each model's real level is measured offline:
 *
 *     calibrated pink noise -> NAM model -> default cabinet IR -> RMS
 *
 * The measurement is taken AFTER the cabinet, because the cabinet is what sets
 * the perceived level: a bright model loses far more to the convolution than a
 * dark one, and a measurement taken before it would rank the models wrongly.
 *
 * The result is written into `public/models/index.json` as `trimDb`.
 *
 * Usage:  npm run calibrate
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCabIR, DEFAULT_CAB } from '../engine/ir.ts';
import { Model } from '../render/model.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48_000;
/** Output level aimed for, before the master fader. */
const TARGET_RMS_DB = -18;

/* ------------------------------- the engine ------------------------------ */
/* The same module the audio thread runs, through the same exports: a trim
   measured against a different engine would be a trim for a sound nobody
   hears. */

const model = await Model.load();

/* ------------------------------ the cabinet ------------------------------ */
/* engine/ir.ts uses only `createBuffer` and `sampleRate` off the audio
   context, so a minimal stand-in is enough to run it outside a browser. */
const fakeCtx = {
  sampleRate: SR,
  createBuffer(ch: number, len: number) {
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, length: len, getChannelData: (i: number) => data[i]! };
  },
} as unknown as BaseAudioContext;
const cab = makeCabIR(fakeCtx, DEFAULT_CAB).getChannelData(0);

/* ------------------------------ test signal ------------------------------ */
/* Pink noise (a simplified Voss-McCartney): its spectrum is close to a musical
   signal, which makes it far more representative than a sine for measuring a
   perceived level. */
function pinkNoise(n: number, rmsDb: number): Float32Array {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const w = seed / 0x3fffffff - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  let e = 0; for (let i = 0; i < n; i++) e += out[i]! * out[i]!;
  const g = Math.pow(10, rmsDb / 20) / Math.sqrt(e / n);
  for (let i = 0; i < n; i++) out[i]! *= g;
  return out;
}

/** A guitar at line level, once the player has set the trim sensibly. */
const testSig = pinkNoise(SR * 4, -20);

function runModel(blobPath: string): Float32Array | null {
  try {
    model.loadBlob(blobPath);
  } catch (error) {
    console.log(`  ${String((error as Error).message)}`);
    return null;
  }
  return model.render(testSig);
}

/** Direct convolution: slow but unambiguous, and it runs once per model. */
function convolveRmsDb(x: Float32Array, h: Float32Array, skip: number): number {
  const M = h.length, N = x.length;
  let e = 0, count = 0;
  for (let i = skip; i < N; i++) {
    let s = 0;
    const kmax = i < M ? i + 1 : M;
    for (let k = 0; k < kmax; k++) s += h[k]! * x[i - k]!;
    e += s * s; count++;
  }
  return 10 * Math.log10(e / count + 1e-30);
}

/* -------------------------------- measure -------------------------------- */

interface Entry { file: string; name?: string; rmsDb?: number; trimDb?: number }

const indexPath = path.join(ROOT, 'public/models/index.json');
const catalog = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { models: Entry[] };

console.log('\nCalibration (pink noise at -20 dBFS RMS -> model -> V30 Modern cabinet)');
console.log(`Target: ${TARGET_RMS_DB} dBFS RMS\n`);

for (const entry of catalog.models) {
  const out = runModel(path.join(ROOT, 'public/models', entry.file));
  if (out === null) { console.log(`  FAILED  ${entry.file}`); continue; }
  const rms = convolveRmsDb(out, cab, SR);        // one second skipped: settling
  entry.rmsDb = Math.round(rms * 100) / 100;
  entry.trimDb = Math.round((TARGET_RMS_DB - rms) * 10) / 10;
  console.log(`  ${(entry.name ?? entry.file).padEnd(34)}measured ${rms.toFixed(1).padStart(7)} dB   ->  trim ` +
    `${entry.trimDb >= 0 ? '+' : ''}${entry.trimDb.toFixed(1)} dB`);
}

fs.writeFileSync(indexPath, `${JSON.stringify(catalog, null, 2)}\n`);
const levels = catalog.models.map((e) => e.rmsDb ?? 0);
const spread = Math.max(...levels) - Math.min(...levels);
console.log(`\nLevel spread between models before correction: ${spread.toFixed(1)} dB`);
console.log('public/models/index.json updated.\n');
