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

{
  /* The transposer. Not a listening test either: what breaks silently here is
     the interval — a shifter that is a few percent out sounds like a shifter
     until you play it against anything. Each shift is measured back with a
     Goertzel at the note it is supposed to have produced, against its
     neighbours a semitone either side. */
  const tone = (hz: number, n: number, level = 0.2): Float32Array<ArrayBuffer> => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = level * Math.sin(2 * Math.PI * hz * (i / SR));
    return x;
  };
  /** Energy at one frequency, over the part of the signal that is settled. */
  const at = (y: Float32Array, hz: number, from: number): number => {
    const w = 2 * Math.PI * hz / SR;
    const c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = from; i < y.length; i++) { const s = y[i]! + c * s1 - s2; s2 = s1; s1 = s; }
    return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2);
  };

  const x = tone(220, SR * 2);
  for (const [semitones, name] of [[12, 'an octave up'], [-12, 'an octave down'], [-2, 'a whole tone down'], [7, 'a fifth up']] as const) {
    const core = await fresh();
    neutral(core, { pitch_bypass: 0, pitch_shift: semitones, pitch_mix: 1 });
    const y = run(core, x, [128, 256, 64]);
    const want = 220 * Math.pow(2, semitones / 12);
    const got = at(y, want, SR / 2);
    const below = at(y, want * Math.pow(2, -1 / 12), SR / 2);
    const above = at(y, want * Math.pow(2, 1 / 12), SR / 2);
    const dry = at(y, 220, SR / 2);
    check(`${name} lands on the note, and not beside it`,
      got > below * 4 && got > above * 4 && got > dry * 4,
      `${want.toFixed(1)} Hz is ${(20 * Math.log10(got / Math.max(below, above, dry))).toFixed(1)} dB over its neighbours`);
  }

  {
    // The level has to survive the crossfade: two heads under complementary
    // windows must add to one signal, not to a tremolo.
    const core = await fresh();
    neutral(core, { pitch_bypass: 0, pitch_shift: -12, pitch_mix: 1 });
    const y = run(core, x, [128]);
    let peak = 0, trough = 1e9;
    for (let at0 = SR; at0 + 2400 < y.length; at0 += 2400) {
      let e = 0;
      for (let i = at0; i < at0 + 2400; i++) e += y[i]! * y[i]!;
      const rms = Math.sqrt(e / 2400);
      peak = Math.max(peak, rms);
      trough = Math.min(trough, rms);
    }
    const ripple = 20 * Math.log10(peak / trough);
    check('a shifted note holds its level between splices', ripple < 3, `${ripple.toFixed(2)} dB of ripple`);
  }

  {
    // Engaged but asked for nothing: a wire, with no delay to pay for.
    const core = await fresh();
    neutral(core, { pitch_bypass: 0, pitch_shift: 0, pitch_mix: 1 });
    const impulse = new Float32Array(4096);
    impulse[1000] = 0.25;
    const y = run(core, impulse, [128]);
    let peak = 0;
    for (let i = 0; i < y.length; i++) if (Math.abs(y[i]!) > Math.abs(y[peak]!)) peak = i;
    check('no shift is no delay, even engaged', peak === 1000 && y[meterIndex('pitch_delay_ms')] !== undefined,
      `peak at ${peak}`);
  }

  {
    // What it delays by is reported, because the interface adds it to the
    // round trip it shows (FR-35).
    const core = await fresh();
    neutral(core, { pitch_bypass: 0, pitch_shift: 12, pitch_mix: 1 });
    run(core, tone(220, SR), [128]);
    const ms = core.meters![meterIndex('pitch_delay_ms')]!;
    check('the shifter reports what it delays by', ms > 5 && ms < 25, `${ms.toFixed(1)} ms at an octave up`);

    const off = await fresh();
    neutral(off);
    run(off, tone(220, SR / 2), [128]);
    check('and reports nothing when it is bypassed', off.meters![meterIndex('pitch_delay_ms')] === 0);
  }
}

{
  /* The looper. It records what leaves the rig, so the material to check it
     against is not the input but the chain's own output — the same chain, fed
     the same thing, with nobody pressing anything. Every check below is the
     difference between the two: what the looper added. */
  const x = noise(SR, 0.2, 4242);
  const silence = new Float32Array(SR / 2);
  const half = SR / 2;

  const core = await fresh(128);
  const ref = await fresh(128);
  neutral(core);
  neutral(ref);
  check('the looper starts empty', core.meters![meterIndex('loop_state')] === 0);

  // The reference plays the same passages in the same order, untouched.
  const refRec = run(ref, x.subarray(0, half), [128]);
  const refFirst = run(ref, silence, [128]);
  const refSecond = run(ref, silence, [128]);
  const refDub = run(ref, x.subarray(0, half), [128]);
  const refAfter = run(ref, silence, [128]);

  /** The worst sample of `got` minus `want`, past the seam and the ramps. */
  const off = (got: Float32Array, want: (i: number) => number): number => {
    let worst = 0;
    for (let i = 2000; i < half - 10; i++) worst = Math.max(worst, Math.abs(got[i]! - want(i)));
    return worst;
  };

  core.call('tc_loop_press');                       // record
  const recorded = run(core, x.subarray(0, half), [128]);
  check('recording does not touch what is playing', recorded.every((v, i) => v === refRec[i]));
  check('and says it is recording', core.meters![meterIndex('loop_state')] === 1);
  core.call('tc_loop_press');                       // close, and play

  const back = run(core, silence, [128]);
  check('what comes back is what was played', off(back, (i) => refFirst[i]! + recorded[i]!) < 2e-3,
    `worst sample off by ${off(back, (i) => refFirst[i]! + recorded[i]!).toExponential(1)}`);
  check('and it says it is playing', core.meters![meterIndex('loop_state')] === 2);
  const length = core.meters![meterIndex('loop_length')]!;
  check('the loop is as long as the recording', Math.abs(length - half / SR) < 0.01, `${length.toFixed(3)} s`);

  const second = run(core, silence, [128]);
  check('and it goes round', off(second, (i) => refSecond[i]! + recorded[i]!) < 2e-3);

  // Overdub: the live signal is heard once, and joins the loop for next time.
  core.call('tc_loop_press');
  const dubbed = run(core, x.subarray(0, half), [128]);
  check('an overdub is not heard twice while it is played',
    off(dubbed, (i) => refDub[i]! + recorded[i]!) < 2e-3);
  core.call('tc_loop_press');                       // back to playing
  const after = run(core, silence, [128]);
  check('and is in the loop on the next pass',
    off(after, (i) => refAfter[i]! + recorded[i]! + refDub[i]!) < 2e-3);

  core.call('tc_loop_stop');
  const stopped = run(core, silence, [128]);
  check('stop is silence', stopped.subarray(SR / 10).every((v) => Math.abs(v) < 1e-6));
  check('and the loop is still there', core.meters![meterIndex('loop_length')]! > 0.4);

  core.call('tc_loop_clear');
  run(core, silence, [128]);
  check('clear empties it', core.meters![meterIndex('loop_state')] === 0 && core.meters![meterIndex('loop_length')] === 0);

  // A press too quick to be a bar is a mistake, not a quarter-second stutter.
  core.call('tc_loop_press');
  run(core, x.subarray(0, 1280), [128]);
  core.call('tc_loop_press');
  run(core, silence, [128]);
  check('a loop too short to be one is dropped', core.meters![meterIndex('loop_state')] === 0);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
