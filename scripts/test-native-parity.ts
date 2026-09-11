/**
 * The browser and Tonecraft Engine play the same sound — to the bit.
 *
 * Both hosts run public/dsp/chain.wasm: V8 in the AudioWorklet, wasmtime in
 * the native engine. Same module, same calls, same input: the output must be
 * identical, not merely close, because the chain is compiled without
 * fast-math or relaxed SIMD precisely so that it is (AD-4). A difference here
 * means a host did something to the sound, which hosts are not allowed to do.
 *
 * The calls are the ones engine.ts sends when it starts — the default preset,
 * the shipped capture and cabinet, the reverb — run once through chain-core.js
 * and once through `tonecraft-engine render`.
 *
 * Needs the native engine built: `cargo build --release` in service/.
 *
 * Usage:  npm run test:parity
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { instantiateChain } from '../public/dsp/chain-core.js';
import { PARAMS } from '../schema/params.ts';
import { IR_SLOTS, CHANNEL_CODES } from '../schema/chain.ts';
import { cabIR, reverbIR, DEFAULT_CAB } from '../engine/ir.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48_000;
const BLOCK = 128;
const WASM = path.join(ROOT, 'public/dsp/chain.wasm');
const EXE = path.join(ROOT, 'service', 'target', 'release', process.platform === 'win32' ? 'tonecraft-engine.exe' : 'tonecraft-engine');

if (!fs.existsSync(EXE)) {
  console.error(`\n${path.relative(ROOT, EXE)} is not built. Run \`cargo build --release\` in service/.\n`);
  process.exit(1);
}

interface Call { fn: string; args: number[]; data: Uint8Array<ArrayBuffer> | null }

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/index.json'), 'utf8')) as {
  models: { file: string; trimDb: number }[];
};
const capture = catalog.models[0]!;
const bytes = (a: Float32Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/* What engine.ts sends on start, in its order. */
const calls: Call[] = [
  { fn: 'tc_set_input_channel', args: [CHANNEL_CODES.follow], data: null },
  ...PARAMS.flatMap((p, i) => (p.deprecated === true ? [] : [{ fn: 'tc_set_param', args: [i, p.default], data: null }])),
  { fn: 'tc_set_powered', args: [1], data: null },
  { fn: 'tc_set_live_input', args: [1], data: null },
  { fn: 'tc_set_ir', args: [IR_SLOTS.cab], data: bytes(cabIR(SR, DEFAULT_CAB)) },
  { fn: 'tc_set_ir', args: [IR_SLOTS.reverb], data: bytes(reverbIR(SR, 1.3)) },
  { fn: 'tc_set_capture_trim', args: [capture.trimDb], data: null },
  { fn: 'tc_load_model', args: [], data: new TextEncoder().encode(fs.readFileSync(path.join(ROOT, 'public/models', capture.file), 'utf8')) },
];

const input = new Float32Array(SR * 3);
for (let i = 0; i < input.length; i++) {
  const t = i / SR;
  input[i] = 0.1 * Math.exp(-(t % 1) * 3.5) *
    (Math.sin(2 * Math.PI * 82.4 * t) + 0.5 * Math.sin(2 * Math.PI * 164.8 * t));
}

// The browser's binding.
const core = await instantiateChain(fs.readFileSync(WASM));
core.init(SR, BLOCK);
for (const c of calls) core.call(c.fn, c.args, c.data);
const web = new Float32Array(input.length);
for (let at = 0; at < input.length; at += BLOCK) {
  core.inputs[0]!.set(input.subarray(at, at + BLOCK));
  core.process(BLOCK, 1);
  web.set(core.output!.subarray(0, BLOCK), at);
}

// The native engine's.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tonecraft-parity-'));
const files = { input: path.join(dir, 'in.f32'), calls: path.join(dir, 'calls.json'), output: path.join(dir, 'out.f32') };
fs.writeFileSync(files.input, bytes(input));
fs.writeFileSync(files.calls, JSON.stringify(calls.map((c) => ({
  fn: c.fn, args: c.args, data: c.data === null ? null : Buffer.from(c.data).toString('base64'),
}))));
execFileSync(EXE, ['render', '--wasm', WASM, '--rate', String(SR), '--block', String(BLOCK), '--channels', '1',
  '--input', files.input, '--calls', files.calls, '--output', files.output], { stdio: ['ignore', 'inherit', 'inherit'] });
const raw = fs.readFileSync(files.output);
const native = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
fs.rmSync(dir, { recursive: true, force: true });

let differing = 0, worst = 0, energy = 0;
for (let i = 0; i < web.length; i++) {
  if (web[i] !== native[i]) differing++;
  worst = Math.max(worst, Math.abs(web[i]! - (native[i] ?? 0)));
  energy += web[i]! * web[i]!;
}

console.log('\nThe same chain in two hosts: chain-core.js (V8) against tonecraft-engine (wasmtime)\n');
const ok = native.length === web.length && differing === 0 && energy > 0;
console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${web.length} samples, ${differing} differ, largest difference ${worst.toExponential(2)}`);
console.log(ok ? '\nBit-identical.\n' : '\nThe hosts disagree.\n');
process.exit(ok ? 0 : 1);
