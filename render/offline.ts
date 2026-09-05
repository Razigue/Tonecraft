/**
 * Drives the chain over a file, from Node, through the identical `.wasm` the
 * browser loads (AD-6). No native build, no second implementation, and no
 * offline quality setting — what this writes is what a player hears.
 *
 * It exists to answer one question that cannot be answered by ear: given the
 * same input, how does our output differ from a reference, in numbers. Feeding
 * one DI through here and through a commercial plugin makes the two comparable
 * band by band, which is the only way to turn "it sounds thin" into a corner
 * frequency.
 *
 *     tsx render/offline.ts in.wav out.wav [--set id=value]... [--channel n]
 *
 * Parameters are named by their schema id and given in engineering units
 * (AD-9), so the command line reads the same as the wire format and neither
 * depends on where a fader happens to sit.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BLOCK_FRAMES, INTERNAL_SAMPLE_RATE, PARAMS } from '../schema/params.ts';
import { readWav, writeWav, toMono, type Wav } from './wav.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface ChainExports {
  readonly memory: WebAssembly.Memory;
  tc_init(rate: number): number;
  tc_process(frames: number): void;
  tc_input_ptr(): number;
  tc_output_ptr(): number;
  tc_set_param(index: number, value: number): void;
  tc_ir_ptr(): number;
  tc_load_ir(bytes: number): number;
  tc_ir_taps(): number;
  tc_meter_ptr(): number;
  tc_meter_count(): number;
}

export interface RenderOptions {
  /** Parameter overrides by schema id, in engineering units. */
  readonly set?: Readonly<Record<string, number>>;
  /** Which input channel feeds the chain. A Scarlett Solo puts the instrument
   *  jack on the right, so this is not always 0 (see `CLAUDE.md` §3). */
  readonly channel?: number;
  /** Silence pushed through after the file, so a reverb or gate tail is not
   *  cut off mid-decay by the end of the input. */
  readonly tailSeconds?: number;
}

export interface RenderResult {
  readonly out: Float32Array;
  readonly rate: number;
  /** Peak RMS reached in each stage's meter slot, over the whole render. */
  readonly meters: readonly number[];
}

export function render(input: Float32Array, rate: number, options: RenderOptions = {}): RenderResult {
  const bytes = readFileSync(join(ROOT, 'public', 'tonecraft.wasm'));
  const module = new WebAssembly.Module(bytes);
  const chain = new WebAssembly.Instance(module, {}).exports as unknown as ChainExports;

  const status = chain.tc_init(rate);
  if (status !== 0) throw new Error(`tc_init refused ${rate} Hz (status ${status})`);

  const heap = chain.memory.buffer;

  // The cabinet is not optional: a high-gain amp with no cab is a fault, not a
  // sound. Fail loudly rather than render something nobody would ship.
  const ir = readFileSync(join(ROOT, 'assets', 'cab.tcir'));
  new Uint8Array(heap, chain.tc_ir_ptr(), ir.length).set(ir);
  const irStatus = chain.tc_load_ir(ir.length);
  if (irStatus !== 0) throw new Error(`cabinet IR refused (IrStatus ${irStatus})`);

  const index = new Map(PARAMS.map((p, i) => [p.id, i] as const));
  for (const [id, value] of Object.entries(options.set ?? {})) {
    const at = index.get(id);
    if (at === undefined) throw new Error(`no such parameter: ${id}`);
    chain.tc_set_param(at, value);
  }

  const inBuffer = new Float32Array(heap, chain.tc_input_ptr(), BLOCK_FRAMES);
  const outBuffer = new Float32Array(heap, chain.tc_output_ptr(), BLOCK_FRAMES);
  const meterCount = chain.tc_meter_count();
  const meterBuffer = new Float32Array(heap, chain.tc_meter_ptr(), meterCount);
  const meters = new Array<number>(meterCount).fill(0);

  const tail = Math.round((options.tailSeconds ?? 1) * rate);
  const total = input.length + tail;
  const out = new Float32Array(total);

  for (let at = 0; at < total; at += BLOCK_FRAMES) {
    const n = Math.min(BLOCK_FRAMES, total - at);
    inBuffer.fill(0);
    for (let i = 0; i < n; i += 1) inBuffer[i] = at + i < input.length ? input[at + i]! : 0;

    chain.tc_process(BLOCK_FRAMES);

    for (let i = 0; i < n; i += 1) out[at + i] = outBuffer[i]!;
    for (let s = 0; s < meterCount; s += 1) {
      if (meterBuffer[s]! > meters[s]!) meters[s] = meterBuffer[s]!;
    }
  }

  return { out, rate, meters };
}

/** Picks the channel that feeds the chain, or sums when none is named. */
function pick(wav: Wav, channel: number | undefined): Float32Array {
  if (channel === undefined) return toMono(wav);
  const picked = wav.channels[channel];
  if (!picked) throw new Error(`channel ${channel} not in a ${wav.channels.length}-channel file`);
  return picked;
}

function main(argv: readonly string[]): void {
  const files: string[] = [];
  const set: Record<string, number> = {};
  let channel: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--set') {
      const [id, value] = (argv[++i] ?? '').split('=');
      if (!id || value === undefined) throw new Error('--set wants id=value');
      set[id] = Number(value);
    } else if (arg === '--channel') {
      channel = Number(argv[++i]);
    } else {
      files.push(arg);
    }
  }

  const [inPath, outPath] = files;
  if (!inPath || !outPath) {
    throw new Error('usage: tsx render/offline.ts in.wav out.wav [--set id=value]... [--channel n]');
  }

  const wav = readWav(inPath);
  if (wav.rate !== INTERNAL_SAMPLE_RATE) {
    // Not refused: the boundary resampler exists precisely for this (AD-18).
    // Said out loud because it puts a filter in the path that a 48 kHz file
    // does not have, and a measurement should know that.
    process.stdout.write(`  note: ${wav.rate} Hz input, converted at the chain boundary\n`);
  }

  const result = render(pick(wav, channel), wav.rate, { set, channel });
  writeWav(outPath, result.rate, [result.out]);

  const dB = (x: number): string => (20 * Math.log10(Math.max(x, 1e-12))).toFixed(1).padStart(7);
  process.stdout.write(
    `  ${inPath} -> ${outPath}\n` +
    `  ${(result.out.length / result.rate).toFixed(2)} s at ${result.rate} Hz\n` +
    `  peak stage RMS, dBFS:  ` +
    result.meters.map((m, i) => `${['in', 'gate', 'drive', 'amp', 'cab', 'rev', 'out'][i]}${dB(m)}`).join('  ') +
    '\n',
  );
}

if (import.meta.filename === process.argv[1]) main(process.argv.slice(2));
