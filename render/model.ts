/**
 * The amp model, outside the browser.
 *
 * `public/nam/wavenet.wasm` is a standalone module with no imports, no runtime
 * and no malloc, so running it from Node is instantiating it and moving floats
 * in and out of its static buffers — the same thing `nam-processor.js` does on
 * the audio thread, through the same exports. That sameness is the point:
 * calibration, the equivalence check and the offline renderer all have to be
 * measuring what a player will actually hear.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `tonecraft::ModelStatus`, from `dsp/model/wavenet.h`. */
export const MODEL_STATUS: readonly string[] = [
  'ok',
  'the blob is shorter than its own header',
  'the blob is not a .tcnm (bad magic)',
  'the blob is a .tcnm of a version this engine does not read',
  'the model is larger than the engine is sized for',
  "the model's layer arrays do not fit together",
  'the weight count does not match the declared shape',
  'the model needs more history than the pool holds',
  'the model was trained at a sample rate this chain does not run at',
];

interface Exports {
  memory: WebAssembly.Memory;
  init(): void;
  blob_ptr(): number;
  blob_capacity(): number;
  in_ptr(): number;
  out_ptr(): number;
  block_frames(): number;
  load(byteCount: number): number;
  loaded(): number;
  reset(): void;
  has_loudness(): number;
  loudness_db(): number;
  receptive_field(): number;
  process(frames: number): void;
}

export class Model {
  readonly #e: Exports;
  readonly #heap: Float32Array;
  readonly #bytes: Uint8Array;
  readonly #inAt: number;
  readonly #outAt: number;
  readonly #block: number;

  private constructor(e: Exports) {
    this.#e = e;
    e.init();
    // Memory never grows (ALLOW_MEMORY_GROWTH=0), so these views never detach.
    this.#heap = new Float32Array(e.memory.buffer);
    this.#bytes = new Uint8Array(e.memory.buffer);
    this.#inAt = e.in_ptr() >> 2;
    this.#outAt = e.out_ptr() >> 2;
    this.#block = e.block_frames();
  }

  static async load(): Promise<Model> {
    const wasm = fs.readFileSync(path.join(ROOT, 'public/nam/wavenet.wasm'));
    const { instance } = await WebAssembly.instantiate(
      wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer,
      {},
    );
    return new Model(instance.exports as unknown as Exports);
  }

  get blockFrames(): number { return this.#block; }
  get loudnessDb(): number | null { return this.#e.has_loudness() ? this.#e.loudness_db() : null; }
  get receptiveField(): number { return this.#e.receptive_field(); }

  /** Loads a `.tcnm` blob. Throws by name rather than playing a different amp. */
  loadBlob(file: string): void {
    const blob = fs.readFileSync(file);
    if (blob.length > this.#e.blob_capacity()) {
      throw new Error(`${path.basename(file)} is ${blob.length} bytes; the engine holds ${this.#e.blob_capacity()}`);
    }
    this.#bytes.set(blob, this.#e.blob_ptr());
    const status = this.#e.load(blob.length);
    if (status !== 0 || !this.#e.loaded()) {
      throw new Error(`${path.basename(file)}: ${MODEL_STATUS[status] ?? `status ${status}`}`);
    }
    this.#e.reset();
  }

  reset(): void { this.#e.reset(); }

  /** Whole-buffer render, in the block size the audio thread uses. */
  render(input: Float32Array): Float32Array {
    const n = this.#block;
    const out = new Float32Array(input.length);
    const tail = new Float32Array(n);
    for (let b = 0; b < input.length; b += n) {
      const have = Math.min(n, input.length - b);
      if (have === n) {
        this.#heap.set(input.subarray(b, b + n), this.#inAt);
      } else {
        tail.fill(0);
        tail.set(input.subarray(b, b + have));
        this.#heap.set(tail, this.#inAt);
      }
      this.#e.process(n);
      out.set(this.#heap.subarray(this.#outAt, this.#outAt + have), b);
    }
    return out;
  }
}
