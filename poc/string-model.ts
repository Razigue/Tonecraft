/**
 * Candidate B: a physical model of an electric guitar's strings, as its
 * bridge humbucker hears them.
 *
 * One digital waveguide per string (single delay loop): a fractional delay
 * sets the pitch, a one-pole loss filter sets how long the fundamental and
 * the treble ring (palm mute is only that filter closing), first-order
 * allpasses stretch the partials of the wound strings the way stiffness does,
 * and the pick excites the loop through a comb set by where it strikes. The
 * pickup reads the loop through its own comb, at its distance from the
 * bridge, for each coil, then through the coil's resonance into the cable.
 * Runs at twice the output rate so the interpolated delay stays accurate at
 * the top of the neck.
 */
import type { NoteEvent, TrackEvents } from './tab-events.ts';

const OUT_RATE = 48000;
const OS = 2;
const FS = OUT_RATE * OS;
const CONTROL = 32;

/** 7-string, 27" scale. Coil distances from the bridge, metres. */
const SCALE = 0.686;
const COILS = [0.030, 0.048];
/** Where the pick strikes, metres from the bridge. */
const PICK_AT = 0.085;

export interface ModelParams {
  /** Seconds for the fundamental of the lowest and of the highest string to fall 60 dB. */
  t60Low: number; t60High: number;
  /** Same at `hfRef` Hz. */
  t60Treble: number; hfRef: number;
  palmT60: number; palmTreble: number;
  /** Pickup resonance. */
  resonance: number; q: number;
  /** Pick pulse width, as a multiple of the default. */
  pulse: number;
  /** 0 reads displacement, 1 velocity (what a magnetic pickup really senses). */
  tilt: number;
  /** Metres from the bridge. */
  pickAt: number;
  gain: number;
}

export const DEFAULT_PARAMS: ModelParams = {
  t60Low: 9, t60High: 4, t60Treble: 0.35, hfRef: 4000,
  palmT60: 0.28, palmTreble: 0.035,
  resonance: 3100, q: 2.0,
  pulse: 1,
  tilt: 0,
  pickAt: 0.085,
  gain: 1,
};

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

/** One-pole loss filter pole giving gain ratio `r` at `w` against DC. */
function lossPole(r: number, w: number): number {
  if (r >= 0.9999) return 0;
  let lo = 0, hi = 0.9995;
  for (let i = 0; i < 50; i++) {
    const a = (lo + hi) / 2;
    const m = (1 - a) / Math.sqrt(1 - 2 * a * Math.cos(w) + a * a);
    if (m > r) lo = a; else hi = a;
  }
  return (lo + hi) / 2;
}

const phaseDelayLP = (a: number, w: number) => Math.atan2(a * Math.sin(w), 1 - a * Math.cos(w)) / w;
function phaseDelayAP(c: number, w: number): number {
  const nr = c + Math.cos(w), ni = -Math.sin(w);
  const dr = 1 + c * Math.cos(w), di = -c * Math.sin(w);
  let ph = Math.atan2(ni, nr) - Math.atan2(di, dr);
  while (ph > 0) ph -= 2 * Math.PI;
  return -ph / w;
}

const SIZE = 1 << 15;
const MASK = SIZE - 1;

function hermite(buf: Float64Array, pos: number): number {
  const i = Math.floor(pos), f = pos - i;
  const xm1 = buf[(i - 1) & MASK]!, x0 = buf[i & MASK]!, x1 = buf[(i + 1) & MASK]!, x2 = buf[(i + 2) & MASK]!;
  const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}

/** A waveguide loop: the string's travelling wave, once round. */
class Loop {
  readonly buf = new Float64Array(SIZE);
  readonly exc = new Float64Array(SIZE);
  w = 0;
  delay = 100;
  g = 0.999; a = 0; lp = 0;
  readonly ap: { c: number; x1: number; y1: number }[];
  period = 100;

  constructor(dispersion: number[]) {
    this.ap = dispersion.map((c) => ({ c, x1: 0, y1: 0 }));
  }

  set(f0: number, t60: number, t60hf: number, hfRef: number): void {
    const w0 = 2 * Math.PI * f0 / FS;
    this.g = Math.pow(10, -3 / (t60 * f0));
    const ghf = Math.pow(10, -3 / (t60hf * f0));
    this.a = lossPole(Math.min(1, ghf / this.g), 2 * Math.PI * Math.min(hfRef, FS * 0.45) / FS);
    let d = FS / f0 - phaseDelayLP(this.a, w0);
    for (const s of this.ap) d -= phaseDelayAP(s.c, w0);
    this.delay = Math.max(2.5, d);
    this.period = FS / f0;
  }

  /** Adds `e` into the loop starting now. */
  excite(e: Float64Array, gain: number): void {
    for (let i = 0; i < e.length; i++) this.exc[(this.w + i) & MASK]! += e[i]! * gain;
  }

  scale(k: number): void {
    for (let i = 0; i < SIZE; i++) this.buf[i]! *= k;
    this.lp *= k;
    for (const s of this.ap) { s.x1 *= k; s.y1 *= k; }
  }

  tick(): number {
    let v = hermite(this.buf, this.w - this.delay);
    for (const s of this.ap) {
      const y = s.c * v + s.x1 - s.c * s.y1;
      s.x1 = v; s.y1 = y; v = y;
    }
    this.lp = this.g * (1 - this.a) * v + this.a * this.lp;
    v = this.lp + this.exc[this.w & MASK]!;
    this.exc[this.w & MASK] = 0;
    this.buf[this.w & MASK] = v;
    this.w = (this.w + 1) & MASK;
    return v;
  }

  /** What the pickup coils at `p` (fraction of the vibrating length from the bridge) hear. */
  pickup(p: readonly number[], realPeriod: number): number {
    const now = this.buf[(this.w - 1) & MASK]!;
    let s = 0;
    for (const x of p) s += hermite(this.buf, this.w - 1 - x * realPeriod);
    return now - s / p.length;
  }
}

/** A raised-cosine pulse plus a little scrape: the pick leaving the string. */
function pickPulse(vel: number, down: boolean, beta: number, period: number, rand: () => number, soft = 1): Float64Array {
  const width = (0.18 + 0.9 * Math.pow(1 - vel, 1.5)) * 1e-3 * FS * soft * (down ? 1 : 0.85);
  const scrape = 0.003 * FS;
  const n = Math.ceil(Math.max(width, scrape) + beta * period + 4);
  const e = new Float64Array(n);
  const sign = down ? 1 : -1;
  for (let i = 0; i < width; i++) e[i]! += sign * 0.5 * (1 - Math.cos(2 * Math.PI * i / width));
  let lp = 0;
  const k = Math.exp(-2 * Math.PI * 3500 / FS);
  for (let i = 0; i < scrape; i++) {
    lp = k * lp + (1 - k) * (rand() * 2 - 1);
    e[i]! += 0.35 * vel * lp * Math.exp(-i / (scrape / 3));
  }
  // The pick position comb: the reflected half arrives beta of a period later.
  const out = new Float64Array(n);
  const lag = beta * period;
  for (let i = 0; i < n; i++) {
    const j = i - lag;
    const lagged = j < 0 ? 0 : (() => { const a = Math.floor(j), f = j - a; return (e[a] ?? 0) * (1 - f) + (e[a + 1] ?? 0) * f; })();
    out[i] = e[i]! - lagged;
  }
  return out;
}

function noiseBurst(ms: number, cutoff: number, rand: () => number): Float64Array {
  const n = Math.ceil(ms * 1e-3 * FS);
  const e = new Float64Array(n);
  let lp = 0;
  const k = Math.exp(-2 * Math.PI * cutoff / FS);
  for (let i = 0; i < n; i++) { lp = k * lp + (1 - k) * (rand() * 2 - 1); e[i] = lp * Math.exp(-i / (n / 4)); }
  return e;
}

const semisAt = (ev: NoteEvent, t: number): number => {
  let s = 0;
  const p = ev.pitch;
  if (p.length > 0) {
    if (t <= p[0]!.t) s = p[0]!.t <= 0.001 ? p[0]!.semis : 0;
    else if (t >= p[p.length - 1]!.t) s = p[p.length - 1]!.semis;
    else for (let i = 1; i < p.length; i++) if (t < p[i]!.t) {
      const a = p[i - 1]!, b = p[i]!;
      s = a.semis + (b.semis - a.semis) * (t - a.t) / Math.max(1e-6, b.t - a.t);
      break;
    }
  }
  if (ev.vibrato > 0) {
    const depth = ev.vibrato === 2 ? 0.7 : 0.35;
    const onset = Math.min(1, t / 0.15);
    s += depth * onset * (0.5 - 0.5 * Math.cos(2 * Math.PI * 5.6 * t));
  }
  if (ev.slideOff !== 0) {
    const len = ev.end - ev.start, from = len * 0.55;
    if (t > from) s += ev.slideOff * Math.min(1, (t - from) / Math.max(0.03, len - from));
  }
  return s;
};

class StringVoice {
  readonly main: Loop;
  readonly aux: Loop;
  ev: NoteEvent | null = null;
  auxLevel = 0;
  prevFret = 0;
  cents = 0;
  coils: number[] = COILS.map((c) => c / SCALE);
  constructor(readonly index: number, readonly open: number, readonly count: number, readonly params: ModelParams, readonly rand: () => number) {
    // Wound strings are stiffer: the lower, the more their partials stretch.
    const wound = index < count - 3;
    const c = wound ? -0.12 - 0.22 * (1 - index / Math.max(1, count - 4)) : -0.04;
    this.main = new Loop([c, c]);
    this.aux = new Loop([c, c]);
  }

  private t60For(f0: number): number {
    // Lower strings sustain longer; interpolate on the open string's position.
    const x = this.index / Math.max(1, this.count - 1);
    return this.params.t60Low * (1 - x) + this.params.t60High * x;
  }

  start(ev: NoteEvent): void {
    const p = this.params;
    const prev = this.ev;
    this.cents = (this.rand() - 0.5) * 6 + (ev.fret > 0 ? 3 : 0);
    const f = 440 * Math.pow(2, (ev.open + ev.fret - 69) / 12);
    const vib = SCALE * Math.pow(2, -ev.fret / 12);
    const beta = (p.pickAt / vib) * (1 + (this.rand() - 0.5) * 0.2);
    const n = ev.harmonic || 1;
    const period = FS / (f * n);
    if (ev.dead) {
      this.main.scale(0.3);
      this.ev = ev;
      this.update(0);
      const e = pickPulse(ev.velocity, ev.down, beta, FS / f, this.rand, 2.5 * p.pulse);
      const noise = noiseBurst(12, 1800, this.rand);
      for (let i = 0; i < noise.length && i < e.length; i++) e[i]! += noise[i]! * 0.6;
      this.main.excite(e, ev.velocity * 0.5);
      return;
    }
    let gain = ev.velocity;
    if (ev.attack === 'legato') {
      const hammer = !prev || ev.fret > this.prevFret;
      gain *= hammer ? 0.28 : 0.4;
    } else if (ev.attack === 'tap') gain *= 0.55;
    else this.main.scale(ev.palm ? 0.35 : 0.55); // the pick stops the string before it plucks it
    this.ev = ev;
    this.prevFret = ev.fret;
    this.update(0);
    const soft = (ev.attack === 'pick' ? 1 : 1.6) * p.pulse;
    const pulse = pickPulse(ev.velocity, ev.down, ev.attack === 'pick' ? beta : 0.02, period, this.rand, soft);
    this.main.excite(pulse, gain * (ev.harmonic ? 0.6 : 1));
    this.auxLevel = 0;
    if (ev.pinch) {
      // The thumb kills most, not all, of the fundamental.
      this.aux.scale(0);
      this.aux.set(f, 0.25, 0.05, p.hfRef);
      this.aux.excite(pickPulse(ev.velocity, ev.down, beta, FS / f, this.rand, p.pulse), gain * 0.25);
      this.auxLevel = 1;
    }
  }

  update(tLocal: number): void {
    const ev = this.ev;
    if (!ev) return;
    const p = this.params;
    let semis = ev.fret + semisAt(ev, tLocal) + this.cents / 100;
    if (ev.attack !== 'legato') semis += 0.14 * ev.velocity * ev.velocity * Math.exp(-tLocal / 0.045);
    if (ev.palm) semis += 0.06;
    const f = 440 * Math.pow(2, (ev.open + semis - 69) / 12) * (ev.harmonic || 1);
    // The coils sit at fixed distances from the bridge; the fret moves the other end.
    const vib = SCALE * Math.pow(2, -(semis - (ev.slideOff ? 0 : 0)) / 12);
    this.coils = COILS.map((c) => c / vib);
    const released = tLocal > ev.end - ev.start;
    const base = this.t60For(f);
    let t60 = ev.palm ? p.palmT60 * (1 + 0.6 * (1 - this.index / this.count)) : base;
    let hf = ev.palm ? p.palmTreble : p.t60Treble;
    if (ev.dead) { t60 = 0.035; hf = 0.012; }
    if (ev.harmonic) { t60 *= 0.8; hf *= 2; }
    if (released) { t60 = Math.min(t60, 0.045); hf = Math.min(hf, 0.015); }
    this.main.set(f, t60, Math.min(hf, t60), p.hfRef);
    if (this.auxLevel > 0) {
      const fa = f / (ev.harmonic || 1);
      this.aux.set(fa, released ? 0.04 : 0.25, 0.04, p.hfRef);
    }
  }

  tick(): number {
    const ev = this.ev;
    const coils = this.coils;
    this.main.tick();
    let out = this.main.pickup(coils, this.main.period * (ev?.harmonic || 1));
    if (this.auxLevel > 0) { this.aux.tick(); out += this.aux.pickup(coils, this.aux.period); }
    return out;
  }
}

/** RBJ low-pass: the coil's inductance against the pot and the cable's capacitance. */
function biquadLP(f: number, q: number, fs: number) {
  const w = 2 * Math.PI * f / fs, al = Math.sin(w) / (2 * q), c = Math.cos(w);
  const a0 = 1 + al;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x: number) => { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}

/** Half-band decimator: a windowed-sinc FIR, since offline cost is free. */
function decimate(x: Float64Array): Float32Array {
  const taps = 127, h = new Float64Array(taps), mid = (taps - 1) / 2;
  for (let i = 0; i < taps; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 0.5 : Math.sin(Math.PI * n / 2) / (Math.PI * n);
    h[i] = sinc * (0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1)));
  }
  const out = new Float32Array(Math.floor(x.length / OS));
  for (let o = 0; o < out.length; o++) {
    let s = 0;
    const c = o * OS;
    for (let k = 0; k < taps; k++) { const j = c + k - mid; if (j >= 0 && j < x.length) s += h[k]! * x[j]!; }
    out[o] = s;
  }
  return out;
}

export function renderModel(track: TrackEvents, seconds: number, params: ModelParams = DEFAULT_PARAMS, seed = 1): Float32Array {
  const rand = rng(seed);
  const voices = track.strings.map((open, i) => new StringVoice(i, open, track.strings.length, params, rand));
  const total = Math.ceil(seconds * FS);
  const out = new Float64Array(total);
  const events = track.events;
  let next = 0;
  const lp = biquadLP(params.resonance, params.q, FS);
  let hpX = 0, hpY = 0, prevS = 0;
  const hpK = Math.exp(-2 * Math.PI * 30 / FS);
  const starts = events.map((e) => Math.round(e.start * FS));
  for (let n = 0; n < total; n++) {
    while (next < events.length && starts[next]! <= n) {
      const ev = events[next]!;
      voices[ev.string]?.start(ev);
      next++;
    }
    if (n % CONTROL === 0) for (const v of voices) if (v.ev) v.update(n / FS - v.ev.start);
    let s = 0;
    for (const v of voices) s += v.tick();
    const d = (s - prevS) * (FS / (2 * Math.PI * 1000));
    prevS = s;
    s = lp(s * (1 - params.tilt) + d * params.tilt);
    const y = hpK * (hpY + s - hpX);
    hpX = s; hpY = y;
    out[n] = y * params.gain;
  }
  return decimate(out);
}
