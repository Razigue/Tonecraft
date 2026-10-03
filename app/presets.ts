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
  /**
   * Captures of one amplifier that the head switches between, the way a
   * channel switch does: the faders stay where they are, only the capture
   * changes. `capture` is the one the preset opens on, and must be listed.
   */
  readonly channels?: readonly Channel[];
}

export interface Channel {
  /** Its key in the strings, and what the switch is addressed by. */
  readonly id: string;
  readonly capture: string;
  /** The colour of its lamp on the switch, a `--lamp-*` token. */
  readonly lamp: 'green' | 'amber' | 'red';
}

/** The preset whose channels include this capture, if any. */
export function channelsOf(capture: string): Preset | undefined {
  return PRESETS.find((p) => p.channels?.some((c) => c.capture === capture));
}

export const PRESETS: readonly Preset[] = [
  {
    name: 'Lead',
    pack: 'metal',
    capture: 'engl-e530.nam',
    cab: 'mesa-412-os',
    values: {
      // Kept in step with the schema defaults by npm run check. Listed as a
      // full rig, but strident without a cabinet after it: it gets the Mesa.
      // Unity input and Tonecraft's boost out: the E530 has gain enough.
      in_trim: 0, gate_threshold: -50, drive_bypass: 1, drive_gain: 25.0, drive_tone: 6011,
      tone_bass: -1.7, tone_mid: 3.4, tone_treble: 1.7, tone_presence: 1.0,
      pitch_shift: 0, reverb_bypass: 0, reverb_mix: 0.30, out_master: -12.4,
    },
  },
  {
    name: 'Modern metal',
    pack: 'metal',
    capture: 'full-rig-peavey-5150-maxon-mesa-os-sm57.nam',
    cab: 'none',
    values: {
      // The OD808 and the Mesa cabinet are already in this full-rig capture.
      in_trim: 0, gate_threshold: -65, drive_bypass: 1, drive_gain: 0, drive_tone: 5200,
      tone_bass: 0, tone_mid: 0, tone_treble: 0, tone_presence: 0,
      pitch_shift: 0, reverb_bypass: 1, reverb_mix: 0.12, out_master: -12.4,
    },
  },
  {
    name: 'Modern metal boost',
    pack: 'metal',
    capture: '5150-stealth-100w-red-mesa-os.nam',
    cab: 'none',
    values: {
      // The red channel was captured unboosted: the screamer goes in front as a
      // clean boost, low gain and a mid tone, to tighten the low end. The Mesa
      // cabinet is in this full-rig capture.
      in_trim: 0, gate_threshold: -60, drive_bypass: 0, drive_gain: 8.0, drive_tone: 4500,
      tone_bass: 0, tone_mid: 0, tone_treble: 0, tone_presence: 0,
      pitch_shift: 0, reverb_bypass: 1, reverb_mix: 0.12, out_master: -12.4,
    },
  },
  {
    name: 'British',
    pack: 'metal',
    capture: 'engl-fb25-lead-modern.nam',
    cab: 'celestion-g12-vintage',
    // Three captures of one Fireball 25 lead channel, on the head's switch.
    // Lamps go green, amber, red as the front end heats up.
    channels: [
      { id: 'modern', capture: 'engl-fb25-lead-modern.nam', lamp: 'green' },
      { id: 'cleanBoost', capture: 'engl-fb25-lead-modern-clean-boost.nam', lamp: 'amber' },
      { id: 'pdBoost', capture: 'engl-fb25-lead-modern-pd-boost.nam', lamp: 'red' },
    ],
    values: {
      // The boosts are in the captures: Tonecraft's own stays out, the EQ flat,
      // as captured through a V30.
      in_trim: 0, gate_threshold: -60, drive_bypass: 1, drive_gain: 0, drive_tone: 5200,
      tone_bass: 0, tone_mid: 0, tone_treble: 0, tone_presence: 0,
      pitch_shift: 0, reverb_bypass: 1, reverb_mix: 0.15, out_master: -12.4,
    },
  },
  {
    name: 'Polyphia',
    pack: 'clean',
    capture: 'polyphia-so-strange.nam',
    cab: 'none',
    values: {
      // The capture's author asks for no IR, and for reverb after it.
      in_trim: 0, gate_threshold: -65, drive_bypass: 1, drive_gain: 0, drive_tone: 5200,
      tone_bass: 0, tone_mid: 0, tone_treble: 0, tone_presence: 0,
      pitch_shift: 0, reverb_bypass: 0, reverb_mix: 0.15, out_master: -12.4,
    },
  },
] as const;

/** The one everybody hears first. Its values are the schema defaults. */
export const DEFAULT_PRESET = 'Lead';
