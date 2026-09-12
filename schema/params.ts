/**
 * The single source of truth for every parameter in the signal chain (AD-7).
 *
 * Nothing in the product may declare a parameter that is not here: `engine/`
 * applies these ids and `app/` shows them, and `scripts/check-schema.ts` fails
 * the build if either side drifts from this file.
 *
 * Three rules govern edits to this file:
 *
 * - **Append-only, forever (AD-8).** Parameters may be added. They may never be
 *   removed, renamed, reordered, or have their meaning or unit changed. A
 *   retired parameter is marked `deprecated` and ignored by the engine; its id
 *   and its wire position are never reused. A tone link created today must
 *   still open and still sound the same in four years.
 * - **Engineering units only (AD-9).** dB, Hz, ratio, milliseconds. Never a
 *   normalised fader position. Taper curves are a presentation concern owned by
 *   `app/` and never reach the wire format, so retuning a taper or redesigning
 *   the UI cannot change how an existing shared tone sounds.
 * - **Nothing is addressed by position (AD-21).** Stages carry stable meter slot
 *   ids and stable bypass parameter ids. Inserting a stage must not shift what
 *   any other stage means.
 */

/**
 * Physical unit of a parameter's value. There is no unitless number.
 *
 * `semitones` is one: a twelfth of a doubling in frequency is a physical
 * quantity, not a fader position, and it is the unit a musician states a
 * transposition in. A ratio would have been the other honest choice and is the
 * wrong one here — nobody asks for 1.0595.
 */
export type Unit = 'dB' | 'Hz' | 'ratio' | 'ms' | 'bool' | 'semitones';

/**
 * How `app/` maps fader travel to value. Presentation only — never serialised,
 * never seen by `dsp/`. `stepped` moves in whole units: the wire format still
 * carries a number, and the chain still accepts any value between them.
 */
export type Taper = 'linear' | 'logarithmic' | 'switch' | 'stepped';

export interface Param {
  /** Stable forever. Never renamed, never reused (AD-8). */
  readonly id: string;
  /** Stage this parameter belongs to. */
  readonly stage: StageId;
  /** Shown in the UI. Translated at the presentation layer, not here. */
  readonly label: string;
  readonly unit: Unit;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly taper: Taper;
  /** Retired but still decoded, so old tone links keep working (AD-8). */
  readonly deprecated?: true;
}

export type StageId =
  | 'input'
  | 'gate'
  | 'pitch'
  | 'drive'
  | 'amp'
  | 'cab'
  | 'tone'
  | 'reverb'
  | 'output';

export interface Stage {
  readonly id: StageId;
  readonly label: string;
  /**
   * Stable id of this stage's slot in the metering array (AD-21). Assigned
   * once, never reused, never derived from chain position.
   */
  readonly meterSlot: number;
  /** Parameter that bypasses this stage, or null where bypass is forbidden. */
  readonly bypassParam: string | null;
  /**
   * Whether this stage sits inside the 4x oversampling window (AD-2). The
   * window must stay contiguous: exactly one run of `true` in chain order.
   */
  readonly oversampled: boolean;
}

/**
 * Chain order. This array *is* the signal path — `dsp/chain.cpp` is generated
 * against it and is the only C++ file that knows the order.
 */
export const STAGES: readonly Stage[] = [
  { id: 'input',  label: 'In',     meterSlot: 0, bypassParam: null,            oversampled: false },
  { id: 'gate',   label: 'Gate',   meterSlot: 1, bypassParam: 'gate_bypass',   oversampled: false },
  // After the gate and before the boost, where a pitch pedal goes on a board:
  // the gate decides on the clean guitar, and the shift is what gets driven.
  // It is the one stage that delays the signal, and only while it is engaged —
  // see dsp/pitch.cpp for the figures and CLAUDE.md section 3 for the trade.
  { id: 'pitch',  label: 'Pitch',  meterSlot: 8, bypassParam: 'pitch_bypass',  oversampled: false },
  { id: 'drive',  label: 'Boost',  meterSlot: 2, bypassParam: 'drive_bypass',  oversampled: true  },
  // No bypass, for the reason the cabinet has none. Bypassing a capture does
  // not give you "the amp off", it gives you a raw DI still carrying the amp's
  // gain staging: measured through the shipped preset, it is 18 dB LOUDER than
  // the amplified signal, because a saturated capture compresses hard and a dry
  // note does not. A control that makes headphones jump 18 dB to do something
  // nobody wanted is not a feature.
  { id: 'amp',    label: 'Amp',    meterSlot: 3, bypassParam: null,            oversampled: false },
  // The cabinet is not optional and has no bypass. These captures are of the
  // amplifier alone: measured, they are still +5 dB at 7 kHz where a capture
  // including a cabinet would be 25 dB down. Without a cabinet the result is
  // not an amp sound, it is a jigsaw.
  { id: 'cab',    label: 'Cab',    meterSlot: 4, bypassParam: null,            oversampled: false },
  // Post-cabinet correction, which is where a four-band EQ belongs: in front of
  // the cab it would be fighting a 25 dB shelf that has not happened yet.
  { id: 'tone',   label: 'Tone',   meterSlot: 7, bypassParam: 'tone_bypass',   oversampled: false },
  { id: 'reverb', label: 'Reverb', meterSlot: 5, bypassParam: 'reverb_bypass', oversampled: false },
  // The limiter lives inside the output stage and is deliberately absent from
  // this table: it has no parameter, no bypass and no UI control, in any mode,
  // on any path (FR-18). A digital feedback loop in headphones can injure.
  { id: 'output', label: 'Out',    meterSlot: 6, bypassParam: null,            oversampled: false },
] as const;

/**
 * Every parameter, in wire order. **Append only** — a new parameter goes at the
 * end (AD-8).
 *
 * The chain these describe is the one the proof of concept validated by ear:
 *
 *     input -> trim, gate, TS-style boost   (one worklet, 4x around the boost)
 *           -> NAM capture                  (the amplifier itself)
 *           -> cabinet                      (synthesised minimum-phase IR)
 *           -> four-band correction         (native biquads, post-cabinet)
 *           -> reverb, in parallel
 *           -> master + limiter
 *
 * A NAM capture is a frozen snapshot of one amplifier at one setting: its gain,
 * its channel and its own EQ are baked into the model and cannot be driven from
 * here. Changing the sound means changing capture, which is why the capture and
 * the cabinet — not any fader below — are the two real tone choices, and why
 * every `amp_*` control that used to drive our own amplifier is now deprecated
 * rather than repurposed (AD-8: an id never changes meaning).
 *
 * Defaults are the v1 preset, "Lead": a JSX Ultra through an OD808, high and
 * singing, with the reverb up where a held note has somewhere to go.
 */
export const PARAMS: readonly Param[] = [
  // --- Input -------------------------------------------------------------
  // What reaches the model. On captures this saturated it sets bite and
  // dynamics far more than it sets volume.
  { id: 'in_trim', stage: 'input', label: 'Trim', unit: 'dB',
    min: -6, max: 24, default: 11.4, taper: 'linear' },

  // --- Gate --------------------------------------------------------------
  // Release is automatic and deliberately not exposed: a player should not have
  // to know what a gate release is to make high gain usable in a room.
  //
  // The floor is far lower than a general-purpose gate would need. These
  // captures amplify enormously — 0.02 in comes back out at -19 dBFS — so the
  // useful thresholds all sit in the last 20 dB above silence.
  //
  // -65 preserves quieter picking; the 8 ms release in dsp/frontend.cpp
  // tightens the close independently of this level threshold.
  { id: 'gate_threshold', stage: 'gate', label: 'Threshold', unit: 'dB',
    min: -95, max: -30, default: -65, taper: 'linear' },
  { id: 'gate_bypass', stage: 'gate', label: 'Bypass', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch' },

  // --- Boost -------------------------------------------------------------
  // A Tube Screamer in front of the amp, exactly where it sits on a real
  // pedalboard: it cuts the low end before the saturation, so the bottom of the
  // spectrum cannot boil, and it tightens the attack. The only hand-written
  // non-linearity left in the chain — everything else about the sound comes
  // from the capture.
  //
  // In dB because AD-9 admits no normalised fader position in the wire format.
  // This is the pre-clip gain the pedal applies: 0 dB is the pedal doing
  // nothing, +28 dB is its maximum.
  { id: 'drive_gain', stage: 'drive', label: 'Boost', unit: 'dB',
    min: 0, max: 28, default: 25.0, taper: 'linear' },
  // Cutoff of the post-clip lowpass, the control a screamer actually offers.
  { id: 'drive_tone', stage: 'drive', label: 'Tone', unit: 'Hz',
    min: 1820, max: 7150, default: 6011, taper: 'logarithmic' },
  // Deprecated: the pedal's output level tracks its gain, as it does in the
  // circuit. A second level control here only ever confused the gain staging.
  { id: 'drive_level', stage: 'drive', label: 'Level', unit: 'dB',
    min: -24, max: 12, default: 0, taper: 'linear', deprecated: true },
  { id: 'drive_bypass', stage: 'drive', label: 'Bypass', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch' },

  // --- Amp ---------------------------------------------------------------
  // All five of these drove the Faust cascade that the NAM pivot retired. They
  // are kept, deprecated and ignored, because AD-8 forbids reusing an id: a
  // tone link written against them must not decode into something else.
  { id: 'amp_gain', stage: 'amp', label: 'Gain', unit: 'dB',
    min: 0, max: 40, default: 27, taper: 'linear', deprecated: true },
  { id: 'amp_bass', stage: 'amp', label: 'Bass', unit: 'dB',
    min: -12, max: 12, default: 0, taper: 'linear', deprecated: true },
  { id: 'amp_mid', stage: 'amp', label: 'Mid', unit: 'dB',
    min: -12, max: 12, default: 1, taper: 'linear', deprecated: true },
  { id: 'amp_treble', stage: 'amp', label: 'Treble', unit: 'dB',
    min: -12, max: 12, default: 0, taper: 'linear', deprecated: true },
  { id: 'amp_master', stage: 'amp', label: 'Master', unit: 'dB',
    min: -24, max: 12, default: -7, taper: 'linear', deprecated: true },
  // Deprecated with the rest of the amp block, and for its own reason: see the
  // note on the amp stage above.
  { id: 'amp_bypass', stage: 'amp', label: 'Bypass', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch', deprecated: true },

  // --- Cab ---------------------------------------------------------------
  // Deprecated with the stage's bypass: a high-gain capture with no cabinet is
  // not a quieter sound, it is a fault, so there is nothing to mix.
  { id: 'cab_mix', stage: 'cab', label: 'Mix', unit: 'ratio',
    min: 0, max: 1, default: 1, taper: 'linear', deprecated: true },
  { id: 'cab_bypass', stage: 'cab', label: 'Bypass', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch', deprecated: true },

  // --- Reverb ------------------------------------------------------------
  // Dry high gain in headphones sits inside the head and fatigues in minutes,
  // and a lead line has nowhere to sustain into. Small, but never zero.
  { id: 'reverb_mix', stage: 'reverb', label: 'Mix', unit: 'ratio',
    min: 0, max: 1, default: 0.30, taper: 'linear' },
  { id: 'reverb_bypass', stage: 'reverb', label: 'Bypass', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch' },

  // --- Output ------------------------------------------------------------
  // The floor is -40 dB rather than -60: below that the fader spends most of
  // its travel on levels nobody plays at.
  { id: 'out_master', stage: 'output', label: 'Master', unit: 'dB',
    min: -40, max: 6, default: -12.4, taper: 'linear' },
  { id: 'out_mute', stage: 'output', label: 'Mute', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch' },

  // --- Tone (post-cabinet correction) ------------------------------------
  // Appended after the output block, because AD-8 makes wire order append-only
  // and these are new. Their place in the *signal* path is set by STAGES.
  { id: 'tone_bass', stage: 'tone', label: 'Bass', unit: 'dB',
    min: -14, max: 14, default: -1.7, taper: 'linear' },
  // Not scooped. A mid scoop plus the cabinet's own dip around 700 Hz takes all
  // the body out and leaves the thin, boxy tone of a very small amplifier.
  { id: 'tone_mid', stage: 'tone', label: 'Mid', unit: 'dB',
    min: -14, max: 14, default: 3.4, taper: 'linear' },
  { id: 'tone_treble', stage: 'tone', label: 'Treble', unit: 'dB',
    min: -14, max: 14, default: 1.7, taper: 'linear' },
  // A narrower range than the other three: presence sits on top of the
  // cabinet's steep rolloff, where a few dB already changes the whole top end.
  { id: 'tone_presence', stage: 'tone', label: 'Presence', unit: 'dB',
    min: -10, max: 10, default: 1.0, taper: 'linear' },
  { id: 'tone_bypass', stage: 'tone', label: 'Bypass', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch' },

  // --- Pitch -------------------------------------------------------------
  // A transposer in front of the amp: a tuning a semitone or two down without
  // retuning, or an octave for a line the guitar does not reach.
  //
  // An octave either way, and no further. Past a twelfth every time-domain
  // shifter turns the guitar into something else — the artefacts stop being a
  // texture and become the sound — so the range stops where the effect is
  // still an instrument.
  //
  // Whole semitones on the control, any value on the wire (AD-9): the taper is
  // presentation, and a link written by hand with 7.5 still plays.
  { id: 'pitch_shift', stage: 'pitch', label: 'Shift', unit: 'semitones',
    min: -12, max: 12, default: 0, taper: 'stepped' },
  // Full wet by default: this is a transposer before it is a harmoniser, and
  // the dry guitar underneath is the choice, not the starting point.
  { id: 'pitch_mix', stage: 'pitch', label: 'Mix', unit: 'ratio',
    min: 0, max: 1, default: 1, taper: 'linear' },
  // The one stage that ships bypassed. It costs latency while it runs (see
  // dsp/pitch.cpp), and a rig that adds milliseconds to everyone's round trip
  // for an effect they did not ask for is not a default.
  { id: 'pitch_bypass', stage: 'pitch', label: 'Bypass', unit: 'bool',
    min: 0, max: 1, default: 1, taper: 'switch' },
] as const;
