/**
 * Builds `public/di-bank/` from recordings of one guitar.
 *
 * Everything the player's machine would otherwise have to work out is measured
 * here: which note each file actually sounds, where its pick lands, how loud it
 * is against its neighbours, where it can be looped to hold it past its
 * recording, and what the palm does to each string. The result is two files the
 * render worker reads straight into memory.
 *
 * The source is **EG-IPT** (Electric Guitar Instrumental Playing Techniques),
 * CC BY-4.0 — Fiorini, Brochec, Borg and Pasini, zenodo.org/records/15205644:
 * a 2005 Gibson SG Standard through a BSS AR-133 DI box, 96 kHz / 24-bit, one
 * file per note. We take the bridge humbucker's DI channel and four of its
 * nineteen techniques. A CC-BY licence is the reason it is this dataset and not
 * another: a bank cut from a no-derivatives dataset could never be published,
 * whatever it sounded like.
 *
 * Nothing in the filenames is trusted on its own. The block number says which
 * string a run belongs to, but which string that is comes from the pitch the
 * recording actually sounds, and a run whose notes do not climb by a semitone
 * a fret is refused rather than shipped.
 *
 *   npx tsx scripts/build-di-bank.ts <EG-IPT dir> [--pickup HB-bridge]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav, toMono } from '../render/wav.ts';
import { BANK_VERSION, encodePcm, type BankIndex, type SampleKind, type Sustain } from '../engine/di-bank.ts';
import { envelopes, FRAMES, type PalmMask } from '../engine/di-palm.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'di-bank');

const args = process.argv.slice(2);
const DATA = args[0];
const PICKUP = (args.includes('--pickup') ? args[args.indexOf('--pickup') + 1] : 'HB-bridge') ?? 'HB-bridge';
if (!DATA) {
  console.error('Usage: npx tsx scripts/build-di-bank.ts <EG-IPT dir> [--pickup HB-bridge]');
  process.exit(1);
}

/** Standard tuning, low to high: what the runs are matched against. */
const STRINGS = [40, 45, 50, 55, 59, 64];
/** The bank plays at the rate the studio renders at; the source is twice that. */
const RATE = 48000;
/** Pre-roll kept before the pick, faded in. */
const GUARD = 0.002;
/**
 * How much of each note is kept, in seconds after its attack. Past it the
 * sustain loop holds the note, so what this buys is the part that still
 * changes — and what it costs is the download. A mute is over in under a
 * second; a picked note has settled by two.
 */
const KEEP: Record<SampleKind, number> = { pick: 2, mute: 0.9, harmonic: 1.5 };

interface Take {
  kind: SampleKind;
  /** 0 is the low E. */
  string: number;
  fret: number;
  pitch: number;
  harmonic: number;
  attack: number;
  data: Float32Array;
}

/** 96 kHz to 48: a windowed-sinc half-band, since an offline build can afford one. */
function halve(x: Float32Array): Float32Array {
  const taps = 127, mid = (taps - 1) / 2, h = new Float64Array(taps);
  for (let i = 0; i < taps; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 0.5 : Math.sin(Math.PI * n / 2) / (Math.PI * n);
    h[i] = sinc * (0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1)));
  }
  const out = new Float32Array(Math.floor(x.length / 2));
  for (let o = 0; o < out.length; o++) {
    let s = 0;
    const c = o * 2;
    for (let k = 0; k < taps; k++) {
      const j = c + k - mid;
      if (j >= 0 && j < x.length) s += h[k]! * x[j]!;
    }
    out[o] = s;
  }
  return out;
}

/**
 * The note a recording sounds.
 *
 * Plain autocorrelation takes the largest peak, which on a plucked string is
 * as often twice the period as the period — an octave low, on half the notes
 * here. This is YIN's rule instead: the *first* dip of the cumulative mean
 * normalised difference under a threshold, which prefers the shortest period
 * that explains the waveform.
 */
function soundedPitch(x: Float32Array, rate: number): number {
  const window = Math.round(rate * 0.05);
  let best = 0, at = 0;
  for (let i = 0; i + window < x.length; i += window) {
    let e = 0;
    for (let k = i; k < i + window; k++) e += x[k]! ** 2;
    if (e > best) { best = e; at = i; }
  }
  const n = Math.min(Math.round(rate * 0.3), x.length - at);
  const seg = x.subarray(at, at + n);
  const maxLag = Math.min(Math.round(rate / 55), n >> 1);
  const minLag = Math.round(rate / 1600);
  const diff = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i += 2) { const d = seg[i]! - seg[i + lag]!; sum += d * d; }
    diff[lag] = sum;
  }
  let running = 0;
  const norm = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    running += diff[lag]!;
    norm[lag] = diff[lag]! * (lag - minLag + 1) / (running + 1e-20);
  }
  let chosen = -1;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (norm[lag]! < 0.15 && norm[lag]! <= norm[lag - 1]! && norm[lag]! <= norm[lag + 1]!) { chosen = lag; break; }
  }
  if (chosen < 0) {
    let low = Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) if (norm[lag]! < low) { low = norm[lag]!; chosen = lag; }
  }
  // Parabolic interpolation around the dip: a semitone is 6% of a period at
  // the top of the neck, and a sample of lag is more than that.
  const a = norm[chosen - 1] ?? norm[chosen]!, b = norm[chosen]!, c = norm[chosen + 1] ?? norm[chosen]!;
  const shift = (a - c) / (2 * (a - 2 * b + c) || 1e-9);
  return 69 + 12 * Math.log2(rate / (chosen + Math.max(-1, Math.min(1, shift))) / 440);
}

/**
 * Where the pick hits: the note's loudest point, then back to where the 1 ms
 * envelope falls under 5% of it. Reading an onset from a label instead cost a
 * week once — the notes started 80 ms late and the tab sounded hollow.
 */
function findAttack(x: Float32Array, rate: number): number {
  const ms = Math.round(rate / 1000);
  const env = (i: number): number => {
    let e = 0;
    for (let k = i; k < i + ms; k++) e += x[k]! ** 2;
    return Math.sqrt(e / ms);
  };
  let peak = 0, at = 0;
  for (let i = 0; i + ms < x.length; i += ms) { const e = env(i); if (e > peak) { peak = e; at = i; } }
  let i = at;
  while (i - ms > 0 && env(i - ms) > 0.05 * peak) i -= ms;
  const floor = 0.05 * peak;
  for (let k = Math.max(0, i - ms); k < i + ms && k < x.length; k++) if (Math.abs(x[k]!) > floor) return k;
  return i;
}

/** The note itself: from just before the pick to where the loop can take over. */
function cut(x: Float32Array, rate: number, keep: number): { data: Float32Array; attack: number } {
  const attack = findAttack(x, rate);
  const start = Math.max(0, attack - Math.round(GUARD * rate));
  const data = x.slice(start, Math.min(x.length, attack + Math.round(keep * rate)));
  const lead = attack - start;
  for (let i = 0; i < lead; i++) data[i]! *= 0.5 - 0.5 * Math.cos(Math.PI * i / lead);
  const fade = Math.min(data.length >> 2, Math.round(0.01 * rate));
  for (let i = 0; i < fade; i++) data[data.length - 1 - i]! *= i / fade;
  return { data, attack: lead };
}

/** Every file of one technique, by block number: EG-IPT records a string per block. */
function runs(folder: string, match: RegExp): Map<number, { fret: number; file: string }[]> {
  const dir = path.join(DATA!, PICKUP, 'DI', folder);
  const by = new Map<number, { fret: number; file: string }[]>();
  for (const file of fs.readdirSync(dir).sort()) {
    const m = match.exec(file);
    if (!m) continue;
    const block = Number(m[1]), index = Number(m[2]);
    // The index counts in twos from the open string: 02 is the nut, 04 the first fret.
    const list = by.get(block) ?? [];
    list.push({ fret: index / 2 - 1, file: path.join(dir, file) });
    by.set(block, list);
  }
  return by;
}

/**
 * Which string a block is, from what its notes sound rather than from its
 * number, and which of those notes to believe.
 *
 * A run is 23 notes climbing a semitone a fret, so the open note each one
 * implies should be the same. The ones that disagree are dropped — a detector
 * has a bad day on a note or two — and the run is refused outright if most of
 * them do, which is what a mis-read name or a wrong folder looks like.
 */
function stringOf(notes: { fret: number; pitch: number }[]): { string: number; keep: boolean[] } | null {
  const open = notes.map((n) => n.pitch - n.fret);
  const median = [...open].sort((a, b) => a - b)[open.length >> 1]!;
  const keep = open.map((o) => Math.abs(o - median) < 0.8);
  if (keep.filter(Boolean).length < notes.length * 0.6) return null;
  let best = -1, closest = 99;
  STRINGS.forEach((note, index) => {
    const off = Math.abs(note - median);
    if (off < closest) { closest = off; best = index; }
  });
  return closest < 1.2 ? { string: best, keep } : null;
}

function load(folder: string, match: RegExp, kind: SampleKind): Take[] {
  const out: Take[] = [];
  let refused = 0, dropped = 0;
  for (const files of runs(folder, match).values()) {
    const notes = files.map(({ fret, file }) => {
      const wav = readWav(file);
      if (wav.rate !== RATE * 2) throw new Error(`${file}: ${wav.rate} Hz, expected ${RATE * 2}`);
      const mono = halve(toMono(wav));
      const { data, attack } = cut(mono, RATE, KEEP[kind]);
      return { fret, data, attack, pitch: soundedPitch(data.subarray(attack), RATE) };
    });
    const run = stringOf(notes);
    if (run === null) { refused += notes.length; continue; }
    notes.forEach((n, i) => {
      if (!run.keep[i]) { dropped++; return; }
      // The fret says the note, now that the string is known: a detector is
      // good enough to identify a run, not to tune the bank.
      out.push({ kind, string: run.string, fret: n.fret, pitch: STRINGS[run.string]! + n.fret, harmonic: 1, attack: n.attack, data: n.data });
    });
  }
  if (refused > 0) console.log(`  ${folder}: ${refused} notes refused — the run does not climb a semitone a fret`);
  if (dropped > 0) console.log(`  ${folder}: ${dropped} notes dropped — they do not sound the note their name says`);
  return out;
}

/**
 * Harmonics are kept by the note they sound, not by which harmonic of which
 * fretted note they are: what the sampler needs is a ring at a pitch, and it
 * moves the nearest one to meet it.
 */
function loadHarmonics(): Take[] {
  const dir = path.join(DATA!, PICKUP, 'DI', 'harmonics');
  const out: Take[] = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!/harmonic_(\d+)-(\d+)_/.test(file)) continue;
    const wav = readWav(path.join(dir, file));
    const mono = halve(toMono(wav));
    const { data, attack } = cut(mono, RATE, KEEP.harmonic);
    const pitch = soundedPitch(data.subarray(attack), RATE);
    // A harmonic that reads as a low note is the fundamental leaking through:
    // the detector found the string, not the ring.
    if (!Number.isFinite(pitch) || pitch < 55) continue;
    out.push({ kind: 'harmonic', string: 0, fret: 0, pitch: Math.round(pitch), harmonic: 2, attack, data });
  }
  return out;
}

/** The loudest 20 ms of a note's first 150 ms. */
function attackLevel(t: Take): number {
  const w = Math.round(0.02 * RATE);
  let best = 0;
  for (let i = t.attack; i + w < Math.min(t.data.length, t.attack + 0.15 * RATE); i += w >> 1) {
    let e = 0;
    for (let k = i; k < i + w; k++) e += t.data[k]! ** 2;
    best = Math.max(best, Math.sqrt(e / w));
  }
  return best || 1e-6;
}

/**
 * Where a note can be held past its recording: a loop of whole periods taken
 * from the steady part, and the rate it was dying at, so what follows the loop
 * keeps dying the same way.
 */
function sustainOf(t: Take): Sustain | null {
  const w = Math.round(0.01 * RATE);
  const env: number[] = [];
  for (let a = t.attack; a + w <= t.data.length; a += w) {
    let e = 0;
    for (let k = a; k < a + w; k++) e += t.data[k]! ** 2;
    env.push(10 * Math.log10(e / w + 1e-20));
  }
  const smooth = env.map((_, i) => {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - 1); k <= Math.min(env.length - 1, i + 1); k++) { s += env[k]!; n++; }
    return s / n;
  });
  // The end of what was kept, or the point the player damped it, whichever comes first.
  let release = smooth.length - 3;
  for (let i = 15; i + 5 < smooth.length; i++) if (smooth[i + 5]! < smooth[i]! - 2.5) { release = i; break; }
  const period = RATE / (440 * Math.pow(2, (t.pitch - 69) / 12));
  const length = Math.max(1, Math.round(0.08 * RATE / period)) * period;
  const from = t.attack + (release - 1) * w - length;
  if (from <= t.attack + 0.06 * RATE) return null;
  const i0 = 10, i1 = Math.max(i0 + 3, release - 2);
  const slope = (smooth[i1]! - smooth[i0]!) / ((i1 - i0) * 0.01);
  return {
    from: Math.round(from), length, crossfade: Math.min(length * 0.5, 0.012 * RATE),
    // What a string into a high-gain amp does, whatever the recording's own end says.
    decayDb: Math.max(-8, Math.min(-2, slope)),
  };
}

/**
 * log(muted / open) per band and frame, from the pairs at the same fret.
 *
 * The bank has a real mute at every fret, so this is not what plays a palm
 * mute — it is what covers the notes no string of this guitar can reach: the
 * low B of a seven-string, the F# of an eight. Resampling a mute that far down
 * drags its pick click and its pickup resonance with it (14.9 dB from a real
 * mute against 12.2 between two real takes); the mask does not.
 */
function learnPalm(open: Take[], muted: Take[]): PalmMask {
  const acc: Float64Array[] = [];
  let pairs = 0;
  for (const mute of muted) {
    const pair = open.find((o) => o.string === mute.string && o.fret === mute.fret);
    if (!pair) continue;
    const ref = envelopes(pair.data, pair.attack, RATE);
    const got = envelopes(mute.data, mute.attack, RATE);
    if (acc.length === 0) for (const _ of ref) acc.push(new Float64Array(FRAMES));
    got.forEach((band, b) => band.forEach((v, f) => { acc[b]![f]! += Math.log(v / ref[b]![f]!); }));
    pairs++;
  }
  if (pairs === 0) throw new Error('No open/muted pair to learn the palm from.');
  return acc.map((band) => {
    const raw = Array.from(band, (v) => v / pairs);
    return raw.map((_, f) => {
      let s = 0, n = 0;
      for (let k = Math.max(0, f - 3); k <= Math.min(FRAMES - 1, f + 3); k++) { s += raw[k]!; n++; }
      return Math.round(s / n * 1000) / 1000;
    });
  });
}

const picked = load('ordinario', /_ordinario_(\d+)-(\d+)_/, 'pick');
const muted = load('muted', /_muted_(\d+)-(\d+)_/, 'mute');
const harmonics = loadHarmonics();
console.log(`read ${picked.length} picked, ${muted.length} muted, ${harmonics.length} harmonics from ${PICKUP}`);
if (picked.length === 0 || muted.length === 0) throw new Error('Nothing to build a bank from.');

// Even out the recording's level note to note, never its character: each note
// is brought to the median of its own string and kind, by at most 6 dB.
for (const group of [picked, muted, harmonics]) {
  for (let s = 0; s < STRINGS.length; s++) {
    const row = group.filter((t) => t.string === s);
    if (row.length === 0) continue;
    const levels = row.map(attackLevel);
    const median = [...levels].sort((a, b) => a - b)[levels.length >> 1]!;
    row.forEach((t, i) => {
      const g = Math.min(2, Math.max(0.5, median / levels[i]!));
      for (let k = 0; k < t.data.length; k++) t.data[k]! *= g;
    });
  }
}

const palm = STRINGS.map((_, s) => learnPalm(picked.filter((t) => t.string === s), muted.filter((t) => t.string === s)));

const all = [...picked, ...muted, ...harmonics];
const samples: BankIndex['samples'][number][] = [];
let at = 0;
for (const t of all) {
  samples.push({
    kind: t.kind, string: t.string, fret: t.fret, pitch: t.pitch, harmonic: t.harmonic, attack: t.attack,
    at, length: t.data.length, sustain: sustainOf(t),
  });
  at += t.data.length;
}
const index: BankIndex = {
  version: BANK_VERSION, rate: RATE, guitar: `EG-IPT ${PICKUP}`, strings: STRINGS,
  palm: palm as number[][][], samples,
};
const pcm = encodePcm(all.map((t) => t.data));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'bank.json'), JSON.stringify(index));
fs.writeFileSync(path.join(OUT, 'bank.pcm'), Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
const held = samples.filter((s) => s.sustain).length;
console.log(`public/di-bank: ${samples.length} notes (${held} can be held), ${(pcm.byteLength / 1e6).toFixed(1)} MB of samples`
  + ` + ${(JSON.stringify(index).length / 1e3).toFixed(0)} kB of index, ${RATE} Hz`);
