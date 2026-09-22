/** The real chain, offline: the same chain.wasm, capture, cabinet and preset the studio plays. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instantiateChain } from '../public/dsp/chain-core.js';
import { PARAMS } from '../schema/params.ts';
import { IR_SLOTS } from '../schema/chain.ts';
import { cabIR, reverbIR, CABS, shapeCabIR } from '../engine/ir.ts';
import { readWav, toMono } from '../render/wav.ts';
import { PRESETS } from '../app/presets.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RATE = 48000;

function cabinet(id: string): Float32Array<ArrayBuffer> {
  const file = CABS.find((c) => c.id === id)?.file;
  if (!file) return cabIR(RATE, id);
  return shapeCabIR(toMono(readWav(path.join(ROOT, 'public', file))), RATE)!;
}

export async function throughChain(di: Float32Array, presetName = 'Lead', overrides: Record<string, number> = {}): Promise<Float32Array> {
  const preset = PRESETS.find((p) => p.name === presetName)!;
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/index.json'), 'utf8')) as { models: { file: string; trimDb: number }[] };
  const capture = index.models.find((m) => m.file === preset.capture)!;
  const core = await instantiateChain(fs.readFileSync(path.join(ROOT, 'public/dsp/chain.wasm')));
  core.init(RATE, 1024);
  core.call('tc_set_input_channel', [0]);
  // No reverb on any tone: asked for explicitly, whatever the preset says.
  const values: Record<string, number> = { ...preset.values, ...overrides, reverb_bypass: 1, reverb_mix: 0 };
  PARAMS.forEach((p, i) => core.call('tc_set_param', [i, values[p.id] ?? p.default]));
  core.call('tc_set_capture_trim', [capture.trimDb]);
  const model = new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/models', capture.file)));
  if (core.call('tc_load_model', [], model) !== 1) throw new Error(core.lastError());
  core.call('tc_set_ir', [IR_SLOTS.cab], cabinet(preset.cab));
  core.call('tc_set_ir', [IR_SLOTS.reverb], reverbIR(RATE, 1.3));
  core.inputs[0]!.fill(0);
  for (let i = 0; i < RATE; i += 128) core.process(128, 1);
  const tail = RATE * 2;
  const out = new Float32Array(di.length + tail);
  for (let o = 0; o < out.length; o += 1024) {
    const n = Math.min(1024, out.length - o);
    core.inputs[0]!.fill(0);
    if (o < di.length) core.inputs[0]!.set(di.subarray(o, Math.min(di.length, o + n)));
    core.process(n, 1);
    out.set(core.output!.subarray(0, n), o);
  }
  return out;
}

export const rms = (x: Float32Array, from = 0, to = x.length): number => {
  let s = 0, n = 0;
  for (let i = from; i < to; i++) { s += x[i]! * x[i]!; n++; }
  return Math.sqrt(s / Math.max(1, n));
};
export const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
export const db = (v: number): number => 20 * Math.log10(v + 1e-20);
