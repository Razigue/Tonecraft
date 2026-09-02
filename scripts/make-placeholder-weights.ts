/**
 * Writes a PLACEHOLDER weights blob so the amp stage can be exercised and
 * measured before a real capture exists.
 *
 * These are not an amplifier. They are small deterministic pseudo-random
 * values that give the LSTM something numerically well-behaved to chew on, so
 * that CPU cost can be measured honestly and the loader can be tested against a
 * real file. What comes out is not a guitar tone and is not meant to be.
 *
 * Training real weights needs an amplifier, a capture rig and paired
 * recordings. That work is not in the epics and is the project's critical path.
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LSTM_HIDDEN_SIZE } from '../schema/params.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAGIC = 0x31574354; // 'TCW1'
const VERSION = 1;

const gates = 4 * LSTM_HIDDEN_SIZE;
const counts = {
  w: 1 * gates,
  u: LSTM_HIDDEN_SIZE * gates,
  b: gates,
  denseW: LSTM_HIDDEN_SIZE,
  denseB: 1,
};
const total = Object.values(counts).reduce((a, b) => a + b, 0);

// A fixed-seed generator: the same file every time, on every machine. A
// placeholder that differed run to run would make every other test flaky.
let seed = 0x9e3779b9;
const next = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x1_0000_0000;
};

const buffer = Buffer.alloc(12 + total * 4);
buffer.writeUInt32LE(MAGIC, 0);
buffer.writeUInt32LE(VERSION, 4);
buffer.writeUInt32LE(total, 8);

let offset = 12;
const write = (n: number, scale: number, bias = 0): void => {
  for (let i = 0; i < n; i += 1) {
    buffer.writeFloatLE((next() * 2 - 1) * scale + bias, offset);
    offset += 4;
  }
};

// Scaled so the recurrent state stays bounded and the output sits at a sane
// level. Chosen for numerical behaviour, not for sound.
write(counts.w, 0.6);
write(counts.u, 0.25);
write(counts.b, 0.05);
write(counts.denseW, 0.4);
write(counts.denseB, 0.0);

const out = join(ROOT, 'assets', 'amp-placeholder.tcw');
writeFileSync(out, buffer);
process.stdout.write(
  `weights: wrote assets/amp-placeholder.tcw (${buffer.length} bytes, ${total} floats)\n` +
  `         PLACEHOLDER — deterministic noise, not an amplifier.\n`,
);
