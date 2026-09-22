/**
 * Candidate A: a sampler over real DI notes, driven string by string.
 *
 * Each string of the tab is one voice, as on a guitar: a new pick stops what
 * the string was playing; a hammer-on, pull-off or legato slide keeps the same
 * vibrating string and only moves its pitch, so the playback rate changes and
 * the note's decay carries on. Bends, vibrato and whammy are the same rate
 * modulation. A target string is served by the source string closest in
 * pitch, so a 7-string's low B is the low E brought down, and every other
 * string moves by two semitones at most.
 */
import { loadBank, SRC_OPEN, SRC_RATE, type Bank, type Sample } from './bank.ts';
import type { NoteEvent, TrackEvents } from './tab-events.ts';
import { learnMask, applyMask } from './palm-mute.ts';

/**
 * Palm mute: the picked note already at the right fret, with the palm of one
 * real muted take applied (its string's own, 5th fret against 5th fret). As
 * close to a real mute as another real take is, where resampling the 5th-fret
 * mute down to a low B is not (poc/palm-mute-test.ts).
 */
const masks = new Map<string, number[][]>();
const mutedCache = new Map<string, Sample>();
function mutedFor(src: number, fret: number, take: number): Sample {
  const key = `${src}:${fret}:${take}`;
  let s = mutedCache.get(key);
  if (!s) {
    const b = getBank();
    const mk = `${src}:${take}`;
    let mask = masks.get(mk);
    if (!mask) { mask = learnMask(b, [src], [take]); masks.set(mk, mask); }
    const row = b.picked[src]!;
    s = applyMask(row.find((x) => x.fret === fret) ?? row[0]!, mask);
    mutedCache.set(key, s);
  }
  return s;
}

const RATE = 48000;
const CONTROL = 16;

let bank: Bank | null = null;
const getBank = (): Bank => (bank ??= loadBank(process.env.GUITAR ?? 'LP'));

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

/** The source string whose open note is closest to the target's; ties go to the thicker. */
export function sourceString(open: number): number {
  let best = 0;
  for (let s = 1; s < SRC_OPEN.length; s++) if (Math.abs(SRC_OPEN[s]! - open) < Math.abs(SRC_OPEN[best]! - open)) best = s;
  return best;
}

function hermite(x: Float32Array, pos: number): number {
  const i = Math.floor(pos), f = pos - i;
  const at = (k: number) => (k >= 0 && k < x.length ? x[k]! : 0);
  const xm1 = at(i - 1), x0 = at(i), x1 = at(i + 1), x2 = at(i + 2);
  const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}

/** Plays one sample at a varying rate, looping pitch-synchronously past its end. */
class Reader {
  pos = 0;
  gain = 1;
  /** Linear fade, per output sample; negative is a release. */
  fade = 0;
  level = 1;
  loopFrom = -1; loopLen = 0; xfade = 0;
  /** The rate it was last played at: a note dying keeps its pitch. */
  step = SRC_RATE / RATE;
  constructor(readonly s: Sample, start: number, readonly bright: number) {
    this.pos = start;
    // A loop of whole periods of the note, taken from the steady part near the end.
    const period = SRC_RATE / (440 * Math.pow(2, (s.pitch - 69) / 12)) / (s.harmonic > 1 ? 1 : 1);
    const periods = Math.max(1, Math.round(0.06 * SRC_RATE / period));
    this.loopLen = periods * period;
    const end = s.data.length - 0.02 * SRC_RATE;
    this.loopFrom = end - this.loopLen;
    this.xfade = Math.min(this.loopLen * 0.5, 0.01 * SRC_RATE);
    if (this.loopFrom < s.attack + 0.05 * SRC_RATE) this.loopFrom = -1;
  }
  /** Advances by `step` source samples and returns the output. */
  next(step: number = this.step): number {
    this.step = step;
    const s = this.s.data;
    let v: number;
    const end = this.loopFrom + this.loopLen;
    if (this.loopFrom > 0 && this.pos >= end - this.xfade) {
      if (this.pos >= end) this.pos -= this.loopLen;
      const into = this.pos - (end - this.xfade);
      if (into > 0) {
        const k = into / this.xfade;
        v = hermite(s, this.pos) * Math.cos(k * Math.PI / 2) + hermite(s, this.pos - this.loopLen) * Math.sin(k * Math.PI / 2);
      } else v = hermite(s, this.pos);
    } else v = hermite(s, this.pos);
    this.pos += step;
    this.level = Math.max(0, Math.min(1, this.level + this.fade));
    return v * this.gain * this.level;
  }
  get done(): boolean { return this.level <= 0 && this.fade < 0 || (this.loopFrom < 0 && this.pos >= this.s.data.length); }
}

interface Playing { reader: Reader; srcPitch: number; ev: NoteEvent; /** Pitch the note is at, before bends. */ base: number; decay: number; aux?: Reader; auxPitch?: number; t: number }

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
    s += depth * Math.min(1, t / 0.15) * (0.5 - 0.5 * Math.cos(2 * Math.PI * 5.6 * t));
  }
  if (ev.slideOff !== 0) {
    const len = ev.end - ev.start, from = len * 0.55;
    if (t > from) s += ev.slideOff * Math.min(1, (t - from) / Math.max(0.03, len - from));
  }
  return s;
};

class StringVoice {
  playing: Playing | null = null;
  readonly dying: Reader[] = [];
  rr = 0;
  constructor(readonly open: number, readonly src: number, readonly rand: () => number) {}

  private pickedFor(pitch: number, rrOffset: number): { s: Sample; shift: number } {
    const row = getBank().picked[this.src]!;
    const want = pitch - SRC_OPEN[this.src]! + rrOffset;
    const fret = Math.max(0, Math.min(row.length - 1, want));
    const s = row.find((x) => x.fret === fret) ?? row[0]!;
    return { s, shift: pitch - s.pitch };
  }

  start(ev: NoteEvent): void {
    const b = getBank();
    const pitch = ev.open + ev.fret;
    const prev = this.playing;
    const vel = ev.velocity;
    if (ev.attack === 'legato' && prev && !prev.reader.done && prev.reader.level > 0.5) {
      // Same string, still vibrating: only the length of it changes.
      const hammer = pitch > prev.base;
      prev.ev = ev; prev.base = pitch; prev.t = 0;
      prev.reader.gain *= hammer ? 1.0 : 0.95;
      return;
    }
    // The pick, or the tapping finger, stops the string before it plays it.
    if (prev) { prev.reader.fade = -1 / (0.004 * RATE); this.dying.push(prev.reader); if (prev.aux) { prev.aux.fade = -1 / (0.004 * RATE); this.dying.push(prev.aux); } }

    let sample: Sample, srcPitch: number;
    let gain = vel;
    let aux: Reader | undefined, auxPitch: number | undefined;
    if (ev.dead) {
      const row = b.dead[this.src]!;
      const near = row.filter((d) => Math.abs(d.fret - ev.fret) === Math.min(...row.map((r) => Math.abs(r.fret - ev.fret))));
      sample = near[Math.floor(this.rand() * near.length)]!;
      srcPitch = sample.pitch;
    } else if (ev.harmonic > 0) {
      const row = b.harmonics[this.src]!;
      const n = Math.min(5, ev.harmonic);
      sample = row.find((h) => h.harmonic === n) ?? row[row.length - 1]!;
      // The sample is the open source string's harmonic: moving it by the
      // fretted note's distance from that open string gives the fretted harmonic.
      srcPitch = SRC_OPEN[this.src]!;
      if (ev.pinch) {
        // What the thumb does not quite kill: the fretted note itself, low.
        const f = this.pickedFor(pitch, 0);
        aux = new Reader(f.s, 0, 1);
        aux.gain = vel * 0.18;
        auxPitch = f.s.pitch;
        gain *= 0.9;
      } else gain *= 0.8;
    } else if (ev.palm) {
      const srcFret = Math.max(0, Math.min(20, pitch - SRC_OPEN[this.src]!));
      sample = mutedFor(this.src, srcFret, this.rr++ % b.muted[this.src]!.length);
      srcPitch = sample.pitch;
    } else {
      // Round robin: the same note, or its neighbour fret brought to pitch.
      const rrOffsets = [0, -1, 1, 0, 1, -1];
      const f = this.pickedFor(pitch, rrOffsets[this.rr++ % rrOffsets.length]!);
      sample = f.s; srcPitch = f.s.pitch;
      if (ev.attack === 'tap') gain *= 0.75;
      if (ev.attack === 'legato') gain *= 0.55;
    }
    const reader = new Reader(sample, 0, 1);
    reader.gain = gain;
    if (ev.attack !== 'pick') {
      // No pick on the string: soften the sample's pick click.
      reader.level = 0; reader.fade = 1 / (0.0025 * RATE);
      reader.pos = sample.attack * 0.5;
    }
    this.playing = { reader, srcPitch, ev, base: pitch, decay: 1, aux, auxPitch, t: 0 };
  }

  /** Output sample; `t` is seconds since the current event started. */
  tick(now: number): number {
    let out = 0;
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const d = this.dying[i]!;
      out += d.next();
      if (d.done) this.dying.splice(i, 1);
    }
    const p = this.playing;
    if (!p) return out;
    const t = now - p.ev.start;
    const semis = p.base + semisAt(p.ev, t) + (p.ev.harmonic > 0 ? 0 : 0) - p.srcPitch;
    const step = SRC_RATE / RATE * Math.pow(2, semis / 12);
    if (t > p.ev.end - p.ev.start && p.reader.fade >= 0) {
      // The fretting hand lets go and the palm stops the string.
      p.reader.fade = -1 / (0.012 * RATE);
      if (p.aux) p.aux.fade = p.reader.fade;
    }
    out += p.reader.next(step);
    if (p.aux) out += p.aux.next(SRC_RATE / RATE * Math.pow(2, (p.base - p.auxPitch!) / 12));
    if (p.reader.done) this.playing = null;
    return out;
  }
}

export function renderSampler(track: TrackEvents, seconds: number, seed = 1): Float32Array {
  const rand = rng(seed * 31 + 7);
  const voices = track.strings.map((open) => new StringVoice(open, sourceString(open), rand));
  const total = Math.ceil(seconds * RATE);
  const out = new Float32Array(total);
  const events = track.events;
  // The sample's attack lands on the event's time, not its pre-roll.
  const lead = 0.002;
  const starts = events.map((e) => Math.round((e.start - lead) * RATE));
  let next = 0;
  for (let n = 0; n < total; n++) {
    while (next < events.length && starts[next]! <= n) { const ev = events[next]!; voices[ev.string]?.start(ev); next++; }
    let s = 0;
    const now = n / RATE;
    for (const v of voices) s += v.tick(now);
    out[n] = s;
  }
  return out;
}
