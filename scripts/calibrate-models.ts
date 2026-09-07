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
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { makeCabIR, DEFAULT_CAB } from '../engine/ir.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48_000;
/** Output level aimed for, before the master fader. */
const TARGET_RMS_DB = -18;

/* ---------------------- the NAM engine, in a sandbox --------------------- */

const glue = fs.readFileSync(path.join(ROOT, 'public/nam/nam-glue.js'), 'utf8');
const wasm = fs.readFileSync(path.join(ROOT, 'public/nam/nam.wasm'));

interface NamModule {
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _nam_setSampleRate(rate: number): void;
  _nam_setMaxBufferSize(frames: number): void;
  _nam_createInstance(): number;
  _nam_destroyInstance(id: number): void;
  _nam_loadModel(id: number, ptr: number): boolean;
  _nam_reset(id: number): void;
  _nam_process(id: number, inPtr: number, outPtr: number, n: number): void;
  lengthBytesUTF8(s: string): number;
  stringToUTF8(s: string, ptr: number, len: number): void;
  HEAPF32: Float32Array;
}

const sandbox: Record<string, unknown> = {
  WebAssembly, TextDecoder, TextEncoder, Math, Date, console,
  Uint8Array, Int8Array, Int32Array, Uint32Array, Float32Array, Float64Array,
  ArrayBuffer, Object, Array, Error, JSON, String, Number, Promise, Symbol,
  setTimeout, clearTimeout, performance,
};
sandbox['globalThis'] = sandbox;
vm.createContext(sandbox);
vm.runInContext(`${glue}\n;globalThis.__create = createNamModule;`, sandbox);

const create = sandbox['__create'] as (o: { wasmBinary: ArrayBuffer }) => Promise<NamModule>;
const mod = await create({
  wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer,
});
mod._nam_setSampleRate(SR);
mod._nam_setMaxBufferSize(128);

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

const inPtr = mod._malloc(128 * 4), outPtr = mod._malloc(128 * 4);

function runModel(json: string): Float32Array | null {
  const id = mod._nam_createInstance();
  const len = mod.lengthBytesUTF8(json) + 1;
  const ptr = mod._malloc(len);
  mod.stringToUTF8(json, ptr, len);
  const ok = mod._nam_loadModel(id, ptr);
  mod._free(ptr);
  if (!ok) { mod._nam_destroyInstance(id); return null; }

  const N = testSig.length, out = new Float32Array(N);
  mod._nam_reset(id);
  for (let b = 0; b + 128 <= N; b += 128) {
    mod.HEAPF32.set(testSig.subarray(b, b + 128), inPtr >> 2);
    mod._nam_process(id, inPtr, outPtr, 128);
    out.set(mod.HEAPF32.subarray(outPtr >> 2, (outPtr >> 2) + 128), b);
  }
  mod._nam_destroyInstance(id);
  return out;
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
  const json = fs.readFileSync(path.join(ROOT, 'public/models', entry.file), 'utf8');
  const out = runModel(json);
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
