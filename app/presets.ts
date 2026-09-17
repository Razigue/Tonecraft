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
  /** The key the rig selects it by. A saved tone's is `saved:<id>`. */
  readonly name: string;
  /** What the dropdown shows, when it is not a translated factory name. */
  readonly label?: string;
  readonly pack: string;
  readonly capture: string;
  readonly cab: string;
  readonly values: Readonly<Record<string, number>>;
}

export const PRESETS: readonly Preset[] = [
  {
    name: 'Lead',
    pack: 'metal',
    capture: 'engl-e530.nam',
    cab: 'celestion-g12-vintage',
    values: {
      // Kept in step with the schema defaults by npm run check.
      in_trim: 11.4, gate_threshold: -58, drive_bypass: 0, drive_gain: 25.0, drive_tone: 6011,
      tone_bass: -1.7, tone_mid: 3.4, tone_treble: 1.7, tone_presence: 1.0,
      pitch_shift: 0, reverb_bypass: 0, reverb_mix: 0.30, out_master: -12.4,
    },
  },
  {
    name: 'Modern metal',
    pack: 'metal',
    capture: 'va-nightmare-md-and-mesa-oversized.nam',
    cab: 'celestion-g12-vintage',
    values: {
      // Merciless Drive and the Mesa cabinet are already in this full-rig capture.
      in_trim: 0, gate_threshold: -65, drive_bypass: 1, drive_gain: 0, drive_tone: 5200,
      tone_bass: 0, tone_mid: 0, tone_treble: 0, tone_presence: 0,
      pitch_shift: 0, reverb_bypass: 1, reverb_mix: 0.12, out_master: -12.4,
    },
  },
  {
    name: 'Clean',
    pack: 'clean',
    capture: 'fender-super-reverb-eq-flat-volume-3-sm57-and-akg-414.nam',
    cab: 'mesa-412-os',
    values: {
      // Preserve the clean capture's headroom, flat EQ and microphone blend.
      in_trim: 0, gate_threshold: -65, drive_bypass: 1, drive_gain: 0, drive_tone: 5200,
      tone_bass: 0, tone_mid: 0, tone_treble: 0, tone_presence: 0,
      pitch_shift: 0, reverb_bypass: 1, reverb_mix: 0.12, out_master: -12.4,
    },
  },
] as const;

/** The one everybody hears first. Its values are the schema defaults. */
export const DEFAULT_PRESET = 'Lead';
