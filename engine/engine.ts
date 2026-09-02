/**
 * Main-thread side of the engine: opens the input, creates the context, hands
 * the WASM bytes to the worklet, and reads metering back.
 *
 * The main thread owns state; the worklet owns nothing (AD-11). Nothing here
 * reads a value back out of the audio thread — metering is a measurement, not
 * state, and it flows one way (AD-12).
 */

import { PARAMS, INTERNAL_SAMPLE_RATE } from '../schema/params.ts';

export interface Meters {
  readonly rms: Float32Array;
  readonly dropouts: number;
}

export interface EngineOptions {
  /** Called at up to 30 Hz. Dropping a call must never matter (AD-12). */
  onMeters?: (meters: Meters) => void;
}

export type EngineFailure =
  | { kind: 'no-input-device' }
  | { kind: 'permission-denied' }
  | { kind: 'unsupported-sample-rate'; deviceRate: number; internalRate: number };

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
  readonly #onMeters: ((meters: Meters) => void) | undefined;

  constructor(options: EngineOptions = {}) {
    this.#onMeters = options.onMeters;
  }

  get context(): AudioContext | null {
    return this.#context;
  }

  /**
   * Round trip, as the browser reports it (FR-35). Shown permanently, never
   * used to decide anything: quality never adapts to the machine (AD-5).
   */
  get roundTripMs(): number | null {
    const ctx = this.#context;
    if (ctx === null) return null;
    const output = 'outputLatency' in ctx ? ctx.outputLatency : 0;
    return (ctx.baseLatency + output) * 1000;
  }

  /**
   * Must be called from a user gesture — the autoplay policy will not create a
   * running context otherwise.
   */
  async start(): Promise<void> {
    if (this.#context !== null) return;

    // The WebRTC voice pipeline is off, explicitly and individually. It is on
    // by default and it destroys a guitar signal: echo cancellation chews
    // sustain, noise suppression eats pick attack, AGC fights the player's
    // volume knob. This is the single most common failure mode for browser
    // audio apps. Story 1.4 adds the automated test that asserts each flag.
    const stream = await this.#openInput();
    this.#stream = stream;

    const track = stream.getAudioTracks()[0];
    if (track === undefined) {
      throw new EngineError({ kind: 'no-input-device' }, 'No audio track on the input stream.');
    }

    // Read the device's rate BEFORE the context exists, then create the context
    // at exactly that rate. Letting the browser resample implicitly costs both
    // latency and quality, and neither is visible from here (FR-9).
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
          case 'ready':
            resolve();
            break;
          case 'error':
            reject(
              new EngineError(
                {
                  kind: 'unsupported-sample-rate',
                  deviceRate: data['sampleRate'] as number,
                  internalRate: INTERNAL_SAMPLE_RATE,
                },
                // Honest about the cause and the fix, one sentence each.
                `This engine build runs at ${INTERNAL_SAMPLE_RATE} Hz and your ` +
                  `interface is at ${String(data['sampleRate'])} Hz. Set the ` +
                  `interface to ${INTERNAL_SAMPLE_RATE} Hz until the boundary ` +
                  `resampler ships.`,
              ),
            );
            break;
          case 'meters':
            this.#onMeters?.({
              rms: data['meters'] as Float32Array,
              dropouts: data['dropouts'] as number,
            });
            break;
          default:
            break;
        }
      };
    });

    // The bytes are fetched here and handed over. The worklet never fetches:
    // its global scope has no business doing I/O (AD-13).
    const bytes = await (await fetch(WASM_URL)).arrayBuffer();
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
  }

  async #openInput(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          // Not in every lib.dom yet, and off is what we need.
          voiceIsolation: false,
          channelCount: 1,
          latency: 0,
        } as MediaTrackConstraints,
        video: false,
      });
    } catch (cause) {
      const name = cause instanceof DOMException ? cause.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new EngineError(
          { kind: 'permission-denied' },
          'Microphone access was refused. Allow it in the address bar and reload.',
        );
      }
      throw new EngineError(
        { kind: 'no-input-device' },
        'No audio input found. Connect an interface and reload.',
      );
    }
  }
}
