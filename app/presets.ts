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
    name: 'Tight djent',
    pack: 'metal',
    capture: 'helga-b-5150-blockletter-boosted.nam',
    cab: 'v30mod',
    values: {
      in_trim: 10.5, gate_threshold: -67.7, drive_gain: 23.0, drive_tone: 5538,
      tone_bass: -2.8, tone_mid: -2.8, tone_treble: 2.2, tone_presence: 1.6,
      reverb_mix: 0.08, out_master: -12.4,
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
  {
    name: 'Thrash',
    pack: 'metal',
    capture: 'helga-b-5150-blockletter-noboost.nam',
    cab: 'green',
    values: {
      in_trim: 12.0, gate_threshold: -71.6, drive_gain: 20.5, drive_tone: 5876,
      tone_bass: -1.1, tone_mid: 0.6, tone_treble: 3.4, tone_presence: 1.6,
      reverb_mix: 0.06, out_master: -12.4,
    },
  },
  {
    name: 'Doom',
    pack: 'metal',
    capture: 'tudor-n-driftwood-nightmare-high-gain-hm2.nam',
    cab: 'v30dark',
    values: {
      in_trim: 11.4, gate_threshold: -80.7, drive_gain: 13.3, drive_tone: 4186,
      tone_bass: 5.0, tone_mid: -0.6, tone_treble: -2.2, tone_presence: -2.4,
      reverb_mix: 0.26, out_master: -12.4,
    },
  },
  {
    name: 'Lead',
    pack: 'metal',
    capture: 'helga-b-jsx-ultra-od808.nam',
    cab: 'v30mod',
    values: {
      in_trim: 11.4, gate_threshold: -75.5, drive_gain: 25.0, drive_tone: 6011,
      tone_bass: -1.7, tone_mid: 3.4, tone_treble: 1.7, tone_presence: 1.0,
      reverb_mix: 0.30, out_master: -12.4,
    },
  },
] as const;

/** The one everybody hears first. Its values are the schema defaults. */
export const DEFAULT_PRESET = 'Modern metal';
