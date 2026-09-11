/**
 * How long the whole chain takes per render quantum.
 *
 * Runs public/dsp/chain.wasm on the default preset — the shipped capture, the
 * default cabinet, the reverb — 128 frames at a time, exactly as the worklet
 * does, and reports the time per block. The budget is one quantum: 2.67 ms at
 * 48 kHz. Exceeding it is not latency, it is a crackle (NFR-1), and CLAUDE.md
 * caps the chain at a quarter of a core on a 2020 laptop.
 *
 * The native engine runs the same file through wasmtime; `service/` prints its
 * own figure with `tonecraft-engine render`, and the two should be close.
 *
 * Usage:  npm run bench
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { instantiateChain, type ChainCore } from '../public/dsp/chain-core.js';
import { PARAMS } from '../schema/params.ts';
import { IR_SLOTS } from '../schema/chain.ts';
import { cabIR, reverbIR, DEFAULT_CAB } from '../engine/ir.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48_000;
const BLOCKS = 6000;
const QUANTUM_US = (128 / SR) * 1e6;

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/index.json'), 'utf8')) as {
  models: { file: string; name: string; trimDb: number }[];
};
const capture = catalog.models[0];
if (capture === undefined) { console.error('no capture installed: run `npm run vendor`'); process.exit(1); }
const model = new TextEncoder().encode(fs.readFileSync(path.join(ROOT, 'public/models', capture.file), 'utf8'));
const wasm = fs.readFileSync(path.join(ROOT, 'public/dsp/chain.wasm'));

/** A plucked low note with a little noise: what a guitar actually sends. */
function testSignal(): Float32Array {
  const x = new Float32Array(BLOCKS * 128);
  let seed = 12345;
  for (let i = 0; i < x.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const t = i / SR;
    x[i] = 0.08 * Math.sin(2 * Math.PI * 110 * t) * Math.exp(-(t % 1) * 3) + 0.002 * (seed / 0x3fffffff - 1);
  }
  return x;
}

async function chain(reverb: boolean): Promise<ChainCore> {
  const core = await instantiateChain(wasm);
  core.init(SR, 128);
  if (core.call('tc_load_model', [], model) !== 1) throw new Error(`the capture did not load: ${core.lastError()}`);
  core.call('tc_set_capture_trim', [capture!.trimDb]);
  core.call('tc_set_ir', [IR_SLOTS.cab], cabIR(SR, DEFAULT_CAB));
  core.call('tc_set_ir', [IR_SLOTS.reverb], reverbIR(SR, 1.3));
  if (!reverb) core.call('tc_set_param', [PARAMS.findIndex((p) => p.id === 'reverb_bypass'), 1]);
  return core;
}

function run(core: ChainCore, input: Float32Array): Float64Array {
  const times = new Float64Array(BLOCKS);
  for (let b = 0; b < BLOCKS; b++) {
    core.inputs[0]!.set(input.subarray(b * 128, b * 128 + 128));
    const t0 = process.hrtime.bigint();
    core.process(128, 1);
    times[b] = Number(process.hrtime.bigint() - t0) / 1000;
  }
  return times;
}

const input = testSignal();
console.log(`\nThe chain, ${capture.name}, 128-frame blocks at 48 kHz (budget ${QUANTUM_US.toFixed(0)} us)\n`);
for (const reverb of [true, false]) {
  const times = run(await chain(reverb), input);
  const steady = Array.from(times.subarray(1000)).sort((a, b) => a - b);
  const med = steady[steady.length >> 1]!;
  const p99 = steady[Math.floor(steady.length * 0.99)]!;
  const first = Array.from(times.subarray(0, 10)).map((t) => t.toFixed(0)).join(' ');
  console.log(`  ${reverb ? 'default preset, reverb on' : 'reverb off'}`);
  console.log(`    median ${med.toFixed(0).padStart(5)} us   p99 ${p99.toFixed(0).padStart(5)} us` +
    `   ${(100 * med / QUANTUM_US).toFixed(1)}% of a core at the median`);
  console.log(`    first ten blocks: ${first} us`);
}
console.log();
