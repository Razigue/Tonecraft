export interface PitchReading {
  readonly frequency: number;
  readonly note: string;
  readonly octave: number;
  readonly cents: number;
  readonly confidence: number;
}

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const;

/** Converts a detected pitch to equal temperament with A4 at 440. */
export function noteFromFrequency(frequency: number, confidence = 1): PitchReading {
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  const exact = 440 * Math.pow(2, (midi - 69) / 12);
  return {
    frequency,
    note: NOTES[((midi % 12) + 12) % 12]!,
    octave: Math.floor(midi / 12) - 1,
    cents: 1200 * Math.log2(frequency / exact),
    confidence,
  };
}

/**
 * Finds the fundamental with the YIN difference function.
 *
 * The analysis is intentionally limited to the guitar register. The input is
 * reduced to a quarter of the device rate, which leaves ample bandwidth for a
 * guitar and keeps a 60-report-per-second display cheaper than the old 20 Hz
 * detector.
 */
export function detectPitch(
  input: Float32Array,
  sampleRate: number,
  minFrequency = 60,
  maxFrequency = 700,
): PitchReading | null {
  if (input.length < 1024 || sampleRate <= 0) return null;

  let mean = 0;
  for (let i = 0; i < input.length; i += 1) mean += input[i]!;
  mean /= input.length;

  let energy = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x = input[i]! - mean;
    energy += x * x;
  }
  // Well below a normal DI guitar, but above analyser noise and numerical dust.
  if (Math.sqrt(energy / input.length) < 0.0025) return null;

  const step = 4;
  const rate = sampleRate / step;
  const count = Math.floor(input.length / step);
  const minTau = Math.max(2, Math.floor(rate / maxFrequency));
  const maxTau = Math.min(Math.floor(rate / minFrequency), Math.floor(count / 2));
  const window = count - maxTau;
  const yin = new Float32Array(maxTau + 1);

  for (let tau = 1; tau <= maxTau; tau += 1) {
    let difference = 0;
    for (let i = 0; i < window; i += 1) {
      const delta = (input[i * step]! - mean) - (input[(i + tau) * step]! - mean);
      difference += delta * delta;
    }
    yin[tau] = difference;
  }

  let running = 0;
  yin[0] = 1;
  for (let tau = 1; tau <= maxTau; tau += 1) {
    running += yin[tau]!;
    yin[tau] = running === 0 ? 1 : (yin[tau]! * tau) / running;
  }

  let tau = -1;
  for (let candidate = minTau; candidate < maxTau; candidate += 1) {
    if (yin[candidate]! < 0.14) {
      while (candidate + 1 <= maxTau && yin[candidate + 1]! < yin[candidate]!) candidate += 1;
      tau = candidate;
      break;
    }
  }

  if (tau < 0) {
    let best = minTau;
    for (let candidate = minTau + 1; candidate <= maxTau; candidate += 1) {
      if (yin[candidate]! < yin[best]!) best = candidate;
    }
    if (yin[best]! > 0.28) return null;
    tau = best;
  }

  const left = yin[Math.max(1, tau - 1)]!;
  const middle = yin[tau]!;
  const right = yin[Math.min(maxTau, tau + 1)]!;
  const curve = left - 2 * middle + right;
  const refinedTau = curve === 0 ? tau : tau + 0.5 * (left - right) / curve;
  const frequency = rate / refinedTau;
  if (!Number.isFinite(frequency) || frequency < minFrequency || frequency > maxFrequency) return null;

  return noteFromFrequency(frequency, Math.max(0, Math.min(1, 1 - middle)));
}
