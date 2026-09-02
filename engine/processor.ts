/// <reference path="./audioworklet.d.ts" />

/**
 * The one AudioWorkletProcessor that holds the entire chain (AD-1).
 *
 * Not one node per effect: every node boundary is a buffer copy, and metering
 * across two contexts would need a second graph. Everything lives here.
 *
 * Rules this file exists to keep (AD-13):
 *
 * - `process()` allocates nothing. Every buffer and every view is created at
 *   construction or when the module arrives, never per block.
 * - No `await`, no exception, no DOM access, no logging in the audio path.
 * - The WASM module is instantiated *inside* the AudioWorkletGlobalScope from
 *   bytes handed over by `postMessage`. The worklet never fetches.
 * - `process()` always produces audio — silence at worst, never nothing.
 */

import { PARAMS, BLOCK_FRAMES } from '../schema/params.ts';

interface ChainExports {
  readonly memory: WebAssembly.Memory;
  tc_init(sampleRate: number): number;
  tc_process(frames: number): void;
  tc_set_param(index: number, value: number): void;
  tc_input_ptr(): number;
  tc_output_ptr(): number;
  tc_meter_ptr(): number;
  tc_meter_count(): number;
  tc_param_count(): number;
  tc_added_latency_frames(): number;
  tc_resampling(): number;
  tc_input_peak(): number;
  tc_input_brightness(): number;
  tc_probe_frames(): number;
  tc_load_ir(byteCount: number): number;
  tc_ir_ptr(): number;
  tc_ir_capacity(): number;
  tc_ir_taps(): number;
}

/** Metering cadence (AD-12). Thirty small messages a second is negligible. */
const METER_HZ = 30;

/** Continuous parameters cross as AudioParam values (FR-19, AD-20). */
const AUTOMATED = PARAMS.filter((p) => p.unit !== 'bool');
/** Discrete ones arrive by postMessage; an AudioParam would interpolate a switch. */
const DISCRETE = PARAMS.filter((p) => p.unit === 'bool');

class TonecraftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return AUTOMATED.map((p) => ({
      name: p.id,
      defaultValue: p.default,
      minValue: p.min,
      maxValue: p.max,
      // k-rate: a parameter is read once per block. The smoothing that matters
      // is the AudioParam's own interpolation, applied once at this boundary
      // and nowhere else (AD-20).
      automationRate: 'k-rate' as const,
    }));
  }

  #exports: ChainExports | null = null;
  #input: Float32Array | null = null;
  #output: Float32Array | null = null;
  #meters: Float32Array | null = null;

  /** Pre-allocated. Posted by structured clone so ownership stays here. */
  #meterMessage: Float32Array = new Float32Array(0);

  /** Index of each automated parameter, resolved once so process() does no lookup. */
  #automatedIndex: Int32Array = new Int32Array(AUTOMATED.length);
  #lastAutomated: Float32Array = new Float32Array(AUTOMATED.length);

  #framesSinceMeter = 0;
  #meterInterval = 0;

  /**
   * Counted here and only here — the main thread never infers one from a gap it
   * observes (FR-36). `currentFrame` advances by exactly one quantum per call
   * when the audio thread keeps up; a larger jump means a render deadline was
   * missed and the context skipped ahead. Story 1.12 adds the UI, the jitter
   * figure and the honest statement of cause.
   */
  #dropouts = 0;
  #lastFrame = -1;
  #ready = false;

  constructor() {
    super();

    for (let i = 0; i < AUTOMATED.length; i += 1) {
      const p = AUTOMATED[i];
      if (p === undefined) continue;
      this.#automatedIndex[i] = PARAMS.findIndex((q) => q.id === p.id);
      this.#lastAutomated[i] = Number.NaN;
    }

    this.port.onmessage = (event: MessageEvent): void => {
      void this.#onMessage(event.data as Record<string, unknown>);
    };
  }

  /**
   * Async, and deliberately outside the audio path: instantiation happens once,
   * before `#ready` is set. `process()` never awaits anything.
   */
  async #onMessage(data: Record<string, unknown>): Promise<void> {
    if (data['type'] === 'module') {
      const bytes = data['bytes'] as ArrayBuffer;

      let exports: ChainExports;
      try {
        const { instance } = await WebAssembly.instantiate(bytes, {});
        exports = instance.exports as unknown as ChainExports;
      } catch (cause) {
        // Outside the audio path, so a throw here is safe — but it must be
        // reported. An unhandled rejection would leave the main thread waiting
        // on a promise that never settles.
        this.port.postMessage({
          type: 'instantiate-failed',
          detail: cause instanceof Error ? cause.message : String(cause),
        });
        return;
      }

      const status = exports.tc_init(sampleRate);
      if (status !== 0) {
        // Resolved at init and reported as a status code, never thrown (AD-13).
        this.port.postMessage({ type: 'error', status, sampleRate });
        return;
      }

      const meterCount = exports.tc_meter_count();
      const heap = exports.memory.buffer;
      this.#input = new Float32Array(heap, exports.tc_input_ptr(), BLOCK_FRAMES);
      this.#output = new Float32Array(heap, exports.tc_output_ptr(), BLOCK_FRAMES);
      this.#meters = new Float32Array(heap, exports.tc_meter_ptr(), meterCount);
      this.#meterMessage = new Float32Array(meterCount);
      this.#meterInterval = Math.max(1, Math.round(sampleRate / METER_HZ / BLOCK_FRAMES));
      this.#exports = exports;
      this.#ready = true;

      this.port.postMessage({
        type: 'ready',
        meterCount,
        // Zero at the internal rate. Reported so the round trip the player sees
        // is the whole truth, including what conversion costs them (FR-35).
        addedLatencyFrames: exports.tc_added_latency_frames(),
        resampling: exports.tc_resampling() === 1,
        sampleRate,
      });
      return;
    }

    if (data['type'] === 'ir') {
      const exports = this.#exports;
      if (exports === null) return;
      const blob = new Uint8Array(data['bytes'] as ArrayBuffer);
      if (blob.byteLength > exports.tc_ir_capacity()) {
        this.port.postMessage({ type: 'ir-failed', status: 4 });
        return;
      }
      new Uint8Array(exports.memory.buffer, exports.tc_ir_ptr(),
                     exports.tc_ir_capacity()).set(blob);
      const status = exports.tc_load_ir(blob.byteLength);
      // Named at load, never discoverable later: process() has no error path.
      this.port.postMessage(
        status === 0
          ? { type: 'ir-loaded', taps: exports.tc_ir_taps() }
          : { type: 'ir-failed', status },
      );
      return;
    }

    if (data['type'] === 'param') {
      // Discrete only: preset switches, bypass, mute. Continuous values come
      // through AudioParam so they interpolate sample-accurately (FR-19).
      const id = data['id'] as string;
      const value = data['value'] as number;
      const index = PARAMS.findIndex((p) => p.id === id);
      if (index >= 0) this.#exports?.tc_set_param(index, value);
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    if (out === undefined) return true;

    const exports = this.#exports;
    const input = this.#input;
    const output = this.#output;

    if (!this.#ready || exports === null || input === null || output === null) {
      out.fill(0);
      return true;
    }

    const frames = out.length;

    if (this.#lastFrame >= 0) {
      const skipped = currentFrame - this.#lastFrame - frames;
      if (skipped > 0) this.#dropouts += 1;
    }
    this.#lastFrame = currentFrame;

    const inp = inputs[0]?.[0];

    // Mono. The chain is mono end to end; a stereo input would be a second
    // chain, which the CPU budget does not have room for.
    if (inp === undefined) {
      input.fill(0);
    } else {
      input.set(inp.subarray(0, frames));
    }

    // Push only what changed. An AudioParam array is length 1 when the value is
    // constant across the block, which is the common case.
    for (let i = 0; i < AUTOMATED.length; i += 1) {
      const descriptor = AUTOMATED[i];
      if (descriptor === undefined) continue;
      const values = parameters[descriptor.id];
      if (values === undefined) continue;
      const value = values[values.length - 1] ?? descriptor.default;
      if (value !== this.#lastAutomated[i]) {
        this.#lastAutomated[i] = value;
        exports.tc_set_param(this.#automatedIndex[i] ?? 0, value);
      }
    }

    exports.tc_process(frames);
    out.set(output.subarray(0, frames));

    // Copy to every other output channel rather than processing twice.
    const channels = outputs[0];
    if (channels !== undefined) {
      for (let c = 1; c < channels.length; c += 1) channels[c]?.set(out);
    }

    this.#framesSinceMeter += 1;
    if (this.#framesSinceMeter >= this.#meterInterval) {
      this.#framesSinceMeter = 0;
      const meters = this.#meters;
      if (meters !== null) {
        this.#meterMessage.set(meters);
        // Structured clone rather than transfer: transferring would detach the
        // array and force an allocation next time round (AD-12). Dropping this
        // message must never affect audio, so it is fire and forget.
        this.port.postMessage({
          type: 'meters',
          meters: this.#meterMessage,
          dropouts: this.#dropouts,
          // Calibration rides along rather than opening a second channel: the
          // measurement is already made, and one message a frame is the budget.
          peak: exports.tc_input_peak(),
          brightness: exports.tc_input_brightness(),
          probeFrames: exports.tc_probe_frames(),
        });
      }
    }

    return true;
  }
}

registerProcessor('tonecraft', TonecraftProcessor);

// Referenced so the bundler keeps them; discrete parameters are driven from the
// main thread by postMessage rather than by an AudioParam.
void DISCRETE;
