/**
 * Makes alphaTab load every sample of the tab reader's soundfont.
 *
 * MuseScore_General stores its acoustic pianos — and a few percussion samples —
 * as stereo pairs: each note is a left sample and a right sample, typed as such
 * in the sample headers. alphaTab's synthesizer only loads samples typed mono,
 * and skips the rest with a console warning per sample. The warnings were the
 * visible part. The real one was that the skipped piano was left as empty
 * voices that render NaN, and one NaN voice turns the whole mix to NaN: a tab
 * with a piano anywhere in it played nothing at all, guitar included.
 *
 * What this does not fix: under alphaTab the piano plays some 40 dB below the
 * guitars. The soundfont is voiced for FluidSynth, whose attenuation and
 * layering conventions alphaTab does not share. That is the soundfont's
 * voicing, not a loading fault, and is measured rather than guessed at.
 *
 * Retyping the halves as mono is enough. The instrument already plays each
 * half from its own zone, panned, so each becomes an ordinary mono region and
 * the pair still sounds as a stereo piano. Done on the bytes in memory, before
 * alphaTab reads them: the committed file stays the unmodified third-party
 * asset `assets/README.md` records, and nothing is added to git history.
 *
 * Pure, and checked in Node against the real file and against alphaTab's own
 * synthesizer (`soundfont.test.ts`).
 */

/** Sample type bits, SoundFont 2.04 §7.10, plus the SF3 compression flag. */
const MONO = 0x0001;
const RIGHT = 0x0002;
const LEFT = 0x0004;
const LINKED = 0x0008;
const VORBIS = 0x0010;
const ROM = 0x8000;

/** One sample header record: 20 bytes of name, five u32, two bytes, u16 link, u16 type. */
const SHDR_SIZE = 46;
const TYPE_OFFSET = 44;

/**
 * Retypes every stereo or linked sample as mono, in place. Returns how many
 * were changed. Throws on bytes that are not a SoundFont, so a soundfont that
 * failed to arrive is a stated error rather than a silent reader.
 */
export function monoSoundFont(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'sfbk') throw new Error('not a SoundFont');

  const end = Math.min(bytes.length, 8 + view.getUint32(4, true));
  for (let at = 12; at + 8 <= end;) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === 'LIST' && tag(at + 8) === 'pdta') {
      const listEnd = Math.min(end, at + 8 + size);
      for (let sub = at + 12; sub + 8 <= listEnd;) {
        const subSize = view.getUint32(sub + 4, true);
        if (tag(sub) === 'shdr') {
          let changed = 0;
          // The last record is the terminal "EOS" header, never a sample.
          const records = Math.floor(subSize / SHDR_SIZE) - 1;
          for (let i = 0; i < records; i++) {
            const typeAt = sub + 8 + i * SHDR_SIZE + TYPE_OFFSET;
            const type = view.getUint16(typeAt, true);
            if ((type & ROM) !== 0 || (type & MONO) !== 0) continue;
            if ((type & (RIGHT | LEFT | LINKED)) === 0) continue;
            view.setUint16(typeAt, MONO | (type & VORBIS), true);
            changed++;
          }
          return changed;
        }
        sub += 8 + subSize + (subSize & 1);
      }
    }
    at += 8 + size + (size & 1);
  }
  throw new Error('the SoundFont has no sample headers');
}
