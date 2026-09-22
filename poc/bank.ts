/**
 * The sample bank: real DI notes cut out of IDMT-SMT-Guitar (dataset 2), one
 * guitar, so every note comes from the same instrument and pickup.
 *
 * IDMT-SMT-Guitar is CC BY-NC-ND 4.0 (Fraunhofer IDMT): usable for this local
 * proof of concept, never shippable as is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readWav, toMono } from '../render/wav.ts';

export const DATA = process.env.IDMT ?? '/home/shinkei/Downloads/tonecraft-poc-data/IDMT-SMT-GUITAR_V2/dataset2';
export const SRC_RATE = 44100;
/** Standard tuning, string 1 = low E, as the dataset numbers them. */
export const SRC_OPEN = [40, 45, 50, 55, 59, 64];

export type Tech = 'PK' | 'MU' | 'DN' | 'HA';

export interface Sample {
  readonly pitch: number;
  /** 0 = low E. */
  readonly string: number;
  readonly fret: number;
  readonly tech: Tech;
  /** From just before the attack to the annotated end. */
  readonly data: Float32Array;
  /** Where the attack lands in `data`. */
  readonly attack: number;
  /** Harmonic number, for HA. */
  readonly harmonic: number;
}

const HARMONIC_OF_FRET: Record<number, number> = { 12: 2, 7: 3, 5: 4, 4: 5, 9: 5 };

interface Annotated { onset: number; offset: number; pitch: number; string: number; fret: number; exc: string; expr: string }

function annotations(file: string): Annotated[] {
  const xml = fs.readFileSync(file, 'utf8');
  const out: Annotated[] = [];
  for (const m of xml.matchAll(/<event>([\s\S]*?)<\/event>/g)) {
    const get = (tag: string) => (m[1]!.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) ?? [])[1] ?? '';
    out.push({ onset: +get('onsetSec'), offset: +get('offsetSec'), pitch: +get('pitch'), string: +get('stringNumber') - 1,
      fret: +get('fretNumber'), exc: get('excitationStyle'), expr: get('expressionStyle') });
  }
  return out;
}

/** The first sample, near the annotated onset, where the note actually starts. */
function findAttack(x: Float32Array, around: number): number {
  const from = Math.max(0, around - Math.round(0.04 * SRC_RATE)), to = Math.min(x.length, around + Math.round(0.06 * SRC_RATE));
  let peak = 0;
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(x[i]!));
  // Ignore what is still ringing from the note before: look for the jump.
  let env = 0;
  for (let i = from; i < to; i++) {
    const a = Math.abs(x[i]!);
    if (a > 0.25 * peak && a > 3 * env + 1e-4) return i;
    env = Math.max(a, env * 0.999);
  }
  return around;
}

function cut(x: Float32Array, a: Annotated, next: number, tech: Tech, guard = 0.002): Sample {
  const attack = findAttack(x, Math.round(a.onset * SRC_RATE));
  const pre = Math.round(guard * SRC_RATE);
  const start = Math.max(0, attack - pre);
  // The next note's pick must not be in this one: stop a little before it.
  const end = Math.min(x.length, Math.round(Math.min(a.offset + 0.05, next - 0.01) * SRC_RATE));
  const data = x.slice(start, end);
  // The pre-roll starts mid-waveform (the string was still moving): fade it in.
  const lead = attack - start;
  for (let i = 0; i < lead; i++) data[i]! *= 0.5 - 0.5 * Math.cos(Math.PI * i / lead);
  const fade = Math.min(data.length >> 2, Math.round(0.01 * SRC_RATE));
  for (let i = 0; i < fade; i++) data[data.length - 1 - i]! *= i / fade;
  return { pitch: a.pitch, string: a.string, fret: a.fret, tech, data, attack: attack - start, harmonic: tech === 'HA' ? HARMONIC_OF_FRET[a.fret] ?? 2 : 1 };
}

function load(name: string, tech: Tech, filter: (a: Annotated) => boolean = () => true): Sample[] {
  const x = toMono(readWav(path.join(DATA, 'audio', `${name}.wav`)));
  const ann = annotations(path.join(DATA, 'annotation', `${name}.xml`));
  // Some files repeat their last events in the XML.
  const seen = new Set<string>();
  const unique = ann.filter((a) => { const k = `${a.onset}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.onset - b.onset);
  return unique.map((a, i) => ({ a, next: unique[i + 1]?.onset ?? x.length / SRC_RATE }))
    .filter(({ a }) => filter(a)).map(({ a, next }) => cut(x, a, next, tech));
}

export interface Bank {
  readonly picked: Sample[][];   // [string][fret]
  readonly muted: Sample[][];    // [string][take]
  readonly dead: Sample[][];     // [string][...]
  readonly harmonics: Sample[][]; // [string][...]
}

export function loadBank(guitar = 'LP'): Bank {
  const names = ['E', 'A', 'D', 'G', 'B', 'E1'];
  const picked = names.map((n) => load(`${guitar}_${n}_fret_0-20`, 'PK').sort((a, b) => a.fret - b.fret));
  const muted = names.map((n) => load(`${guitar}_${n}_muted5`, 'MU'));
  const dn = load(`${guitar}_DN_III_VIII_XIV`, 'DN');
  const dead = names.map((_, s) => dn.filter((d) => d.string === s));
  const ha = ['IV', 'V', 'VII', 'IX', 'XII'].flatMap((f) => load(`${guitar}_NH_${f}`, 'HA'));
  const harmonics = names.map((_, s) => ha.filter((h) => h.string === s));
  // Even out the recording's level from note to note, not its character:
  // each picked note is brought to its string's median attack level.
  for (const row of [...picked, ...muted]) {
    const lv = row.map(attackLevel);
    const med = [...lv].sort((a, b) => a - b)[lv.length >> 1]!;
    row.forEach((s, i) => { const g = Math.min(2, Math.max(0.5, med / lv[i]!)); for (let k = 0; k < s.data.length; k++) s.data[k]! *= g; });
  }
  return { picked, muted, dead, harmonics };
}

export function attackLevel(s: Sample): number {
  let best = 0;
  const w = Math.round(0.02 * SRC_RATE);
  for (let i = s.attack; i + w < Math.min(s.data.length, s.attack + 0.15 * SRC_RATE); i += w >> 1) {
    let e = 0; for (let k = i; k < i + w; k++) e += s.data[k]! ** 2;
    best = Math.max(best, Math.sqrt(e / w));
  }
  return best || 1e-6;
}
