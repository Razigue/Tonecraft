/**
 * The contract between the chain and whatever hosts it.
 *
 * The chain is one WebAssembly module, `public/dsp/chain.wasm`, and it has two
 * hosts: the browser's AudioWorklet and the native Tonecraft Engine, which runs
 * the identical file through wasmtime for ASIO. Neither host knows what the
 * chain does. They move samples in and out, forward `tc_*` calls they do not
 * interpret, and hand back the meter frame described here.
 *
 * That is the whole reason this file exists: a feature added to the chain is
 * in both hosts the moment it is compiled, because there is nothing in either
 * host to add it to. `schema/generate.ts` turns this file and `params.ts` into
 * `dsp/chain.generated.h`; `npm run check` fails when the committed header no
 * longer matches.
 */

import { STAGES } from './params.ts';

/**
 * Bumped whenever a `tc_*` export changes meaning or signature, or the meter
 * frame changes layout. A host compares it with what it was written against
 * and refuses a module it does not understand, rather than calling a function
 * with the wrong arguments.
 */
export const CHAIN_ABI_VERSION = 1;

/**
 * The meter frame, in order. Posted about 30 times a second (AD-12): losing
 * one changes nothing. Append-only, like the parameters, so an old reader of a
 * newer frame still finds every field it knew where it left it.
 */
export const METERS = [
  /** Peak arriving on the selected input, before our own gain. */
  'input_peak',
  /** Peak leaving the input stage, on its way into the amplifier. */
  'drive_peak',
  /** 1 while the gate is open, 0 while it is shut, in between while it moves. */
  'gate',
  /** Share of the arriving energy above 2 kHz — the onboard-mic-input signature. */
  'brightness',
  /** Peak on each captured channel, before one is chosen. */
  'channel0_peak',
  'channel1_peak',
  /** The channel `follow` settled on, or -1 when a channel was chosen by hand. */
  'following',
  /** Peak and RMS at the very end, after the limiter. */
  'output_peak',
  'output_rms',
  /** Where the file source is, in seconds, and whether it is still playing. */
  'file_seconds',
  'file_playing',
  /** What the looper is doing (`LOOP_STATES`), where it is, and how long it is — seconds. */
  'loop_state',
  'loop_seconds',
  'loop_length',
  /**
   * What the pitch shifter is adding to the round trip, in ms. Zero while it
   * is bypassed, and while it is set to no shift at all. It is on screen for
   * the same reason the round trip is (FR-35): a delay nobody mentions is a
   * delay the player blames on the product.
   */
  'pitch_delay_ms',
] as const;

export type MeterField = (typeof METERS)[number];

/** Per-stage RMS follows the named fields, one slot per `Stage.meterSlot`. */
export const STAGE_RMS_OFFSET = METERS.length;
export const STAGE_SLOTS = Math.max(...STAGES.map((s) => s.meterSlot)) + 1;
export const METER_COUNT = STAGE_RMS_OFFSET + STAGE_SLOTS;

/** Index of a named field in the meter frame. */
export const meterIndex = (field: MeterField): number => METERS.indexOf(field);

/** Slots the chain accepts in `tc_set_ir`. */
export const IR_SLOTS = { cab: 0, reverb: 1 } as const;

/** Codes `tc_set_input_channel` accepts. */
export const CHANNEL_CODES = { left: 0, right: 1, sum: -1, follow: -2 } as const;

/** Waveforms `tc_click_voice` accepts. */
export const CLICK_WAVES = { sine: 0, triangle: 1 } as const;

/**
 * What the looper reports in `loop_state`. One button cycles through them
 * (`tc_loop_press`), which is how every looper pedal works and the only shape
 * that can be operated without looking at it.
 */
export const LOOP_STATES = {
  empty: 0,
  recording: 1,
  playing: 2,
  overdubbing: 3,
  stopped: 4,
} as const;

export type LoopState = keyof typeof LOOP_STATES;

/** Longest loop the chain will record, in seconds. It is memory, allocated at init. */
export const LOOP_MAX_SECONDS = 60;
