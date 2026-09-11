/**
 * Designs the half-band filters the boost's oversampler runs on, and prints
 * what they measure. The coefficients in dsp/frontend.cpp are
 * this script's output.
 *
 * Each 2x stage is an elliptic half-band split into two all-pass branches
 * (Valenzuela & Constantinides, 1983):
 *
 *     H(z) = ( A0(z^2) + z^-1 A1(z^2) ) / 2
 *
 * where A0 and A1 are cascades of first-order all-pass sections at the low
 * rate. The closed form for the section coefficients is the one hiir uses
 * (Laurent de Soras). The order is not taken from the closed-form estimate:
 * each candidate is evaluated and the shortest whose stopband meets the
 * target ships, so the numbers printed are measured, not promised.
 *
 * The point of the structure is the group delay: a few samples at the high
 * rate, where the linear-phase FIR it replaced cost half its length. The
 * price is a non-linear phase inside the transition band, above 20 kHz,
 * where there is nothing to hear.
 *
 * Usage:  npm run design:halfband
 */

function transitionParams(transition: number): { k: number; q: number } {
  let k = Math.tan((1 - transition * 2) * Math.PI / 4);
  k *= k;
  const kk = Math.pow(1 - k * k, 0.25);
  const e = 0.5 * (1 - kk) / (1 + kk);
  const e2 = e * e, e4 = e2 * e2;
  const q = e * (1 + e4 * (2 + e4 * (15 + 150 * e4)));
  return { k, q };
}

function accNum(q: number, order: number, c: number): number {
  let i = 0, j = 1, acc = 0, t: number;
  do {
    t = Math.pow(q, i * (i + 1)) * Math.sin((i * 2 + 1) * c * Math.PI / order) * j;
    acc += t; j = -j; i++;
  } while (Math.abs(t) > 1e-100);
  return acc;
}

function accDen(q: number, order: number, c: number): number {
  let i = 1, j = -1, acc = 0, t: number;
  do {
    t = Math.pow(q, i * i) * Math.cos(i * 2 * c * Math.PI / order) * j;
    acc += t; j = -j; i++;
  } while (Math.abs(t) > 1e-100);
  return acc;
}

function coefsForOrder(order: number, k: number, q: number): number[] {
  const coefs: number[] = [];
  for (let idx = 0; idx < (order - 1) / 2; idx++) {
    const c = idx + 1;
    const num = accNum(q, order, c) * Math.pow(q, 0.25);
    const den = accDen(q, order, c) + 0.5;
    const ww = num / den, wwsq = ww * ww;
    const x = Math.sqrt((1 - wwsq * k) * (1 - wwsq / k)) / (1 + wwsq);
    coefs.push((1 - x) / (1 + x));
  }
  return coefs;
}

/** A cascade of (a + z^-1) / (1 + a z^-1) at z = e^{jw}. */
function allpass(coefs: number[], w: number): [number, number] {
  let re = 1, im = 0;
  const zr = Math.cos(w), zi = -Math.sin(w);
  for (const a of coefs) {
    const nr = a + zr, ni = zi;
    const dr = 1 + a * zr, di = a * zi;
    const dd = dr * dr + di * di;
    const hr = (nr * dr + ni * di) / dd, hi = (ni * dr - nr * di) / dd;
    [re, im] = [re * hr - im * hi, re * hi + im * hr];
  }
  return [re, im];
}

/** H at w radians per sample at the HIGH rate, as a complex number. */
function response(coefs: number[], w: number): [number, number] {
  const [r0, i0] = allpass(coefs.filter((_, i) => i % 2 === 0), 2 * w);
  const [r1, i1] = allpass(coefs.filter((_, i) => i % 2 === 1), 2 * w);
  const zr = Math.cos(w), zi = -Math.sin(w);
  return [0.5 * (r0 + (r1 * zr - i1 * zi)), 0.5 * (i0 + (r1 * zi + i1 * zr))];
}

const magnitude = (coefs: number[], w: number): number => Math.hypot(...response(coefs, w));

function stopbandDb(coefs: number[], transition: number): number {
  let worst = 0;
  for (let f = 0.25 + transition / 2; f < 0.5; f += 0.0002) {
    worst = Math.max(worst, magnitude(coefs, 2 * Math.PI * f));
  }
  return 20 * Math.log10(worst);
}

function passbandRippleDb(coefs: number[], transition: number): number {
  let worst = 0;
  for (let f = 0; f <= 0.25 - transition / 2; f += 0.0002) {
    worst = Math.max(worst, Math.abs(20 * Math.log10(magnitude(coefs, 2 * Math.PI * f))));
  }
  return worst;
}

/** Group delay at 1 kHz, in samples at the high rate. */
function groupDelay(coefs: number[], fsHigh: number): number {
  const phase = (w: number): number => { const [r, i] = response(coefs, w); return Math.atan2(i, r); };
  const w = 2 * Math.PI * 1000 / fsHigh, dw = 1e-5;
  return -(phase(w + dw) - phase(w - dw)) / (2 * dw);
}

export function designHalfband(attenuationDb: number, transition: number): number[] {
  const { k, q } = transitionParams(transition);
  for (let order = 3; order < 99; order += 2) {
    const c = coefsForOrder(order, k, q);
    if (stopbandDb(c, transition) <= -attenuationDb) return c;
  }
  throw new Error('no design meets the target');
}

// ---------------------------------------------------------------------------

const ATTENUATION_DB = 100;
/** The passband must reach this at 48 kHz. The transition is relative to the
 *  rate, so at 44.1 kHz it reaches 18.4 kHz — as the FIR before it did. */
const PASSBAND_HZ = 20_000;

const STAGES = [
  ['48k  -> 96k ', 96_000],
  ['96k  -> 192k', 192_000],
  ['192k -> 384k', 384_000],
] as const;

console.log(`\nHalf-band stages: shortest all-pass design at or below -${ATTENUATION_DB} dB,` +
  ` passband to ${PASSBAND_HZ / 1000} kHz.\n`);
for (const [label, fsHigh] of STAGES) {
  const transition = 2 * (0.25 - PASSBAND_HZ / fsHigh);
  const c = designHalfband(ATTENUATION_DB, transition);
  console.log(`  ${label}  ${c.length} sections   stopband ${stopbandDb(c, transition).toFixed(1)} dB` +
    `   ripple ${passbandRippleDb(c, transition).toFixed(5)} dB` +
    `   group delay ${groupDelay(c, fsHigh).toFixed(2)} samples at ${fsHigh / 1000}k`);
  console.log(`    [${c.map((v) => v.toFixed(15)).join(', ')}]`);
}
console.log();
