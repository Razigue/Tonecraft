/**
 * Main-thread side of the engine: opens the input, creates the context, hands
 * the WASM bytes to the worklet, and reads metering back.
 *
 * The main thread owns state; the worklet owns nothing (AD-11). Nothing here
 * reads a value back out of the audio thread — metering is a measurement, not
 * state, and it flows one way (AD-12).
 */

import { PARAMS, INTERNAL_SAMPLE_RATE } from '../schema/params.ts';
import { openInput, InputError, type DeviceKind, classifyDevice } from './input.ts';
import {
  judgeLatency, judgeDropouts, jitterOf, judgeInput,
  type LatencyVerdict, type DropoutVerdict, type JitterStats, type InputVerdict,
} from './diagnosis.ts';

export interface Meters {
  readonly rms: Float32Array;
  readonly dropouts: number;
  readonly peak: number;
  readonly brightness: number;
}

/** Everything the product knows about how well it is running (FR-35 to FR-38). */
export interface Health {
  readonly latency: LatencyVerdict;
  readonly dropouts: DropoutVerdict;
  readonly jitter: JitterStats;
  readonly input: InputVerdict;
  /** Cold load to first audible note, in ms. NFR-3 targets a median under 8 s. */
  readonly timeToFirstNoteMs: number | null;
}

export interface EngineOptions {
  /** Called at up to 30 Hz. Dropping a call must never matter (AD-12). */
  onMeters?: (meters: Meters) => void;
}

export type EngineFailure =
  | { kind: 'no-input-device' }
  | { kind: 'permission-denied' }
  | { kind: 'engine-missing' }
  | { kind: 'engine-broken'; detail: string }
  | { kind: 'unsupported-sample-rate'; deviceRate: number };

/** What the engine found once it was running. Shown, never used to decide. */
export interface EngineInfo {
  readonly deviceRate: number;
  /** False when the device already runs at the chain's internal rate. */
  readonly resampling: boolean;
  /** Cost of that conversion, in milliseconds. Zero when not resampling. */
  readonly conversionLatencyMs: number;
}

export class EngineError extends Error {
  constructor(readonly failure: EngineFailure, message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

const WASM_URL = '/tonecraft.wasm';
const PROCESSOR_URL = '/tonecraft-processor.js';

export class Engine {
  #context: AudioContext | null = null;
  #node: AudioWorkletNode | null = null;
  #stream: MediaStream | null = null;
  #info: EngineInfo | null = null;
  #deviceKind: DeviceKind = 'unknown';
  #deviceLabel = '';
  #startedAt = 0;
  #firstAudioAt: number | null = null;
  #dropouts = 0;
  #peak = 0;
  #brightness = 0;
  /** Wall-clock arrival of each metering frame; the source of the jitter figure. */
  #meterArrivals: number[] = [];
  readonly #onMeters: ((meters: Meters) => void) | undefined;

  constructor(options: EngineOptions = {}) {
    this.#onMeters = options.onMeters;
  }

  get context(): AudioContext | null {
    return this.#context;
  }

  get info(): EngineInfo | null {
    return this.#info;
  }

  /**
   * The whole picture, judged. Nothing here decides anything — every verdict is
   * informational and the play path is never refused on any of it (FR-37).
   */
  get health(): Health | null {
    const ms = this.roundTripMs;
    if (ms === null) return null;
    const elapsed = (performance.now() - this.#startedAt) / 1000;
    const intervals: number[] = [];
    for (let i = 1; i < this.#meterArrivals.length; i += 1) {
      intervals.push(this.#meterArrivals[i]! - this.#meterArrivals[i - 1]!);
    }
    return {
      latency: judgeLatency(ms, this.#deviceKind),
      dropouts: judgeDropouts(this.#dropouts, elapsed),
      jitter: jitterOf(intervals),
      input: judgeInput({
        deviceKind: this.#deviceKind,
        deviceLabel: this.#deviceLabel,
        roundTripMs: ms,
        peak: this.#peak,
        brightness: this.#brightness,
      }),
      timeToFirstNoteMs:
        this.#firstAudioAt === null ? null : this.#firstAudioAt - this.#startedAt,
    };
  }

  /**
   * Round trip, as the browser reports it (FR-35). Shown permanently, never
   * used to decide anything: quality never adapts to the machine (AD-5).
   */
  get roundTripMs(): number | null {
    const ctx = this.#context;
    if (ctx === null) return null;
    const output = 'outputLatency' in ctx ? ctx.outputLatency : 0;
    // Sample-rate conversion is part of the round trip the player feels, so it
    // is added here rather than quietly omitted from the figure on screen.
    return (ctx.baseLatency + output) * 1000 + (this.#info?.conversionLatencyMs ?? 0);
  }

  /**
   * Must be called from a user gesture — the autoplay policy will not create a
   * running context otherwise.
   */
  async start(): Promise<void> {
    if (this.#context !== null) return;
    // NFR-3 measures from the gesture, not from when the engine happens to be
    // ready: the permission prompt is part of what the player waits through.
    this.#startedAt = performance.now();

    // The constraints, the error mapping and the test that asserts each flag
    // all live in engine/input.ts.
    const stream = await this.#open();
    this.#stream = stream;

    const track = stream.getAudioTracks()[0];
    if (track === undefined) {
      throw new EngineError({ kind: 'no-input-device' }, 'No audio track on the input stream.');
    }

    // Read the device's rate BEFORE the context exists, then create the context
    // at exactly that rate. Letting the browser resample implicitly costs both
    // latency and quality, and neither is visible from here (FR-9).
    this.#deviceLabel = track.label;
    this.#deviceKind = classifyDevice(track.label);

    const deviceRate = track.getSettings().sampleRate ?? INTERNAL_SAMPLE_RATE;

    const context = new AudioContext({
      sampleRate: deviceRate,
      // Not 'interactive', which is more conservative than we want.
      latencyHint: 0,
    });
    this.#context = context;

    await context.audioWorklet.addModule(PROCESSOR_URL);

    const node = new AudioWorkletNode(context, 'tonecraft', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.#node = node;

    const ready = new Promise<void>((resolve, reject) => {
      node.port.onmessage = (event: MessageEvent): void => {
        const data = event.data as Record<string, unknown>;
        switch (data['type']) {
          case 'ready': {
            const rate = data['sampleRate'] as number;
            const frames = data['addedLatencyFrames'] as number;
            this.#info = {
              deviceRate: rate,
              resampling: data['resampling'] === true,
              conversionLatencyMs: (frames / rate) * 1000,
            };
            resolve();
            break;
          }
          case 'instantiate-failed':
            reject(
              new EngineError(
                { kind: 'engine-broken', detail: String(data['detail']) },
                'The audio engine could not be loaded. Reload the page; if it ' +
                  'persists the build is incomplete.',
              ),
            );
            break;
          case 'error':
            reject(
              new EngineError(
                { kind: 'unsupported-sample-rate', deviceRate: data['sampleRate'] as number },
                // Honest about the cause and the fix, one sentence each.
                `Your interface reports ${String(data['sampleRate'])} Hz, which ` +
                  `is outside anything real hardware offers. Set it to a ` +
                  `standard rate such as ${INTERNAL_SAMPLE_RATE} Hz and reload.`,
              ),
            );
            break;
          case 'meters': {
            this.#dropouts = data['dropouts'] as number;
            this.#peak = data['peak'] as number;
            this.#brightness = data['brightness'] as number;

            const now = performance.now();
            // A rolling window: jitter is a property of how things are going
            // now, not an average over the whole session.
            this.#meterArrivals.push(now);
            if (this.#meterArrivals.length > 90) this.#meterArrivals.shift();

            // First audible note: the first frame carrying real signal, not the
            // first frame at all — silence is not a note.
            if (this.#firstAudioAt === null && this.#peak > 0.01) this.#firstAudioAt = now;

            this.#onMeters?.({
              rms: data['meters'] as Float32Array,
              dropouts: this.#dropouts,
              peak: this.#peak,
              brightness: this.#brightness,
            });
            break;
          }
          default:
            break;
        }
      };
    });

    // The bytes are fetched here and handed over. The worklet never fetches:
    // its global scope has no business doing I/O (AD-13).
    const response = await fetch(WASM_URL);
    if (!response.ok) {
      // Without this the worklet would fail to instantiate a 404 page and the
      // promise below would never settle — the UI would sit on "Starting…"
      // forever with nothing said. Silence is the one failure mode this
      // product must not have.
      throw new EngineError(
        { kind: 'engine-missing' },
        'The audio engine is not built. Run `npm run build:wasm` and reload.',
      );
    }
    const bytes = await response.arrayBuffer();
    node.port.postMessage({ type: 'module', bytes }, [bytes]);
    await ready;

    // AD-1: exactly one node between input and output. Nothing else is
    // inserted here, ever — every node boundary is a buffer copy.
    context.createMediaStreamSource(stream).connect(node).connect(context.destination);

  }

  /** Continuous values go through AudioParam so they interpolate (FR-19, AD-20). */
  setParam(id: string, value: number): void {
    const param = PARAMS.find((p) => p.id === id);
    const node = this.#node;
    if (param === undefined || node === null) return;

    if (param.unit === 'bool') {
      // A switch must not be interpolated.
      node.port.postMessage({ type: 'param', id, value });
      return;
    }

    const audioParam = node.parameters.get(id);
    if (audioParam === undefined) return;
    const ctx = this.#context;
    if (ctx === null) return;
    audioParam.setTargetAtTime(value, ctx.currentTime, 0.01);
  }

  async stop(): Promise<void> {
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#node?.disconnect();
    await this.#context?.close();
    this.#stream = null;
    this.#node = null;
    this.#context = null;
    this.#info = null;
  }

  async #open(): Promise<MediaStream> {
    try {
      return await openInput(navigator.mediaDevices);
    } catch (cause) {
      if (cause instanceof InputError) {
        throw new EngineError({ kind: cause.reason }, cause.message);
      }
      throw cause;
    }
  }

}
