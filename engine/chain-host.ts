/**
 * What `engine.ts` needs from whatever runs the chain.
 *
 * There are two hosts, and they are deliberately dumb:
 *
 *   - `WebHost` — the browser: an AudioContext, one AudioWorklet, the input;
 *   - `NativeHost` — Tonecraft Engine, the native companion that runs the same
 *     `chain.wasm` on ASIO, CoreAudio or ALSA, reached over a loopback socket.
 *
 * A host moves samples, forwards `tc_*` calls it does not interpret, and hands
 * back meter frames and a dropout count. Everything the product *does* —
 * parameter mapping, power, the tuner's silence, the file source, the capture
 * — is in `engine.ts` and `dsp/`, which both hosts share. That is the point:
 * a feature written once is in both, and nothing in a host can be forgotten
 * because there is nothing in a host to forget.
 */

export type EngineFailure =
  | { kind: 'no-input-device' }
  | { kind: 'permission-denied' }
  | { kind: 'engine-missing' }
  | { kind: 'engine-broken'; detail: string }
  | { kind: 'native-unreachable' }
  | { kind: 'native-failed'; detail: string };

export class EngineError extends Error {
  constructor(readonly failure: EngineFailure, message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface CallResult {
  readonly value: number;
  /** tc_read_* exports return the caller's payload after the chain fills it. */
  readonly data?: Uint8Array<ArrayBuffer>;
  /** Set when the call failed; for `tc_load_model`, the chain's own reason. */
  readonly error?: string;
}

export interface HostEvents {
  /** A meter frame (schema/chain.ts) and the host's dropout count, ~30 Hz. */
  onMeters(frame: Float32Array, dropouts: number): void;
  /** The host can no longer run the chain: a dead worklet, a closed engine. */
  onFailure(message: string): void;
  /** The host replaced its chain with a fresh one (new device, new rate): send it everything again. */
  onReopened?(): void;
}

export interface LatencyParts {
  /** What the input side costs, in ms: the browser's render buffer, or the driver's input. */
  readonly input: number;
  /** What the output side costs, in ms. */
  readonly output: number;
}

export interface ChainHost {
  readonly kind: 'browser' | 'native';
  /** The chain's rate. Valid once started. */
  readonly sampleRate: number;

  /**
   * Calls a chain export and does not wait. A payload is handed over — the
   * caller must not touch it afterwards — and arrives as (pointer, bytes, ...).
   */
  send(fn: string, args?: readonly number[], data?: ArrayBufferView<ArrayBuffer>): void;
  /** The same, answered. Resolves with `value: 0` and an error on failure or timeout. */
  call(fn: string, args?: readonly number[], data?: ArrayBufferView<ArrayBuffer>): Promise<CallResult>;

  /**
   * Whether the live capture should deliver samples at all. The chain gates
   * them itself (`tc_set_live_input`); a host that can also release the device
   * does so, because a laptop's microphone should not be listening for nothing.
   */
  setCaptureOpen(open: boolean): void;

  /** Starts or stops delivering the tuner tap, for hosts that have to stream it. */
  setTunerTap(on: boolean): void;
  /** Copies the latest clean input window and returns its rate, or null. */
  readTunerInput(target: Float32Array<ArrayBuffer>): number | null;
  readonly tunerBufferSize: number;

  /** The round trip as the host reports it, in ms (FR-35). */
  readonly roundTripMs: number | null;
  readonly latencyParts: LatencyParts | null;

  /** Brings a suspended output back, where that is a thing. */
  resume(): void;
  stop(): Promise<void>;
}

/** Wraps a Float32Array so it can be handed to `send` without aliasing the caller's copy. */
export function owned(samples: Float32Array): Float32Array<ArrayBuffer> {
  const copy = new Float32Array(samples.length);
  copy.set(samples);
  return copy;
}
