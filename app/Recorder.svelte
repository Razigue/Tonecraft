<script lang="ts">
  import { lang, engineMessage } from './locale.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { builtInCabIRAt, type Engine } from '../engine/engine.ts';
  import {
    encodeWav, decodeRecording, decodeBacking, exportRecording, laneFrames, laneShift,
    type ExportContent, type Recording, type RecordingTone, type Timeline,
  } from '../engine/recording.ts';
  import { deleteMedia, loadMedia, saveMedia } from '../store/media.ts';
  import { STORES, dbGet, dbPut } from '../store/db.ts';

  let { engine, tone, sinkId = '' }: { engine: Engine | null; tone: RecordingTone; sinkId?: string } = $props();

  type Mode = 'di' | 'processed';
  const STATE_KEY = 'recorder';
  const words = $derived(lang.ui.recorder);
  const MODES: readonly Mode[] = ['di', 'processed'];
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
  const trackName = (index: number) => (index === 0 ? words.guitar : words.guitarN(index + 1));

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
    ['mix', words.mix, undefined],
    ['guitar', tracks.length > 1 ? words.guitarsOnly : words.guitarOnly, undefined],
    ...(tracks.length > 1 ? tracks.map((_, i) => ['guitar', words.trackOnly(trackName(i)), i] as const) : []),
    ['backing', words.backingOnly, undefined],
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
      cabIR: await (engine ? engine.cabIRAt(sampleRate, tone.cab) : builtInCabIRAt(sampleRate, tone.cab)) };
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
    } catch (err) { if (!disposed) error = err instanceof Error ? engineMessage(err.message) : words.playbackFailed; }
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
    } catch (e) { if (!disposed && !(e instanceof DOMException && e.name === 'AbortError')) error = e instanceof Error ? engineMessage(e.message) : words.playbackFailed; }
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
  /**
   * Deleting loses a take for good, so it asks twice: the first press turns
   * the button into its confirmation for a few seconds.
   */
  const CONFIRM_MS = 4000;
  let confirmDelete = $state(false);
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  function cancelDelete() { clearTimeout(confirmTimer); confirmDelete = false; }
  async function askDelete() {
    if (recording || busy) return;
    if (!confirmDelete) {
      confirmDelete = true;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => { confirmDelete = false; }, CONFIRM_MS);
      return;
    }
    cancelDelete();
    if (tracks.length > 1) { await removeTrack(armed); return; }
    // The last track stays, empty: there is always somewhere to record.
    setTrack(0, { take: null, fromFile: false });
    seconds = 0;
    selection = null;
    syncMs = null;
    persist();
    await saveTrackMedia(0);
  }
  function arm(index: number) {
    if (recording) return;
    if (index !== armed) cancelDelete();
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
    if (!isAudio(file)) { error = words.chooseGuitarAudio; return; }
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
    } catch { if (!disposed) error = words.undecodable; }
  }

  async function useBacking(file: File | undefined) {
    // The backing lane only takes a file: nothing is recorded into it, and nothing replaces it mid-take.
    if (!file || recording) return;
    error = '';
    if (!isAudio(file)) {
      error = words.chooseBackingAudio;
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
    } catch { if (!disposed) error = words.undecodable; }
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
      recording = false; error = e instanceof Error ? engineMessage(e.message) : words.engineStopped;
    }
  }
  async function start() {
    if (!engine || busy || recording || working) return;
    const others = tracks.some((t, i) => i !== armed && t.take);
    if (others && rate !== engine.sampleRate) {
      error = words.rateMismatch(rate, engine.sampleRate);
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
      if (!(abortedByPlayer(err))) error = err instanceof Error ? engineMessage(err.message) : words.cannotStart;
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
    } catch (e) { error = e instanceof Error ? engineMessage(e.message) : words.cannotSave; }
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
    } catch (e) { if (!disposed) error = e instanceof Error ? engineMessage(e.message) : words.exportFailed; }
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
    disposed = true; clearTimeout(poll); clearTimeout(confirmTimer); abort?.abort();
    void stopLive();
    stopListening();
    stopPreview();
    if (rendered) URL.revokeObjectURL(rendered.url);
    if (recording) void recordingEngine?.stopRecording().then(() => overdubbing && recordingEngine ? restoreBacking(recordingEngine) : undefined).catch(() => {});
  });
</script>

<svelte:window onpointerdown={closeMenu} />

<section class="recorder" aria-label={words.region}>
  <div class="record-head">
    <div class="record-title"><span class="eyebrow">{words.title}</span><span class="duration" class:live={recording}>{#if recording}<i></i>{/if}{timestamp(seconds)}</span></div>
    <div class="mode" role="radiogroup" aria-label={words.modeGroup}>
      {#each MODES as id (id)}
        <button type="button" role="radio" aria-checked={mode === id} class:on={mode === id} onclick={() => chooseMode(id)}><span class="dot"></span>{words.modes[id]}</button>
      {/each}
    </div>
    <div class="actions">
      <button class="listen" aria-label={listening ? words.pauseTake : words.listen} disabled={(!hasTake && !backing) || recording || busy || working !== null} onclick={() => void listen()}>{working === 'listen' ? `${Math.round(progress * 100)}%` : listening ? '❚❚' : '▶'}</button>
      <button class="primary" class:recording disabled={busy || working !== null || (!engine && !recording)} onclick={() => recording ? void stop() : void start()}>{working === 'prepare' ? words.preparing(Math.round(progress * 100)) : busy ? (recording ? words.saving : words.starting) : recording ? words.stopRecording : armedTake ? words.newTake : words.record}</button>
      <div class="export-menu">
        <button class="export" aria-haspopup="menu" aria-expanded={menu} disabled={(!hasTake && !backing) || recording || busy || working !== null} onclick={() => { menu = !menu; }}>{working === 'export' ? words.exporting(Math.round(progress * 100)) : words.exportWav}</button>
        {#if menu}
          <div class="menu" role="menu" aria-label={words.whatToExport}>
            {#each contents as [id, label, only] (label)}
              <button type="button" role="menuitem" disabled={!available(id, only)} onclick={() => void download(id, only)}>{label}{#if id !== 'backing'}<small>{words.modeSmall[mode]}</small>{/if}</button>
            {/each}
          </div>
        {/if}
      </div>
      {#if working}<button onclick={() => abort?.abort()}>{words.cancel}</button>{/if}
    </div>
  </div>

  <div class="timeline">
    <div class="lane-names">
      {#each tracks as track, i (track.id)}
        <div class="lane-head" class:armed={tracks.length > 1 && armed === i}>
          <div class="lane-title">
            {#if tracks.length > 1}
              <button type="button" class="arm" role="radio" aria-checked={armed === i} aria-label={words.recordInto(trackName(i))} disabled={recording || busy} onclick={() => arm(i)}><span></span>{trackName(i).toUpperCase()}</button>
            {:else}
              <span>{words.guitar.toUpperCase()}</span>
            {/if}
          </div>
          <input type="range" min="0" max="1" step="0.01" value={track.level} aria-label={words.trackLevel(trackName(i))} oninput={e => setGuitarLevel(i, Number(e.currentTarget.value))} />
        </div>
      {/each}
      <label class="lane-head"><span>{words.backingLane.toUpperCase()}</span><input type="range" min="0" max="1" step="0.01" value={backingLevel} aria-label={words.backingLevel} oninput={e => setBackingLevel(Number(e.currentTarget.value))} /></label>
    </div>
    <div class="lanes" role="group" aria-label={words.timeline}
      onpointerdown={selectStart} onpointermove={selectMove} onpointerup={selectEnd} onpointercancel={selectEnd}>
      {#each tracks as track, i (track.id)}
        <div class="lane guitar-lane" class:over={diOver === i} class:armed={tracks.length > 1 && armed === i} role="region" aria-label={trackName(i)}
          ondragover={e => { e.preventDefault(); diOver = i; }} ondragleave={() => { diOver = -1; }}
          ondrop={e => { e.preventDefault(); diOver = -1; void useDi(e.dataTransfer?.files[0], i); }}>
          {#if guitarPaths[i]}
            <svg viewBox={`0 0 ${COLUMNS} 48`} preserveAspectRatio="none" aria-label={i === 0 ? words.recordedGuitar : words.recordedGuitarN(i + 1)}><line x1="0" y1="24" x2={COLUMNS} y2="24" stroke="var(--line)"/><polyline points={guitarPaths[i]} fill="none" stroke="var(--violet-100)" stroke-width="1" /></svg>
          {:else}
            <button type="button" class="drop-hint" disabled={recording} onclick={() => { arm(i); diInputs[i]?.click(); }}><span>{hasTake ? words.dropOver : words.dropFirst} <u>{words.chooseFile}</u></span></button>
          {/if}
          <input class="hidden-file" bind:this={diInputs[i]} type="file" accept="audio/*" aria-label={words.diFile(trackName(i))} onchange={e => { void useDi(e.currentTarget.files?.[0], i); e.currentTarget.value = ''; }} />
        </div>
      {/each}
      <div class="lane backing-lane" class:over={dragOver} role="region" aria-label={words.backingTrack}
        ondragover={e => { e.preventDefault(); dragOver = true; }} ondragleave={() => { dragOver = false; }}
        ondrop={e => { e.preventDefault(); dragOver = false; void useBacking(e.dataTransfer?.files[0]); }}>
        {#if backingPath}
          <svg viewBox={`0 0 ${COLUMNS} 48`} preserveAspectRatio="none" aria-label={words.backingWaveform}><line x1="0" y1="24" x2={COLUMNS} y2="24" stroke="var(--line)"/><polyline points={backingPath} fill="none" stroke="var(--violet-400)" stroke-width="1" /></svg>
        {:else}
          <label class="drop-hint"><span>{words.dropSong} <u>{words.chooseFile}</u></span>
            <input type="file" accept="audio/*" aria-label={words.backingFile} onchange={e => { void useBacking(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} /></label>
        {/if}
      </div>
      {#if selection}<span class="selection" style:left={percent(selection[0])} style:width={`calc(${percent(selection[1])} - ${percent(selection[0])})`}></span>{/if}
      {#if playheadAt >= 0}<span class="playhead-track" aria-hidden="true"><span class="playhead" style:transform={`translateX(${percent(playheadAt)})`}></span></span>{/if}
    </div>
  </div>

  <div class="record-tools">
    {#if tracks.length < MAX_TRACKS}
      <button class="small add-track" disabled={recording || busy} onclick={addTrack}>{words.addTrack}</button>
    {/if}
    {#if tracks.length > 1 || armedTake}
      <button class="small delete-track" class:confirm={confirmDelete} disabled={recording || busy || working !== null} onclick={() => void askDelete()}>
        {confirmDelete ? words.pressAgain : tracks.length > 1 ? words.deleteTrack(trackName(armed)) : words.deleteTake}</button>
    {/if}
    {#if backingFile}
      <span class="backing-name" title={backingFile.name}>{backingFile.name}</span>
      <button class="small" disabled={!engine || recording} onclick={preview}>{previewing ? words.stopPreview : words.preview}</button>
      <button class="small" disabled={recording} onclick={() => replaceInput?.click()}>{words.replace}</button>
      <input class="hidden-file" bind:this={replaceInput} type="file" accept="audio/*" aria-label={words.replaceBacking} onchange={e => { void useBacking(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
      <button class="small" aria-label={words.removeBacking} disabled={recording} onclick={removeBacking}>✕</button>
    {/if}
    {#if syncShown && measured}
      {@const shownMs = syncMs ?? measuredMs}
      <label class="level sync">{words.sync}<input type="range" min="0" max="300" step="1" value={shownMs} aria-label={words.guitarSync}
        oninput={e => setSync(Number(e.currentTarget.value))} /><output>{shownMs} ms</output></label>
      {#if syncMs !== null}<button class="small" onclick={() => setSync(null)}>{words.measured(measuredMs)}</button>{/if}
    {/if}
    {#if selection}
      <span class="selection-info">{words.selection(timestamp(selection[0]), timestamp(selection[1]))}</span>
      <button class="small" onclick={clearSelection}>{words.clearSelection}</button>
    {/if}
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
  /* Part of the rack's plate: no card of its own, the seam above is the rack's. */
  .recorder { padding: 20px 24px; }
  .record-head { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .record-title { display: flex; flex-direction: column; gap: 8px; min-width: 88px; }
  .eyebrow { font: 400 10px/1 var(--display); font-stretch: 125%; letter-spacing: 0.16em; text-transform: uppercase; color: var(--text-2); }
  .duration { display: flex; align-items: center; gap: 7px; font: 18px var(--mono); font-variant-numeric: tabular-nums; }
  .live { color: var(--ember); }
  i { width: 7px; height: 7px; border-radius: 50%; background: var(--ember); }

  .mode { display: flex; gap: 2px; padding: 3px; border: 1px solid var(--line); border-radius: var(--radius); }
  .mode button { display: flex; align-items: center; gap: 7px; min-height: 28px; padding: 4px 12px; border: 0; border-radius: 2px; background: none; font: 11px var(--mono); color: var(--text-2); }
  .mode button:hover { background: var(--surface-2); }
  .mode .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--violet-800); }
  .mode .on, .mode .on:hover { background: var(--violet-900); color: var(--text); }
  .mode .on .dot { background: var(--accent); }

  .actions { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  /* Three weights: primary (record), secondary (export, listen), small (track tools). */
  button, .small {
    min-height: 38px;
    padding: 0 16px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    font: 13px var(--body);
    white-space: nowrap;
    cursor: pointer;
  }
  button:hover:not(:disabled) { border-color: var(--violet-500); background: #29252f; }
  button:disabled { opacity: .45; cursor: default; }
  .primary { border-color: var(--violet-500); background: var(--action); color: var(--action-text); font-weight: 500; }
  .primary:hover:not(:disabled) { background: var(--action-hover); }
  .primary.recording { border-color: var(--ember-line); background: #3a201b; color: #ffd7cc; }
  .listen { min-width: 46px; font-variant-numeric: tabular-nums; }

  .export-menu { position: relative; }
  .menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 5; display: grid; min-width: 220px; padding: 6px; border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--surface-1); box-shadow: var(--shadow); }
  .menu button { display: flex; justify-content: space-between; gap: 16px; min-height: 34px; border: 0; background: none; text-align: left; }
  .menu button:hover:not(:disabled) { background: var(--surface-2); }
  .menu small { font: 10px var(--mono); color: var(--text-2); }

  .timeline { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; margin-top: 18px; }
  .lane-names { display: grid; grid-auto-rows: 48px; gap: 6px; font: 400 9px/1 var(--display); font-stretch: 125%; letter-spacing: 0.16em; color: var(--text-3); }
  .lane-head { display: flex; flex-direction: column; justify-content: center; gap: 8px; }
  .lane-head input { width: 100%; height: 16px; margin: 0; cursor: pointer; }
  .lanes { position: relative; display: grid; grid-auto-rows: 48px; gap: 6px; touch-action: none; cursor: crosshair; }
  .lane { position: relative; overflow: hidden; background: var(--surface-0); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: inset 0 1px 3px #0008; }
  .lane svg { display: block; width: 100%; height: 100%; }
  .lane-title { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
  .arm, .arm:hover:not(:disabled) { display: flex; align-items: center; gap: 6px; min-height: 0; padding: 0; border: 0; background: none; font: inherit; letter-spacing: inherit; color: var(--text-3); }
  .arm span { width: 6px; height: 6px; border-radius: 50%; border: 1px solid var(--violet-600); }
  .armed .arm { color: var(--text); }
  .armed .arm span { background: var(--ember); border-color: var(--ember); }
  .guitar-lane.armed { border-color: var(--line-strong); }
  .backing-lane.over, .guitar-lane.over { border-color: var(--accent); }
  .drop-hint, .drop-hint:hover:not(:disabled) { position: absolute; inset: 0; display: grid; place-items: center; min-height: 0; padding: 0 12px; border: 0; border-radius: 0; background: none; text-align: center; line-height: 1.4; font-size: 12px; color: var(--text-3); cursor: pointer; }
  .drop-hint > span { min-width: 0; max-width: 100%; white-space: normal; }
  .drop-hint u { color: var(--text-2); text-decoration-color: var(--violet-500); text-underline-offset: 3px; }
  .drop-hint input, .hidden-file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  .selection { position: absolute; top: 0; bottom: 0; background: #d8c2dd22; border-left: 1px solid var(--accent); border-right: 1px solid var(--accent); pointer-events: none; }
  .playhead-track { position: absolute; inset: 0; pointer-events: none; }
  .playhead { position: absolute; inset: 0; will-change: transform; }
  .playhead::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 1px; background: var(--violet-50); }

  .record-tools { position: relative; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
  .record-tools:empty { display: none; }
  .small { min-height: 30px; padding: 0 10px; font-size: 12px; }
  /* Adding is routine; deleting is quiet until it asks to be confirmed. */
  .delete-track { border-color: transparent; background: none; color: var(--text-2); }
  .delete-track:hover:not(:disabled) { border-color: var(--ember-line); background: none; color: var(--ember); }
  .delete-track.confirm { color: var(--ember); border-color: var(--ember); }
  .backing-name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px var(--mono); color: var(--text-2); }
  .level { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-2); }
  .level input { width: 110px; }
  .sync output { min-width: 48px; font: 11px var(--mono); font-variant-numeric: tabular-nums; color: var(--text-2); }
  .selection-info { margin-left: auto; font: 11px var(--mono); color: var(--accent); }
  p { margin: 12px 0 0; font-size: 12px; color: var(--ember); }
  @media (max-width: 760px) {
    .recorder { padding: 18px 14px; }
    .record-head { gap: 12px; }
    .actions { margin-left: 0; flex-wrap: wrap; }
    .timeline { grid-template-columns: minmax(0, 1fr); }
    .lane-names { grid-template-rows: auto; grid-template-columns: 1fr 1fr; gap: 12px; }
    .selection-info { margin-left: 0; }
  }
</style>
