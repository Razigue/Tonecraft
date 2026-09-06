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

/**
 * The rate a stage *inside* the oversampling window actually runs at.
 *
 * AD-18 says every stage is designed for the internal rate — and that is true
 * of the rate the chain runs at, but not of the rate every stage sees. A stage
 * inside the window is handed four times as many frames per call (AD-19), and
 * they arrive four times as fast. A filter designed for 48 kHz and run here has
 * its corner frequency four times too high, which is silent, catastrophic, and
 * exactly what happened: the amp's inter-stage highpasses, meant for 45 to 85
 * Hz, were cutting at 180 to 340 Hz and taking 40 dB of the low E with them,
 * while its lowpasses sat at 24 to 48 kHz doing nothing about the top.
 */
export const OVERSAMPLED_SAMPLE_RATE = INTERNAL_SAMPLE_RATE * OVERSAMPLE_FACTOR;

/** Neural amp model size, fixed at build time and never chosen at runtime (AD-5, FR-17). */
export const LSTM_HIDDEN_SIZE = 20;

/** Longest impulse response the direct-form FIR accepts (AD-3). */
export const MAX_IR_TAPS = 2048;

/**
 * The amp model: bounds for the WaveNet the engine can load (AD-5, FR-17).
 *
 * The architecture is NAM's **Standard** WaveNet — the one every `.nam` since
 * format version 0.5 uses — and the *size* is a property of the file, not of
 * the code. That distinction is the whole reason these are bounds rather than
 * dimensions: one kernel loads Standard, Lite, Feather or Nano, and which one
 * we ship is a choice made once at build time and never at runtime, so a tone
 * link renders identically on every machine.
 *
 * The bounds are not arbitrary. Measured in wasm SIMD128 on an i5-7300U — a
 * 2017 dual-core laptop, the floor machine's class — at 128-frame blocks, as a
 * share of one core:
 *
 *   Standard  16/8 channels   22.6 %     the whole budget, for the amp alone
 *   Lite      12/6            16.7 %
 *   Feather    8/4             9.6 %     what v1 ships
 *   Nano       4/2             5.6 %
 *
 * `PRODUCT.md` §5 caps the chain at 25 % of one core, and the rest of the chain
 * measures 5.1 % on the same machine. So Standard does not fit and Feather
 * does, with room left for the reverb. The bounds below still admit Standard,
 * because refusing to *load* it would also stop us rendering a comparison
 * against it offline, where there is no budget at all.
 */

/** Layer arrays in a model. Every trainer size uses two. */
export const MODEL_MAX_LAYER_ARRAYS = 2;

/** Dilated layers per array. Every trainer size uses ten: 1, 2, 4 ... 512. */
export const MODEL_MAX_LAYERS_PER_ARRAY = 10;

/** Widest layer array. Standard's first array is 16; Feather's is 8. */
export const MODEL_MAX_CHANNELS = 16;

/** Convolution kernel. Standard is 3. */
export const MODEL_MAX_KERNEL_SIZE = 3;

/** Largest dilation, which sets how far back a layer has to remember. */
export const MODEL_MAX_DILATION = 512;

/** Weights in a model. Standard is 13 802; Feather is 3 638. */
export const MODEL_MAX_WEIGHTS = 16_384;

/**
 * Frames of per-layer slack in the history pool before it has to be rewound.
 *
 * A dilated convolution reads backwards, so its history has to stay contiguous.
 * Keeping it contiguous by shifting the whole window down every block costs a
 * copy of the entire lookback per block — for the widest layer that is 1024
 * frames of 16 channels, 375 times a second, in twenty layers. Writing forward
 * into slack and rewinding only when the slack runs out divides that by the
 * slack length, and four blocks is already enough to make it disappear.
 */
export const MODEL_HISTORY_SLACK_BLOCKS = 4;

/**
 * Floats in the static history pool the layers carve up at load time.
 *
 * Sized from the worst case this file admits: two arrays of ten layers at
 * `MODEL_MAX_CHANNELS`, each layer holding `(kernel - 1) x dilation` frames of
 * lookback plus its slack. Bump-allocated at load and never freed, because
 * `process()` may not allocate and the module has no malloc at all.
 */
export const MODEL_HISTORY_POOL_FLOATS = 262_144;

/** `TCNM` little-endian: the flat model blob `scripts/nam-to-tcnm.ts` writes. */
export const MODEL_BLOB_MAGIC = 0x4d4e4354;

/** Bumped whenever the blob layout changes. The loader refuses anything else. */
export const MODEL_BLOB_VERSION = 1;

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
  // Set with the amp gain below; the two are one control surface in practice.
  //
  // The previous value came from an attack-spread metric that turned out to be
  // measuring nothing: the detector reported 51 to 75 attacks in a take that
  // contains nine, and the reference take's own hits span 2.8 dB, so no
  // material recorded so far can say anything about pick response at all. That
  // number is withdrawn, and this pair is now set on the spectral difference,
  // which is measured on the same performance and is sound.
  //
  // That difference keeps improving all the way to both faders' maximum, and
  // pinning the default there would be following a metric off a cliff in the
  // other direction — the remaining gap is a harmonic character our clipping
  // does not have, not a quantity of gain. So this sits mid-travel: audibly
  // more saturated than before, with room to move both ways.
  { id: 'drive_gain', stage: 'drive', label: 'Gain', unit: 'dB',
    min: 0, max: 40, default: 22, taper: 'linear' },
  // Cutoff of the post-clip lowpass, the control a screamer actually offers.
  { id: 'drive_tone', stage: 'drive', label: 'Tone', unit: 'Hz',
    min: 400, max: 6000, default: 2200, taper: 'logarithmic' },
  { id: 'drive_level', stage: 'drive', label: 'Level', unit: 'dB',
    min: -24, max: 12, default: 0, taper: 'linear' },
  { id: 'drive_bypass', stage: 'drive', label: 'Bypass', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch' },

  // --- Amp ---------------------------------------------------------------
  // Set with drive_gain above, and provisional for the same reason: the metric
  // that argued for lowering it was invalid. On the spectral difference this
  // pair lands 2.2 dB closer to the reference than the one it replaces, and it
  // is where the amp is plainly a high-gain amp rather than a crunch.
  { id: 'amp_gain', stage: 'amp', label: 'Gain', unit: 'dB',
    min: 0, max: 40, default: 27, taper: 'linear' },
  { id: 'amp_bass', stage: 'amp', label: 'Bass', unit: 'dB',
    min: -12, max: 12, default: 0, taper: 'linear' },
  // Not scooped. A scoop plus the cabinet's own dip around 700 Hz took all the
  // body out and left the thin, boxy tone of a very small amplifier.
  { id: 'amp_mid', stage: 'amp', label: 'Mid', unit: 'dB',
    min: -12, max: 12, default: 1, taper: 'linear' },
  { id: 'amp_treble', stage: 'amp', label: 'Treble', unit: 'dB',
    min: -12, max: 12, default: 0, taper: 'linear' },
  // Leaves the limiter something to do only on peaks, rather than riding the
  // whole signal — a limiter working continuously is a compressor nobody asked
  // for.
  { id: 'amp_master', stage: 'amp', label: 'Master', unit: 'dB',
    min: -24, max: 12, default: -7, taper: 'linear' },
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
    min: -60, max: 6, default: 0, taper: 'linear' },
  { id: 'out_mute', stage: 'output', label: 'Mute', unit: 'bool',
    min: 0, max: 1, default: 0, taper: 'switch' },
] as const;
