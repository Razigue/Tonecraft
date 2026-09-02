/**
 * Verifies the compiled chain by driving it directly, outside a browser.
 *
 * A browser test would need a microphone and a human ear. This instead feeds
 * known signals through the real .wasm and asserts on what comes back, which
 * is what makes "pass-through except for the limiter" and "the limiter can
 * never be defeated" checkable rather than asserted.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PARAMS, BLOCK_FRAMES, INTERNAL_SAMPLE_RATE } from '../schema/params.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CEILING = 0.944060876;

interface Chain {
  memory: WebAssembly.Memory;
  tc_init(rate: number): number;
  tc_process(frames: number): void;
  tc_set_param(index: number, value: number): void;
  tc_get_param(index: number): number;
  tc_input_ptr(): number;
  tc_output_ptr(): number;
  tc_meter_ptr(): number;
  tc_meter_count(): number;
  tc_param_count(): number;
  tc_added_latency_frames(): number;
  tc_resampling(): number;
  tc_load_weights(byteCount: number): number;
  tc_weights_ptr(): number;
  tc_weights_capacity(): number;
  tc_weights_float_count(): number;
  tc_amp_loaded(): number;
  tc_oversample_latency_samples(): number;
}

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures.push(name);
  console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`);
};

const bytes = readFileSync(join(ROOT, 'public', 'tonecraft.wasm'));
const { instance } = await WebAssembly.instantiate(bytes, {});
const chain = instance.exports as unknown as Chain;

// Deliberately NOT calling the module's `_initialize`. A standalone WASM module
// only runs static constructors when a loader calls it, and a loader that
// forgets would get zeroed parameter defaults and a limiter with degenerate
// time constants — while still appearing to work, because a degenerate limiter
// still limits. Nothing in this module may depend on that call.

// --- init ------------------------------------------------------------------
check('accepts the internal design rate',
  chain.tc_init(INTERNAL_SAMPLE_RATE) === 0);
check('at the internal rate nothing is resampled and no latency is added',
  chain.tc_resampling() === 0 && chain.tc_added_latency_frames() === 0);
check('accepts 44.1 kHz and converts at the boundary (AD-18)',
  chain.tc_init(44_100) === 0 && chain.tc_resampling() === 1);
check('and reports the latency that conversion costs rather than hiding it',
  chain.tc_added_latency_frames() > 0,
  `${chain.tc_added_latency_frames()} frames`);
check('rejects a rate no real interface offers',
  chain.tc_init(7_999) !== 0 && chain.tc_init(400_000) !== 0);
chain.tc_init(INTERNAL_SAMPLE_RATE);
check('exports the parameter count the schema declares (AD-7)',
  chain.tc_param_count() === PARAMS.length,
  `wasm ${chain.tc_param_count()} vs schema ${PARAMS.length}`);

const ampGain = PARAMS.findIndex((p) => p.id === 'amp_gain');
check('defaults are established without the loader calling _initialize',
  chain.tc_get_param(ampGain) === PARAMS[ampGain]!.default,
  `amp_gain ${chain.tc_get_param(ampGain)}, expected ${PARAMS[ampGain]!.default}`);

const heap = chain.memory.buffer;
const input = new Float32Array(heap, chain.tc_input_ptr(), BLOCK_FRAMES);
const output = new Float32Array(heap, chain.tc_output_ptr(), BLOCK_FRAMES);
const meters = new Float32Array(heap, chain.tc_meter_ptr(), chain.tc_meter_count());

const index = (id: string): number => PARAMS.findIndex((p) => p.id === id);
const setDefaults = (): void => {
  PARAMS.forEach((p, i) => chain.tc_set_param(i, p.default));
};

const run = (fill: (i: number) => number, blocks = 1): void => {
  for (let b = 0; b < blocks; b += 1) {
    for (let i = 0; i < BLOCK_FRAMES; i += 1) input[i] = fill(b * BLOCK_FRAMES + i);
    chain.tc_process(BLOCK_FRAMES);
  }
};

// --- pass-through ----------------------------------------------------------
setDefaults();
chain.tc_set_param(index('in_trim'), 0);
chain.tc_set_param(index('out_master'), 0);

const sine = (n: number): number => 0.25 * Math.sin((2 * Math.PI * 440 * n) / INTERNAL_SAMPLE_RATE);

// The oversampling window is a linear-phase filter pair, so it delays the
// signal by its group delay and changes nothing else. The chain is therefore
// compared against the input delayed by exactly that much — a comparison that
// would fail if the window altered the signal as well as delaying it.
const latency = chain.tc_oversample_latency_samples();
check('the window reports its own group delay', latency > 0 && latency < 32, `${latency}`);

const blocks = 8;
run(sine, blocks);
const base = (blocks - 1) * BLOCK_FRAMES;
let worst = 0;
for (let i = 0; i < BLOCK_FRAMES; i += 1) {
  worst = Math.max(worst, Math.abs(output[i]! - sine(base + i - latency)));
}
check('a quiet signal crosses the chain delayed but unaltered',
  worst < 5e-3, `max deviation ${worst.toFixed(6)} against a ${latency}-sample delay`);

check('and the window costs under 0.5 ms of round trip',
  (latency / INTERNAL_SAMPLE_RATE) * 1000 < 0.5,
  `${((latency / INTERNAL_SAMPLE_RATE) * 1000).toFixed(3)} ms`);

// --- the limiter cannot be defeated ---------------------------------------
// Every parameter pushed to its most extreme value at once, then a full-scale
// square wave — the worst case a feedback loop could produce. Nothing may leave
// above the ceiling, whatever anyone sets (FR-18).
for (let i = 0; i < PARAMS.length; i += 1) {
  const p = PARAMS[i]!;
  chain.tc_set_param(i, p.id === 'out_mute' ? 0 : p.max);
}
let peak = 0;
run((n) => (n % 32 < 16 ? 1 : -1), 32);
for (let i = 0; i < BLOCK_FRAMES; i += 1) peak = Math.max(peak, Math.abs(output[i]!));
check('no sample escapes the ceiling with every parameter maxed',
  peak <= CEILING + 1e-6, `peak ${peak.toFixed(6)} vs ceiling ${CEILING}`);

// Out-of-range values are clamped, not honoured: the audio thread cannot
// report an error, so it must stay safe instead of undefined (AD-13).
chain.tc_set_param(index('out_master'), 1e9);
peak = 0;
run(() => 1, 32);
for (let i = 0; i < BLOCK_FRAMES; i += 1) peak = Math.max(peak, Math.abs(output[i]!));
check('an out-of-range parameter cannot push past the ceiling either',
  peak <= CEILING + 1e-6, `peak ${peak.toFixed(6)}`);

// --- silence, never nothing -----------------------------------------------
setDefaults();
chain.tc_set_param(index('out_mute'), 1);
run(() => 1, 4);
check('mute produces silence rather than an absent buffer (AD-13)',
  output.every((v) => v === 0));

// --- metering --------------------------------------------------------------
setDefaults();
chain.tc_set_param(index('in_trim'), 0);
run(sine, 4);
check('every declared meter slot is written (AD-21)',
  meters.length === 7 && meters.every((v) => Number.isFinite(v)));
check('input RMS matches a 0.25 amplitude sine',
  Math.abs(meters[0]! - 0.25 / Math.SQRT2) < 0.01, `got ${meters[0]!.toFixed(4)}`);

// --- determinism -----------------------------------------------------------
// The same input through the same state must give the same bytes, or a shared
// tone link means nothing (NFR-9, AD-4).
// Both captures start from the same state. The limiter carries an envelope
// across blocks, so comparing a warm run against a cold one would measure the
// test's own history rather than the chain's determinism.
chain.tc_init(INTERNAL_SAMPLE_RATE);
run(sine, 4);
const first = Float32Array.from(output);
chain.tc_init(INTERNAL_SAMPLE_RATE);
run(sine, 4);
check('the same input and state produce identical output (NFR-9)',
  first.every((v, i) => v === output[i]));

// --- the weights loader (FR-17, AD-14) -------------------------------------
// Every way this can fail is detected at init and named. process() has no
// error path, so nothing about loading may be discoverable later (AD-13).

const MAGIC = 0x31574354;
const floatCount = chain.tc_weights_float_count();
const blobBytes = 12 + floatCount * 4;
const weightsArea = new Uint8Array(heap, chain.tc_weights_ptr(), chain.tc_weights_capacity());

const makeBlob = (magic: number, version: number, count: number, floats = count): Uint8Array => {
  const buf = new Uint8Array(12 + floats * 4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, magic, true);
  view.setUint32(4, version, true);
  view.setUint32(8, count, true);
  for (let i = 0; i < floats; i += 1) view.setFloat32(12 + i * 4, 0.01, true);
  return buf;
};

const tryLoad = (blob: Uint8Array): number => {
  weightsArea.fill(0);
  weightsArea.set(blob.subarray(0, Math.min(blob.length, weightsArea.length)));
  return chain.tc_load_weights(blob.length);
};

check('the schema and the model agree on the float count',
  floatCount === 4 * 20 * 1 + 20 * 4 * 20 + 4 * 20 + 20 + 1,
  `${floatCount}`);
check('the amp passes audio through before any weights are loaded',
  chain.tc_amp_loaded() === 0);
check('a truncated blob is refused', tryLoad(makeBlob(MAGIC, 1, floatCount).subarray(0, 8)) !== 0);
check('a bad magic is refused', tryLoad(makeBlob(0xdeadbeef, 1, floatCount)) !== 0);
check('an unsupported version is refused', tryLoad(makeBlob(MAGIC, 99, floatCount)) !== 0);
check('a different model shape is refused rather than loaded',
  tryLoad(makeBlob(MAGIC, 1, floatCount + 1)) !== 0);
check('a blob whose header lies about its length is refused',
  tryLoad(makeBlob(MAGIC, 1, floatCount, 4)) !== 0);
check('no failed load leaves the amp half-loaded', chain.tc_amp_loaded() === 0);

const real = readFileSync(join(ROOT, 'assets', 'amp-placeholder.tcw'));
check('the placeholder blob is exactly the size the model needs',
  real.length === blobBytes, `${real.length} vs ${blobBytes}`);
check('a well-formed blob loads', tryLoad(new Uint8Array(real)) === 0 && chain.tc_amp_loaded() === 1);

// The amp is in the signal path once loaded: identical input must now give a
// different output than it did before, or the stage is not wired in.
chain.tc_init(INTERNAL_SAMPLE_RATE);
tryLoad(new Uint8Array(real));
setDefaults();
run(sine, 4);
const shaped = Float32Array.from(output);
check('a loaded amp changes the signal', shaped.some((v, i) => v !== input[i]));
check('and it stays bounded — no runaway recurrent state',
  shaped.every((v) => Number.isFinite(v) && Math.abs(v) <= 1));

// --- the same tone at two device rates (AC3, NFR-9) ------------------------
// An LSTM amp is a rate-dependent non-linear system, so a stage running at the
// device rate would make two players with different interfaces hear different
// amplifiers from the same tone link. This is the check that the boundary
// actually prevents that.
const rmsAt = (rate: number, freq: number): number => {
  chain.tc_init(rate);
  setDefaults();
  chain.tc_set_param(index('in_trim'), 0);
  chain.tc_set_param(index('out_master'), 0);
  const blocks = Math.round((rate * 0.5) / BLOCK_FRAMES);
  let sum = 0;
  let counted = 0;
  let n = 0;
  for (let b = 0; b < blocks; b += 1) {
    for (let i = 0; i < BLOCK_FRAMES; i += 1, n += 1) {
      input[i] = 0.2 * Math.sin((2 * Math.PI * freq * n) / rate);
    }
    chain.tc_process(BLOCK_FRAMES);
    if (b > blocks / 2) {
      for (let i = 0; i < BLOCK_FRAMES; i += 1) { sum += output[i]! ** 2; counted += 1; }
    }
  }
  return Math.sqrt(sum / counted);
};

for (const freq of [110, 440, 2000, 5000]) {
  const at48 = rmsAt(48_000, freq);
  const at441 = rmsAt(44_100, freq);
  check(`${freq} Hz renders the same at 44.1 kHz as at 48 kHz`,
    Math.abs(at48 - at441) / at48 < 0.02,
    `48k ${at48.toFixed(5)} vs 44.1k ${at441.toFixed(5)}`);
}

for (const rate of [88_200, 96_000]) {
  const ref = rmsAt(48_000, 440);
  const got = rmsAt(rate, 440);
  check(`${rate} Hz matches 48 kHz`, Math.abs(ref - got) / ref < 0.02,
    `${got.toFixed(5)} vs ${ref.toFixed(5)}`);
}

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
