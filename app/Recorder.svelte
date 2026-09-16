<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Engine } from '../engine/engine.ts';
  import { CUSTOM_CAB } from '../engine/ir.ts';
  import {
    encodeWav, decodeRecording, decodeBacking, exportRecording, laneFrames, laneShift,
    type ExportContent, type Recording, type RecordingTone, type Timeline,
  } from '../engine/recording.ts';
  import { deleteMedia, loadMedia, saveMedia } from '../store/media.ts';
  import { STORES, dbGet, dbPut } from '../store/db.ts';

  let { engine, tone, sinkId = '' }: { engine: Engine | null; tone: RecordingTone; sinkId?: string } = $props();

  type Mode = 'di' | 'processed';
  const STATE_KEY = 'recorder';
  const MODES: readonly (readonly [Mode, string])[] = [['di', 'DI'], ['processed', 'Processed']];
  /**
   * Guitar tracks a session can hold. Nothing in the chain grows with it: a
   * take records one input, and the other tracks are heard as one pre-rendered
   * mix. What grows is the wait before an overdub starts, one offline render per
   * track, and that is what keeps the number small.
   */
  const MAX_TRACKS = 2;

  interface Track {
    /** Stable across reordering, so a render of a removed track is never reused. */
    readonly id: number;
    readonly take: Recording | null;
    /** The take was dropped as a DI, not recorded. */
    readonly fromFile: boolean;
    readonly level: number;
  }
  let nextTrackId = 0;
  const newTrack = (): Track => ({ id: nextTrackId++, take: null, fromFile: false, level: 1 });
  /** The first track keeps the id the single take always had, so sessions from before tracks still load. */
  const mediaId = (index: number) => (index === 0 ? 'last-recording' : `last-recording-${index + 1}`);
  const trackName = (index: number) => (index === 0 ? 'Guitar' : `Guitar ${index + 1}`);

  let tracks = $state.raw<Track[]>([newTrack()]);
  /** The track Record records into. */
  let armed = $state(0);
  let recording = $state(false);
  let busy = $state(false);
  let working = $state<'listen' | 'export' | 'prepare' | null>(null);
  let progress = $state(0);
  let seconds = $state(0);
  let error = $state('');
  let listening = $state(false);
  /** Seconds on the timeline where the playhead is, while listening. */
  let playheadAt = $state(-1);
  /** Whether the guitar is exported as recorded or through the tone on screen. */
  let mode = $state<Mode>('processed');
  let backingFile = $state.raw<File | null>(null);
  let backing = $state.raw<Float32Array<ArrayBuffer> | null>(null);
  /** The rate `backing` was decoded at: a take restored at another rate needs it again. */
  let backingDecodedAt = 0;
  let backingLevel = $state(0.8);
  let previewing = $state(false);
  let dragOver = $state(false);
  /** Seconds on the timeline, start before end. */
  let selection = $state<[number, number] | null>(null);
  let menu = $state(false);
  /**
   * How far the guitar is moved earlier to meet what it was played to, in ms,
   * when set by ear; null follows the latency measured with each take. A
   * measured round trip is what the drivers report, and they can be wrong by a
   * buffer — the same buffer for every take on the same interface, so one
   * setting serves every track.
   */
  let syncMs = $state<number | null>(null);
  let replaceInput = $state<HTMLInputElement | null>(null);
  let diInputs = $state<(HTMLInputElement | null)[]>([]);
  let diOver = $state(-1);
  let live = $state(false);
  let liveLoaded: { engine: Engine; version: number } | null = null;
  let recordingEngine: Engine | null = null;
  /** Other tracks were played back during the take in progress. */
  let overdubbing = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let previewPoll: ReturnType<typeof setInterval> | undefined;
  let abort: AbortController | null = null;
  let disposed = false;
  let changed = false;
  const timestamp = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  const takes = $derived(tracks.flatMap((t) => (t.take ? [t.take] : [])));
  const hasTake = $derived(takes.length > 0);
  const armedTake = $derived(tracks[armed]?.take ?? null);
  const rate = $derived(takes[0]?.sampleRate ?? engine?.sampleRate ?? 48_000);
  const measured = $derived(takes.find((t) => (t.latencyFrames ?? 0) > 0) ?? takes[0] ?? null);
  const measuredMs = $derived(measured ? Math.round(((measured.latencyFrames ?? 0) / measured.sampleRate) * 1000) : 0);
  const alignOf = (take: Recording) => (syncMs === null ? take.latencyFrames ?? 0 : Math.round((syncMs / 1000) * take.sampleRate));
  const syncShown = $derived(hasTake && (backing !== null || takes.some((t) => t.overdub)));
  const EMPTY = new Float32Array(0);
  const timeline = $derived<Timeline>({
    guitars: tracks.map((t) => ({ samples: t.take?.samples ?? EMPTY, level: t.level, latencyFrames: t.take ? alignOf(t.take) : 0, overdub: t.take?.overdub })),
    backing, backingLevel,
  });
  const lanes = $derived(laneFrames(timeline));
  const totalFrames = $derived(Math.max(lanes.backing, ...lanes.guitars));
  const duration = $derived(totalFrames / rate);
  /** What listening plays, and what the export list starts from. */
  const defaultContent = $derived<ExportContent>(hasTake && backing ? 'mix' : hasTake ? 'guitar' : 'backing');
  /** A lone dropped DI plays live through the chain, which has one file source. */
  const liveIndex = $derived(takes.length === 1 ? tracks.findIndex((t) => t.take !== null && t.fromFile) : -1);
  const canPlayLive = $derived(engine !== null && liveIndex >= 0 && mode === 'processed');
  const available = (content: ExportContent, only?: number) =>
    content === 'backing' ? !!backing
    : only !== undefined ? !!tracks[only]?.take
    : content === 'mix' ? hasTake && !!backing : hasTake;
  const contents = $derived<(readonly [ExportContent, string, number | undefined])[]>([
    ['mix', 'Guitar + backing', undefined],
    ['guitar', tracks.length > 1 ? 'Guitars only' : 'Guitar only', undefined],
    ...(tracks.length > 1 ? tracks.map((_, i) => ['guitar', `${trackName(i)} only`, i] as const) : []),
    ['backing', 'Backing only', undefined],
  ]);

  /* One waveform column per 480th of the timeline, so every lane shares a scale
     and each guitar sits where it will sound against the others. */
  const COLUMNS = 480;
  function lanePath(samples: Float32Array | null, offset: number, frames: number, total: number, scale: number): string {
    if (!samples || total === 0) return '';
    const points: string[] = [];
    const per = total / COLUMNS;
    for (let x = 0; x < COLUMNS && x * per < frames; x++) {
      const from = Math.max(0, Math.floor(x * per) + offset);
      const to = Math.min(samples.length, Math.floor((x + 1) * per) + offset);
      let peak = 0;
      for (let i = from; i < to; i++) { const v = Math.abs(samples[i]!); if (v > peak) peak = v; }
      const h = Math.max(0.5, Math.min(22, peak * scale));
      points.push(`${x},${24 - h} ${x},${24 + h}`);
    }
    return points.join(' ');
  }
  const guitarPaths = $derived(tracks.map((t, i) => lanePath(t.take?.samples ?? null, laneShift(timeline, timeline.guitars[i]!), lanes.guitars[i]!, totalFrames, 80)));
  const backingPeak = $derived.by(() => { let p = 0; if (backing) for (const v of backing) { const a = Math.abs(v); if (a > p) p = a; } return p; });
  const backingPath = $derived(lanePath(backing, 0, lanes.backing, totalFrames, backingPeak > 0 ? 20 / backingPeak : 1));
  const percent = (s: number) => `${duration > 0 ? Math.max(0, Math.min(100, (s / duration) * 100)) : 0}%`;

  /**
   * What the take sounds like is what the export will write. Rendered once per
   * set of takes, backing track, content, guitar mode, selection and level, so
   * listening then exporting renders only once.
   */
  let version = 0;
  let backingId = 0;
  let rendered: { key: string; blob: Blob; url: string } | null = null;
  /** The mix heard during an overdub, kept while nothing it depends on changes. */
  let monitor: { key: string; blob: Blob } | null = null;
  let audio: HTMLAudioElement | null = null;
  let frame = 0;
  let listenFrom = 0;

  function persist() {
    void dbPut(STORES.state, {
      mode, backingLevel, syncMs, armed,
      tracks: tracks.map((t) => ({ level: t.level, fromFile: t.fromFile, latencyFrames: t.take?.latencyFrames ?? 0, overdub: t.take?.overdub === true })),
    }, STATE_KEY);
  }
  function forgetRender() {
    stopListening();
    if (rendered) URL.revokeObjectURL(rendered.url);
    rendered = null;
  }
  function setTrack(index: number, patch: Partial<Omit<Track, 'id'>>) {
    if ('take' in patch) { void stopLive(); version++; }
    forgetRender();
    tracks = tracks.map((t, i) => (i === index ? { ...t, ...patch } : t));
  }
  async function saveTrackMedia(index: number) {
    const take = tracks[index]?.take;
    if (take) await saveMedia(new File([encodeWav(take)], `${mediaId(index)}.wav`, { type: 'audio/wav' }), 'take', mediaId(index));
    else await deleteMedia(mediaId(index));
  }
  function selectionFrames(): [number, number] | undefined {
    return selection ? [Math.round(selection[0] * rate), Math.round(selection[1] * rate)] : undefined;
  }
  /** The tone as it is at the click, with a loaded cabinet IR read at the takes' rate. */
  async function snapshotTone(sampleRate: number): Promise<RecordingTone> {
    return { values: { ...tone.values }, capture: tone.capture ? { ...tone.capture } : null, cab: tone.cab,
      ...(tone.cab === CUSTOM_CAB && engine ? { cabIR: await engine.cabIRAt(sampleRate, CUSTOM_CAB) } : {}) };
  }
  const trackTakes = (except = -1): Recording[] => tracks.map((t, i) => (t.take && i !== except ? { ...t.take, latencyFrames: alignOf(t.take) } : { samples: EMPTY, sampleRate: rate }));
  async function render(content: ExportContent, only?: number): Promise<{ blob: Blob; url: string } | null> {
    if (!available(content, only)) return null;
    const guitarTone = content === 'backing' || mode === 'di' ? null : tone;
    const range = selectionFrames();
    const levels = tracks.map((t) => t.level);
    const key = [version, tracks.map((t) => t.id).join(','), backingId, content, only ?? 'all', guitarTone ? JSON.stringify(guitarTone) : 'dry', range?.join('-') ?? 'all', content === 'guitar' ? '' : backingLevel, content === 'backing' ? '' : levels.join(','), syncMs].join('|');
    if (rendered?.key === key) return rendered;
    progress = 0;
    abort = new AbortController();
    try {
      // Snapshot at the click: edits made while rendering belong to the next render.
      const snapshot = guitarTone ? await snapshotTone(rate) : null;
      const wav = await exportRecording(trackTakes(), rate, snapshot, value => { progress = value; }, abort.signal,
        { content, only, backing, guitarLevels: levels, backingLevel, range });
      if (disposed) return null;
      if (rendered) URL.revokeObjectURL(rendered.url);
      const blob = new Blob([wav], { type: 'audio/wav' });
      rendered = { key, blob, url: URL.createObjectURL(blob) };
      return rendered;
    } finally { abort = null; }
  }

  /**
   * What the player hears while recording into `index`: every other track and
   * the backing track, from the start of the timeline, as one file the chain
   * plays in the backing track's place. It starts on the block the recorder
   * starts on, so the new take lines up with the others exactly as it lines up
   * with a backing track. Through the amp whenever there is one, whatever the
   * export mode: nobody plays along to a DI.
   */
  async function renderMonitor(index: number): Promise<Blob> {
    const levels = tracks.map((t) => t.level);
    const guitarTone = tone.capture ? tone : null;
    const key = [version, tracks.map((t) => t.id).join(','), index, backingId, guitarTone ? JSON.stringify(guitarTone) : 'dry', backingLevel, levels.join(','), syncMs].join('|');
    if (monitor?.key === key) return monitor.blob;
    progress = 0;
    abort = new AbortController();
    try {
      const snapshot = guitarTone ? await snapshotTone(rate) : null;
      const wav = await exportRecording(trackTakes(index), rate, snapshot, value => { progress = value; }, abort.signal,
        { content: backing ? 'mix' : 'guitar', backing, guitarLevels: levels, backingLevel });
      monitor = { key, blob: new Blob([wav], { type: 'audio/wav' }) };
      return monitor.blob;
    } finally { abort = null; }
  }
  const abortedByPlayer = (err: unknown) => err instanceof Error && err.message === 'Export cancelled.';
  /** After an overdub, the chain gets the real backing track back, or none. */
  async function restoreBacking(e: Engine) {
    if (backingFile) { await e.loadBacking(backingFile); e.setBackingLevel(backingLevel); }
    else e.clearBacking();
  }

  function follow() {
    if (!audio) return;
    playheadAt = listenFrom + audio.currentTime;
    if (listening) frame = requestAnimationFrame(follow);
  }
  function stopListening() {
    cancelAnimationFrame(frame);
    audio?.pause();
    listening = false;
    playheadAt = -1;
  }
  async function playLive() {
    const e = engine, t = tracks[liveIndex]?.take;
    if (!e || !t || working) return;
    stopPreview();
    working = 'listen'; error = '';
    try {
      if (liveLoaded?.engine !== e || liveLoaded.version !== version) {
        await e.loadFile(new File([encodeWav(t)], 'take.wav', { type: 'audio/wav' }));
        liveLoaded = { engine: e, version };
      }
      await e.setSource('file');
      e.setLoop(false);
      const from = selection?.[0] ?? 0;
      // The guitar is heard where the timeline draws it against the backing track.
      const lead = laneShift(timeline, timeline.guitars[liveIndex]!) / t.sampleRate;
      e.playFile(from + lead);
      if (backing) e.playBacking(from);
      listenFrom = from;
      live = true;
      listening = true;
      frame = requestAnimationFrame(followLive);
    } catch (err) { if (!disposed) error = err instanceof Error ? err.message : 'Playback failed.'; }
    finally { working = null; }
  }
  function followLive() {
    const e = engine, t = tracks[liveIndex]?.take;
    if (!e || !live || !t) { void stopLive(); return; }
    const lead = laneShift(timeline, timeline.guitars[liveIndex]!) / t.sampleRate;
    playheadAt = Math.max(0, e.filePosition - lead);
    const end = selection?.[1];
    if (!e.filePlaying || (end !== undefined && playheadAt >= end)) { void stopLive(); return; }
    frame = requestAnimationFrame(followLive);
  }
  async function stopLive() {
    if (!live) return;
    cancelAnimationFrame(frame);
    live = false;
    listening = false;
    playheadAt = -1;
    engine?.stopFile();
    engine?.stopBacking();
    await engine?.setSource('live');
  }

  async function listen() {
    if (live) { void stopLive(); return; }
    if (listening) { audio?.pause(); return; }
    if (canPlayLive) { void playLive(); return; }
    if ((!hasTake && !backing) || working) return;
    working = 'listen'; error = '';
    try {
      const result = await render(defaultContent);
      if (!result || disposed) return;
      listenFrom = selection?.[0] ?? 0;
      audio ??= new Audio();
      if (audio.src !== result.url) {
        audio.src = result.url;
        // The same output as the amp: headphones sit on the interface, not the laptop.
        const withSink = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
        if (sinkId && withSink.setSinkId) await withSink.setSinkId(sinkId).catch(() => {});
        audio.onplay = () => { listening = true; frame = requestAnimationFrame(follow); };
        audio.onpause = () => { listening = false; cancelAnimationFrame(frame); };
        audio.onended = () => { listening = false; cancelAnimationFrame(frame); playheadAt = -1; };
      }
      await audio.play();
    } catch (e) { if (!disposed && !(e instanceof DOMException && e.name === 'AbortError')) error = e instanceof Error ? e.message : 'Playback failed.'; }
    finally { working = null; }
  }

  function chooseMode(next: Mode) {
    if (next === mode) return;
    void stopLive();
    mode = next;
    forgetRender();
    persist();
  }

  function addTrack() {
    if (tracks.length >= MAX_TRACKS || recording) return;
    forgetRender();
    tracks = [...tracks, newTrack()];
    armed = tracks.length - 1;
    persist();
  }
  async function removeTrack(index: number) {
    if (tracks.length <= 1 || recording || busy) return;
    const last = tracks.length - 1;
    void stopLive();
    forgetRender();
    version++;
    tracks = tracks.filter((_, i) => i !== index);
    if (armed >= tracks.length || armed > index) armed = Math.max(0, armed - 1);
    persist();
    // Media is kept by position: every track after the removed one moves up one.
    for (let i = index; i < tracks.length; i++) await saveTrackMedia(i);
    await deleteMedia(mediaId(last));
  }
  function arm(index: number) {
    if (recording) return;
    armed = index;
    seconds = tracks[index]?.take ? tracks[index].take.samples.length / tracks[index].take.sampleRate : 0;
    persist();
  }

  /* A selection is dragged across the timeline; a click without a drag clears it. */
  let dragFrom: { x: number; at: number } | null = null;
  const secondsAt = (e: PointerEvent, el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * duration;
  };
  function selectStart(e: PointerEvent) {
    if (duration === 0 || recording || (e.target instanceof Element && e.target.closest('label,input,button'))) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    dragFrom = { x: e.clientX, at: secondsAt(e, el) };
  }
  function selectMove(e: PointerEvent) {
    if (!dragFrom || Math.abs(e.clientX - dragFrom.x) < 4) return;
    const at = secondsAt(e, e.currentTarget as HTMLElement);
    selection = [Math.min(dragFrom.at, at), Math.max(dragFrom.at, at)];
  }
  function selectEnd(e: PointerEvent) {
    if (!dragFrom) return;
    if (Math.abs(e.clientX - dragFrom.x) < 4) selection = null;
    dragFrom = null;
    void stopLive();
    forgetRender();
  }
  function clearSelection() { selection = null; forgetRender(); }

  const isAudio = (file: File) => file.type.startsWith('audio/') || /\.(wav|mp3|ogg|oga|flac|m4a|aac|webm)$/i.test(file.name);

  /** A DI dropped on a guitar lane: that track's take, as if it had been recorded, with no latency to line up. */
  async function useDi(file: File | undefined, index: number) {
    if (!file || recording) return;
    error = '';
    if (!isAudio(file)) { error = 'Choose an audio file for the guitar.'; return; }
    try {
      // At the other tracks' rate, so they share one timeline.
      const others = tracks.find((t, i) => i !== index && t.take)?.take;
      const sampleRate = others?.sampleRate ?? engine?.sampleRate ?? 48_000;
      const samples = await decodeBacking(file, sampleRate);
      if (disposed || !tracks[index]) return;
      changed = true;
      setTrack(index, { take: { samples, sampleRate, latencyFrames: 0 }, fromFile: true });
      armed = index;
      seconds = samples.length / sampleRate;
      selection = null;
      if (takes.length === 1) syncMs = null;
      persist();
      await saveTrackMedia(index);
    } catch { if (!disposed) error = 'That file could not be decoded.'; }
  }

  async function useBacking(file: File | undefined) {
    // The backing lane only takes a file: nothing is recorded into it, and nothing replaces it mid-take.
    if (!file || recording) return;
    error = '';
    if (!isAudio(file)) {
      error = 'Choose an audio file for the backing track.';
      return;
    }
    try {
      const decoded = await decodeBacking(file, rate);
      if (disposed) return;
      stopPreview();
      forgetRender();
      backingFile = file;
      backing = decoded;
      backingDecodedAt = rate;
      backingId++;
      if (engine) { await engine.loadBacking(file); engine.setBackingLevel(backingLevel); }
      await saveMedia(file, 'backing', 'last-backing');
    } catch { if (!disposed) error = 'That file could not be decoded.'; }
  }
  function removeBacking() {
    stopPreview();
    forgetRender();
    engine?.clearBacking();
    backingFile = null;
    backing = null;
    backingId++;
    void deleteMedia('last-backing');
  }
  function setSync(ms: number | null) {
    syncMs = ms;
    forgetRender();
    persist();
  }
  function setGuitarLevel(index: number, level: number) {
    setTrack(index, { level });
    persist();
  }
  function setBackingLevel(level: number) {
    backingLevel = level;
    engine?.setBackingLevel(level);
    forgetRender();
    persist();
  }
  function preview() {
    if (!engine || !backing) return;
    if (previewing) { stopPreview(); return; }
    engine.playBacking(selection?.[0] ?? 0);
    previewing = true;
    previewPoll = setInterval(() => { if (!engine?.backingPlaying) stopPreview(); }, 250);
  }
  function stopPreview() {
    clearInterval(previewPoll);
    if (previewing) engine?.stopBacking();
    previewing = false;
  }

  // A new engine is a new chain: it gets the backing track again.
  $effect(() => {
    const e = engine, file = backingFile;
    if (!e || !file || e.backingLoaded) return;
    void e.loadBacking(file).then(() => e.setBackingLevel(backingLevel)).catch(() => {});
  });
  // Decoded at the takes' rate, which a restored take can change.
  $effect(() => {
    const file = backingFile, r = rate;
    if (!file || (backing && backingDecodedAt === r)) return;
    let stale = false;
    void decodeBacking(file, r).then(samples => { if (!stale && !disposed) { backing = samples; backingDecodedAt = r; backingId++; } }).catch(() => {});
    return () => { stale = true; };
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
    if (!engine || busy || recording || working) return;
    const others = tracks.some((t, i) => i !== armed && t.take);
    if (others && rate !== engine.sampleRate) {
      error = `The other tracks are at ${rate} Hz and the interface runs at ${engine.sampleRate} Hz. Set it back to ${rate} Hz to record over them.`;
      return;
    }
    busy = true; error = ''; changed = true;
    await stopLive();
    stopListening();
    stopPreview();
    const e = engine;
    recordingEngine = e;
    overdubbing = others;
    try {
      if (others) {
        working = 'prepare';
        try { await e.loadBacking(await renderMonitor(armed)); }
        finally { working = null; }
        e.setBackingLevel(1);
      }
      await e.startRecording();
      recording = true; seconds = 0;
      void pollRecording();
    } catch (err) {
      // Cancelling the preparation is not a failure worth a message.
      if (!(abortedByPlayer(err))) error = err instanceof Error ? err.message : 'Could not start recording.';
      if (others && !disposed) await restoreBacking(e).catch(() => {});
    }
    finally { busy = false; }
  }
  async function stop() {
    if (!recordingEngine || busy) return;
    busy = true; clearTimeout(poll);
    const index = armed;
    try {
      const captured = await recordingEngine.stopRecording();
      if (overdubbing) await restoreBacking(recordingEngine).catch(() => {});
      if (disposed || !tracks[index]) return;
      setTrack(index, { take: { ...captured, overdub: overdubbing }, fromFile: false });
      seconds = captured.samples.length / captured.sampleRate;
      selection = null;
      if (takes.length === 1) syncMs = null;
      persist();
      await saveTrackMedia(index);
    } catch (e) { error = e instanceof Error ? e.message : 'Could not save the recording.'; }
    finally { recording = false; busy = false; }
  }
  async function download(content: ExportContent, only?: number) {
    menu = false;
    if (working || !available(content, only)) return;
    working = 'export'; error = '';
    try {
      const result = await render(content, only);
      if (!result || disposed) return;
      const what = content === 'backing' ? 'backing' : `${content === 'mix' ? 'cover-' : ''}${only !== undefined ? `track${only + 1}-` : ''}${mode === 'di' ? 'DI' : 'amp'}`;
      const link = document.createElement('a');
      link.href = result.url; link.download = `tonecraft-${what}-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
      document.body.appendChild(link); link.click(); link.remove();
    } catch (e) { if (!disposed) error = e instanceof Error ? e.message : 'Export failed.'; }
    finally { working = null; }
  }
  function closeMenu(e: PointerEvent) {
    if (menu && !(e.target instanceof Element && e.target.closest('.export-menu'))) menu = false;
  }

  interface SavedTrack { level?: unknown; fromFile?: unknown; latencyFrames?: unknown; overdub?: unknown }
  onMount(() => {
    void (async () => {
      const saved = await dbGet<{ mode?: unknown; guitarLevel?: unknown; backingLevel?: unknown; latencyFrames?: unknown; syncMs?: unknown; fromFile?: unknown; tracks?: unknown; armed?: unknown }>(STORES.state, STATE_KEY).catch(() => null);
      if (disposed) return;
      if (saved?.mode === 'di' || saved?.mode === 'processed') mode = saved.mode;
      if (typeof saved?.backingLevel === 'number' && saved.backingLevel >= 0 && saved.backingLevel <= 1) backingLevel = saved.backingLevel;
      if (typeof saved?.syncMs === 'number' && saved.syncMs >= 0 && saved.syncMs <= 300) syncMs = saved.syncMs;
      // Sessions from before tracks kept one take's fields at the top level.
      const list: SavedTrack[] = Array.isArray(saved?.tracks) ? (saved.tracks as SavedTrack[]).slice(0, MAX_TRACKS)
        : [{ level: saved?.guitarLevel, fromFile: saved?.fromFile, latencyFrames: saved?.latencyFrames }];
      const restored: Track[] = [];
      for (const [i, entry] of list.entries()) {
        const level = typeof entry.level === 'number' && entry.level >= 0 && entry.level <= 1 ? entry.level : 1;
        const latencyFrames = typeof entry.latencyFrames === 'number' && entry.latencyFrames >= 0 ? entry.latencyFrames : 0;
        const file = await loadMedia(mediaId(i)).catch(() => null);
        const take = file ? await decodeRecording(file).catch(() => null) : null;
        restored.push({ ...newTrack(), level, fromFile: entry.fromFile === true,
          take: take ? { ...take, latencyFrames, overdub: entry.overdub === true } : null });
      }
      if (disposed) return;
      if (!changed && restored.length > 0) {
        tracks = restored;
        version++;
        const a = typeof saved?.armed === 'number' && Number.isInteger(saved.armed) ? saved.armed : 0;
        armed = Math.min(Math.max(0, a), tracks.length - 1);
        const t = tracks[armed]?.take;
        seconds = t ? t.samples.length / t.sampleRate : 0;
      }
      const backingSaved = await loadMedia('last-backing').catch(() => null);
      if (backingSaved && !disposed && !backingFile) await useBacking(backingSaved);
    })();
  });
  onDestroy(() => {
    disposed = true; clearTimeout(poll); abort?.abort();
    void stopLive();
    stopListening();
    stopPreview();
    if (rendered) URL.revokeObjectURL(rendered.url);
    if (recording) void recordingEngine?.stopRecording().then(() => overdubbing && recordingEngine ? restoreBacking(recordingEngine) : undefined).catch(() => {});
  });
</script>

<svelte:window onpointerdown={closeMenu} />

<section class="recorder" aria-label="Recording and WAV export">
  <div class="record-head">
    <div class="record-title"><span class="eyebrow">RECORDER</span><span class="duration" class:live={recording}>{#if recording}<i></i>{/if}{timestamp(seconds)}</span></div>
    <div class="mode" role="radiogroup" aria-label="Guitar in the export">
      {#each MODES as [id, label] (id)}
        <button type="button" role="radio" aria-checked={mode === id} class:on={mode === id} onclick={() => chooseMode(id)}><span class="dot"></span>{label}</button>
      {/each}
    </div>
    <div class="actions">
      <button class="listen" aria-label={listening ? 'Pause take' : 'Listen to take'} disabled={(!hasTake && !backing) || recording || busy || working !== null} onclick={() => void listen()}>{working === 'listen' ? `${Math.round(progress * 100)}%` : listening ? '❚❚' : '▶'}</button>
      <button class:recording disabled={busy || working !== null || (!engine && !recording)} onclick={() => recording ? void stop() : void start()}>{working === 'prepare' ? `Preparing ${Math.round(progress * 100)}%` : busy ? (recording ? 'Saving…' : 'Starting…') : recording ? '■ Stop recording' : armedTake ? '● New take' : '● Record'}</button>
      <div class="export-menu">
        <button class="export" aria-haspopup="menu" aria-expanded={menu} disabled={(!hasTake && !backing) || recording || busy || working !== null} onclick={() => { menu = !menu; }}>{working === 'export' ? `Exporting ${Math.round(progress * 100)}%` : 'Export WAV ▾'}</button>
        {#if menu}
          <div class="menu" role="menu" aria-label="What to export">
            {#each contents as [id, label, only] (label)}
              <button type="button" role="menuitem" disabled={!available(id, only)} onclick={() => void download(id, only)}>{label}{#if id !== 'backing'}<small>{mode === 'di' ? 'DI' : 'processed'}</small>{/if}</button>
            {/each}
          </div>
        {/if}
      </div>
      {#if working}<button onclick={() => abort?.abort()}>Cancel</button>{/if}
    </div>
  </div>

  <div class="timeline">
    <div class="lane-names">
      {#each tracks as track, i (track.id)}
        <div class="lane-head" class:armed={tracks.length > 1 && armed === i}>
          <div class="lane-title">
            {#if tracks.length > 1}
              <button type="button" class="arm" role="radio" aria-checked={armed === i} aria-label={`Record into ${trackName(i)}`} disabled={recording || busy} onclick={() => arm(i)}><span></span>{trackName(i).toUpperCase()}</button>
              <button type="button" class="remove" aria-label={`Remove ${trackName(i)}`} disabled={recording || busy} onclick={() => void removeTrack(i)}>✕</button>
            {:else}
              <span>GUITAR</span>
            {/if}
          </div>
          <input type="range" min="0" max="1" step="0.01" value={track.level} aria-label={`${trackName(i)} level`} oninput={e => setGuitarLevel(i, Number(e.currentTarget.value))} />
        </div>
      {/each}
      <label class="lane-head"><span>BACKING</span><input type="range" min="0" max="1" step="0.01" value={backingLevel} aria-label="Backing track level" oninput={e => setBackingLevel(Number(e.currentTarget.value))} /></label>
    </div>
    <div class="lanes" role="group" aria-label="Recording timeline"
      onpointerdown={selectStart} onpointermove={selectMove} onpointerup={selectEnd} onpointercancel={selectEnd}>
      {#each tracks as track, i (track.id)}
        <div class="lane guitar-lane" class:over={diOver === i} class:armed={tracks.length > 1 && armed === i} role="region" aria-label={trackName(i)}
          ondragover={e => { e.preventDefault(); diOver = i; }} ondragleave={() => { diOver = -1; }}
          ondrop={e => { e.preventDefault(); diOver = -1; void useDi(e.dataTransfer?.files[0], i); }}>
          {#if guitarPaths[i]}
            <svg viewBox={`0 0 ${COLUMNS} 48`} preserveAspectRatio="none" aria-label={i === 0 ? 'Recorded guitar' : `Recorded guitar ${i + 1}`}><line x1="0" y1="24" x2={COLUMNS} y2="24" stroke="#4e4e4e"/><polyline points={guitarPaths[i]} fill="none" stroke="#c7c0b5" stroke-width="1" /></svg>
          {:else}
            <button type="button" class="drop-hint" disabled={recording} onclick={() => { arm(i); diInputs[i]?.click(); }}><span>{#if hasTake}Press ● Record to play over the other tracks, or drop a DI, or <u>choose a file</u>{:else}Press ● Record to record your guitar, or drop a DI (a dry guitar recording, no amp), or <u>choose a file</u>{/if}</span></button>
          {/if}
          <input class="hidden-file" bind:this={diInputs[i]} type="file" accept="audio/*" aria-label={`${trackName(i)} DI file`} onchange={e => { void useDi(e.currentTarget.files?.[0], i); e.currentTarget.value = ''; }} />
        </div>
      {/each}
      <div class="lane backing-lane" class:over={dragOver} role="region" aria-label="Backing track"
        ondragover={e => { e.preventDefault(); dragOver = true; }} ondragleave={() => { dragOver = false; }}
        ondrop={e => { e.preventDefault(); dragOver = false; void useBacking(e.dataTransfer?.files[0]); }}>
        {#if backingPath}
          <svg viewBox={`0 0 ${COLUMNS} 48`} preserveAspectRatio="none" aria-label="Backing track waveform"><line x1="0" y1="24" x2={COLUMNS} y2="24" stroke="#4e4e4e"/><polyline points={backingPath} fill="none" stroke="#b9a3bf" stroke-width="1" /></svg>
        {:else}
          <label class="drop-hint"><span>Drop a song to play along to, or <u>choose a file</u></span>
            <input type="file" accept="audio/*" aria-label="Backing track file" onchange={e => { void useBacking(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} /></label>
        {/if}
      </div>
      {#if selection}<span class="selection" style:left={percent(selection[0])} style:width={`calc(${percent(selection[1])} - ${percent(selection[0])})`}></span>{/if}
      {#if playheadAt >= 0}<span class="playhead-track" aria-hidden="true"><span class="playhead" style:transform={`translateX(${percent(playheadAt)})`}></span></span>{/if}
    </div>
  </div>

  <div class="record-tools">
    {#if tracks.length < MAX_TRACKS}
      <button class="small add-track" disabled={recording || busy} onclick={addTrack}>+ Add track</button>
    {/if}
    {#if backingFile}
      <span class="backing-name" title={backingFile.name}>{backingFile.name}</span>
      <button class="small" disabled={!engine || recording} onclick={preview}>{previewing ? '■ Stop' : '▶ Preview'}</button>
      <button class="small" disabled={recording} onclick={() => replaceInput?.click()}>Replace</button>
      <input class="hidden-file" bind:this={replaceInput} type="file" accept="audio/*" aria-label="Replace backing track" onchange={e => { void useBacking(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
      <button class="small" aria-label="Remove backing track" disabled={recording} onclick={removeBacking}>✕</button>
    {/if}
    {#if syncShown && measured}
      {@const shownMs = syncMs ?? measuredMs}
      <label class="level sync">Sync<input type="range" min="0" max="300" step="1" value={shownMs} aria-label="Guitar sync"
        oninput={e => setSync(Number(e.currentTarget.value))} /><output>{shownMs} ms</output></label>
      {#if syncMs !== null}<button class="small" onclick={() => setSync(null)}>Measured {measuredMs} ms</button>{/if}
    {/if}
    {#if selection}
      <span class="selection-info">Selection {timestamp(selection[0])}–{timestamp(selection[1])}</span>
      <button class="small" onclick={clearSelection}>Clear selection</button>
    {/if}
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
  .recorder{margin-top:24px;padding:20px 24px;border:1px solid #3c3c3c;border-radius:8px;background:#202020}
  .record-head{display:flex;align-items:center;gap:18px;flex-wrap:wrap}.record-title{display:flex;flex-direction:column;gap:8px;min-width:88px}.eyebrow{font:9px var(--mono);letter-spacing:1.6px;color:#aaa}.duration{display:flex;align-items:center;gap:7px;font:18px var(--mono);font-variant-numeric:tabular-nums}.live{color:#ec987f}i{width:7px;height:7px;background:#ec987f;border-radius:50%}
  .mode{display:flex;gap:2px;padding:3px;border:1px solid #454545;border-radius:999px}.mode button{display:flex;align-items:center;gap:7px;min-height:28px;padding:4px 12px;border:0;border-radius:999px;background:none;font:10px var(--mono);letter-spacing:1px;color:#9c9c9c}.mode button:hover{background:#2c2c2c}.mode .dot{width:6px;height:6px;border-radius:50%;background:#5c5c5c}.mode .on,.mode .on:hover{background:#333;color:#ededed}.mode .on .dot{background:#d8c2dd}
  .actions{display:flex;align-items:center;gap:10px;margin-left:auto}
  button,.small{font:12px var(--body);color:#ddd;background:#303030;border:1px solid #505050;border-radius:4px;min-height:38px;padding:8px 14px;cursor:pointer;white-space:nowrap}button:hover{background:#414141}button:disabled{opacity:.45;cursor:default}.listen{min-width:46px;font-variant-numeric:tabular-nums}.recording{color:#ffc6b7;border-color:#ae7666}.export{background:#dedbd5;color:#222;border-color:#dedbd5}.export:hover{background:#f3f0ea}
  .export-menu{position:relative}.menu{position:absolute;right:0;top:calc(100% + 6px);z-index:5;display:grid;min-width:210px;padding:6px;background:#262626;border:1px solid #4a4a4a;border-radius:6px;box-shadow:0 10px 24px #0008}.menu button{display:flex;justify-content:space-between;gap:16px;border:0;background:none;text-align:left;min-height:34px}.menu button:hover:not(:disabled){background:#353535}.menu small{font:10px var(--mono);color:#9c9c9c}
  .timeline{display:grid;grid-template-columns:96px minmax(0,1fr);gap:12px;margin-top:16px}.lane-names{display:grid;grid-auto-rows:48px;gap:6px;font:9px var(--mono);letter-spacing:1.4px;color:#8f8f8f}.lane-head{display:flex;flex-direction:column;justify-content:center;gap:6px}.lane-head input{width:100%;height:16px;margin:0;accent-color:#c2a9c8;cursor:pointer}
  .lanes{position:relative;display:grid;grid-auto-rows:48px;gap:6px;touch-action:none;cursor:crosshair}.lane{position:relative;overflow:hidden;background:#181818;border:1px solid #373737;border-radius:3px}.lane svg{display:block;width:100%;height:100%}
  .lane-title{display:flex;align-items:center;justify-content:space-between;gap:4px}.arm,.remove,.arm:hover,.remove:hover{display:flex;align-items:center;gap:6px;min-height:0;padding:0;border:0;background:none;font:9px var(--mono);letter-spacing:1.4px;color:#8f8f8f}.arm span{width:6px;height:6px;border-radius:50%;border:1px solid #6a6a6a}.armed .arm{color:#ededed}.armed .arm span{background:var(--ember);border-color:var(--ember)}.remove{font-size:10px;padding:2px 4px}.remove:hover:not(:disabled){color:#ededed}.guitar-lane.armed{border-color:#5a5a5a}
  .backing-lane.over,.guitar-lane.over{border-color:#d8c2dd}.drop-hint,.drop-hint:hover{position:absolute;inset:0;display:grid;place-items:center;min-height:0;padding:0 12px;text-align:center;line-height:1.4;border:0;border-radius:0;background:none;font-size:11px;color:#9c9c9c;cursor:pointer}.drop-hint>span{min-width:0;max-width:100%;white-space:normal}.drop-hint u{color:#dedbd5}.drop-hint input,.hidden-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
  .selection{position:absolute;top:0;bottom:0;background:#d8c2dd22;border-left:1px solid #d8c2dd;border-right:1px solid #d8c2dd;pointer-events:none}
  .playhead-track{position:absolute;inset:0;pointer-events:none}.playhead{position:absolute;inset:0;will-change:transform}.playhead::before{content:'';position:absolute;left:0;top:0;bottom:0;width:1px;background:#e8dfd0}
  .record-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:10px;min-height:0}.record-tools:empty{display:none}.small{min-height:30px;padding:5px 10px;font-size:11px}.record-tools{position:relative}.backing-name{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px var(--mono);color:#cfcfcf}.level{display:flex;align-items:center;gap:8px;font-size:10px;color:#aaa}.level input{width:110px;accent-color:#c2a9c8}.sync output{min-width:48px;font:11px var(--mono);color:#cfcfcf;font-variant-numeric:tabular-nums}.selection-info{font:11px var(--mono);color:#d8c2dd;margin-left:auto}
  p{font-size:12px;color:var(--ember);margin:12px 0 0}
  @media(max-width:760px){.recorder{padding:18px 14px}.record-head{gap:12px}.actions{margin-left:0;flex-wrap:wrap}.timeline{grid-template-columns:minmax(0,1fr)}.lane-names{grid-template-rows:auto;grid-template-columns:1fr 1fr;gap:12px}.selection-info{margin-left:0}}
</style>
