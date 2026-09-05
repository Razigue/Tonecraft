/**
 * WAV reading and writing for the offline harness.
 *
 * Hand-written rather than a dependency: the format needed here is a handful
 * of chunks, and `CLAUDE.md` §9 says not to add a package for something this
 * small. It reads what a DAW actually writes — 32-bit float and 16/24/32-bit
 * integer, with the JUNK, fact and bext chunks a broadcast-wave export puts in
 * front of the data — and writes 32-bit float only, because a render that has
 * left the limiter is compared, not shipped, and must not be quantised on the
 * way to the measurement.
 */

import { readFileSync, writeFileSync } from 'node:fs';

export interface Wav {
  readonly rate: number;
  readonly frames: number;
  /** De-interleaved. One entry per channel. */
  readonly channels: readonly Float32Array[];
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export function readWav(path: string): Wav {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }

  let format = 0;
  let channelCount = 0;
  let rate = 0;
  let bits = 0;
  let dataAt = -1;
  let dataLength = 0;

  // Walk the chunk list rather than assuming fmt and data sit at fixed offsets:
  // every file in sample_guitar/ carries JUNK, fact and bext before the audio.
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body);
      channelCount = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE names the real format in its GUID's first two
      // bytes. Without this, a 32-bit float file written by some hosts reads
      // as integer and every sample comes out as noise.
      if (format === FORMAT_EXTENSIBLE && size >= 40) format = buf.readUInt16LE(body + 24);
    } else if (id === 'data') {
      dataAt = body;
      // Some writers leave the size field at 0 or stale on a stream; trust the
      // file length instead of walking off the end.
      dataLength = Math.min(size, buf.length - body);
    }
    pos = body + size + (size & 1); // chunks are word-aligned
  }

  if (dataAt < 0) throw new Error(`${path}: no data chunk`);
  if (channelCount === 0 || rate === 0) throw new Error(`${path}: no fmt chunk`);

  const bytes = bits >> 3;
  const frames = Math.floor(dataLength / (bytes * channelCount));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));

  for (let n = 0; n < frames; n += 1) {
    for (let c = 0; c < channelCount; c += 1) {
      const at = dataAt + (n * channelCount + c) * bytes;
      channels[c]![n] = sampleAt(buf, at, format, bits, path);
    }
  }
  return { rate, frames, channels };
}

function sampleAt(buf: Buffer, at: number, format: number, bits: number, path: string): number {
  if (format === FORMAT_FLOAT && bits === 32) return buf.readFloatLE(at);
  if (format === FORMAT_FLOAT && bits === 64) return buf.readDoubleLE(at);
  if (format === FORMAT_PCM && bits === 16) return buf.readInt16LE(at) / 32768;
  if (format === FORMAT_PCM && bits === 24) {
    // Little-endian 24-bit: two unsigned bytes and a signed top byte, so the
    // sign extends without a mask.
    return (buf.readUInt8(at) | (buf.readUInt8(at + 1) << 8) | (buf.readInt8(at + 2) << 16)) / 8388608;
  }
  if (format === FORMAT_PCM && bits === 32) return buf.readInt32LE(at) / 2147483648;
  throw new Error(`${path}: unsupported format ${format} at ${bits} bits`);
}

/** 32-bit float, mono or multi-channel. Nothing here quantises. */
export function writeWav(path: string, rate: number, channels: readonly Float32Array[]): void {
  const count = channels.length;
  if (count === 0) throw new Error(`${path}: nothing to write`);
  const frames = channels[0]!.length;
  const dataBytes = frames * count * 4;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(FORMAT_FLOAT, 20);
  buf.writeUInt16LE(count, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * count * 4, 28);
  buf.writeUInt16LE(count * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  for (let n = 0; n < frames; n += 1) {
    for (let c = 0; c < count; c += 1) {
      buf.writeFloatLE(channels[c]![n]!, 44 + (n * count + c) * 4);
    }
  }
  writeFileSync(path, buf);
}

/** Mono sum. The chain is mono end to end, so every comparison starts here. */
export function toMono(wav: Wav): Float32Array {
  const [first] = wav.channels;
  if (!first) throw new Error('empty wav');
  if (wav.channels.length === 1) return first;
  const out = new Float32Array(wav.frames);
  for (let n = 0; n < wav.frames; n += 1) {
    let sum = 0;
    for (const channel of wav.channels) sum += channel[n]!;
    out[n] = sum / wav.channels.length;
  }
  return out;
}
