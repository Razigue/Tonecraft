import { encodeWav, mixTimeline, type ExportOptions, type Recording, type RecordingTone } from './recording.ts';
import { renderRecording } from './render-recording.ts';

self.onmessage = async (event: MessageEvent<{ take: Recording; tone: RecordingTone | null; base: string; options?: ExportOptions }>) => {
  try {
    const { take, tone, base, options = {} } = event.data;
    const backing = options.backing ?? null;
    const content = options.content ?? (backing ? 'mix' : 'guitar');
    let guitar: Recording | null = content === 'backing' ? null : take;
    if (guitar && tone) {
      if (!tone.capture) throw new Error('Choose an amplifier before exporting the processed take.');
      const [wasm, model] = await Promise.all([
        fetch(`${base}dsp/chain.wasm`), fetch(`${base}models/${encodeURIComponent(tone.capture.file)}`),
      ]);
      if (!wasm.ok || !model.ok) throw new Error('The audio engine or amplifier could not be loaded for export.');
      guitar = await renderRecording(guitar, tone, await wasm.arrayBuffer(), new Uint8Array(await model.arrayBuffer()),
        progress => self.postMessage({ progress }));
    }
    const samples = backing || options.range
      ? mixTimeline({ guitar: guitar?.samples ?? null, backing, backingLevel: options.backingLevel ?? 1, latencyFrames: take.latencyFrames ?? 0 },
        content, options.range)
      : guitar!.samples;
    if (samples.length === 0) throw new Error('There is nothing to export in this selection.');
    const wav = encodeWav({ samples, sampleRate: take.sampleRate });
    self.postMessage({ wav }, { transfer: [wav] });
  } catch (e) { self.postMessage({ error: e instanceof Error ? e.message : 'Audio export failed.' }); }
};
