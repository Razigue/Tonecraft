/**
 * The quick settings.
 *
 * A preset is a capture, a cabinet and a set of fader values — in engineering
 * units, like everything on the wire (AD-9), so a preset written today still
 * means the same thing after any taper is retuned.
 *
 * `capture` names a **file**, never an index: the catalogue can be reordered or
 * extended without breaking anything here. A preset naming a capture that is not
 * installed falls back to the first one in the catalogue rather than failing.
 *
 * Adding a pack (clean, crunch, bass) is adding entries here and in
 * `scripts/vendor-nam.mjs`. Nothing else in the interface needs to change.
 */

export interface Preset {
  readonly name: string;
  readonly pack: string;
  readonly capture: string;
  readonly cab: string;
  readonly values: Readonly<Record<string, number>>;
}

export const PRESETS: readonly Preset[] = [
  {
    name: 'Lead',
    pack: 'metal',
    capture: 'helga-b-jsx-ultra-od808.nam',
    cab: 'v30mod',
    values: {
      // -60, and the reason is in schema/params.ts next to the same number:
      // below this the gate closes after the hiss has been heard rather than
      // before. Kept in step with the schema default by npm run check.
      in_trim: 11.4, gate_threshold: -60, drive_gain: 25.0, drive_tone: 6011,
      tone_bass: -1.7, tone_mid: 3.4, tone_treble: 1.7, tone_presence: 1.0,
      reverb_mix: 0.30, out_master: -12.4,
    },
  },
  {
    name: 'Modern metal',
    pack: 'metal',
    capture: 'helga-b-6505-red-ch-mxr-drive.nam',
    cab: 'v30mod',
    values: {
      in_trim: 10.5, gate_threshold: -72.9, drive_gain: 16.9, drive_tone: 5200,
      tone_bass: 1.4, tone_mid: -3.4, tone_treble: 1.4, tone_presence: 0.4,
      reverb_mix: 0.12, out_master: -12.4,
    },
  },
] as const;

/** The one everybody hears first. Its values are the schema defaults. */
export const DEFAULT_PRESET = 'Lead';
