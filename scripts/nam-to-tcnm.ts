/**
 * Converts a NAM `.nam` model into the flat `.tcnm` blob the engine loads.
 *
 *     tsx scripts/nam-to-tcnm.ts model.nam public/models/lead.tcnm
 *
 * **This exists so that no JSON parser ever reaches the audio module.** A
 * `.nam` is a JSON document with the weights as a decimal array — 407 kB for a
 * Standard model, and reading it needs an allocator, a string parser and
 * exceptions. The module is built `-fno-exceptions -fno-rtti` with no malloc
 * and every buffer static, and relaxing any of that to read a file at startup
 * would be trading a permanent invariant for a one-off convenience. So the
 * parsing happens here, once, at build time, in the language that already has
 * a JSON parser, and the module receives numbers it can `memcpy`.
 *
 * The blob is also four times smaller than the JSON it came from and streams as
 * bytes, which is what `PRODUCT.md` §5's bundle budget assumes of a model.
 *
 * **Only NAM's Standard WaveNet is accepted**, which is the architecture of
 * every `.nam` written since format 0.5. Everything newer — the A2 features:
 * FiLM conditioning, gating, bottlenecks, grouped convolutions, a nested
 * condition DSP — is refused by name rather than ignored. A model whose shape
 * we silently mis-read does not fail, it plays, and it plays wrong.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  MODEL_BLOB_MAGIC,
  MODEL_BLOB_VERSION,
  MODEL_MAX_LAYER_ARRAYS,
  MODEL_MAX_LAYERS_PER_ARRAY,
  MODEL_MAX_CHANNELS,
  MODEL_MAX_KERNEL_SIZE,
  MODEL_MAX_DILATION,
  MODEL_MAX_WEIGHTS,
  INTERNAL_SAMPLE_RATE,
} from '../schema/params.ts';

/** One layer array, after validation: the shape the kernel is written against. */
export interface LayerArrayShape {
  readonly inputSize: number;
  readonly conditionSize: number;
  readonly channels: number;
  readonly headSize: number;
  readonly kernelSize: number;
  readonly headBias: boolean;
  readonly dilations: readonly number[];
}

export interface Model {
  readonly sampleRate: number;
  readonly headScale: number;
  /** Model loudness in dBFS as the trainer measured it, or null if absent. */
  readonly loudnessDb: number | null;
  readonly arrays: readonly LayerArrayShape[];
  readonly weights: Float32Array;
}

class Refused extends Error {}

const refuse = (why: string): never => {
  throw new Refused(why);
};

/**
 * Weights consumed by one layer array, in the order NAM's `set_weights_`
 * consumes them. Recomputing it here rather than trusting the file is what
 * catches a model whose shape we read differently than NAM does: the count is
 * a checksum over every dimension at once.
 */
export function weightCount(a: LayerArrayShape): number {
  const rechannel = a.channels * a.inputSize; // Conv1x1, no bias
  const perLayer =
    a.channels * a.channels * a.kernelSize + a.channels + // dilated Conv1D + bias
    a.channels * a.conditionSize +                        // input mixin Conv1x1, no bias
    a.channels * a.channels + a.channels;                 // layer 1x1 + bias
  const head = a.headSize * a.channels + (a.headBias ? a.headSize : 0); // Conv1D, kernel 1
  return rechannel + perLayer * a.dilations.length + head;
}

/** Keys that only exist on A2 models. Their presence means we are reading a shape we do not implement. */
const A2_KEYS = [
  'bottleneck', 'gating_mode', 'secondary_activation', 'head1x1',
  'conv_pre_film', 'conv_post_film', 'input_mixin_pre_film', 'input_mixin_post_film',
  'activation_pre_film', 'activation_post_film', 'layer1x1_post_film', 'head1x1_post_film',
  'kernel_sizes', 'head',
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a .nam is arbitrary JSON until validated; that is what this function is for.
type Json = any;

export function parseNam(text: string): Model {
  const doc: Json = JSON.parse(text);

  if (doc.architecture !== 'WaveNet') {
    refuse(`architecture is "${doc.architecture}", and only "WaveNet" is implemented. ` +
      'An LSTM or ConvNet model needs a different kernel, not a different config.');
  }

  const config: Json = doc.config;
  if (config == null) refuse('no "config" object');
  if (config.condition_dsp != null) {
    refuse('the model has a condition_dsp — an A2 feature: a second network generating the ' +
      'conditioning signal. Not implemented.');
  }
  if (config.head != null) refuse('the model has a post-stack head, which is not implemented.');
  if (config.in_channels != null && config.in_channels !== 1) {
    refuse(`in_channels is ${config.in_channels}; the chain is mono end to end.`);
  }

  const layers: Json[] = config.layers;
  if (!Array.isArray(layers) || layers.length === 0) refuse('no layer arrays');
  if (layers.length > MODEL_MAX_LAYER_ARRAYS) {
    refuse(`${layers.length} layer arrays, and the engine is sized for ${MODEL_MAX_LAYER_ARRAYS}.`);
  }

  const arrays: LayerArrayShape[] = layers.map((layer: Json, i: number): LayerArrayShape => {
    const where = `layer array ${i}`;

    for (const key of A2_KEYS) {
      // `bottleneck === channels` and `head1x1.active === false` are what a
      // Standard model means, so a file that states them explicitly is still
      // Standard. Anything else genuinely changes the computation.
      if (!(key in layer)) continue;
      if (key === 'bottleneck' && layer.bottleneck === layer.channels) continue;
      if (key === 'head1x1' && layer.head1x1?.active === false) continue;
      if (key === 'gating_mode' && layer.gating_mode === 'none') continue;
      if (key === 'secondary_activation' && layer.secondary_activation === '') continue;
      if (key.endsWith('film') && layer[key]?.active === false) continue;
      refuse(`${where} sets "${key}", which is an A2 feature the engine does not implement.`);
    }
    if (layer.gated === true) refuse(`${where} is gated, which is not implemented.`);
    if (layer.activation !== 'Tanh') {
      refuse(`${where} activation is ${JSON.stringify(layer.activation)}; only "Tanh" is implemented.`);
    }
    if ((layer.groups_input ?? 1) !== 1 || (layer.groups_input_mixin ?? 1) !== 1) {
      refuse(`${where} uses grouped convolutions, which are not implemented.`);
    }
    if (layer.layer1x1 != null && (layer.layer1x1.active !== true || layer.layer1x1.groups !== 1)) {
      refuse(`${where} has a non-standard layer1x1.`);
    }
    if (typeof layer.head_size !== 'number') refuse(`${where} has no head_size.`);

    const channels: number = layer.channels;
    const kernelSize: number = layer.kernel_size;
    const dilations: number[] = layer.dilations;

    if (channels > MODEL_MAX_CHANNELS) {
      refuse(`${where} has ${channels} channels, and the engine is sized for ${MODEL_MAX_CHANNELS}.`);
    }
    if (kernelSize > MODEL_MAX_KERNEL_SIZE) {
      refuse(`${where} has kernel size ${kernelSize}, and the engine is sized for ${MODEL_MAX_KERNEL_SIZE}.`);
    }
    if (!Array.isArray(dilations) || dilations.length === 0) refuse(`${where} has no dilations.`);
    if (dilations.length > MODEL_MAX_LAYERS_PER_ARRAY) {
      refuse(`${where} has ${dilations.length} layers, and the engine is sized for ${MODEL_MAX_LAYERS_PER_ARRAY}.`);
    }
    for (const d of dilations) {
      if (d > MODEL_MAX_DILATION) {
        refuse(`${where} dilates to ${d}, and the engine is sized for ${MODEL_MAX_DILATION}.`);
      }
    }

    return {
      inputSize: layer.input_size,
      conditionSize: layer.condition_size,
      channels,
      headSize: layer.head_size,
      kernelSize,
      headBias: layer.head_bias === true,
      dilations,
    };
  });

  // The arrays have to fit together, and NAM never states these: they are
  // implied by how one array's head output becomes the next one's head
  // accumulator, and by the rechannel that feeds it. A model that violates one
  // reads without error and produces noise.
  arrays.forEach((a, i) => {
    if (i === 0) {
      if (a.inputSize !== 1) refuse(`layer array 0 takes ${a.inputSize} inputs; the chain is mono.`);
    } else {
      const previous = arrays[i - 1]!;
      if (a.inputSize !== previous.channels) {
        refuse(`layer array ${i} takes ${a.inputSize} inputs but array ${i - 1} produces ${previous.channels}.`);
      }
      if (a.channels !== previous.headSize) {
        refuse(`layer array ${i} has ${a.channels} channels but array ${i - 1} heads into ` +
          `${previous.headSize}; the head accumulator would not line up.`);
      }
    }
    if (a.conditionSize !== 1) {
      refuse(`layer array ${i} conditions on ${a.conditionSize} channels; ` +
        'without a condition DSP the conditioning signal is the mono input.');
    }
  });

  const last = arrays[arrays.length - 1]!;
  if (last.headSize !== 1) refuse(`the final layer array heads into ${last.headSize} channels, not 1.`);

  // The head scale is the last weight, not the config field — NAM's loader
  // overwrites `config.head_scale` with it, so reading the field instead would
  // be right for most models and quietly wrong for the ones that differ.
  const raw: number[] = doc.weights;
  if (!Array.isArray(raw)) refuse('no weights array');
  const expected = arrays.reduce((n, a) => n + weightCount(a), 0) + 1;
  if (raw.length !== expected) {
    refuse(`the file carries ${raw.length} weights and this shape needs ${expected}. ` +
      'The shape was read differently than the trainer wrote it.');
  }
  if (raw.length - 1 > MODEL_MAX_WEIGHTS) {
    refuse(`${raw.length - 1} weights, and the engine is sized for ${MODEL_MAX_WEIGHTS}.`);
  }

  const headScale = raw[raw.length - 1]!;
  const weights = Float32Array.from(raw.slice(0, raw.length - 1));

  // The rate the model was trained at. A network's weights encode it the way a
  // filter's coefficients encode a corner frequency, so a 44.1 kHz model played
  // at 48 is a different amplifier — and it would be one silently. The engine
  // refuses the mismatch too; refusing it here as well means the failure lands
  // in the tool that can say what to do about it.
  const sampleRate: number = doc.sample_rate ?? doc.samplerate ?? INTERNAL_SAMPLE_RATE;
  if (sampleRate !== INTERNAL_SAMPLE_RATE) {
    refuse(`the model was trained at ${sampleRate} Hz and the chain runs at ${INTERNAL_SAMPLE_RATE}. ` +
      'Retrain or resample the capture; the engine will not adapt to it.');
  }
  const loudness = doc.metadata?.loudness;

  return {
    sampleRate,
    headScale,
    loudnessDb: typeof loudness === 'number' ? loudness : null,
    arrays,
    weights,
  };
}

/**
 * The blob. Every field is 4 bytes and little-endian, so the module reads it
 * with `memcpy` and no alignment question, on the one endianness WebAssembly
 * has.
 */
export function encode(model: Model): Buffer {
  const headerWords =
    7 + // magic, version, sample rate, head scale, loudness, array count, weight count
    model.arrays.reduce((n, a) => n + 7 + a.dilations.length, 0);
  const buffer = Buffer.alloc(4 * headerWords + 4 * model.weights.length);

  let at = 0;
  const u32 = (v: number): void => { buffer.writeUInt32LE(v >>> 0, at); at += 4; };
  const f32 = (v: number): void => { buffer.writeFloatLE(v, at); at += 4; };

  u32(MODEL_BLOB_MAGIC);
  u32(MODEL_BLOB_VERSION);
  u32(model.sampleRate);
  f32(model.headScale);
  // NaN where the trainer measured no loudness. The engine tests for it rather
  // than for a sentinel value, because every real dBFS is a plausible sentinel.
  f32(model.loudnessDb ?? Number.NaN);
  u32(model.arrays.length);
  u32(model.weights.length);

  for (const a of model.arrays) {
    u32(a.inputSize);
    u32(a.conditionSize);
    u32(a.channels);
    u32(a.headSize);
    u32(a.kernelSize);
    u32(a.headBias ? 1 : 0);
    u32(a.dilations.length);
    for (const d of a.dilations) u32(d);
  }

  for (const w of model.weights) f32(w);
  return buffer;
}

function main(argv: readonly string[]): void {
  const [input, output] = argv;
  if (!input || !output) {
    throw new Error('usage: tsx scripts/nam-to-tcnm.ts model.nam out.tcnm');
  }

  let model: Model;
  try {
    model = parseNam(readFileSync(input, 'utf8'));
  } catch (error) {
    if (error instanceof Refused) {
      process.stderr.write(`\n  ${input} is not a model this engine can load.\n  ${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }

  const blob = encode(model);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, blob);

  const shape = model.arrays
    .map((a) => `${a.channels}ch x ${a.dilations.length} (head ${a.headSize})`)
    .join(' -> ');
  const receptive = model.arrays.reduce(
    (n, a) => n + a.dilations.reduce((m, d) => m + d * (a.kernelSize - 1), 0), 0);

  process.stdout.write(
    `model: wrote ${output}\n` +
    `       ${shape}, kernel ${model.arrays[0]!.kernelSize}\n` +
    `       ${model.weights.length} weights, ${blob.length} bytes ` +
    `(${(blob.length / readFileSync(input).length * 100).toFixed(0)}% of the .nam)\n` +
    `       trained at ${model.sampleRate} Hz, receptive field ${receptive} samples ` +
    `(${(receptive / model.sampleRate * 1000).toFixed(1)} ms)\n` +
    `       loudness ${model.loudnessDb === null ? 'not measured' : `${model.loudnessDb.toFixed(1)} dBFS`}\n`,
  );
}

// Importable for the tests without running the CLI.
if (process.argv[1]?.endsWith('nam-to-tcnm.ts')) main(process.argv.slice(2));
