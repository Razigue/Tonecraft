<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Engine } from '../engine/engine.ts';
  import { encodeWav, decodeRecording, exportRecording, type Recording, type RecordingTone } from '../engine/recording.ts';
  import { loadMedia, saveMedia } from '../store/media.ts';

  let { engine, powered, tone }: { engine: Engine | null; powered: boolean; tone: RecordingTone } = $props();
  let take = $state.raw<Recording | null>(null);
  let recording = $state(false);
  let busy = $state(false);
  let exporting = $state(false);
  let exportDry = $state(false);
  let progress = $state(0);
  let seconds = $state(0);
  let error = $state('');
  let note = $state('');
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
      take = captured; seconds = captured.samples.length / captured.sampleRate;
      const file = new File([encodeWav(captured)], 'last-recording.wav', { type: 'audio/wav' });
      const saved = await saveMedia(file, 'take', 'last-recording');
      note = saved ? 'Take saved on this device.' : 'Take kept for this session. Export it before closing the page.';
    } catch (e) { error = e instanceof Error ? e.message : 'Could not save the recording.'; }
    finally { recording = false; busy = false; }
  }
  async function download() {
    if (!take || exporting) return;
    exporting = true; progress = 0; error = ''; exportDry = !powered;
    abort = new AbortController();
    try {
      // Snapshot at the click: edits made while rendering belong to the next export.
      const snapshot = exportDry ? null : { values: { ...tone.values }, capture: tone.capture ? { ...tone.capture } : null, cab: tone.cab };
      const wav = await exportRecording(take, snapshot, value => { progress = value; }, abort.signal);
      if (disposed) return;
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      const link = document.createElement('a');
      link.href = url; link.download = `tonecraft-${exportDry ? 'DI' : 'amp'}-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { if (!disposed) error = e instanceof Error ? e.message : 'Export failed.'; }
    finally { exporting = false; abort = null; }
  }
  onMount(() => {
    void loadMedia('last-recording').then(async file => {
      if (!file) return;
      const restored = await decodeRecording(file);
      if (!disposed && !changed) { take = restored; seconds = restored.samples.length / restored.sampleRate; }
    }).catch(() => {});
  });
  onDestroy(() => {
    disposed = true; clearTimeout(poll); abort?.abort();
    if (recording) void recordingEngine?.stopRecording().catch(() => {});
  });
</script>

<section class="recorder" aria-label="Recording and WAV export">
  <div class="record-main">
    <div class="record-title"><span class="eyebrow">RECORDER</span><span class="duration" class:live={recording}>{#if recording}<i></i>{/if}{timestamp(seconds)}</span></div>
    <div class="wave"><svg viewBox="0 0 240 48" preserveAspectRatio="none" aria-label="Recorded DI waveform"><line x1="0" y1="24" x2="240" y2="24" stroke="#4e4e4e"/>{#if take}<polyline points={waveform} fill="none" stroke="#c7c0b5" stroke-width=".8" />{/if}</svg></div>
    <button class:recording disabled={busy || exporting || (!engine && !recording)} onclick={() => recording ? void stop() : void start()}>{busy ? 'Saving…' : recording ? '■ Stop recording' : take ? '● New take' : '● Record'}</button>
    <button class="export" disabled={!take || recording || busy || exporting} onclick={() => void download()}>{exporting ? `Exporting ${Math.round(progress * 100)}%` : powered ? 'Export amp · WAV' : 'Export DI · WAV'}</button>
    {#if exporting}<button onclick={() => abort?.abort()}>Cancel</button>{/if}
  </div>
  <div class="record-info"><span>{recording ? 'Recording clean input · 5 min maximum' : !engine && !take ? 'Power on the amplifier to record your input.' : note || 'The clean input is kept so you can change your tone after recording.'}</span><span>{powered ? 'Chain on → processed export' : 'Chain off → original DI'} · 32-bit float WAV</span></div>
  {#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
  .recorder{margin-top:24px;padding:20px 24px;border:1px solid #3c3c3c;border-radius:8px;background:#202020}.record-main{display:flex;align-items:center;gap:18px}.record-title{display:flex;flex-direction:column;gap:8px;min-width:88px}.eyebrow{font:9px var(--mono);letter-spacing:1.6px;color:#aaa}.duration{display:flex;align-items:center;gap:7px;font:18px var(--mono);font-variant-numeric:tabular-nums}.live{color:#ec987f}i{width:7px;height:7px;background:#ec987f;border-radius:50%}.wave{flex:1;min-width:80px;height:48px;background:#181818;border:1px solid #373737;border-radius:3px;padding:0 8px}.wave svg{width:100%;height:100%}button{font:12px var(--body);color:#ddd;background:#303030;border:1px solid #505050;border-radius:4px;min-height:38px;padding:8px 14px;cursor:pointer;white-space:nowrap}button:hover{background:#414141}button:disabled{opacity:.45;cursor:default}.recording{color:#ffc6b7;border-color:#ae7666}.export{background:#dedbd5;color:#222;border-color:#dedbd5}.export:hover{background:#f3f0ea}.record-info{display:flex;justify-content:space-between;gap:16px;margin-top:12px;color:#a3a3a3;font:10px/1.6 var(--body)}p{font-size:12px;color:var(--ember);margin:12px 0 0}@media(max-width:760px){.recorder{padding:18px 14px}.record-main{flex-wrap:wrap;gap:12px}.wave{flex-basis:calc(100% - 130px)}button{flex:1}.record-info{flex-direction:column;gap:4px}}
</style>
