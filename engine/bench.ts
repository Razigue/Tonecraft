/**
 * Measures what the chain actually costs, against the budget that decides
 * whether the product works at all.
 *
 * NFR-1: under 25% of one core. In an AudioWorklet the quantum is fixed at 128
 * frames, so there is no buffer setting to trade latency against CPU —
 * exceeding the budget does not produce delay, it produces a glitch. The CPU
 * budget *is* the dropout budget, which is why this is measured rather than
 * estimated.
 *
 * Node is not a browser and this machine is not the floor machine, so treat
 * these as a ratio between stages rather than an absolute verdict.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCK_FRAMES, INTERNAL_SAMPLE_RATE, LSTM_HIDDEN_SIZE } from '../schema/params.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Chain {
  memory: WebAssembly.Memory;
  tc_init(rate: number): number;
  tc_process(frames: number): void;
  tc_input_ptr(): number;
  tc_weights_ptr(): number;
  tc_load_weights(bytes: number): number;
  tc_amp_loaded(): number;
}

const { instance } = await WebAssembly.instantiate(
  readFileSync(join(ROOT, 'public', 'tonecraft.wasm')), {},
);
const chain = instance.exports as unknown as Chain;
chain.tc_init(INTERNAL_SAMPLE_RATE);

const heap = chain.memory.buffer;
const input = new Float32Array(heap, chain.tc_input_ptr(), BLOCK_FRAMES);
for (let i = 0; i < BLOCK_FRAMES; i += 1) {
  input[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / INTERNAL_SAMPLE_RATE);
}

/** Wall-clock budget for one block: 128 frames at 48 kHz. */
const BLOCK_MS = (BLOCK_FRAMES / INTERNAL_SAMPLE_RATE) * 1000;

function measure(label: string): number {
  const blocks = 20_000;
  for (let i = 0; i < 2_000; i += 1) chain.tc_process(BLOCK_FRAMES); // warm up
  const start = process.hrtime.bigint();
  for (let i = 0; i < blocks; i += 1) chain.tc_process(BLOCK_FRAMES);
  const ms = Number(process.hrtime.bigint() - start) / 1e6 / blocks;
  const share = (ms / BLOCK_MS) * 100;
  console.log(
    `  ${label.padEnd(34)} ${ms.toFixed(4)} ms/block  ${share.toFixed(1)}% of one core`,
  );
  return share;
}

console.log(`\nBlock: ${BLOCK_FRAMES} frames at ${INTERNAL_SAMPLE_RATE} Hz = ${BLOCK_MS.toFixed(3)} ms of wall clock`);
console.log(`Budget: 25% of one core = ${(BLOCK_MS * 0.25).toFixed(4)} ms per block\n`);

const withoutAmp = measure('chain without the amp');

const weights = readFileSync(join(ROOT, 'assets', 'amp-placeholder.tcw'));
new Uint8Array(heap, chain.tc_weights_ptr(), weights.length).set(weights);
const status = chain.tc_load_weights(weights.length);
console.log(`\n  weights load status: ${status} (0 = ok), amp loaded: ${chain.tc_amp_loaded() === 1}\n`);

const withAmp = measure(`chain with LSTM-${LSTM_HIDDEN_SIZE}`);

console.log(`\n  the amp alone                      ${(withAmp - withoutAmp).toFixed(1)}% of one core`);
console.log(`  projected at 4x oversampling       ${((withAmp - withoutAmp) * 4).toFixed(1)}% of one core  (story 1.7)`);
console.log(`\n  This machine, in Node. The floor machine is a 2019-2020 mid-range`);
console.log(`  laptop and a browser, both of which will be slower.\n`);
