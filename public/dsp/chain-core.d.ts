/** Types for chain-core.js, which is plain JavaScript so a worklet can import it as is. */

export declare const ABI_VERSION: number;

export interface ChainExports {
  readonly memory: WebAssembly.Memory;
  tc_abi_version(): number;
  tc_meters_len(): number;
  [name: string]: unknown;
}

export declare function instantiateChain(bytes: BufferSource): Promise<ChainCore>;

export declare class ChainCore {
  readonly exports: ChainExports;
  readonly buffer: ArrayBuffer | null;
  readonly maxFrames: number;
  /** Where the host writes each input channel before process(). */
  readonly inputs: Float32Array[];
  readonly output: Float32Array | null;
  readonly tuner: Float32Array | null;
  readonly meters: Float32Array | null;
  init(sampleRate: number, maxFrames: number): void;
  refresh(): void;
  process(frames: number, inChannels: number): boolean;
  call(fn: string, args?: readonly number[], data?: BufferSource | null): number;
  lastError(): string;
}
