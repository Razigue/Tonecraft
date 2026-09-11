/**
 * Measures the boost's aliasing.
 *
 * The boost is the only hand-written non-linearity in the chain — the rest of
 * the sound comes from the NAM capture — so it is the only place our own code
 * can fold aliasing back into the audible band, and the whole reason the
 * oversampling and the antiderivative anti-aliasing are there at all.
 *
 * Measured on the shipped chain.wasm itself, through `tc_measure_boost`: a
 * separate instance of the input stage that can be built at any oversampling
 * factor, with or without ADAA, for this table. The live chain always runs
 * what ships (AD-5) and cannot be reached from here.
 *
 * Method: a pure sine goes in; any energy not on a harmonic of it is aliasing.
 * The analysis window's sidelobes must sit below what is measured, so this uses
 * a 7-term Blackman-Harris (around -180 dB) rather than a Hann (-31 dB). Only
 * the audible band counts: what survives above 17 kHz comes from the last
 * decimator's transition band.
 *
 * Usage:  npm run measure
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { instantiateChain } from '../public/dsp/chain-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48_000;

interface MeasureExports {
  memory: WebAssembly.Memory;
  tc_alloc(bytes: number): number;
  tc_free(ptr: number): void;
  tc_measure_boost(stages: number, adaa: number, amount: number, tone: number,
    inPtr: number, outPtr: number, frames: number, reset: number): number;
}

const core = await instantiateChain(fs.readFileSync(path.join(ROOT, 'public/dsp/chain.wasm')));
core.init(SR, 128);
const e = core.exports as unknown as MeasureExports;

/* ---------------------------- spectral tools ----------------------------- */

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]!; re[i] = re[j]!; re[j] = t; t = im[i]!; im[i] = im[j]!; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k]!, ui = im[i + k]!;
        const jr = re[i + k + half]!, ji = im[i + k + half]!;
        const vr = jr * cr - ji * ci, vi = jr * ci + ji * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** 7-term Blackman-Harris. Sidelobes around -180 dB. */
function bh7(N: number): Float64Array {
  const a = [0.27105140069342, 0.43329793923448, 0.21812299954311, 0.06592544638803,
    0.01081174209837, 0.00077658482522, 0.00001388721735];
  const w = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    let s = 0;
    for (let k = 0; k < 7; k++) s += (k % 2 ? -1 : 1) * a[k]! * Math.cos((2 * Math.PI * k * n) / N);
    w[n] = s;
  }
  return w;
}

function aliasDbc(stages: number, adaa: boolean, f0: number): number {
  const H = 32768, WARM = 96000, M = H + WARM;   // 2 s of warm-up: steady state only
  const inPtr = e.tc_alloc(M * 4);
  const outPtr = e.tc_alloc(M * 4);
  const input = new Float32Array(e.memory.buffer, inPtr, M);
  for (let n = 0; n < M; n++) input[n] = 0.5 * Math.sin((2 * Math.PI * f0 * n) / SR);
  // Boost at maximum, tone at the middle of its travel: what the old table used.
  e.tc_measure_boost(stages, adaa ? 1 : 0, 1, 0.5, inPtr, outPtr, M, 1);
  const rec = new Float32Array(e.memory.buffer, outPtr, M).slice();
  e.tc_free(inPtr);
  e.tc_free(outPtr);

  const seg = rec.subarray(WARM), w = bh7(H);
  const re = new Float64Array(H), im = new Float64Array(H);
  for (let i = 0; i < H; i++) re[i] = seg[i]! * w[i]!;
  fft(re, im);

  const df = SR / H, GUARD = 40;
  const isHarmonic = new Uint8Array(H / 2);
  for (let n = 1; n * f0 < SR / 2; n++) {
    const bin = (n * f0) / df;
    for (let b = Math.max(0, Math.floor(bin) - GUARD); b <= Math.ceil(bin) + GUARD && b < H / 2; b++) {
      isHarmonic[b] = 1;
    }
  }
  for (let b = 0; b <= GUARD; b++) isHarmonic[b] = 1;

  let fundamental = 0, worst = 0;
  for (let b = 1; b < H / 2; b++) {
    const m = Math.hypot(re[b]!, im[b]!), f = b * df;
    if (isHarmonic[b] === 1) { if (m > fundamental) fundamental = m; continue; }
    if (f < 17000 && m > worst) worst = m;
  }
  return 20 * Math.log10(worst / fundamental);
}

/* ------------------------------- the table ------------------------------- */

const TONES = [1237, 2311, 3733];
const FACTORS = [1, 2, 4, 8];

console.log('\nBoost aliasing (boost at maximum), out-of-harmonic energy below');
console.log('17 kHz, relative to the fundamental. Measured on public/dsp/chain.wasm.\n');
console.log(`              ${TONES.map((f) => `${f} Hz`.padStart(11)).join('')}`);

const rows: { adaa: boolean; os: number; values: number[] }[] = [];
for (const adaa of [false, true]) {
  for (const os of FACTORS) {
    const values = TONES.map((f) => aliasDbc(Math.log2(os), adaa, f));
    const label = `${adaa ? 'ADAA  x' : 'plain x'}${os}`;
    console.log(`  ${label.padEnd(12)}${values.map((v) => `${v.toFixed(1)} dBc`.padStart(11)).join('')}`);
    rows.push({ adaa, os, values });
  }
}

const shipped = rows.find((r) => r.adaa && r.os === 4)!;
const naive = rows.find((r) => !r.adaa && r.os === 1)!;
const worstShipped = Math.max(...shipped.values);
const worstNaive = Math.max(...naive.values);
console.log(`\n  What ships (ADAA, 4x) : worst case ${worstShipped.toFixed(1)} dBc`);
console.log(`  Naive processing      : worst case ${worstNaive.toFixed(1)} dBc`);
console.log(`  Gained                : ${(worstNaive - worstShipped).toFixed(1)} dB\n`);
