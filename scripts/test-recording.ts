import assert from 'node:assert/strict';
import fs from 'node:fs';
import { instantiateChain } from '../public/dsp/chain-core.js';
import { encodeWav, decodeRecording, defaultRange, laneFrames, mixTimeline } from '../engine/recording.ts';
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

{
  // The backing track, in the chain. No cabinet is loaded, so the rig itself is
  // silent at the output and what comes out is the backing track alone.
  const rate = 48000;
  const core = await instantiateChain(wasm);
  core.init(rate, 1024);
  core.call('tc_set_input_channel', [0]);
  const backing = Float32Array.from({ length: rate }, (_, i) => (i % 480 === 0 ? 0.2 : 0));
  assert.equal(core.call('tc_backing_load', [1], backing), 1);
  core.call('tc_backing_level', [1]);
  core.call('tc_backing_arm', [1]);
  const guitar = Float32Array.from({ length: rate / 2 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 330 * i / rate));
  const block = (input: Float32Array, at: number, n: number) => {
    core.inputs[0]!.fill(0);
    core.inputs[0]!.set(input.subarray(at, at + n));
    core.process(n, 1);
    return core.output!.slice(0, n);
  };
  let before = 0;
  for (let at = 0; at < rate / 4; at += 128) before = Math.max(before, ...block(new Float32Array(128), 0, 128).map(Math.abs));
  assert.equal(before, 0, 'an armed backing track waits for the recorder');

  assert.equal(core.call('tc_record_start', [1]), 1);
  const out = new Float32Array(guitar.length);
  for (let at = 0; at < guitar.length; at += 128) out.set(block(guitar, at, Math.min(128, guitar.length - at)), at);
  const hits = [...out.keys()].filter(i => Math.abs(out[i]!) > 1e-4);
  assert(hits.length > 0 && hits[0] === 0 && hits.every(i => i % 480 === 0), `the backing track starts with the recorder, on its first sample (${hits.slice(0, 4)})`);
  assert.equal(core.call('tc_record_stop'), guitar.length);
  const di = new Float32Array(guitar.length);
  assert.equal(core.call('tc_read_recording', [0], di), guitar.length);
  assert.deepEqual(di, guitar, 'the DI take never contains the backing track');
  let after = 0;
  for (let at = 0; at < rate / 4; at += 128) after = Math.max(after, ...block(new Float32Array(128), 0, 128).map(Math.abs));
  assert.equal(after, 0, 'and it stops with the recorder');

  core.call('tc_backing_level', [0]);
  core.call('tc_backing_play', [0]);
  for (let at = 0; at < rate / 4; at += 128) block(new Float32Array(128), 0, 128);
  let muted = 0;
  for (let at = 0; at < rate / 8; at += 128) muted = Math.max(muted, ...block(new Float32Array(128), 0, 128).map(Math.abs));
  assert(muted < 1e-5, `its level turns it down (${muted})`);
  console.log('ok the backing track starts with the recorder, is heard, is never in the DI, and stops with it');
}

{
  // The timeline an export is cut from: the guitar moved a round trip earlier
  // to line up with the backing track, the backing track from 0.
  const t = { guitar: Float32Array.from([1, 2, 3, 4, 5, 6]), backing: Float32Array.from([10, 20, 30]), guitarLevel: 1, backingLevel: 0.5, latencyFrames: 2 };
  assert.deepEqual(laneFrames(t), { guitar: 4, backing: 3 });
  assert.deepEqual(defaultRange(t, 'mix'), [0, 4], 'the longer lane sets the end');
  assert.deepEqual(defaultRange(t, 'backing'), [0, 3]);
  assert.deepEqual(defaultRange(t, 'guitar'), [0, 4]);
  assert.deepEqual([...mixTimeline(t, 'mix')], [3 + 5, 4 + 10, 5 + 15, 6], 'the guitar lines up with what it was played to');
  assert.deepEqual([...mixTimeline(t, 'guitar', [1, 3])], [4, 5], 'a selection exports exactly its frames');
  assert.deepEqual([...mixTimeline(t, 'backing')], [5, 10, 15], 'the backing track alone, at its level');
  const alone = { guitar: Float32Array.from([1, 2, 3]), backing: null, guitarLevel: 1, backingLevel: 1, latencyFrames: 2 };
  assert.deepEqual([...mixTimeline(alone, 'guitar')], [1, 2, 3], 'with no backing track the guitar is not moved');
  assert.deepEqual([...mixTimeline({ ...t, guitarLevel: 0.5 }, 'mix', [0, 2])], [1.5 + 5, 2 + 10], 'each lane at its own level');
  console.log('ok exports cut the timeline: a selection, or the longer lane, guitar lined up with the backing track');
}
