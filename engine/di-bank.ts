/**
 * The DI bank: real notes of one electric guitar, straight out of its pickup.
 *
 * What a tab needs from a guitar is not a note per pitch but a note per
 * gesture: picked, dead, harmonic, on a known string. The bank holds those,
 * one guitar throughout so nothing changes character from note to note, plus
 * the palm mask per string (`di-palm.ts`), which stands in for the muted notes
 * a bank of any size could not hold at every fret.
 *
 * Two files, built by `scripts/build-di-bank.ts`: a JSON index and one block
 * of 16-bit samples. 16-bit because the noise it adds sits around -96 dBFS,
 * far under the gate of any tone, and it halves what the player downloads.
 * Nothing is analysed at load time — attacks, sustain loops and masks are all
 * measured when the bank is built.
 */
import type { PalmMask } from './di-palm.ts';

export const BANK_VERSION = 1;

export type SampleKind = 'pick' | 'dead' | 'harmonic';

/** How a note is held past its recorded end (`null`: it cannot be). */
export interface Sustain {
  /** Where the loop starts, in samples from the note's start. */
  readonly from: number;
  readonly length: number;
  readonly crossfade: number;
  /** How fast it keeps dying once looping, dB per second. */
  readonly decayDb: number;
}

export interface BankSample {
  readonly kind: SampleKind;
  /** 0 is the lowest string of the guitar that was recorded. */
  readonly string: number;
  readonly fret: number;
  /** MIDI note it sounds, the harmonic's own pitch for a harmonic. */
  readonly pitch: number;
  /** 2 is the octave harmonic; 1 for everything else. */
  readonly harmonic: number;
  /** Where the pick lands, in samples from the start of `data`. */
  readonly attack: number;
  readonly data: Float32Array<ArrayBuffer>;
  readonly sustain: Sustain | null;
}

export interface Bank {
  readonly rate: number;
  readonly guitar: string;
  /** Open notes of the recorded strings, lowest first. */
  readonly strings: readonly number[];
  /** [string][fret]. */
  readonly picked: readonly (readonly BankSample[])[];
  /** [string][take]. */
  readonly dead: readonly (readonly BankSample[])[];
  /** [string][take], one per harmonic number. */
  readonly harmonics: readonly (readonly BankSample[])[];
  /** [string]. */
  readonly palm: readonly PalmMask[];
}

/** The JSON half of the bank file. */
export interface BankIndex {
  readonly version: number;
  readonly rate: number;
  readonly guitar: string;
  readonly strings: readonly number[];
  readonly palm: readonly number[][][];
  readonly samples: readonly {
    readonly kind: SampleKind;
    readonly string: number;
    readonly fret: number;
    readonly pitch: number;
    readonly harmonic: number;
    readonly attack: number;
    /** Offset and length in the PCM block, in samples. */
    readonly at: number;
    readonly length: number;
    readonly sustain: Sustain | null;
  }[];
}

const INT16 = 32768;

export function encodePcm(parts: readonly Float32Array[]): Int16Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) out[at + i] = Math.max(-INT16, Math.min(INT16 - 1, Math.round(p[i]! * INT16)));
    at += p.length;
  }
  return out;
}

/** The bank, ready to play: the index with its samples attached. */
export function decodeBank(index: BankIndex, pcm: Int16Array): Bank {
  if (index.version !== BANK_VERSION) throw new Error(`DI bank version ${index.version}, expected ${BANK_VERSION}`);
  const rows = (): BankSample[][] => index.strings.map(() => []);
  const picked = rows(), dead = rows(), harmonics = rows();
  for (const s of index.samples) {
    const data = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) data[i] = pcm[s.at + i]! / INT16;
    const sample: BankSample = { kind: s.kind, string: s.string, fret: s.fret, pitch: s.pitch, harmonic: s.harmonic, attack: s.attack, data, sustain: s.sustain };
    const into = s.kind === 'pick' ? picked : s.kind === 'dead' ? dead : harmonics;
    (into[s.string] ??= []).push(sample);
  }
  for (const row of picked) row.sort((a, b) => a.fret - b.fret);
  return { rate: index.rate, guitar: index.guitar, strings: index.strings, picked, dead, harmonics, palm: index.palm };
}

/**
 * Fetches the bank. Called from the tab render worker on the first tab
 * played, never on page load: it is the same deal the soundfont has.
 */
export async function fetchBank(base: string): Promise<Bank> {
  const [index, pcm] = await Promise.all([
    fetch(`${base}di-bank/bank.json`).then((r) => {
      if (!r.ok) throw new Error(`The guitar samples could not be loaded (${r.status}).`);
      return r.json() as Promise<BankIndex>;
    }),
    fetch(`${base}di-bank/bank.pcm`).then((r) => {
      if (!r.ok) throw new Error(`The guitar samples could not be loaded (${r.status}).`);
      return r.arrayBuffer();
    }),
  ]);
  return decodeBank(index, new Int16Array(pcm));
}
