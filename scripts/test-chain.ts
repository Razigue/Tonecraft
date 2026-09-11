/**
 * The chain, tested from Node through the same binding the worklet uses.
 *
 * Nothing here is a listening test. These are the properties that break
 * silently: an ABI a host no longer understands, a convolution that is almost
 * right, a block size that shifts the output by a few samples, a capture that
 * loads but never runs. Each one would still produce sound.
 *
 * The convolver is checked by linearity rather than against a copy of itself.
 * With the amplifier absent, the gate and the boost off and the level under
 * the limiter's knee, every stage left is linear and time-invariant, so the
 * chain with a cabinet `h` must equal the chain with an identity cabinet,
 * convolved with `h` afterwards by the textbook sum. The same holds for the
 * reverb. Host block sizes are varied on purpose: the chain must not care.
 *
 * Usage:  npm run test:chain
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { instantiateChain, type ChainCore } from '../public/dsp/chain-core.js';
import { PARAMS } from '../schema/params.ts';
import { METER_COUNT, IR_SLOTS, meterIndex } from '../schema/chain.ts';
import { cabIR, DEFAULT_CAB } from '../engine/ir.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48_000;

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const wasm = fs.readFileSync(path.join(ROOT, 'public/dsp/chain.wasm'));
const wire = (id: string): number => PARAMS.findIndex((p) => p.id === id);

async function fresh(maxFrames = 1024): Promise<ChainCore> {
  const core = await instantiateChain(wasm);
  core.init(SR, maxFrames);
  return core;
}

/**
 * Everything that is not linear, or not the thing under test, out of the way —
 * and then half a second of silence, because every parameter glides to where
 * it is sent (AD-20) and a gain still moving is not time-invariant. The gate
 * in particular passes through its whole range on the way to "off", and an
 * impulse arriving mid-glide opens it with its 1.2 ms attack.
 */
function neutral(core: ChainCore, extra: Record<string, number> = {}): void {
  const set = (id: string, v: number): void => { core.call('tc_set_param', [wire(id), v]); };
  set('in_trim', 0);
  set('gate_bypass', 1);
  set('drive_bypass', 1);
  set('tone_bypass', 1);
  set('reverb_bypass', 1);
  set('out_master', 0);
  for (const [id, v] of Object.entries(extra)) set(id, v);
  core.call('tc_set_ir', [IR_SLOTS.cab], new Float32Array([1]));
  run(core, new Float32Array(SR / 2), [128]);
}

/** Runs `x` through the chain in host blocks of the given sizes, cycled. */
function run(core: ChainCore, x: Float32Array, blocks: readonly number[]): Float32Array {
  const y = new Float32Array(x.length);
  let at = 0, k = 0;
  while (at < x.length) {
    const n = Math.min(blocks[k++ % blocks.length]!, x.length - at);
    core.inputs[0]!.set(x.subarray(at, at + n));
    core.process(n, 1);
    y.set(core.output!.subarray(0, n), at);
    at += n;
  }
  return y;
}

function noise(n: number, level: number, seed = 12345): Float32Array<ArrayBuffer> {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    x[i] = level * (seed / 0x3fffffff - 1);
  }
  return x;
}

function convolve(x: Float32Array, h: Float32Array): Float64Array {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    const kmax = Math.min(i + 1, h.length);
    for (let k = 0; k < kmax; k++) s += h[k]! * x[i - k]!;
    y[i] = s;
  }
  return y;
}

function errorDb(got: Float32Array, want: Float64Array, from: number): number {
  let e = 0, s = 0;
  for (let i = from; i < got.length; i++) { const d = got[i]! - want[i]!; e += d * d; s += want[i]! * want[i]!; }
  return 10 * Math.log10(e / s + 1e-30);
}

console.log('\nThe chain — from Node, through chain-core.js\n');

{
  const core = await fresh();
  check('the module speaks the ABI this host was written for', core.exports.tc_abi_version() === 1);
  check('the meter frame has the length the schema declares', core.meters!.length === METER_COUNT,
    `${core.meters!.length} of ${METER_COUNT}`);
}

{
  // The cabinet: a real one, synthesised the way the product does it.
  const cab = cabIR(SR, DEFAULT_CAB);
  const x = noise(SR, 0.05);

  const a = await fresh();
  neutral(a);
  const dry = run(a, x, [128]);
  const b = await fresh();
  neutral(b);
  b.call('tc_set_ir', [IR_SLOTS.cab], cab);
  const wet = run(b, x, [37, 128, 256, 1000, 5]);
  const err = errorDb(wet, convolve(dry, cab), 2048);
  check('the cabinet is the textbook convolution, at any host block size', err < -100, `${err.toFixed(1)} dB`);
}

{
  // The reverb: a head of zeros, as the real one has, and a tail long enough
  // to span dozens of partitions.
  const ir = noise(6000, 0.01, 777);
  ir.fill(0, 0, 672);
  const x = noise(SR, 0.05, 99);
  const mix = 0.3;

  const a = await fresh();
  neutral(a);
  const dry = run(a, x, [128]);
  const b = await fresh();
  neutral(b, { reverb_bypass: 0, reverb_mix: mix });
  // Set after the settling silence, so the convolver's state starts clean.
  b.call('tc_set_ir', [IR_SLOTS.reverb], ir);
  const wet = run(b, x, [128, 64, 300]);
  const tail = convolve(dry, ir);
  const want = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) want[i] = (1 - 0.35 * mix) * dry[i]! + 0.8 * mix * tail[i]!;
  const err = errorDb(wet, want, 2048);
  check('the reverb is dry plus wet, exactly, at any host block size', err < -90, `${err.toFixed(1)} dB`);
}

{
  // Nothing in the chain delays the signal.
  const core = await fresh();
  neutral(core);
  const x = new Float32Array(4096);
  x[1000] = 0.25;
  const y = run(core, x, [128]);
  let at = 0;
  for (let i = 0; i < y.length; i++) if (Math.abs(y[i]!) > Math.abs(y[at]!)) at = i;
  check('the chain adds no latency of its own', at === 1000, `peak at ${at}, impulse at 1000`);
}

{
  // The shipped capture, through the whole chain at its defaults.
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/index.json'), 'utf8')) as {
    models: { file: string; trimDb: number }[];
  };
  const first = catalog.models[0]!;
  const core = await fresh(128);
  const json = new TextEncoder().encode(fs.readFileSync(path.join(ROOT, 'public/models', first.file), 'utf8'));
  const loaded = core.call('tc_load_model', [], json);
  check('a capture loads', loaded === 1 && core.call('tc_model_loaded') === 1, loaded === 1 ? first.file : core.lastError());
  core.call('tc_set_capture_trim', [first.trimDb]);
  core.call('tc_set_ir', [IR_SLOTS.cab], cabIR(SR, DEFAULT_CAB));

  const x = new Float32Array(SR * 2);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] = 0.1 * Math.exp(-(t % 1) * 3.5) * Math.sin(2 * Math.PI * 82.4 * t);
  }
  let frames = 0, finite = true, peak = 0, amp = 0;
  const y = new Float32Array(128);
  for (let at = 0; at < x.length; at += 128) {
    core.inputs[0]!.set(x.subarray(at, at + 128));
    if (core.process(128, 1)) {
      frames++;
      amp = Math.max(amp, core.meters![meterIndex('output_rms')]!);
    }
    y.set(core.output!.subarray(0, 128));
    for (const v of y) { if (!Number.isFinite(v)) finite = false; peak = Math.max(peak, Math.abs(v)); }
  }
  check('the output is finite and under the ceiling', finite && peak <= 1, `peak ${peak.toFixed(3)}`);
  check('there is sound at the output', amp > 1e-3, `rms ${amp.toExponential(2)}`);
  // A frame closes on the first 128-frame block past sr / 30: 13 blocks, 28.8 Hz.
  const expected = Math.floor(x.length / (Math.ceil(SR / 30 / 128) * 128));
  check('meter frames arrive about 30 times a second', frames === expected, `${frames} in 2 s`);

  core.call('tc_set_powered', [0]);
  run(core, new Float32Array(SR * 2), [128]);
  const off = run(core, x.subarray(0, SR / 2), [128]);
  check('power off is silence, tails included', off.every((v) => v === 0));
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
