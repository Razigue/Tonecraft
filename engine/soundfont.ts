/**
 * Makes the tab reader's soundfont play under alphaTab the way it was voiced.
 *
 * MuseScore_General is voiced for FluidSynth, and alphaTab's synthesizer
 * differs from it in three ways that meet in its acoustic pianos. Each is
 * corrected here on the bytes in memory, before alphaTab reads them: the
 * committed file stays the unmodified third-party asset `assets/README.md`
 * records, and nothing is added to git history.
 *
 * 1. **Stereo samples.** The pianos, and a few percussion samples, are stereo
 *    pairs: a left and a right sample per note. alphaTab only loads samples
 *    typed mono and skipped these — a console warning per sample, and empty
 *    piano voices that render NaN. One NaN voice turns the whole mix to NaN,
 *    so a tab with a piano anywhere in it played nothing at all. Retyping the
 *    halves as mono is enough: each already plays from its own panned zone.
 *
 * 2. **Global zones.** A SoundFont's global zone holds defaults that a local
 *    zone's own value replaces. alphaTab adds them instead, so an attenuation
 *    set in both counts twice — 23 dB too much on the piano.
 *
 * 3. **Modulators.** alphaTab reads them and applies none. The pianos rely on
 *    them to open a low-pass that the instruments set at 246-300 Hz: key-
 *    tracked modulators raise it by 1929 to 8000 cents across the keyboard.
 *    Without them a piano is a muffled thump, 30 dB quiet in the treble.
 *
 * Corrections 2 and 3 are applied to the pianos only — the presets built on
 * the stereo samples, outside the percussion bank, and the instruments they
 * use. Other instruments carry some of the same differences, but nobody has
 * listened to what changing them does, and this is not the place to find out.
 *
 * Measured through alphaTab's own synthesizer (`soundfont.test.ts`): a forte
 * A3 on the grand piano went from -72.9 dB to -27.9 dB, next to -22.9 for the
 * electric piano; its dynamics rise from ppp to fff instead of p being louder
 * than mf; and the other instruments render bit-identical.
 */

/** Sample type bits, SoundFont 2.04 §7.10, plus the SF3 compression flag. */
const MONO = 0x0001;
const RIGHT = 0x0002;
const LEFT = 0x0004;
const LINKED = 0x0008;
const VORBIS = 0x0010;
const ROM = 0x8000;

/** Generator numbers, SoundFont 2.04 §8.1.3. */
const GEN_FILTER_FC = 8;
const GEN_ATTENUATION = 48;
const GEN_INSTRUMENT = 41;
const GEN_SAMPLE = 53;
/** alphaTab switches its low-pass off above this cutoff, in absolute cents (20 kHz). */
const FILTER_OPEN = 13500;

const PERCUSSION_BANK = 128;

interface Chunk { readonly at: number; readonly size: number }

/** The sub-chunks of pdta, by id. Throws on bytes that are not a SoundFont. */
function hydra(bytes: Uint8Array): { view: DataView; chunks: Map<string, Chunk> } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'sfbk') throw new Error('not a SoundFont');
  const chunks = new Map<string, Chunk>();
  const end = Math.min(bytes.length, 8 + view.getUint32(4, true));
  for (let at = 12; at + 8 <= end;) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === 'LIST' && tag(at + 8) === 'pdta') {
      const listEnd = Math.min(end, at + 8 + size);
      for (let sub = at + 12; sub + 8 <= listEnd;) {
        const subSize = view.getUint32(sub + 4, true);
        chunks.set(tag(sub), { at: sub + 8, size: subSize });
        sub += 8 + subSize + (subSize & 1);
      }
    }
    at += 8 + size + (size & 1);
  }
  if (!chunks.has('shdr')) throw new Error('the SoundFont has no sample headers');
  return { view, chunks };
}

/** A zone list — a preset's or an instrument's — as the generator indices of each zone. */
function zonesOf(view: DataView, chunks: Map<string, Chunk>, kind: 'preset' | 'instrument', index: number): number[][] {
  const [hdr, hdrSize, bagOffset, bag] = kind === 'preset' ? ['phdr', 38, 24, 'pbag'] : ['inst', 22, 20, 'ibag'];
  const h = chunks.get(hdr)!, b = chunks.get(bag)!;
  const first = view.getUint16(h.at + index * hdrSize + bagOffset, true);
  const last = view.getUint16(h.at + (index + 1) * hdrSize + bagOffset, true);
  const zones: number[][] = [];
  for (let z = first; z < last; z++) {
    const gens: number[] = [];
    for (let g = view.getUint16(b.at + z * 4, true); g < view.getUint16(b.at + (z + 1) * 4, true); g++) gens.push(g);
    zones.push(gens);
  }
  return zones;
}

/**
 * Retypes every stereo or linked sample as mono, in place. Returns how many
 * were changed.
 */
export function monoSoundFont(bytes: Uint8Array): number {
  const { view, chunks } = hydra(bytes);
  return retype(view, chunks.get('shdr')!, stereoSamples(view, chunks.get('shdr')!));
}

/** Sample header record: 20 bytes of name, five u32, two bytes, u16 link, u16 type. */
const SHDR_SIZE = 46;
const TYPE_OFFSET = 44;

function stereoSamples(view: DataView, shdr: Chunk): Set<number> {
  const stereo = new Set<number>();
  // The last record is the terminal "EOS" header, never a sample.
  const records = Math.floor(shdr.size / SHDR_SIZE) - 1;
  for (let i = 0; i < records; i++) {
    const type = view.getUint16(shdr.at + i * SHDR_SIZE + TYPE_OFFSET, true);
    if ((type & ROM) === 0 && (type & MONO) === 0 && (type & (RIGHT | LEFT | LINKED)) !== 0) stereo.add(i);
  }
  return stereo;
}

function retype(view: DataView, shdr: Chunk, samples: Set<number>): number {
  for (const i of samples) {
    const at = shdr.at + i * SHDR_SIZE + TYPE_OFFSET;
    view.setUint16(at, MONO | (view.getUint16(at, true) & VORBIS), true);
  }
  return samples.size;
}

/**
 * Local attenuation minus the global zone's, so that alphaTab's sum of the two
 * comes out as the local value the SoundFont specifies.
 */
function undoGlobalAttenuation(view: DataView, gens: Chunk, zones: number[][], link: number): void {
  const op = (g: number): number => view.getUint16(gens.at + g * 4, true);
  const amount = (g: number): number => gens.at + g * 4 + 2;
  if (zones.length < 2 || zones[0]!.some((g) => op(g) === link)) return;   // no global zone
  const global = zones[0]!.find((g) => op(g) === GEN_ATTENUATION);
  if (global === undefined) return;
  const value = view.getInt16(amount(global), true);
  for (const zone of zones.slice(1)) {
    for (const g of zone) if (op(g) === GEN_ATTENUATION) view.setInt16(amount(g), view.getInt16(amount(g), true) - value, true);
  }
}

export interface Prepared {
  /** Stereo or linked samples retyped as mono. */
  readonly retyped: number;
  /** Presets and instruments whose voicing was corrected. */
  readonly pianoPresets: number;
  readonly pianoInstruments: number;
}

/**
 * Everything above, in place. Throws on bytes that are not a SoundFont, so a
 * soundfont that failed to arrive is a stated error rather than a silent reader.
 */
export function prepareSoundFont(bytes: Uint8Array): Prepared {
  const { view, chunks } = hydra(bytes);
  const shdr = chunks.get('shdr')!;
  const stereo = stereoSamples(view, shdr);
  const igen = chunks.get('igen'), pgen = chunks.get('pgen');
  const inst = chunks.get('inst'), phdr = chunks.get('phdr');

  const pianoInstruments = new Set<number>();
  let pianoPresets = 0;
  if (igen && pgen && inst && phdr) {
    const instruments = inst.size / 22 - 1;
    const onStereo = new Set<number>();
    for (let i = 0; i < instruments; i++) {
      const uses = zonesOf(view, chunks, 'instrument', i).flat()
        .some((g) => view.getUint16(igen.at + g * 4, true) === GEN_SAMPLE && stereo.has(view.getUint16(igen.at + g * 4 + 2, true)));
      if (uses) onStereo.add(i);
    }
    const presets = phdr.size / 38 - 1;
    for (let p = 0; p < presets; p++) {
      if (view.getUint16(phdr.at + p * 38 + 22, true) === PERCUSSION_BANK) continue;
      const zones = zonesOf(view, chunks, 'preset', p);
      const used = zones.flat()
        .filter((g) => view.getUint16(pgen.at + g * 4, true) === GEN_INSTRUMENT)
        .map((g) => view.getUint16(pgen.at + g * 4 + 2, true));
      if (!used.some((i) => onStereo.has(i))) continue;
      pianoPresets++;
      undoGlobalAttenuation(view, pgen, zones, GEN_INSTRUMENT);
      // A preset's filter value is an offset added to the instrument's: zeroed,
      // so it cannot pull an opened filter back under the cutoff.
      for (const g of zones.flat()) if (view.getUint16(pgen.at + g * 4, true) === GEN_FILTER_FC) view.setInt16(pgen.at + g * 4 + 2, 0, true);
      for (const i of used) pianoInstruments.add(i);
    }
    for (const i of pianoInstruments) {
      const zones = zonesOf(view, chunks, 'instrument', i);
      undoGlobalAttenuation(view, igen, zones, GEN_SAMPLE);
      for (const g of zones.flat()) if (view.getUint16(igen.at + g * 4, true) === GEN_FILTER_FC) view.setInt16(igen.at + g * 4 + 2, FILTER_OPEN, true);
    }
  }

  return { retyped: retype(view, shdr, stereo), pianoPresets, pianoInstruments: pianoInstruments.size };
}
