/**
 * Prints the difference between two renders, band by band.
 *
 *     tsx render/compare.ts ours.wav reference.wav
 *
 * Both curves are normalised at 1 kHz, so the table is about tone and not
 * about how loud either file happens to be. The right-hand column is the
 * correction to apply: positive means we have more energy there than the
 * reference does.
 */

import { readWav, toMono } from './wav.ts';
import { toneCurve, attacks, dB, rms, activeRange } from './measure.ts';

function main(argv: readonly string[]): void {
  const [oursPath, referencePath] = argv;
  if (!oursPath || !referencePath) {
    throw new Error('usage: tsx render/compare.ts ours.wav reference.wav');
  }

  const ours = readWav(oursPath);
  const reference = readWav(referencePath);
  const a = toMono(ours);
  const b = toMono(reference);

  const ca = toneCurve(a, ours.rate);
  const cb = toneCurve(b, reference.rate);

  process.stdout.write(`\n  ours      ${oursPath}\n  reference ${referencePath}\n\n`);
  process.stdout.write('      Hz      ours   reference    ours - reference\n');
  ca.centres.forEach((f, i) => {
    const delta = ca.levels[i]! - cb.levels[i]!;
    // A bar, because a column of numbers hides the shape of an error and the
    // shape is what names the filter that fixes it.
    const bar = delta >= 0 ? '+'.repeat(Math.min(20, Math.round(delta))) : '-'.repeat(Math.min(20, Math.round(-delta)));
    process.stdout.write(
      String(Math.round(f)).padStart(8) +
      ca.levels[i]!.toFixed(1).padStart(10) +
      cb.levels[i]!.toFixed(1).padStart(12) +
      delta.toFixed(1).padStart(12) + '  ' + bar + '\n',
    );
  });

  const spread = (x: Float32Array, rate: number): string => {
    const found = attacks(x, rate);
    if (found.length < 3) return `${found.length} attacks — too few to judge`;
    return `${found.length} attacks, loudest ${found[0]!.toFixed(1)} dB, ` +
      `quietest ${found[found.length - 1]!.toFixed(1)} dB, spread ${(found[0]! - found[found.length - 1]!).toFixed(1)} dB`;
  };
  process.stdout.write(`\n  dynamics\n    ours      ${spread(a, ours.rate)}\n    reference ${spread(b, reference.rate)}\n`);

  const crest = (x: Float32Array): string => {
    const [from, to] = activeRange(x);
    let peak = 0;
    for (let i = from; i < to; i += 1) peak = Math.max(peak, Math.abs(x[i]!));
    return `${(dB(peak) - dB(rms(x, from, to))).toFixed(1)} dB`;
  };
  process.stdout.write(`\n  crest factor\n    ours      ${crest(a)}\n    reference ${crest(b)}\n\n`);
}

main(process.argv.slice(2));
