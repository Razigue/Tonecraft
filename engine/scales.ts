/**
 * Scales, and where they lie on a neck.
 *
 * Pure: no DOM and no alphaTab, so it is tested in Node. Pitches are MIDI note
 * numbers, which is what alphaTab's tunings are made of, and a pitch class is
 * that number modulo twelve, 0 being C.
 *
 * Coordinates are the ones a played note arrives in: strings numbered from the
 * lowest (1), frets counted from the capo. alphaTab sounds a note at
 * `tuning + capo + fret`, so a position computed any other way would light a
 * scale one capo away from the notes being played over it.
 */

/** One spelling per pitch class, the one the neck already prints. */
export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const;

/**
 * All twelve keys. Both spellings where there are two: the list is for finding
 * a key, and a player looks for the name they know it by.
 */
export const KEYS = [
  { root: 0, label: 'C' },
  { root: 1, label: 'C♯ / D♭' },
  { root: 2, label: 'D' },
  { root: 3, label: 'D♯ / E♭' },
  { root: 4, label: 'E' },
  { root: 5, label: 'F' },
  { root: 6, label: 'F♯ / G♭' },
  { root: 7, label: 'G' },
  { root: 8, label: 'G♯ / A♭' },
  { root: 9, label: 'A' },
  { root: 10, label: 'A♯ / B♭' },
  { root: 11, label: 'B' },
] as const;

export type ScaleGroup = 'Essentials' | 'Modes' | 'Colours';
export const SCALE_GROUPS: readonly ScaleGroup[] = ['Essentials', 'Modes', 'Colours'];

export interface Scale {
  readonly id: string;
  readonly name: string;
  readonly group: ScaleGroup;
  /** Semitones above the root, ascending, starting at 0. */
  readonly intervals: readonly number[];
}

/**
 * What a guitarist reaches for first, then the modes, then the colours metal
 * and jazz players ask for by name. Ionian and Aeolian are not listed twice:
 * they are the major and the natural minor.
 */
export const SCALES: readonly Scale[] = [
  { id: 'major', name: 'Major', group: 'Essentials', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'natural-minor', name: 'Natural minor', group: 'Essentials', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'minor-pentatonic', name: 'Minor pentatonic', group: 'Essentials', intervals: [0, 3, 5, 7, 10] },
  { id: 'major-pentatonic', name: 'Major pentatonic', group: 'Essentials', intervals: [0, 2, 4, 7, 9] },
  { id: 'blues', name: 'Blues', group: 'Essentials', intervals: [0, 3, 5, 6, 7, 10] },
  { id: 'major-blues', name: 'Major blues', group: 'Essentials', intervals: [0, 2, 3, 4, 7, 9] },
  { id: 'harmonic-minor', name: 'Harmonic minor', group: 'Essentials', intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodic-minor', name: 'Melodic minor', group: 'Essentials', intervals: [0, 2, 3, 5, 7, 9, 11] },

  { id: 'dorian', name: 'Dorian', group: 'Modes', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', name: 'Phrygian', group: 'Modes', intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', name: 'Lydian', group: 'Modes', intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', name: 'Mixolydian', group: 'Modes', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'locrian', name: 'Locrian', group: 'Modes', intervals: [0, 1, 3, 5, 6, 8, 10] },

  { id: 'phrygian-dominant', name: 'Phrygian dominant', group: 'Colours', intervals: [0, 1, 4, 5, 7, 8, 10] },
  { id: 'hungarian-minor', name: 'Hungarian minor', group: 'Colours', intervals: [0, 2, 3, 6, 7, 8, 11] },
  { id: 'whole-tone', name: 'Whole tone', group: 'Colours', intervals: [0, 2, 4, 6, 8, 10] },
  { id: 'diminished-half-whole', name: 'Diminished (half-whole)', group: 'Colours', intervals: [0, 1, 3, 4, 6, 7, 9, 10] },
  { id: 'diminished-whole-half', name: 'Diminished (whole-half)', group: 'Colours', intervals: [0, 2, 3, 5, 6, 8, 9, 11] },
];

const pc = (n: number): number => ((n % 12) + 12) % 12;

export function scaleById(id: string): Scale | undefined {
  return SCALES.find((s) => s.id === id);
}

/** The scale's pitch classes, in order from the root. */
export function pitchClasses(root: number, scale: Scale): number[] {
  return scale.intervals.map((i) => pc(root + i));
}

/** The scale spelled out, root first: what the player reads next to the neck. */
export function scaleNoteNames(root: number, scale: Scale): string[] {
  return pitchClasses(root, scale).map((p) => NOTE_NAMES[p]!);
}

export interface NeckNote {
  /** From the lowest string, 1-based, as alphaTab numbers them. */
  readonly string: number;
  /** From the capo. */
  readonly fret: number;
  readonly root: boolean;
}

/**
 * Every place on the neck the scale can be played, up to `frets` counted from
 * the nut. `tuning` is alphaTab's: highest string first. Positions behind a
 * capo cannot be played and are not returned.
 */
export function scaleOnNeck(
  tuning: readonly number[], capo: number, root: number, scale: Scale, frets = 24,
): NeckNote[] {
  const inScale = new Set(pitchClasses(root, scale));
  const tonic = pc(root);
  const out: NeckNote[] = [];
  const count = tuning.length;
  for (let string = 1; string <= count; string++) {
    const open = tuning[count - string]! + capo;
    for (let fret = 0; capo + fret <= frets; fret++) {
      const p = pc(open + fret);
      if (inScale.has(p)) out.push({ string, fret, root: p === tonic });
    }
  }
  return out;
}

/**
 * The tonic of a key signature: sharps and flats counted as alphaTab stores
 * them (-7 for seven flats, +7 for seven sharps). Each sharp is a fifth up,
 * and a minor key is the relative minor, a minor third below its major.
 */
export function keyOfSignature(signature: number, minor: boolean): number {
  const major = pc(signature * 7);
  return minor ? pc(major + 9) : major;
}
