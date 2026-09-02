/**
 * Verifies the compiled chain by driving it directly, outside a browser.
 *
 * A browser test would need a microphone and a human ear. This instead feeds
 * known signals through the real .wasm and asserts on what comes back, which
 * is what makes "pass-through except for the limiter" and "the limiter can
 * never be defeated" checkable rather than asserted.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PARAMS, STAGES, BLOCK_FRAMES, INTERNAL_SAMPLE_RATE } from '../schema/params.ts';

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
  tc_oversample_latency_samples(): number;
  tc_bypass_mask(): number;
  tc_input_peak(): number;
  tc_input_brightness(): number;
  tc_probe_frames(): number;
  tc_probe_clear(): void;
  tc_load_ir(byteCount: number): number;
  tc_ir_ptr(): number;
  tc_ir_capacity(): number;
  tc_ir_taps(): number;
  tc_max_ir_taps(): number;
}

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures.push(name);
  console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`);
};

const artifact = join(ROOT, 'public', 'tonecraft.wasm');
if (!existsSync(artifact)) {
  // Cause and fix, one line each — the same rule the product's own errors
  // follow. An ENOENT stack trace tells a contributor nothing about which of
  // the several build steps they skipped.
  console.error(
    'public/tonecraft.wasm has not been built, so there is no artifact to test.\n' +
    'Run: npm run build:wasm   (needs Emscripten; see README)',
  );
  process.exit(1);
}
const bytes = readFileSync(artifact);
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

// The stronger form of the same rule, and the one that catches it wherever it
// hides. A value computed by a static initialiser reads as zero when the loader
// skips `_initialize` — and a zero coefficient does not crash, it misbehaves
// quietly. It has already happened twice: once in Chain and Limiter, once in
// Gate, where a hysteresis ratio of zero held the gate open for every signal
// while every other test still passed.
//
// So rather than grep for the pattern, run the module both ways and compare
// the audio. Nothing that changes behaviour can escape this.
{
  const renderSignature = async (callInitialize: boolean): Promise<Float32Array> => {
    const fresh = await WebAssembly.instantiate(bytes, {});
    const mod = fresh.instance.exports as unknown as Chain & { _initialize?: () => void };
    if (callInitialize) mod._initialize?.();
    mod.tc_init(INTERNAL_SAMPLE_RATE);
    const heapB = mod.memory.buffer;
    const inB = new Float32Array(heapB, mod.tc_input_ptr(), BLOCK_FRAMES);
    const outB = new Float32Array(heapB, mod.tc_output_ptr(), BLOCK_FRAMES);
    // Deliberately quiet: this is the level at which a wrongly-zeroed gate
    // threshold shows up, and loud signals would hide it behind the limiter.
    for (let b = 0; b < 80; b += 1) {
      for (let i = 0; i < BLOCK_FRAMES; i += 1) {
        const n = b * BLOCK_FRAMES + i;
        inB[i] = 0.0008 * Math.sin((2 * Math.PI * 440 * n) / INTERNAL_SAMPLE_RATE);
      }
      mod.tc_process(BLOCK_FRAMES);
    }
    return Float32Array.from(outB);
  };

  const withInit = await renderSignature(true);
  const withoutInit = await renderSignature(false);
  check('the module renders identically with and without _initialize',
    withInit.every((v, i) => v === withoutInit[i]),
    'a value somewhere is computed by a static initialiser');
}

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

const latency = chain.tc_oversample_latency_samples();
check('the window reports its own group delay', latency > 0 && latency < 32, `${latency}`);
check('and it costs under 0.5 ms of round trip',
  (latency / INTERNAL_SAMPLE_RATE) * 1000 < 0.5,
  `${((latency / INTERNAL_SAMPLE_RATE) * 1000).toFixed(3)} ms`);

// With every stage bypassed the chain must be exactly transparent — same
// samples, same alignment, no residual delay. Bypassing the amp skips the
// oversampling window with it, which is the point: a bypassed stage costs
// nothing, including its resampling. The window's own transparency is measured
// directly in dsp/tests/oversample.test.cpp.
chain.tc_set_param(index('gate_bypass'), 1);
chain.tc_set_param(index('amp_bypass'), 1);
run(sine, 8);
let worst = 0;
for (let i = 0; i < BLOCK_FRAMES; i += 1) {
  worst = Math.max(worst, Math.abs(output[i]! - input[i]!));
}
check('a fully bypassed chain is exactly transparent', worst < 1e-6,
  `max deviation ${worst}`);
setDefaults();

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

// --- the gate and bypass (FR-11, FR-20, AD-21) -----------------------------

chain.tc_init(INTERNAL_SAMPLE_RATE);
setDefaults();
chain.tc_set_param(index('in_trim'), 0);
chain.tc_set_param(index('out_master'), 0);

const quiet = (n: number): number =>
  0.0005 * Math.sin((2 * Math.PI * 440 * n) / INTERNAL_SAMPLE_RATE);
const loud = (n: number): number =>
  0.4 * Math.sin((2 * Math.PI * 440 * n) / INTERNAL_SAMPLE_RATE);

const peakOf = (): number => {
  let peak = 0;
  for (let i = 0; i < BLOCK_FRAMES; i += 1) peak = Math.max(peak, Math.abs(output[i]!));
  return peak;
};

chain.tc_set_param(index('gate_threshold'), -40);
run(quiet, 60);
const gatedPeak = peakOf();
check('the gate silences a signal below its threshold', gatedPeak < 1e-4,
  `peak ${gatedPeak.toExponential(2)}`);

chain.tc_init(INTERNAL_SAMPLE_RATE);
setDefaults();
chain.tc_set_param(index('in_trim'), 0);
chain.tc_set_param(index('out_master'), 0);
chain.tc_set_param(index('gate_threshold'), -40);
// The amp is bypassed: this is a question about the gate, and an amplifier in
// the path would be answering it instead.
chain.tc_set_param(index('amp_bypass'), 1);
run(loud, 60);
check('and passes one above it', peakOf() > 0.3, `peak ${peakOf().toFixed(3)}`);

// Bypassed, the same quiet signal must come straight through.
chain.tc_init(INTERNAL_SAMPLE_RATE);
setDefaults();
chain.tc_set_param(index('in_trim'), 0);
chain.tc_set_param(index('out_master'), 0);
chain.tc_set_param(index('gate_threshold'), -40);
chain.tc_set_param(index('gate_bypass'), 1);
run(quiet, 60);
check('bypassing the gate stops it processing entirely', peakOf() > 4e-4,
  `peak ${peakOf().toExponential(2)}`);

// A bypassed stage's meter reports what passed through it untouched.
const gateSlot = STAGES.findIndex((st) => st.id === 'gate');
const inputSlot = STAGES.findIndex((st) => st.id === 'input');
check('a bypassed stage meters the level that passed through it',
  Math.abs(meters[gateSlot]! - meters[inputSlot]!) < 1e-6,
  `${meters[gateSlot]} vs ${meters[inputSlot]}`);

// AD-21: the bypass belongs to the stage the schema says it belongs to, and is
// found through that declared id rather than through a position in the chain.
for (const stage of STAGES) {
  setDefaults();
  if (stage.bypassParam === null) continue;
  chain.tc_set_param(index(stage.bypassParam), 1);
  const expected = 1 << STAGES.indexOf(stage);
  check(`bypassing ${stage.id} marks ${stage.id} and nothing else`,
    chain.tc_bypass_mask() === expected,
    `mask ${chain.tc_bypass_mask().toString(2)}, expected ${expected.toString(2)}`);
}

setDefaults();
check('no stage is bypassed by default', chain.tc_bypass_mask() === 0);
check('the input and the output cannot be bypassed at all (FR-18)',
  STAGES.filter((st) => st.bypassParam === null).map((st) => st.id).join(',') === 'input,output');

chain.tc_init(INTERNAL_SAMPLE_RATE);
setDefaults();

// --- the amp is in the chain and is a distortion (FR-17) -------------------
// Its behaviour is covered in depth by dsp/tests/amp.test.cpp; what matters
// here is that the shipped artifact actually has it wired in.

chain.tc_init(INTERNAL_SAMPLE_RATE);
setDefaults();
chain.tc_set_param(index('in_trim'), 0);
chain.tc_set_param(index('gate_bypass'), 1);
chain.tc_set_param(index('amp_bypass'), 1);
run(sine, 8);
const clean = Float32Array.from(output);

setDefaults();
chain.tc_set_param(index('in_trim'), 0);
chain.tc_set_param(index('gate_bypass'), 1);
run(sine, 8);
check('the amp changes the signal', clean.some((v, i) => v !== output[i]));

// Turning the tone controls has to reach the audio, or the schema and the
// generated binding have drifted apart.
for (const control of ['amp_gain', 'amp_bass', 'amp_mid', 'amp_treble', 'amp_master']) {
  chain.tc_init(INTERNAL_SAMPLE_RATE);
  setDefaults();
  chain.tc_set_param(index('gate_bypass'), 1);
  run(sine, 8);
  const before = Float32Array.from(output);

  chain.tc_init(INTERNAL_SAMPLE_RATE);
  setDefaults();
  chain.tc_set_param(index('gate_bypass'), 1);
  const p = PARAMS[index(control)]!;
  chain.tc_set_param(index(control), p.min);
  run(sine, 8);
  check(`${control} reaches the audio`, before.some((v, i) => v !== output[i]));
}

chain.tc_init(INTERNAL_SAMPLE_RATE);
setDefaults();

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
