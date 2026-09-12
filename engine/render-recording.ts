import { instantiateChain } from '../public/dsp/chain-core.js';
import { PARAMS } from '../schema/params.ts';
import { IR_SLOTS } from '../schema/chain.ts';
import { cabIR, reverbIR } from './ir.ts';
import type { Recording, RecordingTone } from './recording.ts';

/** Same compiled DSP and IRs as live playback. Input is already channel-selected. */
export async function renderRecording(take: Recording, tone: RecordingTone, wasm: ArrayBuffer | Uint8Array<ArrayBuffer>, model: Uint8Array<ArrayBuffer>, progress = (_: number) => {}): Promise<Recording> {
  if (!tone.capture) throw new Error('Choose an amplifier before exporting the processed take.');
  const core = await instantiateChain(wasm);
  const rate = take.sampleRate;
  core.init(rate, 1024);
  core.call('tc_set_input_channel', [0]);
  PARAMS.forEach((p, index) => core.call('tc_set_param', [index, tone.values[p.id] ?? p.default]));
  core.call('tc_set_capture_trim', [tone.capture.trimDb]);
  if (core.call('tc_load_model', [], model) !== 1) throw new Error(core.lastError() || 'The amplifier could not be loaded.');
  core.call('tc_set_ir', [IR_SLOTS.cab], cabIR(rate, tone.cab));
  core.call('tc_set_ir', [IR_SLOTS.reverb], reverbIR(rate, 1.3));
  core.inputs[0]!.fill(0);
  for (let i = 0; i < rate / 2; i += 128) core.process(128, 1);
  // Preserve reverb/pitch decay after the last recorded sample.
  const tail = tone.values.reverb_bypass !== 1 && (tone.values.reverb_mix ?? 0) > 0 ? rate * 2
    : tone.values.pitch_bypass !== 1 && (tone.values.pitch_shift ?? 0) !== 0 ? Math.ceil(rate * 0.1) : 0;
  const samples = new Float32Array(take.samples.length + tail);
  for (let offset = 0; offset < samples.length; offset += 1024) {
    const n = Math.min(1024, samples.length - offset);
    core.inputs[0]!.fill(0);
    if (offset < take.samples.length) core.inputs[0]!.set(take.samples.subarray(offset, offset + n));
    core.process(n, 1);
    samples.set(core.output!.subarray(0, n), offset);
    if (offset % (1024 * 32) === 0) progress(offset / samples.length);
  }
  progress(1);
  return { samples, sampleRate: rate };
}
