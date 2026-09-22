/**
 * A tab, played as a guitar: the DI a pickup would have put out.
 *
 * One voice per string of the tab, because that is what a guitar has. A pick
 * stops whatever the string was doing and starts a note; a hammer-on, pull-off
 * or legato slide keeps the same vibrating string and only moves its pitch, so
 * the playback rate changes and the note's decay carries on; bends, vibrato
 * and the whammy bar are that same rate, moving. Every string of the tab is
 * served by the bank string closest in pitch, so a 7-string's low B is the low
 * E brought down and everything else moves by two semitones at most.
 *
 * Output is mono, at the rate asked for, at the level the presets are voiced
 * against (`TARGET_RMS_DB`): what leaves here is a DI, and the chain does the
 * rest.
 */
import type { Bank, BankSample } from './di-bank.ts';
import { applyPalm } from './di-palm.ts';
import type { NoteEvent, TrackEvents } from './tab-guitar.ts';

/** The shipped DI loop's level while it is playing, which is what the presets are set for. */
export const TARGET_RMS_DB = -36.1;

/**
 * How much of the learned palm is applied: its tone nearly whole, its decay
 * well short of it. The dataset's hardest mutes are gone in 80 ms, and copied
 * as they are they left a hole before every note of a run of sixteenths.
 */
const PALM_DECAY = 0.4;
const PALM_TONE = 0.8;
/** The palm presses a little differently every stroke. */
const PALM_PRESSURES = [-0.08, 0, 0.08];
/** Masked notes kept around, in samples: about 40 MB at 44.1 kHz. */
const PALM_CACHE_LIMIT = 10_000_000;

const RELEASE_SECONDS = 0.03;
const PICK_STOP_SECONDS = 0.004;
/** The pre-roll before the attack the bank cut into every note. */
const LEAD_SECONDS = 0.002;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

function hermite(x: Float32Array, pos: number): number {
  const i = Math.floor(pos), f = pos - i;
  const at = (k: number): number => (k >= 0 && k < x.length ? x[k]! : 0);
  const xm1 = at(i - 1), x0 = at(i), x1 = at(i + 1), x2 = at(i + 2);
  const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}

/** Palm mutes, made on demand from the picked note at that fret and kept. */
class Palm {
  #cache = new Map<string, BankSample>();
  #samples = 0;
  constructor(private readonly bank: Bank) {}

  at(string: number, fret: number, take: number): BankSample {
    const key = `${string}:${fret}:${take}`;
    const held = this.#cache.get(key);
    if (held) return held;
    const row = this.bank.picked[string]!;
    const open = row.find((s) => s.fret === fret) ?? row[0]!;
    const data = applyPalm(open.data, open.attack, this.bank.rate, this.bank.palm[string]!,
      PALM_DECAY + PALM_PRESSURES[take % PALM_PRESSURES.length]!, PALM_TONE);
    const muted: BankSample = { ...open, data, sustain: null };
    if (this.#samples > PALM_CACHE_LIMIT) { this.#cache.clear(); this.#samples = 0; }
    this.#cache.set(key, muted);
    this.#samples += data.length;
    return muted;
  }
}

/** Plays one note at a varying rate, holding it past its recording on its sustain loop. */
class Reader {
  pos = 0;
  gain = 1;
  /** Per output sample; negative is a release. */
  fade = 0;
  level = 1;
  /** The decay that carries on once the loop has taken over. */
  held = 1;
  step: number;
  #decay: number;

  constructor(readonly sample: BankSample, rate: number, start = 0) {
    this.pos = start;
    this.step = 1;
    this.#decay = sample.sustain ? Math.pow(10, sample.sustain.decayDb / 20 / rate) : 1;
  }

  next(step = this.step): number {
    this.step = step;
    const data = this.sample.data;
    const loop = this.sample.sustain;
    let v: number;
    if (loop) {
      const end = loop.from + loop.length;
      if (this.pos >= end) this.pos -= loop.length;
      const into = this.pos - (end - loop.crossfade);
      if (into > 0) {
        const k = into / loop.crossfade;
        v = hermite(data, this.pos) * Math.cos(k * Math.PI / 2) + hermite(data, this.pos - loop.length) * Math.sin(k * Math.PI / 2);
      } else v = hermite(data, this.pos);
      if (this.pos >= end - loop.crossfade || this.held < 1) this.held *= Math.pow(this.#decay, step);
    } else v = hermite(data, this.pos);
    this.pos += step;
    this.level = Math.max(0, Math.min(1, this.level + this.fade));
    return v * this.gain * this.level * this.held;
  }

  get done(): boolean {
    return (this.level <= 0 && this.fade < 0) || (!this.sample.sustain && this.pos >= this.sample.data.length) || this.held < 1e-4;
  }
}

interface Playing {
  reader: Reader;
  /** The note the sample sounds at rate 1. */
  srcPitch: number;
  ev: NoteEvent;
  /** What the string is fretted at, before bends. */
  base: number;
  /** A pinch harmonic's fundamental, which the thumb does not quite kill. */
  aux?: Reader;
  auxPitch?: number;
  released: boolean;
}

/** Semitones off the fretted note at `t` seconds in: bends, whammy, slides, vibrato. */
function semisAt(ev: NoteEvent, t: number): number {
  let s = 0;
  const points = ev.pitch;
  if (points.length > 0) {
    const first = points[0]!, last = points[points.length - 1]!;
    if (t <= first.t) s = first.t <= 0.001 ? first.semis : 0;
    else if (t >= last.t) s = last.semis;
    else for (let i = 1; i < points.length; i++) if (t < points[i]!.t) {
      const a = points[i - 1]!, b = points[i]!;
      s = a.semis + (b.semis - a.semis) * (t - a.t) / Math.max(1e-6, b.t - a.t);
      break;
    }
  }
  if (ev.vibrato > 0) {
    // A guitarist's vibrato bends up from the note and comes back, never under it.
    const depth = ev.vibrato === 2 ? 0.7 : 0.35;
    s += depth * Math.min(1, t / 0.15) * (0.5 - 0.5 * Math.cos(2 * Math.PI * 5.6 * t));
  }
  if (ev.slideOff !== 0) {
    const length = ev.end - ev.start, from = length * 0.55;
    if (t > from) s += ev.slideOff * Math.min(1, (t - from) / Math.max(0.03, length - from));
  }
  return s;
}

class StringVoice {
  playing: Playing | null = null;
  readonly dying: Reader[] = [];
  #rr = 0;

  constructor(
    private readonly bank: Bank,
    private readonly palm: Palm,
    /** Which bank string serves this one. */
    readonly source: number,
    private readonly rate: number,
    private readonly rand: () => number,
  ) {}

  #picked(pitch: number, rrOffset: number): BankSample {
    const row = this.bank.picked[this.source]!;
    const want = pitch - this.bank.strings[this.source]! + rrOffset;
    const fret = Math.max(0, Math.min(row.length - 1, want));
    return row.find((s) => s.fret === fret) ?? row[0]!;
  }

  start(ev: NoteEvent): void {
    const pitch = ev.open + ev.fret;
    const prev = this.playing;
    if (ev.attack === 'legato' && prev && !prev.reader.done && prev.reader.level > 0.5) {
      // The string is still ringing and only its length changes.
      // A pull-off plucks the string on the way off, a hammer-on only lands on it.
      if (pitch < prev.base) prev.reader.gain *= 0.95;
      prev.ev = ev;
      prev.base = pitch;
      prev.released = false;
      // It had begun its release: the finger is back on the string.
      prev.reader.fade = 1 / (0.002 * this.rate);
      if (prev.aux) prev.aux.fade = prev.reader.fade;
      return;
    }
    // A pick, or a tapping finger, stops the string before it sounds it.
    if (prev) {
      const stop = -1 / (PICK_STOP_SECONDS * this.rate);
      prev.reader.fade = stop;
      this.dying.push(prev.reader);
      if (prev.aux) { prev.aux.fade = stop; this.dying.push(prev.aux); }
    }

    let sample: BankSample;
    let srcPitch: number;
    let gain = ev.velocity;
    let aux: Reader | undefined;
    let auxPitch: number | undefined;
    const open = this.bank.strings[this.source]!;
    if (ev.dead) {
      const row = this.bank.dead[this.source]!;
      const closest = Math.min(...row.map((d) => Math.abs(d.fret - ev.fret)));
      const near = row.filter((d) => Math.abs(d.fret - ev.fret) === closest);
      sample = near[Math.floor(this.rand() * near.length)] ?? row[0]!;
      srcPitch = sample.pitch;
    } else if (ev.harmonic > 0) {
      const row = this.bank.harmonics[this.source]!;
      const n = Math.min(5, ev.harmonic);
      sample = row.find((h) => h.harmonic === n) ?? row[row.length - 1]!;
      // The sample is the open string's harmonic, so moving it by the fretted
      // note's distance from that open string gives the fretted one's.
      srcPitch = open;
      if (ev.pinch) {
        const fundamental = this.#picked(pitch, 0);
        aux = new Reader(fundamental, this.rate);
        aux.gain = ev.velocity * 0.18;
        auxPitch = fundamental.pitch;
        gain *= 0.9;
      } else gain *= 0.8;
    } else if (ev.palm) {
      const row = this.bank.picked[this.source]!;
      const fret = Math.max(0, Math.min(row.length - 1, pitch - open));
      sample = this.palm.at(this.source, fret, this.#rr++ % PALM_PRESSURES.length);
      srcPitch = sample.pitch;
    } else {
      // Round robin: the note itself, or a neighbouring fret brought to pitch.
      const offsets = [0, -1, 1, 0, 1, -1];
      sample = this.#picked(pitch, offsets[this.#rr++ % offsets.length]!);
      srcPitch = sample.pitch;
      if (ev.attack === 'tap') gain *= 0.75;
      if (ev.attack === 'legato') gain *= 0.55;
    }

    const reader = new Reader(sample, this.rate);
    reader.gain = gain;
    if (ev.attack !== 'pick') {
      // Nothing struck the string: fade in over the sample's own pick click.
      reader.level = 0;
      reader.fade = 1 / (0.0025 * this.rate);
      reader.pos = sample.attack * 0.5;
    }
    this.playing = { reader, srcPitch, ev, base: pitch, aux, auxPitch, released: false };
  }

  /** One output sample, `now` being the time in the track. */
  tick(now: number, ratio: number): number {
    let out = 0;
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const d = this.dying[i]!;
      out += d.next();
      if (d.done) this.dying.splice(i, 1);
    }
    const p = this.playing;
    if (!p) return out;
    const t = now - p.ev.start;
    if (t > p.ev.end - p.ev.start && !p.released) {
      p.released = true;
      // As fast as a fret hand damps a string.
      p.reader.fade = -1 / (RELEASE_SECONDS * this.rate);
      if (p.aux) p.aux.fade = p.reader.fade;
    }
    out += p.reader.next(ratio * Math.pow(2, (p.base + semisAt(p.ev, t) - p.srcPitch) / 12));
    if (p.aux) out += p.aux.next(ratio * Math.pow(2, (p.base - p.auxPitch!) / 12));
    if (p.reader.done) this.playing = null;
    return out;
  }
}

/** The bank string whose open note is closest to this one; a tie goes to the thicker. */
export function sourceString(bank: Bank, open: number): number {
  let best = 0;
  for (let s = 1; s < bank.strings.length; s++) {
    if (Math.abs(bank.strings[s]! - open) < Math.abs(bank.strings[best]! - open)) best = s;
  }
  return best;
}

export interface RenderOptions {
  readonly rate: number;
  readonly seconds: number;
  /** Which of the track's own random draws to use: one per track, so two guitars are not one. */
  readonly seed?: number;
  readonly onProgress?: (done: number) => void;
}

/** Renders a track's events to a mono DI, at the DI level the presets expect. */
export function renderDi(bank: Bank, track: TrackEvents, options: RenderOptions): Float32Array {
  const { rate, seconds, seed = 1, onProgress } = options;
  const rand = rng(seed * 31 + 7);
  const palm = new Palm(bank);
  const voices = track.strings.map((open) => new StringVoice(bank, palm, sourceString(bank, open), rate, rand));
  const total = Math.ceil(seconds * rate);
  const out = new Float32Array(total);
  const ratio = bank.rate / rate;
  const events = track.events;
  // The attack lands on the event's time, not the sample's pre-roll.
  const starts = events.map((e) => Math.round((e.start - LEAD_SECONDS) * rate));
  const block = Math.max(1, Math.round(rate / 4));
  let next = 0;
  for (let n = 0; n < total; n++) {
    while (next < events.length && starts[next]! <= n) {
      const ev = events[next]!;
      voices[ev.string]?.start(ev);
      next++;
    }
    let s = 0;
    const now = n / rate;
    for (const v of voices) s += v.tick(now, ratio);
    out[n] = s;
    if (onProgress && n % block === 0) onProgress(n / total);
  }
  onProgress?.(1);
  return out;
}

/**
 * The level a track is played into the chain at.
 *
 * Normalising the loudest 80% of its 50 ms windows, rather than its peak,
 * lands a quiet passage and a wall of chugs at the same place in the amp's
 * gain — which is what a player does with their volume knob, and what the
 * presets were voiced against.
 */
export function activeRms(x: Float32Array, rate: number): number {
  const window = Math.round(rate * 0.05);
  const levels: number[] = [];
  for (let i = 0; i + window < x.length; i += window) {
    let e = 0;
    for (let k = i; k < i + window; k++) e += x[k]! ** 2;
    const rms = Math.sqrt(e / window);
    if (rms > 1e-6) levels.push(rms);
  }
  if (levels.length === 0) return 0;
  levels.sort((a, b) => b - a);
  const loud = levels.slice(0, Math.max(1, Math.floor(levels.length * 0.8)));
  return Math.sqrt(loud.reduce((s, r) => s + r * r, 0) / loud.length);
}
