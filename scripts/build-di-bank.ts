/**
 * Builds `public/di-bank/` from recordings of one guitar.
 *
 * Everything the player's machine would otherwise have to work out is
 * measured here: where each pick actually lands, how loud each note is against
 * its neighbours, where a note can be looped to hold it past its recording,
 * and what the palm does to each string. The result is two files the render
 * worker reads straight into memory.
 *
 * The source layout is the one of IDMT-SMT-Guitar dataset 2 (a WAV of a run of
 * notes plus an XML of onsets). That dataset is CC BY-NC-ND: it is what this
 * was developed against and it cannot be published with the site, so the
 * directory is given on the command line and the built bank is not committed.
 *
 *   npx tsx scripts/build-di-bank.ts <dataset dir> [--guitar LP]
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
const GUITAR = (args.includes('--guitar') ? args[args.indexOf('--guitar') + 1] : 'LP') ?? 'LP';
if (!DATA) {
  console.error('Usage: npx tsx scripts/build-di-bank.ts <dataset dir> [--guitar LP]');
  process.exit(1);
}

/** Standard tuning, as the dataset numbers its strings. */
const STRINGS = [40, 45, 50, 55, 59, 64];
const STRING_FILES = ['E', 'A', 'D', 'G', 'B', 'E1'];
/** The harmonic each of the dataset's fret positions sounds. */
const HARMONIC_OF_FRET: Record<number, number> = { 12: 2, 7: 3, 5: 4, 4: 5, 9: 5 };
/** Pre-roll kept before the pick, faded in. */
const GUARD = 0.002;

interface Annotated { onset: number; offset: number; pitch: number; string: number; fret: number }
interface Cut { kind: SampleKind; string: number; fret: number; pitch: number; harmonic: number; attack: number; data: Float32Array }

function annotations(file: string): Annotated[] {
  const xml = fs.readFileSync(file, 'utf8');
  const seen = new Set<number>();
  const out: Annotated[] = [];
  for (const m of xml.matchAll(/<event>([\s\S]*?)<\/event>/g)) {
    const get = (tag: string): string => (new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(m[1]!) ?? [])[1] ?? '';
    const onset = Number(get('onsetSec'));
    // Some of the files repeat their last events.
    if (seen.has(onset)) continue;
    seen.add(onset);
    out.push({ onset, offset: Number(get('offsetSec')), pitch: Number(get('pitch')), string: Number(get('stringNumber')) - 1, fret: Number(get('fretNumber')) });
  }
  return out.sort((a, b) => a.onset - b.onset);
}

/**
 * Where the pick actually hits. The dataset's onsets can be 100 ms early, and
 * taking them at face value put 50 to 100 ms of near-silence in front of every
 * note: on a sixteenth at 138 bpm the note was over before it sounded. So the
 * note's loudest point is found first, in a wide window, and the attack is
 * where the 1 ms envelope, walked back from it, falls under 5% of that peak.
 */
function findAttack(x: Float32Array, around: number, until: number, rate: number): number {
  const ms = Math.round(rate / 1000);
  const from = Math.max(ms, around - 60 * ms);
  const to = Math.min(x.length - ms, around + 300 * ms, until);
  const env = (i: number): number => {
    let e = 0;
    for (let k = i; k < i + ms; k++) e += x[k]! ** 2;
    return Math.sqrt(e / ms);
  };
  let peak = 0, at = around;
  for (let i = from; i < to; i += ms) { const e = env(i); if (e > peak) { peak = e; at = i; } }
  let i = at;
  while (i - ms > from && env(i - ms) > 0.05 * peak) i -= ms;
  const floor = 0.05 * peak;
  for (let k = Math.max(0, i - ms); k < i + ms; k++) if (Math.abs(x[k]!) > floor) return k;
  return i;
}

function cut(x: Float32Array, a: Annotated, next: number, kind: SampleKind, rate: number): Cut {
  const attack = findAttack(x, Math.round(a.onset * rate), Math.round((next - 0.01) * rate), rate);
  const start = Math.max(0, attack - Math.round(GUARD * rate));
  // Never reach into the next note's pick.
  const end = Math.min(x.length, Math.round(Math.min(a.offset + 0.05, next - 0.01) * rate));
  const data = x.slice(start, end);
  const lead = attack - start;
  for (let i = 0; i < lead; i++) data[i]! *= 0.5 - 0.5 * Math.cos(Math.PI * i / lead);
  const fade = Math.min(data.length >> 2, Math.round(0.01 * rate));
  for (let i = 0; i < fade; i++) data[data.length - 1 - i]! *= i / fade;
  const harmonic = kind === 'harmonic' ? HARMONIC_OF_FRET[a.fret] ?? 2 : 1;
  return { kind, string: a.string, fret: a.fret, pitch: a.pitch, harmonic, attack: lead, data };
}

function load(name: string, kind: SampleKind): { cuts: Cut[]; rate: number } {
  const wav = readWav(path.join(DATA!, 'audio', `${name}.wav`));
  const x = toMono(wav);
  const ann = annotations(path.join(DATA!, 'annotation', `${name}.xml`));
  const cuts = ann.map((a, i) => cut(x, a, ann[i + 1]?.onset ?? x.length / wav.rate, kind, wav.rate));
  return { cuts, rate: wav.rate };
}

/** The loudest 20 ms of a note's first 150 ms. */
function attackLevel(c: Cut, rate: number): number {
  const w = Math.round(0.02 * rate);
  let best = 0;
  for (let i = c.attack; i + w < Math.min(c.data.length, c.attack + 0.15 * rate); i += w >> 1) {
    let e = 0;
    for (let k = i; k < i + w; k++) e += c.data[k]! ** 2;
    best = Math.max(best, Math.sqrt(e / w));
  }
  return best || 1e-6;
}

/**
 * Where a note can be held past its end.
 *
 * The recordings last under a second and finish with the player damping the
 * string, so the loop is not taken at the end — it is taken just before that
 * release, where the note still rings, and past it the note keeps dying at the
 * rate it had. A whole number of periods, so the loop is pitch-synchronous.
 */
function sustainOf(c: Cut, rate: number): Sustain | null {
  const w = Math.round(0.01 * rate);
  const env: number[] = [];
  for (let a = c.attack; a + w <= c.data.length; a += w) {
    let e = 0;
    for (let k = a; k < a + w; k++) e += c.data[k]! ** 2;
    env.push(10 * Math.log10(e / w + 1e-20));
  }
  // Smoothed over 30 ms, or a low string's own period reads as a release.
  const smooth = env.map((_, i) => {
    let t = 0, n = 0;
    for (let k = Math.max(0, i - 1); k <= Math.min(env.length - 1, i + 1); k++) { t += env[k]!; n++; }
    return t / n;
  });
  let release = smooth.length - 3;
  for (let i = 15; i + 5 < smooth.length; i++) if (smooth[i + 5]! < smooth[i]! - 2.5) { release = i; break; }
  const period = rate / (440 * Math.pow(2, (c.pitch - 69) / 12));
  const length = Math.max(1, Math.round(0.08 * rate / period)) * period;
  const from = c.attack + (release - 1) * w - length;
  if (from <= c.attack + 0.06 * rate) return null;
  const i0 = 10, i1 = Math.max(i0 + 3, release - 2);
  const slope = (smooth[i1]! - smooth[i0]!) / ((i1 - i0) * 0.01);
  return {
    from: Math.round(from), length, crossfade: Math.min(length * 0.5, 0.012 * rate),
    // What a string into a high-gain amp does, whatever the recording's own end says.
    decayDb: Math.max(-8, Math.min(-2, slope)),
  };
}

/** log(muted / open) per band and frame, averaged over a string's muted takes. */
function learnPalm(open: Cut, muted: Cut[], rate: number): PalmMask {
  const ref = envelopes(open.data, open.attack, rate);
  const acc = ref.map(() => new Float64Array(FRAMES));
  for (const m of muted) {
    const e = envelopes(m.data, m.attack, rate);
    e.forEach((band, b) => band.forEach((v, f) => { acc[b]![f]! += Math.log(v / ref[b]![f]!); }));
  }
  // Smoothed over time: the mask is the palm, not one take of it.
  return acc.map((band) => {
    const raw = Array.from(band, (v) => v / muted.length);
    return raw.map((_, f) => {
      let s = 0, n = 0;
      for (let k = Math.max(0, f - 3); k <= Math.min(FRAMES - 1, f + 3); k++) { s += raw[k]!; n++; }
      return Math.round(s / n * 1000) / 1000;
    });
  });
}

const picked = STRING_FILES.map((n) => load(`${GUITAR}_${n}_fret_0-20`, 'pick'));
const muted = STRING_FILES.map((n) => load(`${GUITAR}_${n}_muted5`, 'pick'));
const rate = picked[0]!.rate;
if (picked.some((p) => p.rate !== rate) || muted.some((p) => p.rate !== rate)) throw new Error('The recordings are not all at one sample rate.');
const dead = load(`${GUITAR}_DN_III_VIII_XIV`, 'dead').cuts;
const harmonics = ['IV', 'V', 'VII', 'IX', 'XII'].flatMap((f) => load(`${GUITAR}_NH_${f}`, 'harmonic').cuts);

// Even out the recording's level note to note, never its character: each note
// is brought to the median of its own string, by at most 6 dB.
for (const row of [...picked.map((p) => p.cuts), ...muted.map((p) => p.cuts)]) {
  const levels = row.map((c) => attackLevel(c, rate));
  const median = [...levels].sort((a, b) => a - b)[levels.length >> 1]!;
  row.forEach((c, i) => {
    const g = Math.min(2, Math.max(0.5, median / levels[i]!));
    for (let k = 0; k < c.data.length; k++) c.data[k]! *= g;
  });
}

const palm = STRINGS.map((_, s) => {
  const open = picked[s]!.cuts.find((c) => c.fret === 5);
  const takes = muted[s]!.cuts;
  if (!open || takes.length === 0) throw new Error(`No 5th-fret pair to learn the palm from on string ${s + 1}.`);
  return learnPalm(open, takes, rate);
});

const all: Cut[] = [...picked.flatMap((p) => p.cuts), ...dead, ...harmonics];
const samples: BankIndex['samples'][number][] = [];
let at = 0;
for (const c of all) {
  samples.push({
    kind: c.kind, string: c.string, fret: c.fret, pitch: c.pitch, harmonic: c.harmonic, attack: c.attack,
    at, length: c.data.length, sustain: c.kind === 'dead' ? null : sustainOf(c, rate),
  });
  at += c.data.length;
}
const index: BankIndex = { version: BANK_VERSION, rate, guitar: GUITAR, strings: STRINGS, palm: palm as number[][][], samples };
const pcm = encodePcm(all.map((c) => c.data));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'bank.json'), JSON.stringify(index));
fs.writeFileSync(path.join(OUT, 'bank.pcm'), Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
const held = samples.filter((s) => s.sustain).length;
console.log(`public/di-bank: ${samples.length} notes (${held} can be held), ${(pcm.byteLength / 1e6).toFixed(1)} MB of samples + ${(JSON.stringify(index).length / 1e3).toFixed(0)} kB of index, ${rate} Hz, guitar ${GUITAR}`);
