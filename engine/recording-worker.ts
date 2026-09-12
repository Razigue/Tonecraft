import { encodeWav, type Recording, type RecordingTone } from './recording.ts';
import { renderRecording } from './render-recording.ts';

self.onmessage = async (event: MessageEvent<{ take: Recording; tone: RecordingTone | null; base: string }>) => {
  try {
    const { take, tone, base } = event.data;
    let output = take;
    if (tone) {
      if (!tone.capture) throw new Error('Choose an amplifier before exporting the processed take.');
      const [wasm, model] = await Promise.all([
        fetch(`${base}dsp/chain.wasm`), fetch(`${base}models/${encodeURIComponent(tone.capture.file)}`),
      ]);
      if (!wasm.ok || !model.ok) throw new Error('The audio engine or amplifier could not be loaded for export.');
      output = await renderRecording(take, tone, await wasm.arrayBuffer(), new Uint8Array(await model.arrayBuffer()),
        progress => self.postMessage({ progress }));
    }
    const wav = encodeWav(output);
    self.postMessage({ wav }, { transfer: [wav] });
  } catch (e) { self.postMessage({ error: e instanceof Error ? e.message : 'Audio export failed.' }); }
};
