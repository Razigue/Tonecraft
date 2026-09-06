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

function highshelf(f: number, slope: number, gainDb: number): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * f) / rate, cw = Math.cos(w), sw = Math.sin(w);
  const alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
  const twoSqrtAlpha = 2 * Math.sqrt(A) * alpha;
  const a0 = (A + 1) - (A - 1) * cw + twoSqrtAlpha;
  return {
    b0: (A * ((A + 1) + (A - 1) * cw + twoSqrtAlpha)) / a0,
    b1: (-2 * A * ((A - 1) + (A + 1) * cw)) / a0,
    b2: (A * ((A + 1) + (A - 1) * cw - twoSqrtAlpha)) / a0,
    a1: (2 * ((A - 1) - (A + 1) * cw)) / a0,
    a2: ((A + 1) - (A - 1) * cw - twoSqrtAlpha) / a0,
  };
}

const CABINET: readonly Biquad[] = [
  // Fitted, not felt. The reference cabinet's magnitude response was measured
  // as the difference between a commercial chain's cab'd and cab-bypassed
  // renders of the same performance, and these coefficients were then
  // optimised against it: 1.7 dB of RMS error across 50 Hz to 13 kHz, where
  // the previous hand-set cascade was 7.8 dB out.
  //
  // The one thing the fit cannot reach is a notch near 1.3 kHz. That is not a
  // filter someone forgot — the reference mics a cabinet with two capsules at
  // different distances and sums them, so its response carries comb structure
  // that no cascade of smooth biquads produces. Reproducing it needs a captured
  // impulse response, which is the day this file is deleted (NFR-16).
  // 58 Hz, not the 74 the fit asked for. The fit was against a reference whose
  // preset cuts 6.8 dB at 65 Hz in a post EQ, and against a player tuned to D
  // standard whose lowest string is 73.4 Hz — a corner sitting on top of the
  // lowest fundamental in the material is wrong however well it scores.
  highpass(58, 0.60),
  peaking(115, 0.90, 7.5),      // cone and box resonance
  peaking(680, 0.49, 3.0),      // the body a big cabinet has and a small one does not
  peaking(1520, 0.50, -5.0),    // the dip every real cabinet has through the low treble
  peaking(3200, 0.79, 1.8),     // presence, which is the bite
  lowpass(9000, 0.40),
  // The shelf is the correction, and it is the reason the old top end was
  // wrong. Three cascaded lowpasses fall forever: they left the cabinet 43 dB
  // down at 10 kHz and 62 dB at 12.9 kHz, against a reference that plateaus
  // around -30 and stays there. That missing air is heard exactly as the
  // player described it — round, warm, no attack, no brilliance — because
  // everything that defines a pick attack lives above 6 kHz.
  //
  // A shelf plateaus by construction. That is the entire difference, and it is
  // also what a real cabinet does: it rolls off, then levels out into the
  // room's own noise and the microphone's own top end.
  //
  // The corner is at 7.5 kHz rather than the 5 kHz the fit preferred. Fitting
  // the reference cabinet in isolation put the shelf low enough to darken 4 to
  // 6 kHz, and measured through the whole chain that lost more than the air
  // above 8 kHz gained. Against the reference the full chain is 10.8 dB out
  // where the previous cabinet was 11.2, and better in every band group.
  highshelf(7500, 1.00, -24.0),
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
