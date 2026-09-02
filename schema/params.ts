/**
 * The single source of truth for every parameter in the signal chain (AD-7).
 *
 * `dsp/params.generated.h` is generated from this file and is never edited by
 * hand. Nothing in the product may declare a parameter that is not here.
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

/** Physical unit of a parameter's value. There is no unitless number. */
export type Unit = 'dB' | 'Hz' | 'ratio' | 'ms' | 'bool';

/**
 * How `app/` maps fader travel to value. Presentation only — never serialised,
 * never seen by `dsp/`.
 */
export type Taper = 'linear' | 'logarithmic' | 'switch';

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
  | 'drive'
  | 'amp'
  | 'cab'
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
 * The fixed internal design rate (AD-18). Every stage is designed for and runs
 * at this rate; model weights, half-band coefficients and the cab FIR are all
 * defined here and nowhere else. `engine/` converts at the chain boundary when
 * the device runs at another rate. A stage may not read the device rate.
 */
export const INTERNAL_SAMPLE_RATE = 48_000;

/** The AudioWorklet render quantum. Fixed by the platform, not by us. */
export const BLOCK_FRAMES = 128;

/** Oversampling factor across the non-linear window (AD-2, FR-16). */
export const OVERSAMPLE_FACTOR = 4;

/** Frames per call inside the oversampling window (AD-19). */
export const OVERSAMPLED_BLOCK_FRAMES = BLOCK_FRAMES * OVERSAMPLE_FACTOR;

/** Neural amp model size, fixed at build time and never chosen at runtime (AD-5, FR-17). */
export const LSTM_HIDDEN_SIZE = 20;

/** Longest impulse response the direct-form FIR accepts (AD-3). */
export const MAX_IR_TAPS = 2048;

/**
 * Chain order. This array *is* the signal path — `dsp/chain.cpp` is generated
 * against it and is the only C++ file that knows the order.
 */
export const STAGES: readonly Stage[] = [
  { id: 'input',  label: 'In',     meterSlot: 0, bypassParam: null,            oversampled: false },
  { id: 'gate',   label: 'Gate',   meterSlot: 1, bypassParam: 'gate_bypass',   oversampled: false },
  { id: 'drive',  label: 'Drive',  meterSlot: 2, bypassParam: 'drive_bypass',  oversampled: true  },
  { id: 'amp',    label: 'Amp',    meterSlot: 3, bypassParam: 'amp_bypass',    oversampled: true  },
  { id: 'cab',    label: 'Cab',    meterSlot: 4, bypassParam: 'cab_bypass',    oversampled: false },
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
 * Defaults are the v1 preset: a saturated high-gain lead built for shred and
 * solos. Most people will hear this and nothing else, so these are product
 * decisions rather than placeholders.
 */
export const PARAMS: readonly Param[] = [
  // --- Input -------------------------------------------------------------
  { id: 'in_trim', stage: 'input', label: 'Trim', unit: 'dB',
    min: -24, max: 24, default: 0, taper: 'linear' },

  // --- Gate --------------------------------------------------------------
  // Release is automatic and deliberately not exposed: a player should not have
  // to know what a gate release is to make high gain usable in a room.
  { id: 'gate_threshold', stage: 'gate', label: 'Threshold', unit: 'dB',
    min: -80, max: -20, default: -55, taper: 'linear' },
  { id: 'gate_bypass', stage: 'gate', label: 'Bypass', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch' },

  // --- Drive -------------------------------------------------------------
  // A boost in front of high gain tightens the low end and defines the attack.
  { id: 'drive_gain', stage: 'drive', label: 'Gain', unit: 'dB',
    min: 0, max: 40, default: 12, taper: 'linear' },
  // Cutoff of the post-clip lowpass, the control a screamer actually offers.
  { id: 'drive_tone', stage: 'drive', label: 'Tone', unit: 'Hz',
    min: 400, max: 6000, default: 2200, taper: 'logarithmic' },
  { id: 'drive_level', stage: 'drive', label: 'Level', unit: 'dB',
    min: -24, max: 12, default: 0, taper: 'linear' },
  { id: 'drive_bypass', stage: 'drive', label: 'Bypass', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch' },

  // --- Amp ---------------------------------------------------------------
  { id: 'amp_gain', stage: 'amp', label: 'Gain', unit: 'dB',
    min: 0, max: 40, default: 30, taper: 'linear' },
  { id: 'amp_bass', stage: 'amp', label: 'Bass', unit: 'dB',
    min: -12, max: 12, default: 0, taper: 'linear' },
  // Slightly scooped by default — the shape a lead tone wants.
  { id: 'amp_mid', stage: 'amp', label: 'Mid', unit: 'dB',
    min: -12, max: 12, default: -2, taper: 'linear' },
  { id: 'amp_treble', stage: 'amp', label: 'Treble', unit: 'dB',
    min: -12, max: 12, default: 2, taper: 'linear' },
  { id: 'amp_master', stage: 'amp', label: 'Master', unit: 'dB',
    min: -24, max: 12, default: -6, taper: 'linear' },
  { id: 'amp_bypass', stage: 'amp', label: 'Bypass', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch' },

  // --- Cab ---------------------------------------------------------------
  // A high-gain amp with no cab is not a sound, it is a fault. Hence 1.0.
  { id: 'cab_mix', stage: 'cab', label: 'Mix', unit: 'ratio',
    min: 0, max: 1, default: 1, taper: 'linear' },
  { id: 'cab_bypass', stage: 'cab', label: 'Bypass', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch' },

  // --- Reverb ------------------------------------------------------------
  // Dry high gain in headphones sits inside the head and fatigues in minutes,
  // and a lead line has nowhere to sustain into. Small, but never zero.
  { id: 'reverb_mix', stage: 'reverb', label: 'Mix', unit: 'ratio',
    min: 0, max: 1, default: 0.18, taper: 'linear' },
  { id: 'reverb_bypass', stage: 'reverb', label: 'Bypass', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch' },

  // --- Output ------------------------------------------------------------
  { id: 'out_master', stage: 'output', label: 'Master', unit: 'dB',
    min: -60, max: 6, default: -3, taper: 'linear' },
  { id: 'out_mute', stage: 'output', label: 'Mute', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch' },
] as const;
