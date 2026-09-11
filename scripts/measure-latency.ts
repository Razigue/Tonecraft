/**
 * What the chain itself adds, in samples.
 *
 * The round trip on screen is dominated by the operating system and the
 * device — or, under Tonecraft Engine, by the ASIO buffer the player chose.
 * This measures the part that is ours, on the shipped chain.wasm, the same
 * file both hosts run:
 *
 *   1. the whole chain, at its neutral settings, with an impulse: where the
 *      peak comes out. The cabinet and reverb convolvers, the correction
 *      biquads and the limiter are all in there, and all at zero.
 *   2. the boost's oversampler alone, with a burst, by cross-correlation. It
 *      is the one stage with a group delay of its own: a few samples at 4x.
 *
 * There used to be a third part, through Chromium's own nodes: a WaveShaperNode
 * at 4x delayed by 192 frames, which is how the limiter came to live in the
 * chain. No browser node is left between the input and the output, so there
 * is nothing left in a browser to measure.
 *
 * Usage:  npm run measure:latency
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { instantiateChain } from '../public/dsp/chain-core.js';
import { PARAMS } from '../schema/params.ts';
import { IR_SLOTS } from '../schema/chain.ts';
import { cabIR, DEFAULT_CAB } from '../engine/ir.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48_000;
const wasm = fs.readFileSync(path.join(ROOT, 'public/dsp/chain.wasm'));
const wire = (id: string): number => PARAMS.findIndex((p) => p.id === id);

interface MeasureExports {
  memory: WebAssembly.Memory;
  tc_alloc(bytes: number): number;
  tc_free(ptr: number): void;
  tc_measure_boost(stages: number, adaa: number, amount: number, tone: number,
    inPtr: number, outPtr: number, frames: number, reset: number): number;
}

async function chainImpulse(cab: 'identity' | 'shipped'): Promise<number> {
  const core = await instantiateChain(wasm);
  core.init(SR, 128);
  for (const [id, v] of Object.entries({
    in_trim: 0, gate_bypass: 1, drive_bypass: 1, tone_bypass: 1, reverb_bypass: 1, out_master: -20,
  })) core.call('tc_set_param', [wire(id), v]);
  core.call('tc_set_ir', [IR_SLOTS.cab], cab === 'identity' ? new Float32Array([1]) : cabIR(SR, DEFAULT_CAB));
  const x = new Float32Array(SR);
  x[SR / 2] = 0.25;   // after half a second: every parameter has arrived where it was sent
  const y = new Float32Array(SR);
  for (let at = 0; at < SR; at += 128) {
    core.inputs[0]!.set(x.subarray(at, at + 128));
    core.process(128, 1);
    y.set(core.output!.subarray(0, 128), at);
  }
  let peak = 0;
  for (let i = 0; i < y.length; i++) if (Math.abs(y[i]!) > Math.abs(y[peak]!)) peak = i;
  return peak - SR / 2;
}

/** Delay through the boost path, in samples, by cross-correlation. */
async function boostLatency(amount: number): Promise<number> {
  const core = await instantiateChain(wasm);
  core.init(SR, 128);
  const e = core.exports as unknown as MeasureExports;
  const WARM = 128 * 400, N = 128 * 40, M = WARM + N;
  const inPtr = e.tc_alloc(M * 4), outPtr = e.tc_alloc(M * 4);
  const input = new Float32Array(e.memory.buffer, inPtr, M);
  input.fill(0);
  const x = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    // A quiet burst: the stage must stay linear for the correlation to mean a delay.
    x[n] = n > 2000 && n < 3000 ? 0.001 * Math.sin(2 * Math.PI * 1000 * n / SR) : 0;
    input[WARM + n] = x[n]!;
  }
  e.tc_measure_boost(2, 1, amount, 1, inPtr, outPtr, M, 1);
  const y = new Float32Array(e.memory.buffer, outPtr, M).slice(WARM);
  e.tc_free(inPtr);
  e.tc_free(outPtr);
  const corr = (l: number): number => {
    let s = 0;
    for (let n = 2000; n < 3100; n++) { const m = n + l; if (m >= 0 && m < N) s += x[n]! * y[m]!; }
    return s;
  };
  let best = -Infinity, lag = 0;
  for (let l = -5; l < 200; l++) { const s = corr(l); if (s > best) { best = s; lag = l; } }
  const a = corr(lag - 1), b = corr(lag), c = corr(lag + 1);
  const frac = (a - c) / (2 * (a - 2 * b + c));
  return lag + (Number.isFinite(frac) ? frac : 0);
}

const ms = (frames: number): string =>
  `${frames.toFixed(1).padStart(6)} frames = ${((frames / SR) * 1000).toFixed(2).padStart(5)} ms at 48 kHz`;

console.log('\nThe chain, impulse in, peak out (public/dsp/chain.wasm):\n');
console.log(`  ${'identity cabinet, everything else neutral'.padEnd(52)} ${ms(await chainImpulse('identity'))}`);
console.log(`  ${'the shipped cabinet (minimum phase: peak at once)'.padEnd(52)} ${ms(await chainImpulse('shipped'))}`);
console.log('\nThe boost path (the 4x oversampler):\n');
console.log(`  ${'boost off (bypassed)'.padEnd(52)} ${ms(await boostLatency(0))}`);
console.log(`  ${'boost at 5% (linear, the oversampler alone)'.padEnd(52)} ${ms(await boostLatency(0.05))}`);
console.log();
