<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Engine } from '../engine/engine.ts';
  import { encodeWav, decodeRecording, exportRecording, type Recording, type RecordingTone } from '../engine/recording.ts';
  import { loadMedia, saveMedia } from '../store/media.ts';

  let { engine, powered, tone, sinkId = '' }: { engine: Engine | null; powered: boolean; tone: RecordingTone; sinkId?: string } = $props();
  let take = $state.raw<Recording | null>(null);
  let recording = $state(false);
  let busy = $state(false);
  let working = $state<'listen' | 'export' | null>(null);
  let progress = $state(0);
  let seconds = $state(0);
  let error = $state('');
  let note = $state('');
  let listening = $state(false);
  let playhead = $state(0);
  let recordingEngine: Engine | null = null;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | null = null;
  let disposed = false;
  let changed = false;
  const timestamp = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const waveform = $derived.by(() => {
    if (!take) return '';
    const points: string[] = [];
    for (let x = 0; x < 240; x++) {
      let peak = 0;
      const start = Math.floor(x * take.samples.length / 240);
      const end = Math.floor((x + 1) * take.samples.length / 240);
      for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(take.samples[i]!));
      const height = Math.max(1, Math.min(22, peak * 80));
      points.push(`${x},${24 - height} ${x},${24 + height}`);
    }
    return points.join(' ');
  });

  /**
   * What the take sounds like is what the export will write: the DI with the
   * chain off, the offline render through the current tone with it on. Rendered
   * once per take and tone, so listening then exporting renders only once.
   */
  let takeId = 0;
  let rendered: { key: string; blob: Blob; url: string } | null = null;
  let audio: HTMLAudioElement | null = null;
  let frame = 0;

  function setTake(next: Recording | null) {
    stopListening();
    if (rendered) URL.revokeObjectURL(rendered.url);
    rendered = null;
    takeId++;
    take = next;
  }
  async function render(): Promise<{ blob: Blob; url: string; dry: boolean } | null> {
    if (!take) return null;
    const dry = !powered;
    const key = `${takeId}|${dry ? 'dry' : JSON.stringify(tone)}`;
    if (rendered?.key === key) return { ...rendered, dry };
    progress = 0;
    abort = new AbortController();
    try {
      // Snapshot at the click: edits made while rendering belong to the next render.
      const snapshot = dry ? null : { values: { ...tone.values }, capture: tone.capture ? { ...tone.capture } : null, cab: tone.cab };
      const wav = await exportRecording(take, snapshot, value => { progress = value; }, abort.signal);
      if (disposed) return null;
      if (rendered) URL.revokeObjectURL(rendered.url);
      const blob = new Blob([wav], { type: 'audio/wav' });
      rendered = { key, blob, url: URL.createObjectURL(blob) };
      return { ...rendered, dry };
    } finally { abort = null; }
  }

  function follow() {
    if (!audio) return;
    playhead = audio.duration > 0 ? audio.currentTime / audio.duration : 0;
    if (listening) frame = requestAnimationFrame(follow);
  }
  function stopListening() {
    cancelAnimationFrame(frame);
    audio?.pause();
    listening = false;
    playhead = 0;
  }
  async function listen() {
    if (listening) { audio?.pause(); return; }
    if (!take || working) return;
    working = 'listen'; error = '';
    try {
      const result = await render();
      if (!result || disposed) return;
      audio ??= new Audio();
      if (audio.src !== result.url) {
        audio.src = result.url;
        // The same output as the amp: headphones sit on the interface, not the laptop.
        const withSink = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
        if (sinkId && withSink.setSinkId) await withSink.setSinkId(sinkId).catch(() => {});
        audio.onplay = () => { listening = true; frame = requestAnimationFrame(follow); };
        audio.onpause = () => { listening = false; cancelAnimationFrame(frame); follow(); };
        audio.onended = () => { listening = false; cancelAnimationFrame(frame); playhead = 0; };
      }
      await audio.play();
    } catch (e) { if (!disposed && !(e instanceof DOMException && e.name === 'AbortError')) error = e instanceof Error ? e.message : 'Playback failed.'; }
    finally { working = null; }
  }
  function seekTake(e: MouseEvent) {
    if (!audio || !(audio.duration > 0) || !rendered || audio.src !== rendered.url) return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * audio.duration;
    follow();
  }

  async function pollRecording() {
    if (!recording || !recordingEngine || disposed) return;
    try {
      seconds = await recordingEngine.recordingSeconds();
      if (seconds >= 300 || !recordingEngine.running) { await stop(); return; }
      poll = setTimeout(() => void pollRecording(), 250);
    } catch (e) {
      recording = false; error = e instanceof Error ? e.message : 'The recording engine stopped.';
    }
  }
  async function start() {
    if (!engine || busy || recording) return;
    busy = true; error = ''; note = ''; changed = true;
    stopListening();
    try {
      recordingEngine = engine;
      await recordingEngine.startRecording();
      recording = true; seconds = 0;
      void pollRecording();
    } catch (e) { error = e instanceof Error ? e.message : 'Could not start recording.'; }
    finally { busy = false; }
  }
  async function stop() {
    if (!recordingEngine || busy) return;
    busy = true; clearTimeout(poll);
    try {
      const captured = await recordingEngine.stopRecording();
      if (disposed) return;
      setTake(captured); seconds = captured.samples.length / captured.sampleRate;
      const file = new File([encodeWav(captured)], 'last-recording.wav', { type: 'audio/wav' });
      const saved = await saveMedia(file, 'take', 'last-recording');
      note = saved ? 'Take saved on this device.' : 'Take kept for this session. Export it before closing the page.';
    } catch (e) { error = e instanceof Error ? e.message : 'Could not save the recording.'; }
    finally { recording = false; busy = false; }
  }
  async function download() {
    if (!take || working) return;
    working = 'export'; error = '';
    try {
      const result = await render();
      if (!result || disposed) return;
      const link = document.createElement('a');
      link.href = result.url; link.download = `tonecraft-${result.dry ? 'DI' : 'amp'}-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
      document.body.appendChild(link); link.click(); link.remove();
    } catch (e) { if (!disposed) error = e instanceof Error ? e.message : 'Export failed.'; }
    finally { working = null; }
  }
  onMount(() => {
    void loadMedia('last-recording').then(async file => {
      if (!file) return;
      const restored = await decodeRecording(file);
      if (!disposed && !changed) { setTake(restored); seconds = restored.samples.length / restored.sampleRate; }
    }).catch(() => {});
  });
  onDestroy(() => {
    disposed = true; clearTimeout(poll); abort?.abort();
    stopListening();
    if (rendered) URL.revokeObjectURL(rendered.url);
    if (recording) void recordingEngine?.stopRecording().catch(() => {});
  });
</script>

<section class="recorder" aria-label="Recording and WAV export">
  <div class="record-main">
    <div class="record-title"><span class="eyebrow">RECORDER</span><span class="duration" class:live={recording}>{#if recording}<i></i>{/if}{timestamp(seconds)}</span></div>
    <button class="listen" aria-label={listening ? 'Pause take' : 'Listen to take'} disabled={!take || recording || busy || working !== null} onclick={() => void listen()}>{working === 'listen' ? `${Math.round(progress * 100)}%` : listening ? '❚❚' : '▶'}</button>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="wave" class:seekable={listening || playhead > 0} onclick={seekTake}>
      <svg viewBox="0 0 240 48" preserveAspectRatio="none" aria-label="Recorded DI waveform"><line x1="0" y1="24" x2="240" y2="24" stroke="#4e4e4e"/>{#if take}<polyline points={waveform} fill="none" stroke="#c7c0b5" stroke-width=".8" />{/if}</svg>
      {#if listening || playhead > 0}<span class="playhead-track" aria-hidden="true"><span class="playhead" style:transform={`translateX(${playhead * 100}%)`}></span></span>{/if}
    </div>
    <button class:recording disabled={busy || working !== null || (!engine && !recording)} onclick={() => recording ? void stop() : void start()}>{busy ? 'Saving…' : recording ? '■ Stop recording' : take ? '● New take' : '● Record'}</button>
    <button class="export" disabled={!take || recording || busy || working !== null} onclick={() => void download()}>{working === 'export' ? `Exporting ${Math.round(progress * 100)}%` : powered ? 'Export amp · WAV' : 'Export DI · WAV'}</button>
    {#if working}<button onclick={() => abort?.abort()}>Cancel</button>{/if}
  </div>
  <div class="record-info"><span>{recording ? 'Recording clean input · 5 min maximum' : !engine && !take ? 'Power on the amplifier to record your input.' : note || 'The clean input is kept so you can change your tone after recording.'}</span><span>{powered ? 'Chain on → processed export' : 'Chain off → original DI'} · 32-bit float WAV</span></div>
  {#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
  .recorder{margin-top:24px;padding:20px 24px;border:1px solid #3c3c3c;border-radius:8px;background:#202020}.record-main{display:flex;align-items:center;gap:18px}.record-title{display:flex;flex-direction:column;gap:8px;min-width:88px}.eyebrow{font:9px var(--mono);letter-spacing:1.6px;color:#aaa}.duration{display:flex;align-items:center;gap:7px;font:18px var(--mono);font-variant-numeric:tabular-nums}.live{color:#ec987f}i{width:7px;height:7px;background:#ec987f;border-radius:50%}.wave{position:relative;flex:1;min-width:80px;height:48px;background:#181818;border:1px solid #373737;border-radius:3px;padding:0 8px}.wave.seekable{cursor:pointer}.wave svg{width:100%;height:100%}.playhead-track{position:absolute;inset:0 8px;pointer-events:none}.playhead{position:absolute;inset:0;will-change:transform}.playhead::before{content:'';position:absolute;left:0;top:4px;bottom:4px;width:1px;background:#e8dfd0}button{font:12px var(--body);color:#ddd;background:#303030;border:1px solid #505050;border-radius:4px;min-height:38px;padding:8px 14px;cursor:pointer;white-space:nowrap}button:hover{background:#414141}button:disabled{opacity:.45;cursor:default}.listen{min-width:46px;font-variant-numeric:tabular-nums}.recording{color:#ffc6b7;border-color:#ae7666}.export{background:#dedbd5;color:#222;border-color:#dedbd5}.export:hover{background:#f3f0ea}.record-info{display:flex;justify-content:space-between;gap:16px;margin-top:12px;color:#a3a3a3;font:10px/1.6 var(--body)}p{font-size:12px;color:var(--ember);margin:12px 0 0}@media(max-width:760px){.recorder{padding:18px 14px}.record-main{flex-wrap:wrap;gap:12px}.wave{flex-basis:calc(100% - 190px)}button{flex:1}.record-info{flex-direction:column;gap:4px}}
</style>
