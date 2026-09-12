<script lang="ts">
  // Studio shell owns audio state; amplifier materials are scoped to its head.
  import { onDestroy } from 'svelte';
  import { Engine, EngineError, readCatalog, type Meters, type Backend, type LoopMeters,
           type InputChannel, type InputDevice, type OutputDevice, type Source } from '../engine/engine.ts';
  import type { NativeOpened } from '../engine/native-host.ts';
  import { openInput } from '../engine/input.ts';
  import { CABS } from '../engine/ir.ts';
  import { detectPitch, noteFromFrequency, type PitchReading } from '../engine/tuner.ts';
  import { bpmFromFourTaps, Metronome, MIN_BPM, MAX_BPM } from '../engine/metronome.ts';
  import type { Capture } from '../engine/catalog.ts';
  import { PARAMS, STAGES, type Param } from '../schema/params.ts';
  import { PRESETS, DEFAULT_PRESET, type Preset } from './presets.ts';
  import { loadSession, saveSession } from '../store/session.ts';
  import { loadMedia, saveMedia, deleteMedia } from '../store/media.ts';
  import Knob from './Knob.svelte';
  import Meter from './Meter.svelte';
  import Segmented from './Segmented.svelte';
  import Waveform from './Waveform.svelte';
  import Tuner from './Tuner.svelte';
  import MetronomePanel from './Metronome.svelte';
  import EngineSettings from './EngineSettings.svelte';
  import TabReader from './TabReader.svelte';
  import Recorder from './Recorder.svelte';
  import './tokens.css';

  let mode = $state<'musician' | 'tester'>('musician');
  let settingsDialog = $state<HTMLDialogElement | null>(null);
  let detecting = $state(false);
  let settingsError = $state('');
  let tunerDialog = $state<HTMLDialogElement | null>(null);
  let tunerOpening = $state(false);
  let tunerReading = $state<PitchReading | null>(null);
  let tunerFrame = 0;
  let tunerReadAt = 0;
  let tunerLastNoteAt = 0;
  let tunerSamples: Float32Array<ArrayBuffer> | null = null;
  let tunerHistory: number[] = [];
  let tunerPreviousSource: Source | null = null;
  let tunerResumeFile = false;
  const TUNER_REPORT_MS = 1000 / 60;
  const TUNER_SMOOTHING_READINGS = 3;
  let metronomeDialog = $state<HTMLDialogElement | null>(null);
  let metronomeOpening = $state(false);
  let metronomeValue = $state('');
  let metronomeBpm = $state<number | null>(null);
  let metronomePlaying = $state(false);
  let metronomeVolume = $state(0.55);
  let tapTimes: number[] = [];
  let tapCount = $state(0);
  let tapResetTimer: number | null = null;
  const metronome = new Metronome();

  async function detectInputs(): Promise<void> {
    // Tonecraft Engine lists its own devices, and needs no microphone permission.
    if (mode === 'tester' || detecting || engineState === 'starting' || backend === 'native') return;
    detecting = true;
    settingsError = '';
    let stream: MediaStream | undefined;
    try {
      if (engineState !== 'running' || source !== 'live' || poweredOff) {
        stream = await openInput(navigator.mediaDevices);
        channelCount = stream.getAudioTracks()[0]?.getSettings().channelCount ?? 1;
      }
      const detector = engine ?? new Engine();
      devices = await detector.listInputs();
      outputs = await detector.listOutputs();
    } catch (error) {
      settingsError = error instanceof Error ? error.message : 'Unable to detect audio inputs.';
    } finally {
      stream?.getTracks().forEach(track => track.stop());
      detecting = false;
    }
  }

  function openSettings(): void {
    if (mode === 'tester') return;
    settingsDialog?.showModal();
    void detectInputs();
  }

  async function openTuner(): Promise<void> {
    if (tunerOpening || tunerDialog?.open || engineState === 'starting') return;
    tunerOpening = true;
    tunerPreviousSource = engineState === 'running' ? source : null;
    tunerResumeFile = filePlaying;

    try {
      if (engineState !== 'running') await start('play');
      else if (source !== 'live') await chooseSource('live');
      if (engineState !== 'running' || engine === null) return;

      tunerSamples = new Float32Array(engine.tunerBufferSize);
      tunerHistory = [];
      tunerReading = null;
      tunerLastNoteAt = 0;
      engine.setTunerActive(true);
      tunerDialog?.showModal();
      tunerFrame = requestAnimationFrame(tickTuner);
    } catch (error) {
      notice = error instanceof Error ? error.message : 'The tuner could not open.';
      engine?.setTunerActive(false);
    } finally {
      tunerOpening = false;
    }
  }

  function tickTuner(now: number): void {
    tunerFrame = requestAnimationFrame(tickTuner);
    // One report per display frame up to 60 Hz. The small tolerance prevents a
    // nominal 16.67 ms frame from being skipped because of timer rounding.
    if (now - tunerReadAt < TUNER_REPORT_MS - 1 || engine === null || tunerSamples === null) return;
    tunerReadAt = now;
    const rate = engine.readTunerInput(tunerSamples);
    const found = rate === null ? null : detectPitch(tunerSamples, rate);

    if (found !== null && found.confidence >= 0.7) {
      tunerHistory.push(found.frequency);
      if (tunerHistory.length > TUNER_SMOOTHING_READINGS) tunerHistory.shift();
      const ordered = [...tunerHistory].sort((a, b) => a - b);
      const frequency = ordered[Math.floor(ordered.length / 2)]!;
      tunerReading = noteFromFrequency(frequency, found.confidence);
      tunerLastNoteAt = now;
    } else if (now - tunerLastNoteAt > 350) {
      tunerReading = null;
      tunerHistory = [];
    }
  }

  async function onTunerClosed(): Promise<void> {
    tunerOpening = true;
    cancelAnimationFrame(tunerFrame);
    tunerReading = null;
    tunerSamples = null;
    tunerHistory = [];

    const previousSource = tunerPreviousSource;
    const resumeFile = tunerResumeFile;
    tunerPreviousSource = null;
    tunerResumeFile = false;
    try {
      // Restore a file source while monitoring is still muted, so closing the
      // sheet cannot leak a moment of live guitar before the old route returns.
      if (engine !== null && previousSource !== null && source !== previousSource) {
        await chooseSource(previousSource);
        if (resumeFile && previousSource === 'file') play();
      }
    } finally {
      engine?.setTunerActive(false);
      tunerOpening = false;
    }
  }

  async function openMetronome(): Promise<void> {
    if (metronomeOpening || metronomeDialog?.open) return;
    metronomeOpening = true;
    try {
      await metronome.prepare(engine?.outputId ?? outputId);
      metronome.setVolume(metronomeVolume);
      metronomeDialog?.showModal();
    } catch {
      notice = 'The metronome could not start. Check the browser audio output.';
    } finally {
      metronomeOpening = false;
    }
  }

  function setMetronomeValue(raw: string): void {
    if (tapResetTimer !== null) clearTimeout(tapResetTimer);
    tapResetTimer = null;
    metronomeValue = raw;
    tapTimes = [];
    tapCount = 0;
    const value = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(value) && value >= MIN_BPM && value <= MAX_BPM) {
      metronomeBpm = value;
      metronome.play(value);
      metronomePlaying = true;
    } else {
      metronomeBpm = null;
      metronome.pause();
      metronomePlaying = false;
    }
    persist();
  }

  function tapTempo(): void {
    if (tapResetTimer !== null) clearTimeout(tapResetTimer);
    tapResetTimer = null;
    const now = performance.now();
    const previous = tapTimes[tapTimes.length - 1];
    if (previous === undefined || now - previous < 60_000 / MAX_BPM || now - previous > 60_000 / MIN_BPM) {
      tapTimes = [now];
      metronome.pause();
      metronomeBpm = null;
      metronomePlaying = false;
      metronomeValue = '';
    } else {
      tapTimes.push(now);
    }
    tapCount = tapTimes.length;

    if (tapTimes.length === 4) {
      const bpm = bpmFromFourTaps(tapTimes);
      if (bpm !== null) {
        metronomeBpm = bpm;
        metronomeValue = String(bpm);
        metronome.play(bpm);
        metronomePlaying = true;
        persist();
      }
      tapTimes = [];
      if (tapResetTimer !== null) clearTimeout(tapResetTimer);
      tapResetTimer = self.setTimeout(() => { tapCount = 0; }, 420);
    }
  }

  function setMetronomeVolume(value: number): void {
    metronomeVolume = value;
    metronome.setVolume(value);
    persist();
  }

  async function toggleMetronome(): Promise<void> {
    if (metronomeOpening || metronomeBpm === null) return;
    if (metronomePlaying) {
      metronome.pause();
      metronomePlaying = false;
      return;
    }
    metronomeOpening = true;
    try {
      await metronome.prepare(engine?.outputId ?? outputId);
      metronome.setVolume(metronomeVolume);
      metronome.play(metronomeBpm);
      metronomePlaying = true;
    } catch {
      notice = 'The metronome could not start. Check the browser audio output.';
    } finally {
      metronomeOpening = false;
    }
  }

  function onMetronomeClosed(): void {
    tapTimes = [];
    tapCount = 0;
    if (tapResetTimer !== null) clearTimeout(tapResetTimer);
    tapResetTimer = null;
  }

  function chooseMusician(): void {
    mode = 'musician';
    source = 'live';
    asking = false;
    welcomeDialog?.close();
    openSettings();
  }

  async function chooseTester(): Promise<void> {
    mode = 'tester';
    asking = false;
    welcomeDialog?.close();
    settingsDialog?.close();
    deviceId = '';
    outputId = '';
    devices = [];
    outputs = [];
    source = 'file';
    await start('demo');
  }

  async function power(): Promise<void> {
    if (engineState === 'starting' || detecting) return;
    if (engineState === 'running') toggleChain();
    else await start(source === 'file' ? 'demo' : 'play');
  }

  type State = 'idle' | 'starting' | 'running' | 'failed';

  const param = (id: string): Param => PARAMS.find((p) => p.id === id)!;
  const DEFAULT_VALUES = Object.fromEntries(PARAMS.map((p) => [p.id, p.default]));

  const SOURCES = [
    { value: 'live', label: 'Live' },
    { value: 'file', label: 'File' },
  ] as const;

  /**
   * The A/B, as one button rather than two.
   *
   * It answers the only question a first-time visitor actually has — what does
   * this do to my guitar — and the answer is far more convincing heard back to
   * back than described. That means flipping it repeatedly, and a two-option
   * selector makes you move the pointer between two targets to do it. One
   * button in one place can be hammered.
   */
  const BYPASS_KEY = 'b';

  /**
   * A two-input interface puts its instrument jack on the second channel — a
   * Scarlett Solo carries the XLR left and the jack right — so the choice only
   * exists when there is one to make. "Follow" is the honest default: many
   * interfaces declare stereo with only one side wired.
   */
  const CHANNELS = [
    { value: 'follow', label: 'Auto' },
    { value: 'left', label: 'L' },
    { value: 'right', label: 'R' },
    { value: 'sum', label: 'Both' },
  ] as const;

  let engineState = $state<State>('idle');
  let problem = $state<{ cause: string; fix: string } | null>(null);
  /**
   * The round trip, and only that.
   *
   * `engine.health` also judges dropouts, jitter and the shape of the input, and
   * reading it here would run all four every metering frame for something
   * nothing displays any more. The verdicts are still there for whoever wants
   * them; the meter loop does not pay for them.
   */
  let latencyMs = $state<number | null>(null);
  /** What the figure is made of, for the title on hover. */
  let latencyDetail = $state('');
  /** The two figures the sentence above is made of, to detect when it moves. */
  let latencyKey = '';
  /** The opening sheet. Dismissible: looking around is never blocked. */
  let asking = $state(true);
  let welcomeDialog = $state<HTMLDialogElement | null>(null);
  $effect(() => {
    if (asking && engineState !== 'running') welcomeDialog?.showModal();
    else welcomeDialog?.close();
  });
  let notice = $state<string | null>(null);
  /**
   * Whether the worklet has confirmed the capture is loaded and processing.
   *
   * This is not a detail: when a model fails to load, the processor passes the
   * signal straight through. There is still sound, the meters still move, and
   * the rig would otherwise show the capture's name as though it were playing.
   * The one thing this product must not do is stay quiet about that.
   */
  let captureLoaded = $state(false);

  let values = $state<Record<string, number>>(
    { ...DEFAULT_VALUES },
  );
  let resetValues = $state<Record<string, number>>({
    ...DEFAULT_VALUES,
    ...(PRESETS.find((p) => p.name === DEFAULT_PRESET)?.values ?? {}),
  });
  let captures = $state<readonly Capture[]>([]);
  let captureFile = $state('');
  let cab = $state('v30mod');
  /** Whether the player has chosen a cabinet themselves since the last capture. */
  let cabTouched = $state(false);
  let preset = $state<string | null>(DEFAULT_PRESET);
  /** The preset double-click returns to; survives an edit, unlike `preset`. */
  let resetPreset: string | null = DEFAULT_PRESET;

  let devices = $state<InputDevice[]>([]);
  let deviceId = $state('');
  /**
   * Where the sound comes out. '' is "follow the input": the output that
   * shares hardware with the interface, which is where the headphones are.
   * Only offered where the browser lets a page choose (not Firefox).
   */
  let outputs = $state<OutputDevice[]>([]);
  let outputId = $state('');
  /**
   * Where the chain runs: this tab, or Tonecraft Engine, the native companion
   * that plays through ASIO. The player's choice, remembered; the tone is the
   * same either way, because both run the same chain. Which interface the
   * engine plays through is its own saved configuration, edited from the
   * settings sheet.
   */
  let backend = $state<Backend>('browser');
  let nativeOpened = $state<NativeOpened | null>(null);
  let channel = $state<InputChannel>('follow');
  let channelCount = $state(1);
  let source = $state<Source>('live');
  /** Hearing the guitar as it arrives rather than as the chain leaves it. */
  let poweredOff = $state(false);

  const NO_LOOP: LoopMeters = { state: 'empty', position: 0, length: 0 };
  let meters = $state<Meters>({
    input: 0, drive: 0, output: 0, outputRms: 0, gate: 1, channelPeaks: [0], channels: 1,
    pitchDelayMs: 0, loop: NO_LOOP,
  });

  /**
   * The looper, as the chain reports it. Nothing here is a second copy of the
   * state: the chain owns what a press means, and this is only what it says
   * it is doing (dsp/looper.h).
   */
  let loop = $state<LoopMeters>(NO_LOOP);
  /** How loud the loop sits under the playing. Session, never part of a tone. */
  let loopLevel = $state(0.8);

  let fileName = $state('');
  let filePeaks = $state<Float32Array | null>(null);
  let fileDuration = $state(0);
  let filePosition = $state(0);
  let filePlaying = $state(false);
  let fileLoop = $state(true);
  /** The player's last take, kept in IndexedDB so Stop, Start and a reload keep it. */
  let takeId: string | null = null;
  let dragging = $state(false);

  let engine = $state.raw<Engine | null>(null);
  let frame = 0;

  const capture = $derived(captures.find((c) => c.file === captureFile) ?? null);
  const cabInfo = $derived(CABS.find((c) => c.id === cab) ?? CABS[0]!);
  const level = (v: number): number => Math.min(1, Math.sqrt(Math.max(0, v)) * 1.6);
  const isGuilt = $derived(captureFile === PRESETS[0]?.capture);
  /**
   * How lit the front of the amp is, 0 to 1, from the output RMS.
   *
   * Quantised to 64 steps. The meters arrive 30 times a second and every
   * distinct value here is a style write on the largest element on the page;
   * a step finer than 1/64 is below the eye's threshold on a brightness ramp
   * and buys nothing but repaints.
   */
  const light = $derived(engineState === 'running' && captureLoaded && !poweredOff
    ? Math.round(Math.max(0, Math.min(1, (20 * Math.log10(Math.max(0.0001, meters.outputRms)) + 60) / 60)) * 64) / 64
    : 0);
  /**
   * The same lighting, expressed as the opacity of a black veil over the art
   * instead of a `brightness()` filter on it.
   *
   * The filter was re-rasterising a 1.6 megapixel image on every meter frame:
   * measured at 55% of one core, continuously, most of it on the compositor
   * thread. `opacity` is a compositor property — the image is rastered once and
   * never again, and the veil is a layer whose alpha the GPU changes for free
   * (CLAUDE.md section 4: only `transform` and `opacity` may animate).
   *
   * The image carries a static brightness(1.67) so the range is unchanged:
   * a veil at alpha a over it yields (1 - a) * 1.67, and a = 1 - b / 1.67
   * reproduces exactly the brightness b the filter used to apply.
   */
  const VEIL_MAX_BRIGHTNESS = 1.67;
  const veil = $derived(
    Math.max(0, Math.min(1, 1 - (0.42 + light * 1.25) / VEIL_MAX_BRIGHTNESS)),
  );
  function nextPreset(direction: number) {
    const index = PRESETS.findIndex(p => p.name === preset);
    void applyPreset(PRESETS[(index + direction + PRESETS.length) % PRESETS.length]!);
  }

  // --------------------------------------------------------------------------
  // Persistence (store/). Local only, and never a reason to fail: a private
  // window that refuses storage still plays.

  /** Nothing is written until the saved session has been read, or the defaults would overwrite it. */
  let restored = false;

  function persist(): void {
    if (!restored) return;
    // Snapshot: IndexedDB cannot structured-clone Svelte's state proxies.
    saveSession($state.snapshot({
      values, captureFile, cab, cabTouched, preset, resetPreset,
      // Tonecraft Engine keeps its own device configuration now; nothing to save here.
      deviceId, outputId, channel, backend, native: null,
      source, takeId, fileLoop, metronomeBpm, metronomeVolume, loopLevel,
    }));
  }

  async function restore(): Promise<void> {
    const saved = await loadSession();
    if (saved.values !== undefined) values = { ...DEFAULT_VALUES, ...saved.values };
    if (saved.resetPreset !== undefined) {
      resetPreset = saved.resetPreset;
      const from = PRESETS.find((p) => p.name === resetPreset);
      resetValues = { ...DEFAULT_VALUES, ...(from?.values ?? {}) };
    }
    if (saved.preset !== undefined) preset = saved.preset;
    if (saved.captureFile !== undefined) captureFile = saved.captureFile;
    if (saved.cab !== undefined) cab = saved.cab;
    if (saved.cabTouched !== undefined) cabTouched = saved.cabTouched;
    if (saved.deviceId !== undefined) deviceId = saved.deviceId;
    if (saved.outputId !== undefined) outputId = saved.outputId;
    if (saved.channel !== undefined) channel = saved.channel;
    if (saved.backend !== undefined) backend = saved.backend;
    if (saved.source !== undefined) source = saved.source;
    if (saved.takeId !== undefined) takeId = saved.takeId;
    if (saved.fileLoop !== undefined) fileLoop = saved.fileLoop;
    if (saved.metronomeVolume !== undefined) metronomeVolume = saved.metronomeVolume;
    if (saved.loopLevel !== undefined) loopLevel = saved.loopLevel;
    // The tempo comes back ready, never playing: sound waits for a gesture.
    if (saved.metronomeBpm != null && saved.metronomeBpm >= MIN_BPM && saved.metronomeBpm <= MAX_BPM) {
      metronomeBpm = saved.metronomeBpm;
      metronomeValue = String(saved.metronomeBpm);
    }
    if (captures.length > 0) settleCapture();
  }

  // --------------------------------------------------------------------------

  function setParam(id: string, value: number): void {
    values = { ...values, [id]: value };
    engine?.setParam(id, value);
    // Moving anything means this is no longer the preset it came from.
    preset = null;
    persist();
  }

  async function applyPreset(p: Preset): Promise<void> {
    values = { ...values, ...p.values };
    resetValues = { ...DEFAULT_VALUES, ...p.values };
    resetPreset = p.name;
    for (const [id, v] of Object.entries(p.values)) engine?.setParam(id, v);
    // A preset may name a capture that is not installed.
    const wanted = captures.some((c) => c.file === p.capture) ? p.capture : captures[0]?.file;
    cabTouched = false;
    cab = p.cab;
    engine?.setCab(p.cab);
    if (wanted !== undefined && wanted !== captureFile) {
      captureFile = wanted;
      await engine?.setCapture(wanted);
    }
    preset = p.name;
    persist();
  }

  async function chooseCapture(file: string): Promise<void> {
    captureFile = file;
    captureLoaded = false;
    preset = null;
    const chosen = captures.find((c) => c.file === file);
    // Each capture names the cabinet it was voiced against; we follow it until
    // the player picks one themselves.
    if (chosen !== undefined && !cabTouched) {
      cab = chosen.cab;
      engine?.setCab(cab);
    }
    persist();
    const ok = await engine?.setCapture(file);
    notice = ok === false
      ? 'That capture did not load. Reload the page; if it persists, run `npm run vendor`.'
      : null;
  }

  function chooseCab(id: string): void {
    cab = id;
    cabTouched = true;
    preset = null;
    engine?.setCab(id);
    persist();
  }

  function toggleChain(): void {
    poweredOff = !poweredOff;
    engine?.setPowered(!poweredOff);
  }

  /**
   * The same thing from the keyboard, because an A/B you have to aim at is an
   * A/B people do twice. Ignored while a control has focus, so it cannot fire
   * while somebody is typing in a field or nudging a fader.
   */
  function onWindowKey(event: KeyboardEvent): void {
    if (engineState !== 'running') return;
    const key = event.key.toLowerCase();
    if (key !== BYPASS_KEY && key !== LOOP_KEY) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) {
      const tag = active.tagName.toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (active.getAttribute('role') === 'slider') return;
    }
    event.preventDefault();
    // Both hands are on the guitar: the two things worth doing mid-phrase are
    // hearing the difference and closing a loop, and both are one key.
    if (key === LOOP_KEY) loopPress();
    else toggleChain();
  }

  // --------------------------------------------------------------------------
  // The looper. One button, as a pedal has: the chain decides what the next
  // press means, and this only says what that will be.

  /** What pressing the button will do next, which is what it is labelled. */
  const LOOP_ACTION = {
    empty: 'Record', recording: 'Play', playing: 'Overdub', overdubbing: 'Play', stopped: 'Play',
  } as const;
  const LOOP_STATUS = {
    empty: 'Empty', recording: 'Recording', playing: 'Playing', overdubbing: 'Overdubbing', stopped: 'Stopped',
  } as const;
  const LOOP_KEY = 'l';

  const loopAction = $derived(LOOP_ACTION[loop.state]);
  const loopHas = $derived(loop.length > 0);

  /** m:ss.t — a loop is counted in seconds, and the tenth shows it turning. */
  function clock(seconds: number): string {
    const whole = Math.max(0, seconds);
    const m = Math.floor(whole / 60);
    const s = (whole - m * 60).toFixed(1).padStart(4, '0');
    return `${m}:${s}`;
  }

  function loopPress(): void {
    if (engineState !== 'running') return;
    engine?.loopPress();
  }

  function loopStop(): void { engine?.loopStop(); }
  function loopClear(): void { engine?.loopClear(); }

  function setLoopLevel(value: number): void {
    loopLevel = value;
    engine?.setLoopLevel(value);
    persist();
  }

  function chooseChannel(next: string): void {
    channel = next as InputChannel;
    engine?.setInputChannel(channel);
    persist();
  }

  async function chooseDevice(id: string): Promise<void> {
    deviceId = id;
    persist();
    await engine?.useDevice(id);
    channelCount = engine?.channelCount ?? 1;
    // The output may have followed the new interface.
    outputId = engine?.outputId ?? outputId;
  }

  async function chooseOutput(id: string): Promise<void> {
    outputId = id;
    persist();
    await engine?.useOutput(id);
    outputId = engine?.outputId ?? outputId;
    await metronome.useOutput(outputId);
  }

  /** Moving the chain between the browser and Tonecraft Engine restarts it; nothing else changes. */
  async function chooseBackend(next: Backend): Promise<void> {
    if (next === backend) return;
    backend = next;
    persist();
    await restart();
  }

  /* The chain is rebuilt from the rig's state on every start, in either host,
     so a restart is how a device or buffer change takes effect. */
  async function restart(): Promise<void> {
    if (engineState !== 'running') return;
    const intent: Intent = source === 'file' ? 'demo' : 'play';
    await stop();
    await start(intent);
  }

  async function chooseSource(next: string): Promise<void> {
    source = next as Source;
    persist();
    await engine?.setSource(source);
    if (source === 'live') { engine?.stopFile(); filePlaying = false; }
    else if (filePeaks === null) await loadTake();
  }

  function onModel(file: string, ok: boolean): void {
    if (file === captureFile || file === '') captureLoaded = ok;
  }

  function onEngineError(message: string): void {
    captureLoaded = false;
    notice = backend === 'native'
      ? `${message}. Start Tonecraft Engine again, or switch the audio engine back to the browser in the settings.`
      : `The amplifier engine did not start (${message}). Reload the page; if it persists, run \`npm run build:dsp\`.`;
  }

  /**
   * What each output costs, filled in the first time the selector is opened.
   *
   * Not at start, and not on a timer. Probing opens a short-lived context per
   * device to read its `outputLatency`, and opening an output stream while a
   * guitar is going through the chain is exactly the kind of thing that can
   * cost a block. Doing it when somebody reaches for the menu puts any hiccup
   * where a menu is already opening, and it is also the only moment the
   * numbers are wanted.
   */
  let outputsProbed = false;
  async function probeOutputs(): Promise<void> {
    if (outputsProbed || engine === null) return;
    outputsProbed = true;
    outputs = await engine.probeOutputs();
  }

  function onMeters(m: Meters): void {
    meters = m;
    if (m.loop.state !== loop.state || m.loop.position !== loop.position || m.loop.length !== loop.length) {
      loop = m.loop;
    }
    // The engine can reopen by itself when a device changes: follow what it opened.
    const opened = engine?.nativeOpened ?? null;
    if (opened !== nativeOpened) nativeOpened = opened;
    channelCount = m.channels;
    /* The transposer's delay is part of what the player feels, so it is part
       of the figure they are shown — it is not the host's, but the ear cannot
       tell the difference and the product should not pretend to. */
    const trip = engine?.roundTripMs ?? null;
    latencyMs = trip === null ? null : trip + m.pitchDelayMs;
    const parts = engine?.latencyParts ?? null;
    /* Where the number comes from, and which half anyone can do anything
       about. The render buffer is one quantum and cannot go lower; the chain
       itself measures a tenth of a millisecond (npm run measure:latency). So
       the output device is the figure, and it is the one thing here that is a
       choice — hence the Output selector, which carries each device's cost.

       Built only when one of the two figures actually moves. It is a tooltip
       on a number that changes at most a few times a session, and assembling
       four hundred characters thirty times a second to say the same thing is
       garbage the collector has to come back for — on the one thread that
       must not stall. */
    const key = parts === null ? '' :
      `${backend}/${parts.input.toFixed(1)}/${parts.output.toFixed(1)}/${outputs.length > 1}/${m.pitchDelayMs > 0.05}`;
    if (key !== latencyKey) {
      latencyKey = key;
      latencyDetail = parts === null ? '' : backend === 'native'
        ? `${parts.input.toFixed(1)} ms in and ${parts.output.toFixed(1)} ms out, as the driver reports them` +
          (nativeOpened?.bufferSize == null ? '' : ` at ${nativeOpened.bufferSize}-frame buffers`) +
          '. The chain itself adds nothing; a smaller buffer in the settings lowers both.'
        : `${parts.input.toFixed(1)} ms of render buffer, which is one block and cannot ` +
          `go lower, and ${parts.output.toFixed(1)} ms in the output device` +
          (outputs.length > 1 ? ', which the Output selector can change' : '') +
          '. The chain itself adds a tenth of a millisecond. The input path is not ' +
          'reported by the browser and is not in this number.';
      if (m.pitchDelayMs > 0.05) {
        latencyDetail += ` The transposer is adding ${m.pitchDelayMs.toFixed(1)} ms on top: ` +
          'shifting a note means waiting for its waveform to come round again. ' +
          'Switching it off gives that back.';
      }
    }
  }

  // --------------------------------------------------------------------------
  // The file source

  /** Enough buckets to recognise a riff; computed once, not per frame. */
  const BUCKETS = 900;

  function peaksOf(buffer: AudioBuffer): Float32Array {
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const n = buffer.length;
    const nc = channels.length || 1;
    const peaks = new Float32Array(BUCKETS * 2);
    for (let b = 0; b < BUCKETS; b++) {
      const from = Math.floor((b * n) / BUCKETS);
      const to = Math.min(n, Math.floor(((b + 1) * n) / BUCKETS));
      let lo = 0, hi = 0;
      for (let i = from; i < to; i++) {
        let v = 0;
        for (let c = 0; c < nc; c++) v += channels[c]![i]!;
        v /= nc;
        if (v < lo) lo = v; else if (v > hi) hi = v;
      }
      peaks[b * 2] = lo;
      peaks[b * 2 + 1] = hi;
    }
    return peaks;
  }

  /** `remember`: false when the file already came out of storage. */
  async function loadFile(file: File | undefined, remember = true): Promise<void> {
    if (file === undefined || engine === null) return;
    pause();
    try {
      const buffer = await engine.loadFile(file);
      fileName = file.name;
      fileDuration = buffer.duration;
      filePeaks = peaksOf(buffer);
      filePosition = 0;
      notice = null;
      if (remember) void rememberTake(file);
    } catch (error) {
      notice = `That file could not be decoded: ${String((error as Error).message)}`;
    }
  }

  /** Only a take that decoded is kept; the one it replaces is deleted, so the store holds one. */
  async function rememberTake(file: File): Promise<void> {
    const previous = takeId;
    takeId = await saveMedia(file, 'take');
    if (previous !== null && previous !== takeId) void deleteMedia(previous);
    persist();
  }

  /** The remembered take, back from IndexedDB. False when there is none any more. */
  async function loadTake(): Promise<boolean> {
    if (takeId === null || engine === null) return false;
    const file = await loadMedia(takeId);
    if (file === null) { takeId = null; persist(); return false; }
    await loadFile(file, false);
    return filePeaks !== null;
  }

  const DEMO_NAME = 'Demo take (Tonecraft)';

  async function loadDemo(): Promise<void> {
    if (engine === null) return;
    // Stop before fetching, not after: a load takes a moment, and until it
    // lands the transport would go on claiming to be playing a take that is
    // being replaced.
    pause();
    try {
      const buffer = await engine.loadDemoTake();
      fileName = DEMO_NAME;
      fileDuration = buffer.duration;
      filePeaks = peaksOf(buffer);
      filePosition = 0;
      notice = null;
    } catch {
      notice = 'The demo take is not installed. It lives in public/di/.';
    }
  }

  function play(): void {
    if (engine === null || filePeaks === null) return;
    if (engineState !== 'running') { notice = 'Press start to power the chain.'; return; }
    engine.playFile();
    filePlaying = true;
  }

  function pause(): void {
    engine?.stopFile();
    filePlaying = false;
    filePosition = engine?.filePosition ?? filePosition;
  }

  function seek(seconds: number): void {
    engine?.seekFile(seconds);
    filePosition = engine?.filePosition ?? seconds;
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    dragging = false;
    void loadFile(event.dataTransfer?.files[0]);
  }

  /**
   * One rAF loop, for the playhead only. Meters arrive already throttled to
   * 30 Hz from the audio thread and are written straight to state.
   *
   * The playhead is throttled to the same 30 Hz, and not because 30 Hz looks
   * better. Moving it resizes the clip that reveals the played part of the
   * take, which re-rasterises both 900-segment waveform paths; on a 120 Hz
   * display an unthrottled rAF paid for that four times per meter frame, for a
   * line that advances a fraction of a pixel each time. The audio thread is
   * what that raster competes with.
   */
  const PLAYHEAD_MS = 1000 / 30;
  let playheadAt = 0;
  function tick(): void {
    frame = requestAnimationFrame(tick);
    if (filePlaying && engine !== null) {
      const now = performance.now();
      if (now - playheadAt >= PLAYHEAD_MS) {
        playheadAt = now;
        filePosition = engine.filePosition;
      }
      if (!engine.filePlaying) filePlaying = false;
    }
  }

  // --------------------------------------------------------------------------

  /**
   * Two ways in, and they are not the same product.
   *
   * Someone with a guitar in their hands wants the input open and nothing in
   * the way. Someone who arrived to find out what this is wants to hear it
   * immediately, and asking them for microphone permission first is a toll gate
   * in front of a demonstration — so the demo path never calls getUserMedia at
   * all. No prompt, no device, nothing listening.
   */
  type Intent = 'play' | 'demo';

  async function start(intent: Intent = 'play'): Promise<void> {
    if (engineState === 'starting' || engineState === 'running' || detecting) return;
    engineState = 'starting';
    problem = null;
    // Milliseconds after load, long settled by the first click; awaited so a
    // very fast one cannot start the chain on defaults.
    await ready;
    engine = new Engine({ onMeters, onModel, onEngineError });
    engine.useNative(backend === 'native');
    source = intent === 'demo' ? 'file' : 'live';
    /* A fresh engine defaults to the live input, so the source has to be pushed
       into it every time — not only on the demo path. Without this, stopping
       and starting again reopened the microphone while the interface still
       showed File selected. */
    await engine.setSource(source);
    try {
      captures = (await engine.loadCatalog()).models;
      settleCapture();
      engine.setInputChannel(channel);
      await engine.setCapture(captureFile);
      engine.setCab(cab);
      // A remembered output is the player's choice and takes precedence over
      // following the input. It is set before start so the context is built
      // on it rather than moved to it.
      if (outputId !== '') await engine.useOutput(outputId);
      if (deviceId !== '') await engine.useDevice(deviceId);
      outputsProbed = false;
      await engine.start();
      nativeOpened = engine.nativeOpened;
      engine.setLoopLevel(loopLevel);
      // Under ASIO the clicks have to leave through the interface too.
      metronome.useChain(engine.clickTransport);
      // Anything moved before starting carries over — the rig is live-looking
      // from the first frame, so it has to be honest about what it shows.
      for (const p of PARAMS) {
        if (p.deprecated !== true) engine.setParam(p.id, values[p.id] ?? p.default);
      }
      latencyMs = engine.roundTripMs;
      asking = false;
      engineState = 'running';
      // Labels are withheld until permission has been granted, so the device
      // list is only meaningful from here on.
      // Only meaningful once permission has been granted, which the demo path
      // deliberately never asks for.
      if (intent === 'play' && mode === 'musician') {
        if (backend === 'browser') {
          devices = await engine.listInputs();
          outputs = await engine.listOutputs();
        }
        channelCount = engine.channelCount;
      }
      frame = requestAnimationFrame(tick);
      /* The take is loaded and drawn, and then it waits. Nothing plays until
         somebody presses play — a page that starts making noise on its own is
         the thing everyone hates about audio sites, and the point here is that
         the listener is in control of the comparison.
         What is *not* left to them is the chain: it is on, so the first press
         of play is Tonecraft, and turning it off is the deliberate act.
         A file has to be re-decoded on every start, because the buffer belongs
         to the engine and stopping threw the engine away. The waveform on
         screen outlived it, so without this, Start after Stop left a take
         drawn, a Play button that responded, and no sound.
         The player's own take is read back from IndexedDB for the same
         reason, so a restart or a reload no longer loses it. */
      engine.setLoop(fileLoop);
      const ownTake = intent === 'demo' && mode === 'musician' && fileName !== DEMO_NAME && await loadTake();
      if (ownTake) { /* nothing else to load */ }
      else if (intent === 'demo' || fileName === DEMO_NAME) await loadDemo();
      else if (source === 'file' && filePeaks !== null) {
        notice = 'Load the file again — stopping released it.';
        filePeaks = null;
        fileName = '';
      }
      // Whatever was chosen before, the chain is what you hear first.
      poweredOff = false;
      engine.setPowered(true);
    } catch (error) {
      /* Tonecraft Engine is optional, and a rig that will not start without it
         would make it required. It is a native program the player may have
         quit, uninstalled, or never had — and the last session remembered the
         choice, so this is what a normal reload looks like once it is gone.
         The browser path is complete on its own, so that is where this goes,
         once, saying why. */
      if (error instanceof EngineError && backend === 'native'
          && (error.failure.kind === 'native-unreachable' || error.failure.kind === 'native-failed')) {
        backend = 'browser';
        persist();
        engine = null;
        engineState = 'idle';
        await start(intent);
        // The selector shows what is running, not what was wished for.
        if ((engineState as State) === 'running') {
          notice = 'Tonecraft Engine is not running, so this is playing in the browser. ' +
            'Start it and choose ASIO again in the audio settings to go back.';
        }
        return;
      }
      // Cause in one sentence, fix in one sentence, no apology. Nothing is
      // blocked: the control stays available (FR-12).
      if (error instanceof EngineError) {
        const [cause, fix] = error.message.split(/(?<=\.)\s+/, 2);
        problem = { cause: cause ?? error.message, fix: fix ?? '' };
      } else {
        problem = {
          cause: 'The audio engine did not start.',
          fix: 'Reload the page and try again.',
        };
      }
      engineState = 'failed';
      // Dismissing the sheet must not hide the reason the engine did not start.
      asking = true;
    }
  }

  async function stop(): Promise<void> {
    cancelAnimationFrame(frame);
    metronome.useChain(null);
    await engine?.stop();
    engine = null;
    nativeOpened = null;
    filePlaying = false;
    filePosition = 0;
    // A loop is audio, and it lived in the chain that has just been thrown away.
    loop = NO_LOOP;
    latencyMs = null;
    captureLoaded = false;
    engineState = 'idle';
    meters = { input: 0, drive: 0, output: 0, outputRms: 0, gate: 1, channelPeaks: [0], channels: 1,
      pitchDelayMs: 0, loop: NO_LOOP };
  }

  /** Falls back to the default preset's capture, then to whatever is installed. */
  function settleCapture(): void {
    if (captures.some((c) => c.file === captureFile)) return;
    const first = PRESETS.find((p) => p.name === DEFAULT_PRESET);
    captureFile = captures.find((c) => c.file === first?.capture)?.file
      ?? captures[0]?.file ?? '';
  }

  // Component init, not an effect: restore() writes the same state the effect
  // would then be reading, which is how an effect turns into a loop. The island
  // is client:only, so IndexedDB exists by the time this runs.
  const ready = restore().catch(() => {}).finally(() => { restored = true; });
  void readCatalog().then((catalog) => {
    captures = catalog.models;
    settleCapture();
  });
  onDestroy(() => { void metronome.dispose(); });
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="page">
  <header class="bar">
    <span class="t-wordmark">tonecraft</span>

    <div class="bar-right">
      {#if latencyMs !== null}
        <!-- The round trip is on screen permanently (FR-35), as a number and
             nothing more. It used to explain itself and turn red past 35 ms;
             it does not, because most of what it named is the operating
             system's buffering and saying so on every frame is nagging, not
             informing. -->
        <span class="latency" title={latencyDetail}>{latencyMs.toFixed(1)} ms</span>
      {/if}
      {#if mode === 'musician'}
      <button class="settings-button" type="button" aria-label="Audio settings" title="Audio settings" onclick={openSettings} disabled={engineState === 'starting'}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m9.5 3-.6 2.2-1.7 1L5 5.6 2.5 9.9l1.6 1.6v2L2.5 15 5 19.3l2.2-.6 1.7 1 .6 2.3h5l.6-2.3 1.7-1 2.2.6 2.5-4.3-1.6-1.5v-2l1.6-1.6L19 5.6l-2.2.6-1.7-1L14.5 3z"/><circle cx="12" cy="12.5" r="3.5"/></svg>
      </button>
      {/if}
    </div>
  </header>

  <main class="workspace">
    <section class="global-controls" aria-label="Global controls">
      <div class="io-control"><Meter level={meters.input} /><Knob param={param('in_trim')} value={values.in_trim!} resetValue={resetValues.in_trim} onchange={v => setParam('in_trim',v)} label="Input" /></div>
      <div class="gate-control"><Knob param={param('gate_threshold')} value={values.gate_threshold!} resetValue={resetValues.gate_threshold} onchange={v => setParam('gate_threshold',v)} label="Gate" /><button class="enable" aria-label="Gate enabled" aria-pressed={values.gate_bypass !== 1} onclick={() => setParam('gate_bypass',values.gate_bypass === 1 ? 0 : 1)}>{values.gate_bypass === 1 ? 'OFF' : 'ON'}</button></div>
      <div class="rig-selectors">
        <label class="selector"><span>AMPLIFIER</span><select aria-label="Capture" value={captureFile} onchange={e => chooseCapture(e.currentTarget.value)}>{#each captures as c}<option value={c.file}>{c.file === PRESETS[0]?.capture ? 'GUILT · Lead' : c.name}</option>{/each}</select></label>
        <label class="selector"><span>CABINET</span><select aria-label="Cabinet" value={cab} onchange={e => chooseCab(e.currentTarget.value)}>{#each CABS as c}<option value={c.id}>{c.name}</option>{/each}</select></label>
      </div>
      <div class="tone-selector"><span class="eyebrow">TONE PRESET</span><div class="preset-picker"><button aria-label="Previous preset" onclick={() => nextPreset(-1)}>‹</button><select aria-label="Tone preset" value={preset ?? ''} onchange={e => { const p = PRESETS.find(p => p.name === e.currentTarget.value); if(p) void applyPreset(p); }}><option value="" disabled>Custom tone</option>{#each PRESETS as p}<option value={p.name}>{p.name}</option>{/each}</select><button aria-label="Next preset" onclick={() => nextPreset(1)}>›</button></div></div>
      <div class="io-control output-control"><Knob param={param('out_master')} value={values.out_master!} resetValue={resetValues.out_master} onchange={v => setParam('out_master',v)} label="Output" /><Meter level={meters.outputRms} /></div>
    </section>

    <section class="amp-head" class:guilt={isGuilt} class:bypassed={poweredOff} aria-label={isGuilt ? 'GUILT amplifier' : 'Tonecraft amplifier'}>
      <span class="screw tl"></span><span class="screw tr"></span><span class="screw bl"></span><span class="screw br"></span>
      <div class="glass-window">
        {#if isGuilt}<img src={`${import.meta.env.BASE_URL}images/guilt-stained-glass.webp`} alt="Purple Gothic stained glass with a central rose window" width="2172" height="724" decoding="async" /><div class="veil" style={`opacity:${veil}`}></div>{:else}<div class="neutral-art"><span>TC</span><small>AMPLIFICATION</small></div>{/if}
        <div class="amp-brand"><span class="brand-rule"></span><h1>{isGuilt ? 'GUILT' : 'TONECRAFT'}</h1><span class="brand-rule"></span><p>{isGuilt ? 'LUX EX SONO' : 'FIND YOUR FREQUENCY'}</p></div>
      </div>
      <div class="amp-panel">
        <div class="amp-signature"><span class="sig-symbol">✧</span><span>{isGuilt ? 'Guilt' : 'Tonecraft'}</span><small>{isGuilt ? 'LEAD AMPLIFIER' : 'CAPTURE SERIES'}</small></div>
        <div class="control-group tone-group"><button class="group-label" aria-label="Tone enabled" aria-pressed={values.tone_bypass !== 1} onclick={() => setParam('tone_bypass',values.tone_bypass === 1 ? 0 : 1)}>TONE <span>{values.tone_bypass === 1 ? '○' : '●'}</span></button><div class="knob-row">{#each ['tone_bass','tone_mid','tone_treble','tone_presence'] as id}<Knob param={param(id)} value={values[id]!} resetValue={resetValues[id]} onchange={v => setParam(id,v)} />{/each}</div></div>
        <div class="control-group"><button class="group-label" aria-label="Pitch enabled" aria-pressed={values.pitch_bypass !== 1} onclick={() => setParam('pitch_bypass',values.pitch_bypass === 1 ? 0 : 1)}>PITCH <span>{values.pitch_bypass === 1 ? '○' : '●'}</span></button><div class="knob-row">{#each ['pitch_shift','pitch_mix'] as id}<Knob param={param(id)} value={values[id]!} resetValue={resetValues[id]} onchange={v => setParam(id,v)} />{/each}</div></div>
        <div class="control-group"><button class="group-label" aria-label="Boost enabled" aria-pressed={values.drive_bypass !== 1} onclick={() => setParam('drive_bypass',values.drive_bypass === 1 ? 0 : 1)}>BOOST <span>{values.drive_bypass === 1 ? '○' : '●'}</span></button><div class="knob-row">{#each ['drive_gain','drive_tone'] as id}<Knob param={param(id)} value={values[id]!} resetValue={resetValues[id]} onchange={v => setParam(id,v)} />{/each}</div></div>
        <div class="control-group"><button class="group-label" aria-label="Reverb enabled" aria-pressed={values.reverb_bypass !== 1} onclick={() => setParam('reverb_bypass',values.reverb_bypass === 1 ? 0 : 1)}>REVERB <span>{values.reverb_bypass === 1 ? '○' : '●'}</span></button><div class="knob-row"><Knob param={param('reverb_mix')} value={values.reverb_mix!} resetValue={resetValues.reverb_mix} onchange={v => setParam('reverb_mix',v)} /></div></div>
        <button class="power-indicator" type="button" aria-label="Amplifier power" aria-pressed={engineState === 'running' && !poweredOff} aria-busy={engineState === 'starting'} disabled={engineState === 'starting' || detecting} onclick={power}><span class:lit={engineState === 'running' && !poweredOff}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 2v10M6 5a9 9 0 1 0 12 0"/></svg></span><small>POWER</small></button>
      </div>
    </section>
    <div class="amp-foot"><span></span><span></span></div>
    <div class="capture-info" data-capture={latencyMs === null ? 'idle' : captureLoaded ? 'loaded' : 'silent'}></div>
    {#if engineState === 'running' && !captureLoaded}<p class="alert">This capture is not running: you are hearing your dry guitar. Reload the page.</p>{/if}
    <p class="notice" role="status">{notice ?? ''}</p>
    {#if mode === 'musician'}
      <section class="session-bar" aria-label="Audio session">
        <div class="source-block"><span class="eyebrow">AUDIO SOURCE</span><Segmented label="Source" options={SOURCES} value={source} onchange={chooseSource} /></div>
        <!-- The looper. It records what leaves the rig, so a part stays as it
             was played while the capture, the preset and the boost move on
             under it. One button does record, play and overdub, as a pedal
             does, because both hands are on the guitar. -->
        <div class="looper" aria-label="Looper">
          <div class="looper-head">
            <span class="eyebrow">LOOPER</span>
            <span class="loop-status" data-state={loop.state}><span class="loop-dot"></span>{LOOP_STATUS[loop.state]}</span>
          </div>
          <div class="looper-controls">
            <button
              class="loop-main"
              type="button"
              data-state={loop.state}
              disabled={engineState !== 'running'}
              title={engineState === 'running' ? `${loopAction} (L)` : 'Start the amplifier to use the looper'}
              onclick={loopPress}
            >{loopAction}</button>
            <button class="loop-small" type="button" disabled={engineState !== 'running' || !loopHas || loop.state === 'stopped'} onclick={loopStop}>Stop</button>
            <button class="loop-small" type="button" disabled={engineState !== 'running' || !loopHas} onclick={loopClear}>Clear</button>
            <label class="loop-level">
              <span class="eyebrow">LEVEL</span>
              <input type="range" min="0" max="1" step="0.01" value={loopLevel} aria-label="Loop level" oninput={(e) => setLoopLevel(Number(e.currentTarget.value))} />
            </label>
          </div>
          <div class="loop-track" aria-hidden="true">
            <span class="loop-fill" data-state={loop.state} style={`transform:scaleX(${loop.length > 0 ? Math.min(1, loop.position / loop.length) : 0})`}></span>
          </div>
          <span class="loop-clock">{clock(loop.position)} / {loopHas ? clock(loop.length) : '0:00.0'}</span>
        </div>
      </section>
    {/if}

    <Recorder engine={engineState === 'running' ? engine : null} powered={engineState === 'running' && !poweredOff}
      tone={{ values, capture: captures.find(c => c.file === captureFile) ?? null, cab }} />
    <TabReader />
  </main>

  {#if mode === 'musician'}
    <button
      class="tuner-launch"
      type="button"
      aria-label="Open tuner"
      title="Tuner"
      aria-busy={tunerOpening}
      disabled={engineState === 'starting' || tunerOpening}
      onclick={() => void openTuner()}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        <path d="M7 3v7a5 5 0 0 0 10 0V3M7 6h3M14 6h3M12 15v6M9.5 21h5" />
      </svg>
    </button>
    <Tuner bind:element={tunerDialog} reading={tunerReading} onclose={() => void onTunerClosed()} />
  {/if}

  <button
    class="metronome-toggle"
    class:active={metronomePlaying}
    type="button"
    aria-label={metronomePlaying ? 'Pause metronome' : 'Start metronome'}
    title={metronomeBpm === null ? 'Set a tempo first' : metronomePlaying ? 'Pause metronome' : 'Start metronome'}
    aria-pressed={metronomePlaying}
    disabled={metronomeBpm === null || metronomeOpening}
    onclick={() => void toggleMetronome()}
  >
    {#if metronomePlaying}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="2.5" width="3.5" height="11" rx=".5"/><rect x="9.5" y="2.5" width="3.5" height="11" rx=".5"/></svg>
    {:else}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5 13 8l-9 5.5z"/></svg>
    {/if}
  </button>
  <button
    class="metronome-launch"
    type="button"
    aria-label="Open metronome"
    title="Metronome"
    aria-busy={metronomeOpening}
    disabled={metronomeOpening}
    onclick={() => void openMetronome()}
  >
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 20h8M9 20l2-16h2l2 16M12 7l4 5M16 12l1.5-1.5" />
    </svg>
  </button>
  <MetronomePanel
    bind:element={metronomeDialog}
    value={metronomeValue}
    active={metronomePlaying}
    volume={metronomeVolume}
    {tapCount}
    onvalue={setMetronomeValue}
    onvolume={setMetronomeVolume}
    ontap={tapTempo}
    onclose={onMetronomeClosed}
  />

  {#if mode === 'musician'}
  <dialog class="audio-settings" bind:this={settingsDialog} aria-labelledby="audio-settings-title">
    <div class="settings-heading"><h2 id="audio-settings-title">Audio settings</h2><button class="settings-button" aria-label="Close settings" onclick={() => settingsDialog?.close()}>×</button></div>
    <EngineSettings {backend} opened={nativeOpened} onbackend={chooseBackend} />
    {#if backend === 'native'}
    {#if nativeOpened !== null && channelCount > 1}<div class="device-controls"><Segmented label="Input channel" options={CHANNELS} value={channel} onchange={chooseChannel}/><div class="levels">{#each meters.channelPeaks as peak}<span class="level"><span class="level-fill" style={`transform:scaleX(${level(peak)})`}></span></span>{/each}</div></div>{/if}
    {:else}
    <button class="start small" disabled={detecting || engineState === 'starting'} onclick={detectInputs}>{detecting ? 'Detecting inputs…' : 'Detect audio inputs'}</button>
    <div aria-busy={detecting}>
    <div class="device-controls">{#if devices.length > 0}<label class="field"><span class="t-small">Input device</span><select disabled={detecting} value={deviceId} onchange={e => chooseDevice(e.currentTarget.value)}><option value="">Default input</option>{#each devices as d}<option value={d.id}>{d.label || 'Input'}</option>{/each}</select></label>{/if}{#if channelCount > 1}<Segmented label="Input channel" options={CHANNELS} value={channel} onchange={chooseChannel}/><div class="levels">{#each meters.channelPeaks as peak}<span class="level"><span class="level-fill" style={`transform:scaleX(${level(peak)})`}></span></span>{/each}</div>{/if}{#if outputs.length > 1}<label class="field"><span class="t-small">Output device</span><select value={outputId} onfocus={() => void probeOutputs()} onchange={e => chooseOutput(e.currentTarget.value)}><option value="">Same as input</option>{#each outputs as d}<option value={d.id}>{d.label || 'Output'}{d.outputMs === undefined ? '' : ` — ${d.outputMs.toFixed(0)} ms`}</option>{/each}</select></label>{/if}</div>
    </div>
    {/if}
    {#if settingsError}<p class="failure" role="alert">{settingsError}</p>{/if}
    <button class="connect" disabled={detecting || engineState === 'starting'} onclick={() => { settingsDialog?.close(); if (engineState !== 'running') void power(); }}>Done</button>
  </dialog>
  {/if}

  {#if source === 'file'}
    <!-- Below the strand, and only when it is the source. A DI take through the
         identical chain is how anyone without an interface hears this at all,
         and how two captures get compared on the same performance. -->
    <section class="file">
      {#if filePeaks === null}
        <!-- The musician's only. A tester arrived to hear the thing, not to
             supply the material for it: their take is loaded for them, so a
             drop target is a question they have no answer to. -->
        {#if mode === 'musician'}
        <div
          class="drop"
          class:over={dragging}
          role="button"
          tabindex="0"
          ondragover={(e) => { e.preventDefault(); dragging = true; }}
          ondragleave={() => (dragging = false)}
          ondrop={onDrop}
        >
          <label class="drop-label">
            <strong class="t-body">Drop an audio file here</strong>
            <span class="t-small">or choose one — a dry DI guitar take works best</span>
            <input
              type="file"
              accept="audio/*"
              onchange={(e) => loadFile(e.currentTarget.files?.[0])}
            />
          </label>
          <!-- No guitar, no interface, no file to hand: there is still
               something to listen to. -->
          <button class="quiet demo" type="button" onclick={loadDemo}>
            or use the demo take
          </button>
        </div>
        {/if}
      {:else}
        <Waveform peaks={filePeaks} duration={fileDuration} position={filePosition} onseek={seek} />
        <div class="transport">
          <button class="start small" type="button" onclick={() => (filePlaying ? pause() : play())}>
            {filePlaying ? 'Pause' : 'Play'}
          </button>
          <label class="check t-small">
            <input
              type="checkbox"
              checked={fileLoop}
              onchange={(e) => { fileLoop = e.currentTarget.checked; engine?.setLoop(fileLoop); persist(); }}
            /> Loop
          </label>
          <span class="t-small name">{fileName}</span>
          {#if mode === 'musician'}
            <label class="replace t-small">
              Replace
              <input
                type="file"
                accept="audio/*"
                onchange={(e) => loadFile(e.currentTarget.files?.[0])}
              />
            </label>
            <!-- Reachable once a file is loaded too, or the demo is a one-way
                 door: load your own take and there is no way back to it. -->
            <button class="quiet demo" type="button" onclick={loadDemo}>Load demo</button>
          {/if}
        </div>
      {/if}
    </section>
  {/if}

  <dialog class="sheet welcome" bind:this={welcomeDialog} aria-labelledby="welcome-title" oncancel={() => (asking = false)}>
        <h2 id="welcome-title">Bienvenue sur Tonecraft</h2>
        <div class="choices">
          <button
            class="choice"
            type="button"
            onclick={chooseMusician}
            disabled={engineState === 'starting'}
          >
            <span class="t-module">Musicien</span>
            <span class="t-small">Branchez votre guitare et sélectionnez votre entrée audio.</span>
          </button>
          <button
            class="choice"
            type="button"
            onclick={chooseTester}
            disabled={engineState === 'starting'}
          >
            <span class="t-module">Testeur</span>
            <span class="t-small">Explorez les sons avec une démo, sans guitare ni accès au micro.</span>
          </button>
        </div>
        <button class="quiet" type="button" onclick={() => (asking = false)}>
          Explorer d’abord
        </button>

        {#if problem !== null}
          <!-- Attached to the button that failed, rather than filed at the
               bottom of the page: it is about this action and nothing else. -->
          <p class="failure">
            <span>{problem.cause}</span>
            <span class="fix">{problem.fix}</span>
          </p>
        {/if}
  </dialog>

</div>

<style>
  .page {
    min-height: 100svh;
    display: grid;
    grid-template-rows: auto auto 1fr auto;
    gap: calc(var(--u) * 3);
    padding: calc(var(--u) * 3);
    box-sizing: border-box;
  }

  .bar {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: calc(var(--u) * 2);
  }

  .bar-right {
    display: flex;
    align-items: center;
    gap: calc(var(--u) * 2);
  }

  .latency {
    font-family: var(--mono);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    color: var(--graphite);
  }

  .tuner-launch, .metronome-launch, .metronome-toggle {
    position: fixed;
    bottom: 20px;
    z-index: 4;
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    padding: 0;
    border: 1px solid #343136;
    border-radius: 50%;
    background: #111012;
    color: #817a84;
    cursor: pointer;
  }
  .tuner-launch { left: 22px; }
  .metronome-launch { right: 22px; }
  .metronome-toggle { right: 72px; width: 38px; height: 38px; bottom: 22px; }
  .metronome-toggle.active { color: #e2cce6; border-color: #876f8c; background: #1b171d; }
  .tuner-launch:hover, .metronome-launch:hover, .metronome-toggle:hover { color: #d4c9d7; border-color: #655b68; }
  .tuner-launch:disabled, .metronome-launch:disabled, .metronome-toggle:disabled { opacity: .32; cursor: default; }
  .tuner-launch:focus-visible, .metronome-launch:focus-visible, .metronome-toggle:focus-visible { outline: 2px solid var(--iris); outline-offset: 3px; }

  /* One target, hit as often as you like. The dot carries the state — the same
     idiom as a module's bypass — and the label says what you are hearing. */
  .chain {
    display: flex;
    align-items: center;
    gap: var(--u);
    min-height: 32px;
    padding: 0 calc(var(--u) * 1.5) 0 var(--u);
    background: none;
    border: 1px solid var(--ink);
    border-radius: var(--radius);
    color: var(--ink);
    cursor: pointer;
  }
  .chain:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }

  .chain-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1px solid var(--graphite);
    background: transparent;
  }
  .chain[aria-pressed='true'] .chain-dot { background: var(--celadon); }

  .chain-label {
    display: grid;
    font-family: var(--display);
    font-size: 11px;
    letter-spacing: 0.24em;
    text-transform: uppercase;
    text-align: left;
  }
  .chain-label > * { grid-area: 1 / 1; }
  .chain-ghost { visibility: hidden; }

  .file {
    display: flex;
    flex-direction: column;
    gap: var(--u);
    max-width: var(--column);
    width: 100%;
    justify-self: center;
  }

  .drop {
    border: 1px dashed var(--graphite);
    border-radius: var(--radius);
    padding: calc(var(--u) * 3);
    display: grid;
    place-items: center;
  }
  .drop.over { border-color: var(--ink); }
  .drop-label {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }
  .drop-label input, .replace input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .replace { cursor: pointer; border-bottom: 1px solid var(--graphite); }

  .transport { display: flex; align-items: center; gap: calc(var(--u) * 2); flex-wrap: wrap; }
  .check { display: flex; align-items: center; gap: 4px; }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Audio connection choices and errors. */
  .wash {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(231, 232, 226, 0.72);
    padding: calc(var(--u) * 3);
  }

  .sheet {
    background: var(--bone);
    border-radius: var(--radius);
    box-shadow: var(--lift);
    padding: calc(var(--u) * 4);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: calc(var(--u) * 3);
    text-align: center;
    max-width: 60ch;
    animation: rise 200ms cubic-bezier(0.2, 0, 0, 1);
  }

  @keyframes rise {
    from { opacity: 0; transform: translateY(16px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet { animation: none; }
  }

  /* Two doors, side by side and the same size, because neither is the lesser
     one: half the people who arrive have a guitar and half want to know what
     this is before they fetch it. */
  .choices {
    display: flex;
    gap: calc(var(--u) * 2);
    flex-wrap: wrap;
    justify-content: center;
    align-items: stretch;
  }

  .choice {
    flex: 1 1 20ch;
    max-width: 26ch;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--u);
    text-align: left;
    padding: calc(var(--u) * 2);
    background: none;
    border: 1px solid var(--ink);
    border-radius: var(--radius);
    color: var(--ink);
    cursor: pointer;
  }
  .choice:hover { background: rgba(255, 255, 255, 0.08); }
  .choice:disabled { opacity: 0.4; cursor: default; }
  .choice:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }

  .quiet {
    font-family: var(--body);
    font-size: 13px;
    min-height: 40px;
    padding: 0 var(--u);
    background: none;
    border: 0;
    color: var(--graphite);
    cursor: pointer;
  }
  .quiet:hover { color: var(--ink); }
  .demo { border-bottom: 1px solid var(--graphite); min-height: 32px; }
  .quiet:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }

  .start {
    font-family: var(--body);
    font-size: 15px;
    min-height: 40px;
    padding: 0 calc(var(--u) * 3);
    background: none;
    border: 1px solid var(--ink);
    border-radius: var(--radius);
    color: var(--ink);
    cursor: pointer;
  }
  .start.small { font-size: 13px; padding: 0 calc(var(--u) * 2); min-height: 32px; }
  .start:disabled { opacity: 0.4; cursor: default; }
  .start:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }

  /* The one thing still said in words, and only when an action failed. It sits
     inside the sheet, under the button that failed, rather than in a permanent
     report at the foot of the page — that report named the operating system's
     buffering and the shape of a microphone input on every single frame, which
     is nagging rather than informing. */
  .failure {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    max-width: 46ch;
    font-family: var(--body);
    font-size: 15px;
    color: var(--ember);
  }
  .fix { color: var(--graphite); }

  .notice {
    margin: 0;
    max-width: 52ch;
    /* Three lines held open.
       It was two, on the claim that two was every notice there is, and that was
       simply not true: at 52ch the capture-not-running message and the decode
       failures both take three, and so does the representative notice the
       browser test writes in. The slot then did exactly what reserving it was
       meant to prevent — the rig dropped 18 px the moment anything was said. */
    min-height: 4.2em;
    overflow-y: auto;
  }

  .levels { display: flex; gap: var(--u); }
  .level {
    flex: 1;
    height: 3px;
    background: rgba(22, 24, 27, 0.10);
    overflow: hidden;
  }
  .level-fill {
    display: block;
    height: 100%;
    background: var(--celadon);
    transform-origin: left center;
    transform: scaleX(0);
  }

  .field { display: flex; flex-direction: column; gap: 2px; }
  select {
    font-family: var(--body);
    font-size: 13px;
    min-height: 40px;
    max-width: 22ch;
    background: none;
    border: 0;
    border-bottom: 1px solid var(--graphite);
    color: var(--ink);
    padding: 0;
  }
  select:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }

  .page{display:flex;flex-direction:column;gap:0;padding:0 48px 28px;max-width:1600px;margin:auto;min-height:100svh}.bar{height:94px;align-items:center}.t-wordmark{font-size:22px;text-transform:lowercase;letter-spacing:-1px;font-weight:600}.workspace{width:100%;max-width:var(--column);margin:36px auto 0}.workspace-heading,.amp-caption,.capture-info,.page-footer{display:flex;justify-content:space-between;gap:16px;font:9px var(--mono);letter-spacing:1.5px;color:#8f8f8f}.workspace-heading{margin-bottom:20px}.edition{color:#c1c1c1}.edition span{color:#6f6f6f}.global-controls{display:grid;grid-template-columns:100px 90px minmax(180px,1fr) minmax(210px,1.2fr) 110px;align-items:center;gap:24px;padding:26px 24px;background:#242424;border:1px solid #3b3b3b;border-radius:8px}.io-control{display:flex;align-items:center;gap:12px}.gate-control{position:relative}.gate-control .enable{bottom:-15px;right:calc(50% - 14px);padding:3px 8px}.enable{position:absolute;right:-2px;bottom:0;background:none;border:0;color:#b7b7b7;font:8px var(--mono);cursor:pointer}.rig-selectors{border-left:1px solid #404040;padding-left:26px;display:grid;gap:16px}.selector{display:flex;flex-direction:column;gap:3px;min-width:0}.selector>span,.eyebrow{font:9px var(--mono);letter-spacing:1.6px;color:#999999}.selector select{width:100%;max-width:100%;min-height:26px;border:0;font-size:12px}.tone-selector{padding:0 20px;border-right:1px solid #404040;text-align:center}.preset-picker{display:flex;align-items:center;gap:8px;margin:10px 0}.preset-picker select{width:100%;max-width:none;text-align:center;background:#323232;border:1px solid #4f4f4f;border-radius:4px;padding:0 8px;font-size:14px;min-height:38px}.preset-picker button{background:none;border:0;font-size:28px;color:#b4b4b4;cursor:pointer;padding:0 3px}.preset-note{font-size:10px;color:#969696}.amp-caption{margin:28px 2px 13px;font-size:8px;letter-spacing:1.4px}.amp-caption>span:first-child{display:flex;align-items:center;gap:7px}.status-dot{width:5px;height:5px;background:#717171;border-radius:50%}.status-dot.live{background:#c0c0c0}.amp-head{margin-top:28px;position:relative;padding:17px;border:1px solid #53534f;border-radius:9px;background:repeating-linear-gradient(32deg,#262626 0 1px,#2a2a2a 1px 3px);box-shadow:0 14px 30px #0005,inset 0 1px 1px #85817a55;--knob-accent:#c5c5c5;--control-label:#b4b4b4}.amp-head.guilt{--knob-material:linear-gradient(135deg,#827187,#39333d 50%,#201d24);--knob-accent:#d2badb;--control-label:#b9adbd}.glass-window{position:relative;height:260px;background:#101010;overflow:hidden;border:2px solid #0e0e10;box-shadow:0 0 0 1px #55505b}.glass-window img{width:100%;height:100%;object-fit:cover;filter:brightness(1.67)}.glass-window .veil{position:absolute;inset:0;background:#000;pointer-events:none;will-change:opacity}.glass-window:after{content:'';position:absolute;inset:0;box-shadow:inset 0 0 35px 12px #08080bd9;background:linear-gradient(0deg,#09080bb0,transparent 65%);pointer-events:none}.amp-brand{position:absolute;z-index:1;bottom:24px;left:0;right:0;text-align:center;display:flex;align-items:center;justify-content:center;gap:18px;flex-wrap:wrap;color:#e4d4e8;text-shadow:0 2px 8px #000}.amp-brand h1{font:38px Georgia,serif;letter-spacing:12px;margin:0 -12px 0 0}.brand-rule{height:1px;width:42px;background:#ad96b777}.amp-brand p{flex-basis:100%;font:7px var(--mono);letter-spacing:4px;margin:-6px 0 0}.amp-panel{display:flex;align-items:center;justify-content:space-around;gap:20px;padding:22px 20px 20px;background:linear-gradient(110deg,#313131,#232323);border:1px solid #565656;border-top:1px solid #777269}.guilt .amp-panel{background:linear-gradient(110deg,#322f34,#29262d 60%,#252329);border-color:#514852;border-top-color:#7b687e}.control-group{position:relative;border-left:1px solid #69616a55;padding-left:20px}.group-label{display:block;margin:0 auto 14px;font:8px var(--mono);letter-spacing:2px;color:#bcb2c0;background:none;border:0;cursor:pointer}.group-label span{font-size:7px;margin-left:5px;color:var(--knob-accent)}.group-label[aria-pressed=false]{opacity:.45}.knob-row{display:flex;gap:16px}.amp-signature{display:flex;flex-direction:column;align-items:center;gap:8px;min-width:110px;color:#c6b9cb}.amp-signature>span:not(.sig-symbol){font:italic 25px Georgia,serif}.sig-symbol{font-size:32px}.amp-signature small{font:6px var(--mono);letter-spacing:2px}.power-indicator{display:flex;flex-direction:column;align-items:center;gap:15px}.power-indicator>span{width:8px;height:8px;border-radius:50%;background:#5f5163;border:3px solid #252227;box-shadow:0 0 0 1px #75677b}.power-indicator>span.lit{background:#ddbae9;box-shadow:0 0 12px #c47adf}.power-indicator small{font:7px var(--mono);color:#b2aab7;letter-spacing:1px}.screw{position:absolute;width:5px;height:5px;background:linear-gradient(135deg,#777,#222 45%,#999 50%,#333 60%);border-radius:50%}.tl{top:6px;left:7px}.tr{top:6px;right:7px}.bl{bottom:6px;left:7px}.br{bottom:6px;right:7px}.amp-foot{display:flex;justify-content:space-between;margin:0 50px}.amp-foot span{width:65px;height:9px;background:#0f0f0f;border-radius:0 0 3px 3px}.capture-info{margin:0 0 24px;font-size:8px;letter-spacing:.4px}.capture-info>span:last-child{color:#7b7b7b;font-size:7px;letter-spacing:1px}.session-bar{display:flex;align-items:center;gap:24px;border:1px solid #3c3c3c;border-radius:6px;padding:19px 22px;background:#252525}.looper{flex:1;display:grid;grid-template-columns:1fr auto;grid-template-rows:auto auto auto;gap:9px 16px;align-items:center;border-left:1px solid #414141;padding-left:24px}.looper-head{grid-column:1/3;display:flex;align-items:baseline;justify-content:space-between;gap:12px}.loop-status{display:flex;align-items:center;gap:7px;font:10px var(--mono);letter-spacing:1px;color:#9c9c9c}.loop-dot{width:6px;height:6px;border-radius:50%;background:#5c5c5c}.loop-status[data-state=recording] .loop-dot,.loop-status[data-state=overdubbing] .loop-dot{background:var(--ember)}.loop-status[data-state=playing] .loop-dot{background:#d8c2dd}.looper-controls{grid-column:1/3;display:flex;align-items:center;gap:10px;flex-wrap:wrap}.loop-main{min-width:104px;padding:9px 16px;background:#323232;border:1px solid #565656;border-radius:4px;color:#ededed;font-size:13px;cursor:pointer}.loop-main:hover:not(:disabled){background:#3b3b3b;border-color:#7c7c7c}.loop-main[data-state=recording],.loop-main[data-state=overdubbing]{border-color:#8a4436;color:#f0d5cf}.loop-small{padding:8px 12px;background:none;border:1px solid #4a4a4a;border-radius:4px;color:#b7b7b7;font-size:12px;cursor:pointer}.loop-small:hover:not(:disabled){color:#ededed;border-color:#7c7c7c}.loop-main:disabled,.loop-small:disabled{opacity:.4;cursor:default}.loop-level{display:flex;align-items:center;gap:8px;margin-left:auto}.loop-level input{width:96px;min-height:40px;accent-color:#c2a9c8}.loop-track{height:2px;background:#3a3a3a;overflow:hidden}.loop-fill{display:block;height:100%;background:#6d6d6d;transform-origin:left;transform:scaleX(0)}.loop-fill[data-state=recording],.loop-fill[data-state=overdubbing]{background:var(--ember)}.loop-fill[data-state=playing]{background:#c2a9c8}.loop-clock{font:10px var(--mono);color:#9c9c9c;white-space:nowrap}.source-block{display:flex;flex-direction:column;gap:9px}.session-message{display:flex;flex:1;flex-direction:column;gap:6px;border-left:1px solid #414141;padding-left:24px}.session-message strong{font-size:13px;font-weight:500}.session-message>span{font-size:11px;color:#9c9c9c}.connect{align-self:flex-end;padding:12px 18px;background:#c5c5c5;border:1px solid #d0d0d0;border-radius:4px;font-size:12px;color:#272727;cursor:pointer}.audio-settings .start.small{align-self:flex-start}.connect:disabled{opacity:.5}.session-bar .demo{margin-left:auto;border:0;font-size:11px}.device-controls{display:flex;gap:24px;margin-top:18px;flex-wrap:wrap}.device-controls .levels{width:80px;align-items:center}.page-footer{margin-top:auto;padding:28px 0 22px;font-size:8px;letter-spacing:1px}.page-footer>span:last-child{color:#a5a5a5}.page-footer>span:last-child span{padding:0 8px;color:#636363}.file{margin:22px auto 0}.wash{background:#0f0f0fcc;z-index:10}.sheet{border:1px solid #555555;border-radius:8px}.notice{min-height:0;color:var(--ember);margin:10px 0}.alert{color:var(--ember);font-size:13px}.neutral-art{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:repeating-linear-gradient(0deg,#1b1b1b 0 2px,#2e2e2e 2px 3px);color:#848484}.neutral-art>span{font-size:80px;letter-spacing:-15px;font-weight:800;opacity:.35}.neutral-art small{font-size:8px;letter-spacing:6px}.neutral-art+.amp-brand h1{font:22px var(--body);letter-spacing:7px}.bypassed .glass-window{opacity:.5}:global(select option){background:#2c2c2c;color:#e4e4e4}:global(button:focus-visible){outline:2px solid var(--iris);outline-offset:4px}
  @media(min-width:1500px){.glass-window{height:310px}.workspace{margin-top:48px}}
  @media(max-width:1100px){.page{padding:0 24px}.global-controls{gap:14px;padding:22px 16px;grid-template-columns:85px 65px 1fr 1fr 90px}.rig-selectors{padding-left:16px}.tone-selector{padding:0 10px}.amp-panel{flex-wrap:wrap;gap:18px 10px;padding:20px 12px}.amp-signature{min-width:70px}.control-group{padding-left:12px}.knob-row{gap:5px}.tone-group{flex-basis:100%;border-left:0;padding-left:0}.tone-group .knob-row{justify-content:center;gap:14px}.power-indicator{display:flex}.session-bar{gap:15px}.session-message{padding-left:15px}}
  @media(max-width:760px){.page{padding:0 16px}.bar{height:76px}.t-wordmark{font-size:20px}.bar-right{gap:10px}.workspace{margin-top:24px}.edition{display:none}.global-controls{grid-template-columns:1fr 1fr 1fr;gap:22px}.io-control{justify-content:center}.output-control{grid-column:3;grid-row:1}.gate-control{display:flex;justify-content:center}.enable{right:5px}.rig-selectors{grid-column:1/3;grid-row:2;padding:0;border:0}.tone-selector{grid-column:3;grid-row:2;padding:0;border:0;min-width:0}.preset-picker{gap:0}.preset-picker select{font-size:12px;min-width:0}.preset-note{display:none}.glass-window{height:210px}.amp-head{padding:12px}.amp-panel{flex-wrap:wrap;padding:18px 10px;gap:22px 12px}.amp-signature{display:none}.tone-group{flex-basis:100%;border:0;padding:0}.knob-row{justify-content:space-evenly;gap:15px}.control-group{border:0;padding:0}.amp-brand h1{font-size:30px}.capture-info{line-height:1.6}.capture-info>span:last-child{display:none}.session-bar{flex-wrap:wrap;padding:16px}.looper{flex-basis:100%;border-left:0;padding-left:0;border-top:1px solid #414141;padding-top:16px}.loop-level{margin-left:0}.session-message{flex:1;min-width:130px}.session-message>span{line-height:1.6}.page-footer{font-size:6px}.amp-caption{font-size:7px;letter-spacing:.6px}.chain-label{letter-spacing:0;font-size:9px}.bar .start{font-size:11px;padding:0 10px}}
  @media(prefers-reduced-motion:reduce){.glass-window .veil{opacity:.61!important}}

  .settings-button{display:grid;place-items:center;width:40px;height:40px;padding:8px;border:0;background:none;color:var(--ink);cursor:pointer;border-radius:4px;font-size:26px}.settings-button:hover{background:#252525}.audio-settings{width:min(440px,calc(100vw - 64px));padding:calc(var(--u)*3);color:var(--ink);background:#171717;border:1px solid #444;border-radius:8px}.audio-settings[open]{display:flex;flex-direction:column;gap:calc(var(--u)*3)}.audio-settings::backdrop{background:#000a}.settings-heading{display:flex;align-items:center;justify-content:space-between}.settings-heading h2{margin:0;font-size:18px;font-weight:500}.audio-settings .device-controls{flex-direction:column;gap:calc(var(--u)*2);margin-top:0}.audio-settings select{max-width:100%;width:100%}.audio-settings .failure{margin-top:0}.power-indicator{border:0;background:none;cursor:pointer;color:#bab0bf;padding:8px;min-width:44px}.power-indicator>span{width:28px;height:28px;display:grid;place-items:center;background:#29252d}.power-indicator>span.lit{color:#fff;background:#66536f}.power-indicator:disabled{opacity:.5;cursor:wait}
  .welcome{color:var(--ink);background:#101010;border:1px solid #3b3b3b;width:min(580px,calc(100vw - 64px));box-sizing:border-box;max-height:calc(100svh - 48px);overflow:auto}.welcome:not([open]){display:none}.welcome::backdrop{background:#000b}.welcome h2{font-size:21px;font-weight:500;margin:0}.welcome .choices{width:100%}.welcome .choice{background:#191919;border-color:#404040;border-radius:5px;padding:22px;min-width:0}.welcome .choice:hover{background:#252525;border-color:#888}.welcome .choice .t-module{font-size:12px;color:#ededed}.welcome .choice .t-small{line-height:1.6}.welcome .quiet{color:#aaa}
</style>
