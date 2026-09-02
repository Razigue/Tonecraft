/**
 * Ambient declarations for the AudioWorkletGlobalScope.
 *
 * TypeScript's `lib.dom` describes the main thread only: `AudioWorkletProcessor`,
 * `registerProcessor` and the global `sampleRate` exist solely inside a worklet
 * and have no declarations anywhere. Without these the processor cannot be
 * written in strict TypeScript at all — and the alternative, `any` on the audio
 * path, is exactly where a silent type error would be least visible.
 *
 * Kept deliberately minimal: only what the processor actually uses.
 */

declare global {
  /** Sample rate of the context this worklet belongs to. Read-only, global. */
  const sampleRate: number;

  /** Frames rendered since the context was created. */
  const currentFrame: number;

  /** Context time in seconds. */
  const currentTime: number;

  interface AudioParamDescriptor {
    name: string;
    defaultValue?: number;
    minValue?: number;
    maxValue?: number;
    automationRate?: 'a-rate' | 'k-rate';
  }

  abstract class AudioWorkletProcessor {
    readonly port: MessagePort;
    constructor();
    /**
     * Called once per render quantum. Returning true keeps the node alive.
     *
     * `parameters` maps each declared parameter name to a Float32Array that is
     * length 1 when the value is constant across the block — the common case,
     * and the reason k-rate costs nothing to read.
     */
    abstract process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ): boolean;
  }

  function registerProcessor(
    name: string,
    constructor: new () => AudioWorkletProcessor,
  ): void;
}

export {};
