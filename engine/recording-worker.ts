import { encodeWav, mixTimeline, type ExportOptions, type Recording, type RecordingTone } from './recording.ts';
import { renderRecording } from './render-recording.ts';

self.onmessage = async (event: MessageEvent<{ takes: Recording[]; sampleRate: number; tone: RecordingTone | null; base: string; options?: ExportOptions }>) => {
  try {
    const { takes, sampleRate, tone, base, options = {} } = event.data;
    const backing = options.backing ?? null;
    const content = options.content ?? (backing ? 'mix' : 'guitar');
    const rendered = takes.map((t) => t.samples);
    const toRender = content === 'backing' ? [] : takes.map((_, i) => i)
      .filter((i) => (options.only === undefined || i === options.only) && takes[i]!.samples.length > 0);
    if (tone && toRender.length > 0) {
      if (!tone.capture) throw new Error('Choose an amplifier before exporting the processed take.');
      const [wasm, model] = await Promise.all([
        fetch(`${base}dsp/chain.wasm`), fetch(`${base}models/${encodeURIComponent(tone.capture.file)}`),
      ]);
      if (!wasm.ok || !model.ok) throw new Error('The audio engine or amplifier could not be loaded for export.');
      const wasmBytes = await wasm.arrayBuffer(), modelBytes = new Uint8Array(await model.arrayBuffer());
      for (const [k, i] of toRender.entries()) {
        rendered[i] = (await renderRecording(takes[i]!, tone, wasmBytes, modelBytes,
          progress => self.postMessage({ progress: (k + progress) / toRender.length }))).samples;
      }
    }
    const samples = mixTimeline({
      guitars: takes.map((t, i) => ({ samples: rendered[i]!, level: options.guitarLevels?.[i] ?? 1, latencyFrames: t.latencyFrames ?? 0,
        overdub: t.overdub, offsetFrames: options.guitarOffsets?.[i] ?? 0 })),
      backing, backingLevel: options.backingLevel ?? 1, backingOffset: options.backingOffset ?? 0,
    }, content, options.range, options.only);
    if (samples.length === 0) throw new Error('There is nothing to export in this selection.');
    const wav = encodeWav({ samples, sampleRate });
    self.postMessage({ wav }, { transfer: [wav] });
  } catch (e) { self.postMessage({ error: e instanceof Error ? e.message : 'Audio export failed.' }); }
};
