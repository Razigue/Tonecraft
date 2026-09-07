/**
 * Minimal WAV reader, for the tools that have to run on a real DI rather than a
 * test tone. `render/wav.ts` writes; this reads.
 *
 * PCM 16, PCM 24, PCM 32 and float 32 are what a DI arrives as. Anything else
 * is refused rather than guessed at.
 */

import fs from 'node:fs';

export interface Wave {
  readonly sampleRate: number;
  readonly channels: number;
  /** Channel 0 only: the chain is mono end to end. */
  readonly data: Float32Array;
}

export function readWav(file: string): Wave {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} is not a RIFF/WAVE file`);
  }

  let format = 0, channels = 0, sampleRate = 0, bits = 0;
  let dataAt = -1, dataLength = 0;
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      format = b.readUInt16LE(at + 8);
      channels = b.readUInt16LE(at + 10);
      sampleRate = b.readUInt32LE(at + 12);
      bits = b.readUInt16LE(at + 22);
    } else if (id === 'data') {
      dataAt = at + 8;
      dataLength = size;
    }
    at += 8 + size + (size & 1);          // chunks are word aligned
  }
  if (dataAt < 0) throw new Error(`${file} has no data chunk`);

  const bytes = bits >> 3;
  const frames = Math.floor(dataLength / bytes / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const o = dataAt + i * channels * bytes;
    if (format === 3 && bits === 32) out[i] = b.readFloatLE(o);
    else if (format === 1 && bits === 16) out[i] = b.readInt16LE(o) / 32768;
    else if (format === 1 && bits === 24) out[i] = ((b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 24 >> 8))) / 8388608;
    else if (format === 1 && bits === 32) out[i] = b.readInt32LE(o) / 2147483648;
    else throw new Error(`${file}: unsupported WAV format ${format} at ${bits} bits`);
  }
  return { sampleRate, channels, data: out };
}
