/**
 * Lines up the level of every embedded capture.
 *
 * The captures from pelennor2170/NAM_models carry no `loudness` metadata.
 * Uncorrected, their levels span 8.8 dB — changing capture makes the sound
 * jump, which is unpleasant on a laptop and genuinely unpleasant in headphones.
 *
 * So each model's real level is measured offline, on the shipped chain:
 *
 *     calibrated pink noise -> the input stage, neutral -> NAM model
 *       -> default cabinet -> RMS, read from the cabinet's own meter slot
 *
 * The measurement is taken AFTER the cabinet, because the cabinet is what sets
 * the perceived level: a bright model loses far more to the convolution than a
 * dark one, and a measurement taken before it would rank the models wrongly.
 * The input stage at its neutral settings is a unity gain behind an 18 Hz DC
 * blocker, which is what every capture really receives.
 *
 * The result is written into `public/models/index.json` as `trimDb`.
 *
 * Usage:  npm run calibrate
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { instantiateChain } from '../public/dsp/chain-core.js';
import { PARAMS } from '../schema/params.ts';
import { IR_SLOTS, STAGE_RMS_OFFSET } from '../schema/chain.ts';
import { STAGES } from '../schema/params.ts';
import { cabIR, DEFAULT_CAB } from '../engine/ir.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48_000;
/** Output level aimed for, before the master fader. */
const TARGET_RMS_DB = -18;

const wasm = fs.readFileSync(path.join(ROOT, 'public/dsp/chain.wasm'));
const wire = (id: string): number => PARAMS.findIndex((p) => p.id === id);
const CAB_RMS = STAGE_RMS_OFFSET + STAGES.find((s) => s.id === 'cab')!.meterSlot;
const cab = cabIR(SR, DEFAULT_CAB);

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

/** Level after the cabinet in dB RMS, one second skipped for settling; null if the model fails. */
async function measure(json: string): Promise<number | null> {
  const core = await instantiateChain(wasm);
  core.init(SR, 128);
  for (const [id, v] of Object.entries({
    in_trim: 0, gate_bypass: 1, drive_bypass: 1, tone_bypass: 1, reverb_bypass: 1, out_master: -40,
  })) core.call('tc_set_param', [wire(id), v]);
  core.call('tc_set_ir', [IR_SLOTS.cab], cab);
  if (core.call('tc_load_model', [], new TextEncoder().encode(json)) !== 1) return null;

  let energy = 0, frames = 0;
  for (let at = 0; at + 128 <= testSig.length; at += 128) {
    core.inputs[0]!.set(testSig.subarray(at, at + 128));
    // Every frame covers the same number of samples, so their mean square is the mean.
    if (core.process(128, 1) && at >= SR) {
      energy += core.meters![CAB_RMS]! ** 2;
      frames++;
    }
  }
  return 10 * Math.log10(energy / frames + 1e-30);
}

interface Entry { file: string; name?: string; rmsDb?: number; trimDb?: number }

const indexPath = path.join(ROOT, 'public/models/index.json');
const catalog = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { models: Entry[] };

console.log('\nCalibration (pink noise at -20 dBFS RMS -> model -> V30 Modern cabinet)');
console.log(`Target: ${TARGET_RMS_DB} dBFS RMS\n`);

for (const entry of catalog.models) {
  const rms = await measure(fs.readFileSync(path.join(ROOT, 'public/models', entry.file), 'utf8'));
  if (rms === null) { console.log(`  FAILED  ${entry.file}`); continue; }
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
