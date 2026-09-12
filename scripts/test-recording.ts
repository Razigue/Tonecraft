import assert from 'node:assert/strict';
import fs from 'node:fs';
import { instantiateChain } from '../public/dsp/chain-core.js';
import { encodeWav, decodeRecording } from '../engine/recording.ts';
import { renderRecording } from '../engine/render-recording.ts';
import { PRESETS } from '../app/presets.ts';
import { PARAMS } from '../schema/params.ts';

const wasm = fs.readFileSync(new URL('../public/dsp/chain.wasm', import.meta.url));
await assert.rejects(decodeRecording(new Blob(['invalid audio'])), /Invalid saved take/);
const invalid = encodeWav({ samples: new Float32Array([0.25]), sampleRate: 48000 });
new DataView(invalid).setUint32(24, 0, true);
await assert.rejects(decodeRecording(new Blob([invalid])), /Invalid saved take/);
for (const rate of [44100, 48000, 96000]) {
  const core = await instantiateChain(wasm);
  core.init(rate, 1024);
  core.call('tc_set_input_channel', [1]); // right channel only
  core.call('tc_set_powered', [0]); // output power cannot change the stored DI
  assert.equal(core.call('tc_record_start', [1]), 1);
  const right = Float32Array.from({ length: rate }, (_, i) => 0.15 * Math.sin(2 * Math.PI * 220 * i / rate));
  for (let at = 0; at < rate; at += 128) {
    const n = Math.min(128, rate - at);
    core.inputs[0]!.fill(0.4);
    core.inputs[1]!.set(right.subarray(at, at + n));
    core.process(n, 2);
  }
  assert.equal(core.call('tc_record_frames'), rate);
  // At capacity the recorder stops automatically and never writes beyond it.
  core.process(128, 2);
  assert.equal(core.call('tc_record_stop'), rate);
  const copy = new Float32Array(rate);
  assert.equal(core.call('tc_read_recording', [0], copy), rate);
  assert.deepEqual(copy, right, 'DI must be exactly the selected input, even with power off');
  assert.equal(core.call('tc_read_recording', [-1], copy), 0);
  assert.equal(core.call('tc_read_recording', [rate], copy), 0);
  const wav = encodeWav({ samples: copy, sampleRate: rate });
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
  assert.equal(new DataView(wav).getUint32(4, true), wav.byteLength - 8);
  const restored = await decodeRecording(new Blob([wav]));
  assert.equal(restored.sampleRate, rate);
  assert.deepEqual(restored.samples, right, 'WAV reload preserves every DI sample');
  console.log(`ok recording, capacity limit, raw DI and WAV round trip at ${rate} Hz`);
}
const catalog = JSON.parse(fs.readFileSync(new URL('../public/models/index.json', import.meta.url), 'utf8'));
const preset = PRESETS[1]!;
const capture = catalog.models.find((c: { file: string }) => c.file === preset.capture);
const values = { ...Object.fromEntries(PARAMS.map(p => [p.id, p.default])), ...preset.values };
const samples = Float32Array.from({ length: 48000 }, (_, i) => 0.05 * Math.sin(2 * Math.PI * 110 * i / 48000));
const original = samples.slice();
const tone = { capture, values, cab: preset.cab };
const model = fs.readFileSync(new URL(`../public/models/${capture.file}`, import.meta.url));
const wet = await renderRecording({ samples, sampleRate: 48000 }, tone, wasm, model);
assert.deepEqual(samples, original, 'Rendering must never modify the saved DI');
assert.equal(wet.samples.length, samples.length, 'Bypassed reverb adds no tail');
assert(wet.samples.every(Number.isFinite));
assert(wet.samples.some((v, i) => Math.abs(v - samples[i]!) > 0.01), 'Processed export must contain the amplifier');
const quiet = await renderRecording({ samples, sampleRate: 48000 }, { ...tone, values: { ...values, out_master: -30 } }, wasm, model);
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
assert(rms(quiet.samples) < rms(wet.samples) * 0.3, 'Export must use the current output control');
const verb = await renderRecording({ samples, sampleRate: 48000 }, { ...tone, values: { ...values, reverb_bypass: 0 } }, wasm, model);
assert.equal(verb.samples.length, samples.length + 96000);
assert(rms(verb.samples.subarray(samples.length, samples.length + 12000)) > 1e-6, 'Reverb tail must be rendered');
console.log('ok processed WAV uses the amp and current controls, preserves DI and includes reverb decay');
