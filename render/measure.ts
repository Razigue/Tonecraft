/**
 * The measurement side of the offline loop.
 *
 * Everything here answers "how do these two renders differ, in numbers".
 * Deliberately small and dependency-free: an FFT, fractional-octave band
 * energy, and the two time-domain measures that decide whether an amplifier
 * feels alive — how far a note's level tracks how hard it was struck, and how
 * a sustained note decays.
 *
 * Bands rather than raw bins because that is the resolution the ear works at
 * and the resolution a filter is designed at. A 4 dB error in a third of an
 * octave is audible; a 4 dB error in one bin is nothing.
 */

/** In-place iterative radix-2 FFT. Length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const vi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export const FFT_SIZE = 8192;

/** Welch-averaged power spectrum. Hann window, 50% overlap. */
export function spectrum(x: Float32Array, from = 0, to = x.length, size = FFT_SIZE): Float64Array {
  const power = new Float64Array(size / 2);
  const window = new Float64Array(size);
  for (let i = 0; i < size; i += 1) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));

  let blocks = 0;
  for (let start = from; start + size <= to; start += size / 2) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i += 1) re[i] = x[start + i]! * window[i]!;
    fft(re, im);
    for (let k = 0; k < size / 2; k += 1) power[k]! += re[k]! ** 2 + im[k]! ** 2;
    blocks += 1;
  }
  if (blocks > 0) for (let k = 0; k < size / 2; k += 1) power[k]! /= blocks;
  return power;
}

/** Fractional-octave centres spanning what a guitar cabinet has to say. */
export function bandCentres(perOctave = 3): number[] {
  const out: number[] = [];
  for (let f = 50; f <= 14000; f *= 2 ** (1 / perOctave)) out.push(f);
  return out;
}

/** Mean power in each band, in dB. */
export function bandLevels(
  power: Float64Array,
  rate: number,
  centres: readonly number[],
  perOctave = 3,
  size = FFT_SIZE,
): number[] {
  const edge = 2 ** (1 / (2 * perOctave));
  return centres.map((f) => {
    const lo = Math.max(1, Math.floor(((f / edge) * size) / rate));
    const hi = Math.min(power.length - 1, Math.ceil(((f * edge) * size) / rate));
    let sum = 0;
    let count = 0;
    for (let k = lo; k <= hi; k += 1) {
      sum += power[k]!;
      count += 1;
    }
    return 10 * Math.log10(sum / Math.max(1, count) + 1e-30);
  });
}

export function rms(x: Float32Array, from = 0, to = x.length): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += x[i]! * x[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
}

export const dB = (x: number): number => 20 * Math.log10(Math.max(x, 1e-12));

/**
 * The frames that are actually playing. Silence at either end would otherwise
 * pull a long-term average down by an amount that depends only on how long the
 * player waited before starting, which is not a property of the amplifier.
 */
export function activeRange(x: Float32Array, floorDb = -40): [number, number] {
  const hop = 2400; // 50 ms
  const levels: number[] = [];
  let peak = 0;
  for (let i = 0; i + hop < x.length; i += hop) {
    const level = rms(x, i, i + hop);
    levels.push(level);
    if (level > peak) peak = level;
  }
  const gate = peak * 10 ** (floorDb / 20);
  let first = -1;
  let last = 0;
  levels.forEach((level, i) => {
    if (level > gate) {
      if (first < 0) first = i;
      last = i;
    }
  });
  return [Math.max(0, first) * hop, Math.min(x.length, (last + 1) * hop)];
}

/**
 * Long-term average spectrum over the playing part, normalised so that every
 * curve reads 0 dB at 1 kHz. Level is not the subject: two renders at
 * different volumes have the same tone, and comparing their shapes is the
 * whole point.
 */
export function toneCurve(x: Float32Array, rate: number, perOctave = 3): { centres: number[]; levels: number[] } {
  const centres = bandCentres(perOctave);
  const [from, to] = activeRange(x);
  const levels = bandLevels(spectrum(x, from, to), rate, centres, perOctave);
  const at1k = centres.reduce((best, f, i) => (Math.abs(f - 1000) < Math.abs(centres[best]! - 1000) ? i : best), 0);
  const reference = levels[at1k]!;
  return { centres, levels: levels.map((level) => level - reference) };
}

/**
 * Peak level of each attack, in dB, strongest first. The spread across these
 * is how much dynamic range survived the amplifier: a chain that squashes
 * everything to the same level reports a narrow spread, and that measures as
 * heavy saturation while being heard as a compressor.
 */
export function attacks(x: Float32Array, rate: number): number[] {
  const hop = Math.round(0.005 * rate);
  const window = Math.round(0.03 * rate);
  const envelope: number[] = [];
  for (let i = 0; i + window < x.length; i += hop) envelope.push(rms(x, i, i + window));

  const peak = Math.max(...envelope, 1e-12);
  const gate = peak * 10 ** (-30 / 20);
  const minimumGap = Math.round(0.12 / 0.005); // no two attacks closer than 120 ms

  const found: number[] = [];
  let last = -minimumGap;
  for (let i = 1; i < envelope.length - 1; i += 1) {
    const level = envelope[i]!;
    if (level > gate && level >= envelope[i - 1]! && level > envelope[i + 1]! && i - last >= minimumGap) {
      found.push(dB(level));
      last = i;
    }
  }
  return found.sort((a, b) => b - a);
}
