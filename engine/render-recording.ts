import { instantiateChain, type ChainCore } from '../public/dsp/chain-core.js';
import { PARAMS } from '../schema/params.ts';
import { IR_SLOTS } from '../schema/chain.ts';
import { cabIR, reverbIR } from './ir.ts';
import type { Recording, RecordingTone } from './recording.ts';

/**
 * A chain, set to a tone and warmed up: the same compiled DSP, capture and IRs
 * the studio plays live, so an exported take uses the same signal chain.
 */
async function openChain(tone: RecordingTone, wasm: ArrayBuffer | Uint8Array<ArrayBuffer>, model: Uint8Array<ArrayBuffer>, rate: number, maxFrames = 1024): Promise<ChainCore> {
  if (!tone.capture) throw new Error('Choose an amplifier before exporting the processed take.');
  const core = await instantiateChain(wasm);
  core.init(rate, maxFrames);
  core.call('tc_set_input_channel', [0]);
  PARAMS.forEach((p, index) => core.call('tc_set_param', [index, tone.values[p.id] ?? p.default]));
  core.call('tc_set_capture_trim', [tone.capture.trimDb]);
  if (core.call('tc_load_model', [], model) !== 1) throw new Error(core.lastError() || 'The amplifier could not be loaded.');
  core.call('tc_set_ir', [IR_SLOTS.cab], tone.cabIR ?? cabIR(rate, tone.cab));
  core.call('tc_set_ir', [IR_SLOTS.reverb], reverbIR(rate, 1.3));
  core.inputs[0]!.fill(0);
  // Half a second of silence: the smoothers settle where the faders are, so
  // the first note is not played through a chain still gliding into place.
  for (let i = 0; i < rate / 2; i += 128) core.process(128, 1);
  return core;
}

/**
 * How long the chain keeps sounding after its last input sample: reverb and
 * pitch decay, and the doubler's late ear.
 */
function chainTail(tone: RecordingTone, rate: number): number {
  const doubled = (tone.values.doubler_bypass ?? 1) !== 1;
  return tone.values.reverb_bypass !== 1 && (tone.values.reverb_mix ?? 0) > 0 ? rate * 2
    : tone.values.pitch_bypass !== 1 && (tone.values.pitch_shift ?? 0) !== 0 ? Math.ceil(rate * 0.1)
    : doubled ? Math.ceil(rate * 0.025) : 0;
}

/** Whether the tone makes two ears of one guitar. */
const isDoubled = (tone: RecordingTone): boolean => (tone.values.doubler_bypass ?? 1) !== 1;

/** Same compiled DSP and IRs as live playback. Input is already channel-selected. */
export async function renderRecording(take: Recording, tone: RecordingTone, wasm: ArrayBuffer | Uint8Array<ArrayBuffer>, model: Uint8Array<ArrayBuffer>, progress = (_: number) => {}): Promise<Recording> {
  const rate = take.sampleRate;
  const core = await openChain(tone, wasm, model, rate);
  const doubled = isDoubled(tone);
  const tail = chainTail(tone, rate);
  const samples = new Float32Array(take.samples.length + tail);
  // Off, the right ear is the left one to the bit: the file stays mono.
  const right = doubled ? new Float32Array(samples.length) : undefined;
  for (let offset = 0; offset < samples.length; offset += 1024) {
    const n = Math.min(1024, samples.length - offset);
    core.inputs[0]!.fill(0);
    if (offset < take.samples.length) core.inputs[0]!.set(take.samples.subarray(offset, offset + n));
    core.process(n, 1);
    samples.set(core.output!.subarray(0, n), offset);
    right?.set(core.outputRight!.subarray(0, n), offset);
    if (offset % (1024 * 32) === 0) progress(offset / samples.length);
  }
  progress(1);
  return right === undefined ? { samples, sampleRate: rate } : { samples, right, sampleRate: rate };
}
