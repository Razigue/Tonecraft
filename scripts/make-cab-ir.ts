/**
 * Generates the cabinet impulse response.
 *
 * **This is a designed response, not a capture.** No microphone, no room, no
 * speaker. The reason is the same as for the amplifier: what a captured IR
 * uniquely buys is fidelity to one particular cabinet, with that microphone at
 * that position in that room — and `PRODUCT.md` section 7 forbids claiming any
 * of those. The product would be paying for an asset it is not allowed to
 * describe.
 *
 * What it produces is a real impulse response all the same, and it goes through
 * exactly the same convolution a capture would. The day a real cabinet is
 * recorded, this file is replaced and no code changes.
 *
 * Built by running an impulse through a cascade of biquads shaped like a guitar
 * cabinet, then windowing the tail. A cabinet is, to a good approximation, a
 * steep bandpass with a few resonances:
 *
 *  - almost nothing below 80 Hz, and a resonant peak just above it where the
 *    cone and the sealed box work against each other
 *  - a scoop around 700 Hz that gives the low mids room
 *  - a presence peak near 2.6 kHz, which is the bite you hear in a lead tone
 *  - and a cliff above 5 kHz. This one is not decoration: a high-gain preamp
 *    generates enormous energy up there, and every amp simulator that sounds
 *    like a wasp is one that failed to remove it.
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERNAL_SAMPLE_RATE, MAX_IR_TAPS } from '../schema/params.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAGIC = 0x52494354; // 'TCIR'
const VERSION = 1;

/** 1024 taps is 21 ms, past where a cabinet has anything left to say. */
const TAPS = 1024;

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

const rate = INTERNAL_SAMPLE_RATE;

/** RBJ cookbook coefficients, normalised by a0. */
function highpass(f: number, q: number): Biquad {
  const w = (2 * Math.PI * f) / rate, cw = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cw) / 2) / a0, b1: (-(1 + cw)) / a0, b2: ((1 + cw) / 2) / a0,
    a1: (-2 * cw) / a0, a2: (1 - alpha) / a0,
  };
}

function lowpass(f: number, q: number): Biquad {
  const w = (2 * Math.PI * f) / rate, cw = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cw) / 2) / a0, b1: (1 - cw) / a0, b2: ((1 - cw) / 2) / a0,
    a1: (-2 * cw) / a0, a2: (1 - alpha) / a0,
  };
}

function peaking(f: number, q: number, gainDb: number): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * f) / rate, cw = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0, b1: (-2 * cw) / a0, b2: (1 - alpha * A) / a0,
    a1: (-2 * cw) / a0, a2: (1 - alpha / A) / a0,
  };
}

const CABINET: readonly Biquad[] = [
  // Below the low E's fundamental, but not by much: a 4x12 has real weight at
  // 80 Hz and cutting it at 82 was part of why this sounded like a small amp.
  highpass(58, 0.75),
  peaking(105, 1.0, 5.5),       // cone and box resonance, wider and stronger
  peaking(240, 0.9, 2.5),       // the body a big cabinet has and a small one does not
  peaking(700, 1.0, -2.5),      // a dip, not a scoop
  peaking(1450, 1.6, 1.0),      // upper mid, gently
  // Presence, halved. At +5 dB this was the "aigu cartonné" — the brittle top
  // that reads as a cheap speaker rather than a loud one.
  peaking(2300, 1.3, 2.5),
  peaking(3800, 2.0, -3.5),     // takes the edge off before the cliff
  // Three pole pairs, low enough that 5 kHz is already well down. A cabinet
  // that is only -1.5 dB at 5 kHz is not a cabinet, and the difference is
  // audible as harshness on every note.
  lowpass(4400, 0.71),
  lowpass(4700, 0.71),
  lowpass(5800, 1.1),
];

function runImpulse(chain: readonly Biquad[], length: number): Float64Array {
  const out = new Float64Array(length);
  const state = chain.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
  for (let n = 0; n < length; n += 1) {
    let x = n === 0 ? 1 : 0;
    for (let i = 0; i < chain.length; i += 1) {
      const c = chain[i]!, s = state[i]!;
      const y = c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
      s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
      x = y;
    }
    out[n] = x;
  }
  return out;
}

/** Magnitude of the finished IR at one frequency, for normalising and reporting. */
function magnitudeAt(ir: Float64Array, f: number): number {
  let re = 0, im = 0;
  for (let n = 0; n < ir.length; n += 1) {
    const w = (-2 * Math.PI * f * n) / rate;
    re += ir[n]! * Math.cos(w);
    im += ir[n]! * Math.sin(w);
  }
  return Math.hypot(re, im);
}

// Run longer than we keep, so the tail being cut is already tiny.
const ir = runImpulse(CABINET, TAPS);

// Fade the last eighth to zero. Truncating an IR with a step leaves a broadband
// click smeared across the response; a raised-cosine fade does not.
const fadeFrom = Math.floor(TAPS * 0.875);
for (let n = fadeFrom; n < TAPS; n += 1) {
  const t = (n - fadeFrom) / (TAPS - fadeFrom);
  ir[n] = ir[n]! * 0.5 * (1 + Math.cos(Math.PI * t));
}

// Unity at 1 kHz, so switching the cabinet in does not change the playing
// level — the cabinet is a tone shape, not a volume control.
const reference = magnitudeAt(ir, 1000);
for (let n = 0; n < TAPS; n += 1) ir[n] = ir[n]! / reference;

const buffer = Buffer.alloc(12 + TAPS * 4);
buffer.writeUInt32LE(MAGIC, 0);
buffer.writeUInt32LE(VERSION, 4);
buffer.writeUInt32LE(TAPS, 8);
for (let n = 0; n < TAPS; n += 1) buffer.writeFloatLE(ir[n]!, 12 + n * 4);

const out = join(ROOT, 'assets', 'cab.tcir');
writeFileSync(out, buffer);

const db = (f: number): string => (20 * Math.log10(magnitudeAt(ir, f))).toFixed(1).padStart(6);
process.stdout.write(
  `cab: wrote assets/cab.tcir (${TAPS} taps, ${buffer.length} bytes, max ${MAX_IR_TAPS})\n` +
  `     designed response, not a capture — see the header of this script\n` +
  `      50 Hz ${db(50)}   110 ${db(110)}   250 ${db(250)}   700 ${db(700)}\n` +
  `       1 kHz ${db(1000)}  2.6k ${db(2600)}   4k ${db(4000)}    5k ${db(5000)}\n` +
  `       6 kHz ${db(6000)}    8k ${db(8000)}  10k ${db(10000)}   12k ${db(12000)}\n`,
);
