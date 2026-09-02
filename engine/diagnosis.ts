/**
 * Turning measurements into sentences, and nothing else.
 *
 * Every function here is pure. That is deliberate: the hard part of FR-11 and
 * FR-35 is not measuring, it is *judging* — deciding that 28 ms deserves a
 * number and 41 ms deserves an explanation, or that a weak, dull signal from a
 * device called "Realtek" is an impedance mismatch rather than a quiet player.
 * A judgement that can only be exercised by plugging a guitar into a laptop is
 * a judgement nobody checks.
 *
 * Two rules run through all of it:
 *
 * - **Cause in one sentence, remedy in one sentence.** No apology, no hedging.
 * - **Nothing blocks.** Every verdict here is informational. There is no state
 *   this module can return that stops someone playing (FR-12, FR-37).
 */

import type { DeviceKind } from './input.ts';

// ---------------------------------------------------------------------------
// Latency (FR-35)

export type LatencyTier = 'quiet' | 'explained' | 'named';

export interface LatencyVerdict {
  readonly tier: LatencyTier;
  readonly ms: number;
  /** Present from the middle tier up. Absent means the product says nothing. */
  readonly cause?: string;
  readonly remedy?: string;
}

/** Below this, the delay is not felt and nothing is said. */
export const LATENCY_QUIET_MS = 20;
/** Above this, the cause is named. Between the two, the figure explains itself. */
export const LATENCY_NAMED_MS = 35;

export function judgeLatency(ms: number, device: DeviceKind): LatencyVerdict {
  if (ms < LATENCY_QUIET_MS) return { tier: 'quiet', ms };

  if (ms < LATENCY_NAMED_MS) {
    return {
      tier: 'explained',
      ms,
      cause:
        'Most of this delay belongs to your operating system and audio driver, ' +
        'not to the processing.',
      remedy: 'It is playable as it is; a USB interface would lower it further.',
    };
  }

  // Past here the delay is felt, so the product says why rather than leaving
  // the player to conclude the engine is slow.
  return {
    tier: 'named',
    ms,
    cause:
      device === 'onboard'
        ? 'Your computer’s built-in audio adds most of this delay.'
        : 'Your audio driver is buffering more than this engine asked for.',
    remedy:
      device === 'onboard'
        ? 'A USB interface or a guitar-to-USB cable typically cuts it in half.'
        : 'Closing other audio applications, or a different USB port, often helps.',
  };
}

// ---------------------------------------------------------------------------
// Dropouts (FR-36, FR-37)

export interface DropoutVerdict {
  readonly perMinute: number;
  readonly audible: boolean;
  readonly cause?: string;
  readonly remedy?: string;
}

/**
 * The product's own target is under 0.2 reported dropouts per session. A
 * session is minutes long, so anything approaching one a minute is already the
 * failure this metric exists to catch.
 */
export const DROPOUTS_AUDIBLE_PER_MINUTE = 1;

export function judgeDropouts(count: number, secondsElapsed: number): DropoutVerdict {
  const perMinute = secondsElapsed > 0 ? (count / secondsElapsed) * 60 : 0;
  if (perMinute < DROPOUTS_AUDIBLE_PER_MINUTE) return { perMinute, audible: false };

  return {
    perMinute,
    audible: true,
    // Never a refusal and never a redirect: the listen path is offered, and
    // the player decides (FR-37).
    cause: 'This machine is not keeping up with the audio thread, so the sound is breaking up.',
    remedy: 'Closing other tabs usually helps; otherwise the preset pages play the same tone as a file.',
  };
}

// ---------------------------------------------------------------------------
// Jitter (FR-38)

export interface JitterStats {
  readonly meanMs: number;
  readonly deviationMs: number;
  readonly samples: number;
}

/**
 * Standard deviation of the interval between metering frames.
 *
 * A constant 20 ms delay is forgotten within a minute; a delay that varies is
 * unplayable forever. That is why this is instrumented next to the absolute
 * figure rather than instead of it — the number the player sees is not the
 * number that decides whether they can play.
 */
export function jitterOf(intervalsMs: readonly number[]): JitterStats {
  if (intervalsMs.length < 2) return { meanMs: 0, deviationMs: 0, samples: intervalsMs.length };
  const mean = intervalsMs.reduce((a, b) => a + b, 0) / intervalsMs.length;
  const variance =
    intervalsMs.reduce((a, b) => a + (b - mean) ** 2, 0) / (intervalsMs.length - 1);
  return { meanMs: mean, deviationMs: Math.sqrt(variance), samples: intervalsMs.length };
}

// ---------------------------------------------------------------------------
// The input itself (FR-10, FR-11)

export interface Calibration {
  readonly deviceKind: DeviceKind;
  readonly deviceLabel: string;
  readonly roundTripMs: number;
  /** Peak amplitude seen, 0 to 1. */
  readonly peak: number;
  /** Share of energy above 2 kHz, 0 to 1. */
  readonly brightness: number;
}

export type InputProblem = 'impedance' | 'level-low' | 'level-clipping' | null;

export interface InputVerdict {
  readonly problem: InputProblem;
  readonly cause?: string;
  readonly remedy?: string;
  /** Always true. There is no measurement that stops someone playing (FR-12). */
  readonly canPlay: true;
}

/** Below this the player is amplifying their own noise floor to be heard. */
export const PEAK_TOO_LOW = 0.02;
/** At this the converter is already clipping before the chain sees anything. */
export const PEAK_CLIPPING = 0.98;
/**
 * A guitar into a proper instrument input keeps a good share of its overtones.
 * Into a few kΩ microphone input with a bias voltage on it, they are loaded
 * away — this is what "sounds thin" measures as.
 */
export const BRIGHTNESS_DULL = 0.10;

export function judgeInput(c: Calibration): InputVerdict {
  const quiet = c.peak < PEAK_TOO_LOW;
  const dull = c.brightness < BRIGHTNESS_DULL;

  // Quiet *and* dull, on an onboard input, is the impedance signature. A
  // passive pickup wants a 500 kΩ to 1 MΩ load; a microphone input offers a few
  // kΩ and injects a bias voltage meant for an electret. The player cannot tell
  // this from a bad amp model, and will blame the amp model.
  if (quiet && dull && (c.deviceKind === 'onboard' || c.deviceKind === 'unknown')) {
    return {
      problem: 'impedance',
      cause:
        'Your guitar is plugged into a microphone input, which loads the pickup ' +
        'and takes the highs with it.',
      remedy: 'A guitar-to-USB cable or an audio interface fixes it for about 25 euros.',
      canPlay: true,
    };
  }

  if (c.peak >= PEAK_CLIPPING) {
    return {
      problem: 'level-clipping',
      cause: 'The input is clipping before the amp sees it.',
      remedy: 'Turn down your interface’s input gain until the loudest playing stops peaking.',
      canPlay: true,
    };
  }

  if (quiet) {
    return {
      problem: 'level-low',
      cause: 'The signal reaching the browser is very quiet.',
      remedy: 'Turn up your interface’s input gain, or your guitar’s volume knob.',
      canPlay: true,
    };
  }

  // A healthy interface hears nothing about hardware at all.
  return { problem: null, canPlay: true };
}
