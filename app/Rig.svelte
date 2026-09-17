<script lang="ts">
  // Studio shell owns audio state; amplifier materials are scoped to its head.
  import { onDestroy } from 'svelte';
  import { Engine, EngineError, checkCabIR, readCatalog, type Meters, type Backend, type LoopMeters,
           type InputChannel, type InputDevice, type OutputDevice, type Source } from '../engine/engine.ts';
  import type { NativeOpened } from '../engine/native-host.ts';
  import { openInput } from '../engine/input.ts';
  import { CABS, CUSTOM_CAB, DEFAULT_CAB } from '../engine/ir.ts';
  import { detectPitch, noteFromFrequency, type PitchReading } from '../engine/tuner.ts';
  import { bpmFromFourTaps, Metronome, MIN_BPM, MAX_BPM } from '../engine/metronome.ts';
  import type { Capture } from '../engine/catalog.ts';
  import { PARAMS, STAGES, type Param } from '../schema/params.ts';
  import { PRESETS, DEFAULT_PRESET, type Preset } from './presets.ts';
  import { loadSession, saveSession } from '../store/session.ts';
  import { loadMedia, saveMedia } from '../store/media.ts';
  import Knob from './Knob.svelte';
  import Meter from './Meter.svelte';
  import Segmented from './Segmented.svelte';
  import Waveform from './Waveform.svelte';
  import Tuner from './Tuner.svelte';
  import MetronomePanel from './Metronome.svelte';
  import EngineSettings from './EngineSettings.svelte';
  import TabReader from './TabReader.svelte';
  import Recorder from './Recorder.svelte';
  import Tour, { type TourFigure, type TourStep } from './Tour.svelte';
  import { MESSAGES, detectLocale, saveLocale, type Locale } from './i18n.ts';
  import { NativeLink, detectPlatform, downloadUrl, releasesUrl } from '../engine/native-host.ts';
  import { engineUpdate } from '../engine/engine-update.ts';
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
  /** The tab reader follows the click: its bars start on the first beat, at this tempo. */
  let metronomeSync = $state(false);
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
    settingsDialog?.showModal();
    if (mode === 'musician') void detectInputs();
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

  /**
   * A score carries its tempo, so opening one sets the metronome to it, and
   * the metronome button pulses so a player who never opens it finds out.
   * Transform and opacity only.
   *
   * It never starts the click: a tab being opened is not a request for sound.
   * A click already running follows the new tempo.
   */
  let metronomeGlow = $state(0);

  function takeScoreTempo(bpm: number): void {
    if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) return;
    if (tapResetTimer !== null) clearTimeout(tapResetTimer);
    tapResetTimer = null;
    tapTimes = [];
    tapCount = 0;
    metronomeBpm = bpm;
    metronomeValue = String(bpm);
    if (metronomePlaying) metronome.play(bpm);
    persist();
    metronomeGlow++;
  }

  function toggleMetronomeSync(): void {
    metronomeSync = !metronomeSync;
    persist();
  }

  /**
   * A synced tab asks when to begin. A click already ticking in this tab is
   * followed where it is; otherwise it is (re)started, so its first beat is
   * now — including inside Tonecraft Engine, whose phase is never reported.
   */
  async function syncTabStart(): Promise<number | null> {
    if (metronomeBpm === null) return null;
    const waiting = metronomePlaying ? metronome.msToDownbeat() : null;
    if (waiting !== null) return waiting;
    try {
      await metronome.prepare(engine?.outputId ?? outputId);
    } catch {
      notice = 'The metronome could not start. Check the browser audio output.';
      return null;
    }
    metronome.setVolume(metronomeVolume);
    metronome.play(metronomeBpm);
    metronomePlaying = true;
    return metronome.msToDownbeat() ?? 0;
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

  /**
   * A tester arrived to find out what this is, with no guitar to find out by
   * playing: the page is shown to them one window at a time, each one saying
   * what it does. The musician is not walked through anything — their guitar
   * is in their hands, and settings come first.
   */
  const TOUR_LAYOUT: readonly { targets: readonly string[]; figure?: TourFigure }[] = [
    { targets: ['.global-controls'] },
    { targets: ['.amp-head'] },
    { targets: ['.demo-panel'] },
    { targets: ['.reader'], figure: 'tracks' },
    // The whole reader, not the button alone: the step waits for a note, and
    // the note written has to be seen on the tab and the neck, not in the dark.
    { targets: ['.reader'], figure: 'compose' },
    { targets: ['.metronome-launch', '.metronome-toggle'] },
    { targets: [] },
  ];
  /**
   * What each term of the tutorial names on the page, for the ring drawn while
   * it is hovered. The controls a tester has not opened yet — a tab's tracks,
   * the editor — are named in the card's own drawing as well.
   */
  const TOUR_TERMS: Readonly<Record<string, string>> = {
    input: '.global-controls > .io-control:first-child',
    gate: '.gate-control',
    amp: '.rig-selectors .selector:first-child',
    cab: '.rig-selectors .selector:nth-child(2)',
    preset: '.tone-selector',
    output: '.output-control',
    tone: '.amp-panel > .tone-group',
    pitch: '.amp-panel > .control-group:nth-child(3)',
    boost: '.amp-panel > .control-group:nth-child(4)',
    reverb: '.amp-panel > .control-group:nth-child(5)',
    blocks: '.amp-panel .group-label',
    power: '.power-indicator',
    demo: '.demo-launch, .demo-panel .file',
    wave: '.demo-panel .wave',
    loop: '.demo-panel .check',
    import: '.reader-heading .primary',
    solo: '.track-tools button:first-child, .tour-figure [data-term="solo"]',
    mute: '.track-tools button:nth-child(2), .tour-figure [data-term="mute"]',
    volume: '.tracks .track-volume, .tour-figure [data-term="volume"]',
    neck: '.reader .neck',
    scale: '.scale-bar',
    write: '.write-tab',
    tempo: '.editor-bar .tempo, .tour-figure [data-term="tempo"]',
    signature: '.editor-bar [aria-label="Time signature"], .tour-figure [data-term="signature"]',
    tuning: '.editor-bar [aria-label="Tuning"], .tour-figure [data-term="tuning"]',
    digits: '.tour-figure [data-term="digits"]',
    arrows: '.tour-figure [data-term="arrows"]',
    metronome: '.metronome-launch',
    metronomePlay: '.metronome-toggle',
    tutorial: '.tour-button',
  };
  let touring = $state(false);
  /** The composing step's task: a note written during this tutorial, not one left in a draft. */
  let wroteNote = $state(false);
  $effect(() => { if (!touring) wroteNote = false; });

  let locale = $state<Locale>(detectLocale());
  const text = $derived(MESSAGES[locale]);
  const testerTour = $derived<readonly TourStep[]>(text.tour.steps.map((step, i) => ({ ...step, ...TOUR_LAYOUT[i]!, done: wroteNote })));
  $effect(() => { document.documentElement.lang = locale; });
  const LANGUAGES = [{ value: 'en', label: 'English' }, { value: 'fr', label: 'Français' }] as const;
  function chooseLocale(next: Locale): void {
    locale = next;
    saveLocale(next);
  }

  async function chooseTester(): Promise<void> {
    mode = 'tester';
    asking = false;
    welcomeDialog?.close();
    touring = true;
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
    else await start(mode === 'tester' ? 'demo' : 'play');
  }

  type State = 'idle' | 'starting' | 'running' | 'failed';

  const param = (id: string): Param => PARAMS.find((p) => p.id === id)!;
  const DEFAULT_VALUES = Object.fromEntries(PARAMS.map((p) => [p.id, p.default]));

  async function openDemo(): Promise<void> {
    demoOpen = true;
    if (engineState !== 'running') await start('demo');
    else if (filePeaks === null) await loadDemo();
  }

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
  /** The cabinet IR the player loaded; one at a time, kept on their machine. */
  let customCab = $state<File | null>(null);
  let cabRevision = $state(0);
  let cabFileInput = $state<HTMLInputElement>();
  const CAB_IR_MEDIA = 'cabinet-ir';
  /** A select value that is an action, not a cabinet. */
  const LOAD_CAB = 'load-ir';
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
  /**
   * An engine older than the newest release, once the rig runs on it. It does
   * not update itself, so the page offers the download, explicitly.
   */
  let engineLatest = $state<{ current: string; latest: string } | null>(null);
  const enginePlatform = detectPlatform();
  const engineDownload = enginePlatform === 'windows' || enginePlatform === 'macos' || enginePlatform === 'linux'
    ? downloadUrl(enginePlatform) : releasesUrl;
  async function checkEngineUpdate(): Promise<void> {
    const current = NativeLink.shared.info?.version;
    if (current === undefined) return;
    const latest = await engineUpdate(current);
    engineLatest = latest === null ? null : { current, latest };
  }
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
  /** Kept in the session's shape; a musician's DI lives in the recorder now. */
  let takeId: string | null = null;
  /** The tester's demo player, behind its button until asked for. */
  let demoOpen = $state(false);

  let engine = $state.raw<Engine | null>(null);
  let frame = 0;

  const capture = $derived(captures.find((c) => c.file === captureFile) ?? null);
  const cabInfo = $derived(CABS.find((c) => c.id === cab) ?? CABS[0]!);
  const level = (v: number): number => Math.min(1, Math.sqrt(Math.max(0, v)) * 1.6);
  const isGuilt = $derived(captureFile === PRESETS[0]?.capture);
  const ampIlluminated = $derived(engineState === 'running' && !poweredOff);
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
      source, takeId, fileLoop, metronomeBpm, metronomeVolume, metronomeSync, loopLevel,
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
    customCab = await loadMedia(CAB_IR_MEDIA);
    if (cab === CUSTOM_CAB && customCab === null) cab = DEFAULT_CAB;
    if (saved.cabTouched !== undefined) cabTouched = saved.cabTouched;
    if (saved.deviceId !== undefined) deviceId = saved.deviceId;
    if (saved.outputId !== undefined) outputId = saved.outputId;
    if (saved.channel !== undefined) channel = saved.channel;
    if (saved.backend !== undefined) backend = saved.backend;
    if (saved.source !== undefined) source = saved.source;
    if (saved.takeId !== undefined) takeId = saved.takeId;
    if (saved.fileLoop !== undefined) fileLoop = saved.fileLoop;
    if (saved.metronomeVolume !== undefined) metronomeVolume = saved.metronomeVolume;
    if (saved.metronomeSync !== undefined) metronomeSync = saved.metronomeSync;
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

  async function loadCabFile(file: File): Promise<void> {
    const ok = engine !== null ? await engine.loadCab(file) : await checkCabIR(file);
    if (!ok) {
      notice = `${file.name} could not be read as an impulse response. A WAV file of the cabinet works.`;
      return;
    }
    notice = null;
    customCab = file;
    cabRevision++;
    cab = CUSTOM_CAB;
    cabTouched = true;
    preset = null;
    void saveMedia(file, 'ir', CAB_IR_MEDIA);
    persist();
  }

  function chooseCab(id: string): void {
    if (id === LOAD_CAB) { cabFileInput?.click(); return; }
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
  // press means, and this only says what that will be. Rec, then Stop — which
  // closes the loop and plays it at once — then Overdub and Stop again. The
  // power button beside it switches the looper off, and the loop with it.

  /** What pressing the button will do next, which is what it is labelled. */
  const LOOP_ACTION = {
    empty: 'Rec', recording: 'Stop', playing: 'Overdub', overdubbing: 'Stop', stopped: 'Play',
  } as const;
  const LOOP_STATUS = {
    empty: 'Empty', recording: 'Recording', playing: 'Playing', overdubbing: 'Overdubbing', stopped: 'Stopped',
  } as const;
  const LOOP_KEY = 'l';

  const loopAction = $derived(LOOP_ACTION[loop.state]);
  const loopOn = $derived(loop.state !== 'empty');

  function loopPress(): void {
    if (engineState !== 'running') return;
    engine?.loopPress();
  }

  /** Off is empty: the chain fades the loop out before it lets it go. */
  function loopPower(): void { engine?.loopClear(); }

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
    const intent: Intent = mode === 'tester' ? 'demo' : 'play';
    await stop();
    await start(intent);
  }

  async function chooseSource(next: string): Promise<void> {
    source = next as Source;
    persist();
    await engine?.setSource(source);
    if (source === 'live') { engine?.stopFile(); filePlaying = false; }
    else if (filePeaks === null) await loadDemo();
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
    // Only the state is shown: a position ticking at 30 Hz would redraw nothing.
    if (m.loop.state !== loop.state) {
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
      if (customCab !== null) await engine.loadCab(customCab);
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
      if (backend === 'native') void checkEngineUpdate();
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
      if (intent === 'demo' || fileName === DEMO_NAME) await loadDemo();
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
      {#if mode === 'tester'}
      <button class="tour-button" type="button" onclick={() => (touring = true)} disabled={touring}>{text.tour.open}</button>
      {/if}
      <button class="settings-button" type="button" aria-label={text.settings} title={text.settings} onclick={openSettings} disabled={engineState === 'starting'}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m9.5 3-.6 2.2-1.7 1L5 5.6 2.5 9.9l1.6 1.6v2L2.5 15 5 19.3l2.2-.6 1.7 1 .6 2.3h5l.6-2.3 1.7-1 2.2.6 2.5-4.3-1.6-1.5v-2l1.6-1.6L19 5.6l-2.2.6-1.7-1L14.5 3z"/><circle cx="12" cy="12.5" r="3.5"/></svg>
      </button>
    </div>
  </header>

  <main class="workspace">
    <section class="global-controls" aria-label="Global controls">
      <div class="io-control"><Meter level={meters.input} kind="peak" label="In" /><Knob param={param('in_trim')} value={values.in_trim!} resetValue={resetValues.in_trim} onchange={v => setParam('in_trim',v)} label="Input" /></div>
      <div class="gate-control"><Knob param={param('gate_threshold')} value={values.gate_threshold!} resetValue={resetValues.gate_threshold} onchange={v => setParam('gate_threshold',v)} label="Gate" /><button class="enable" aria-label="Gate enabled" title={values.gate_bypass === 1 ? 'Gate off' : 'Gate on'} aria-pressed={values.gate_bypass !== 1} onclick={() => setParam('gate_bypass',values.gate_bypass === 1 ? 0 : 1)}><span></span></button></div>
      <div class="rig-selectors">
        <label class="selector"><span>AMPLIFIER</span><select aria-label="Capture" value={captureFile} onchange={e => chooseCapture(e.currentTarget.value)}>{#each captures as c}<option value={c.file}>{c.file === PRESETS[0]?.capture ? 'GUILT · Lead' : c.name}</option>{/each}</select></label>
        <label class="selector"><span>CABINET</span><select aria-label="Cabinet" value={cab} onchange={e => { const id = e.currentTarget.value; e.currentTarget.value = cab; chooseCab(id); }}>{#each CABS as c}<option value={c.id}>{c.name}</option>{/each}{#if customCab !== null}<option value={CUSTOM_CAB}>IR · {customCab.name.replace(/\.[^.]+$/, '')}</option>{/if}<option value={LOAD_CAB}>Load an IR…</option></select></label>
        <input bind:this={cabFileInput} aria-label="Cabinet IR file" type="file" accept=".wav,.aif,.aiff,.flac,audio/*" hidden onchange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void loadCabFile(f); }} />
      </div>
      <div class="tone-selector"><span class="eyebrow">TONE PRESET</span><div class="preset-picker"><button aria-label="Previous preset" onclick={() => nextPreset(-1)}>‹</button><select aria-label="Tone preset" value={preset ?? ''} onchange={e => { const p = PRESETS.find(p => p.name === e.currentTarget.value); if(p) void applyPreset(p); }}><option value="" disabled>Custom tone</option>{#each PRESETS as p}<option value={p.name}>{p.name}</option>{/each}</select><button aria-label="Next preset" onclick={() => nextPreset(1)}>›</button></div></div>
      <div class="io-control output-control"><Knob param={param('out_master')} value={values.out_master!} resetValue={resetValues.out_master} onchange={v => setParam('out_master',v)} label="Output" /><Meter level={meters.outputRms} label="Out" /></div>
    </section>

    <section class="amp-head" class:guilt={isGuilt} class:illuminated={isGuilt && ampIlluminated} class:bypassed={poweredOff} aria-label={isGuilt ? 'GUILT amplifier' : 'Tonecraft amplifier'}>
      {#if isGuilt}
        <div class="guilt-handle" aria-hidden="true"><span></span></div>
        <div class="guilt-corners" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <!-- Static image filters; only the glow layer's opacity follows the meters. -->
        <svg class="glass-filters" width="0" height="0" aria-hidden="true" focusable="false">
          <defs>
            <filter id="guilt-glass-relief" color-interpolation-filters="sRGB">
              <feColorMatrix type="saturate" values="0" />
              <feGaussianBlur stdDeviation="0.45" />
              <feConvolveMatrix order="3" kernelMatrix="-1 -1 0 -1 0 1 0 1 1" divisor="2" bias="0.5" preserveAlpha="true" result="bevel" />
              <feBlend in="bevel" in2="SourceGraphic" mode="soft-light" />
            </filter>
            <filter id="guilt-glass-bloom" x="-5%" y="-10%" width="110%" height="120%" color-interpolation-filters="sRGB">
              <feComponentTransfer>
                <feFuncR type="linear" slope="2.4" intercept="-0.35" />
                <feFuncG type="linear" slope="2.4" intercept="-0.35" />
                <feFuncB type="linear" slope="2.4" intercept="-0.35" />
              </feComponentTransfer>
              <feGaussianBlur stdDeviation="3" result="nearGlow" />
              <feGaussianBlur stdDeviation="8" />
              <feBlend in2="nearGlow" mode="screen" />
            </filter>
          </defs>
        </svg>
      {/if}
      <span class="screw tl"></span><span class="screw tr"></span><span class="screw bl"></span><span class="screw br"></span>
      <div class="glass-window">
        {#if isGuilt}<img src={`${import.meta.env.BASE_URL}images/guilt-stained-glass.webp`} alt="Purple Gothic stained glass with a central rose window" width="2172" height="724" decoding="async" /><div class="veil" style={`opacity:${veil}`}></div>{:else}<div class="neutral-art"><span>TC</span><small>AMPLIFICATION</small></div>{/if}
        {#if isGuilt}
          <div class="glass-bloom-power" aria-hidden="true">
            <div class="glass-glow" style={`opacity:${0.28 + light * 0.44}`}>
              <img src={`${import.meta.env.BASE_URL}images/guilt-stained-glass.webp`} alt="" width="2172" height="724" decoding="async" />
            </div>
          </div>
        {/if}
        {#if isGuilt}
          <div class="glass-reflections" aria-hidden="true"></div>
          <div class="glass-night" aria-hidden="true"></div>
        {/if}
        <div class="amp-brand"><span class="brand-rule"></span><h1>{isGuilt ? 'GUILT' : 'TONECRAFT'}</h1><span class="brand-rule"></span><p>{isGuilt ? 'LUX EX SONO' : 'FIND YOUR FREQUENCY'}</p></div>
      </div>
      <div class="amp-panel">
        <div class="amp-signature"><svg class="sig-symbol" width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><circle cx="15" cy="15" r="13.5"/><path d="M15 3.8a5.6 5.6 0 0 1 0 11.2 5.6 5.6 0 0 1 0-11.2ZM15 15a5.6 5.6 0 0 1 0 11.2A5.6 5.6 0 0 1 15 15ZM3.8 15a5.6 5.6 0 0 1 11.2 0 5.6 5.6 0 0 1-11.2 0ZM15 15a5.6 5.6 0 0 1 11.2 0A5.6 5.6 0 0 1 15 15Z"/><circle cx="15" cy="15" r="2"/></svg><span>{isGuilt ? 'Guilt' : 'Tonecraft'}</span><small>{isGuilt ? 'LEAD AMPLIFIER' : 'CAPTURE SERIES'}</small></div>
        <div class="control-group tone-group"><button class="group-label" aria-label="Tone enabled" aria-pressed={values.tone_bypass !== 1} onclick={() => setParam('tone_bypass',values.tone_bypass === 1 ? 0 : 1)}>TONE <span>{values.tone_bypass === 1 ? '○' : '●'}</span></button><div class="knob-row">{#each ['tone_bass','tone_mid','tone_treble','tone_presence'] as id}<Knob param={param(id)} value={values[id]!} powered={isGuilt ? ampIlluminated : undefined} resetValue={resetValues[id]} onchange={v => setParam(id,v)} />{/each}</div></div>
        <div class="control-group"><button class="group-label" aria-label="Pitch enabled" aria-pressed={values.pitch_bypass !== 1} onclick={() => setParam('pitch_bypass',values.pitch_bypass === 1 ? 0 : 1)}>PITCH <span>{values.pitch_bypass === 1 ? '○' : '●'}</span></button><div class="knob-row">{#each ['pitch_shift','pitch_mix'] as id}<Knob param={param(id)} value={values[id]!} powered={isGuilt ? ampIlluminated : undefined} resetValue={resetValues[id]} onchange={v => setParam(id,v)} />{/each}</div></div>
        <div class="control-group"><button class="group-label" aria-label="Boost enabled" aria-pressed={values.drive_bypass !== 1} onclick={() => setParam('drive_bypass',values.drive_bypass === 1 ? 0 : 1)}>BOOST <span>{values.drive_bypass === 1 ? '○' : '●'}</span></button><div class="knob-row">{#each ['drive_gain','drive_tone'] as id}<Knob param={param(id)} label={id === 'drive_gain' ? 'Gain' : 'Color'} value={values[id]!} powered={isGuilt ? ampIlluminated : undefined} resetValue={resetValues[id]} onchange={v => setParam(id,v)} />{/each}</div></div>
        <div class="control-group"><button class="group-label" aria-label="Reverb enabled" aria-pressed={values.reverb_bypass !== 1} onclick={() => setParam('reverb_bypass',values.reverb_bypass === 1 ? 0 : 1)}>REVERB <span>{values.reverb_bypass === 1 ? '○' : '●'}</span></button><div class="knob-row"><Knob param={param('reverb_mix')} value={values.reverb_mix!} powered={isGuilt ? ampIlluminated : undefined} resetValue={resetValues.reverb_mix} onchange={v => setParam('reverb_mix',v)} /></div></div>
        <button class="power-indicator" type="button" aria-label="Amplifier power" aria-pressed={ampIlluminated} aria-busy={engineState === 'starting'} disabled={engineState === 'starting' || detecting} onclick={power}>
          {#if isGuilt}
            <span class="power-rocker" class:lit={ampIlluminated} aria-hidden="true">
              <span class="rocker-face"><span class="rocker-on">I</span><span class="rocker-lamp"></span><span class="rocker-off">O</span></span>
            </span>
          {:else}
            <span class:lit={ampIlluminated}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 2v10M6 5a9 9 0 1 0 12 0"/></svg></span>
          {/if}
          <small>POWER</small>
        </button>
      </div>
    </section>
    <div class="amp-foot"><span></span><span></span></div>
    <div class="capture-info" data-capture={latencyMs === null ? 'idle' : captureLoaded ? 'loaded' : 'silent'}></div>
    {#if engineState === 'running' && !captureLoaded}<p class="alert">This capture is not running: you are hearing your dry guitar. Reload the page.</p>{/if}
    <p class="notice" role="status">{notice ?? ''}</p>
    {#if engineLatest !== null && backend === 'native'}
      <div class="engine-update" role="status">
        <span>Tonecraft Engine {engineLatest.latest} is available — this computer runs {engineLatest.current}. Quit it from its icon, then open the new one.</span>
        <a class="update-button" href={engineDownload} rel="noopener">Update Tonecraft Engine</a>
      </div>
    {/if}
    <div class="rack">
    {#if mode === 'tester'}
      <section class="demo-panel" aria-label="Demo">
        {#if !demoOpen}
          <button class="demo-launch" type="button" disabled={engineState === 'starting'} onclick={() => void openDemo()}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 16 0v3" /><rect x="3" y="14" width="4" height="7" rx="1.5" /><rect x="17" y="14" width="4" height="7" rx="1.5" /></svg>
            <span>Listen to a demo</span>
            <span class="demo-play" aria-hidden="true">▶</span>
          </button>
        {:else if filePeaks !== null}
          <div class="file">
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
            </div>
          </div>
        {/if}
      </section>
    {/if}
    {#if mode === 'musician'}
      <section class="session-bar" aria-label="Audio session">
        <!-- The looper. It records what leaves the rig, so a part stays as it
             was played while the capture, the preset and the boost move on
             under it. One button does rec, stop and overdub, as a pedal does,
             because both hands are on the guitar; the other one is power. -->
        <div class="looper" aria-label="Looper">
          <span class="eyebrow">LOOPER</span>
          <span class="loop-status" data-state={loop.state}><span class="loop-dot"></span>{LOOP_STATUS[loop.state]}</span>
          <button
            class="loop-main"
            type="button"
            data-state={loop.state}
            disabled={engineState !== 'running'}
            title={engineState === 'running' ? `${loopAction} (L)` : 'Start the amplifier to use the looper'}
            onclick={loopPress}
          >{loopAction}</button>
          <button
            class="loop-power"
            type="button"
            aria-label="Looper off"
            title="Looper off: erases the loop"
            aria-pressed={loopOn}
            disabled={engineState !== 'running' || !loopOn}
            onclick={loopPower}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 1.8v5.6M4.4 4a5 5 0 1 0 7.2 0" /></svg>
          </button>
          <label class="loop-level">
            <span class="eyebrow">LEVEL</span>
            <input type="range" min="0" max="1" step="0.01" value={loopLevel} aria-label="Loop level" oninput={(e) => setLoopLevel(Number(e.currentTarget.value))} />
          </label>
        </div>
      </section>
    {/if}

    {#if mode === 'musician'}
      <Recorder engine={engineState === 'running' ? engine : null} sinkId={engine?.outputId ?? outputId}
        tone={{ values, capture: captures.find(c => c.file === captureFile) ?? null, cab, cabRevision }} />
    {/if}
    <TabReader ontempo={takeScoreTempo} syncBpm={metronomeSync ? metronomeBpm : null} onsyncstart={syncTabStart} onwrite={() => { if (touring) wroteNote = true; }} />
    </div>
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
    title={metronomeBpm === null ? 'Metronome' : `Metronome · ${metronomeBpm} BPM`}
    aria-busy={metronomeOpening}
    disabled={metronomeOpening}
    onclick={() => void openMetronome()}
  >
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 20h8M9 20l2-16h2l2 16M12 7l4 5M16 12l1.5-1.5" />
    </svg>
    {#key metronomeGlow}{#if metronomeGlow > 0}<span class="metronome-glow" aria-hidden="true"></span>{/if}{/key}
  </button>
  <MetronomePanel
    bind:element={metronomeDialog}
    value={metronomeValue}
    active={metronomePlaying}
    volume={metronomeVolume}
    {tapCount}
    sync={metronomeSync}
    onsync={toggleMetronomeSync}
    onvalue={setMetronomeValue}
    onvolume={setMetronomeVolume}
    ontap={tapTempo}
    onclose={onMetronomeClosed}
  />

  <!-- One settings sheet. The language is detected, so it is changed here and
       nowhere on the rig; a tester has nothing else to set. -->
  <dialog class="tc-dialog settings" bind:this={settingsDialog} aria-labelledby="settings-title">
    <button class="tc-close" type="button" aria-label="Close settings" onclick={() => settingsDialog?.close()}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" /></svg></button>
    <h2 class="tc-dialog-title" id="settings-title">{text.settings}</h2>
    <section class="settings-section" aria-labelledby="settings-language">
      <h3 class="eyebrow" id="settings-language">{text.language}</h3>
      <Segmented label={text.language} options={LANGUAGES} value={locale} onchange={v => chooseLocale(v as Locale)} />
    </section>
    {#if mode === 'musician'}
    <section class="settings-section audio-settings" aria-labelledby="settings-audio">
    <h3 class="eyebrow" id="settings-audio">Audio</h3>
    <EngineSettings {backend} opened={nativeOpened} onbackend={chooseBackend} />
    {#if backend === 'native'}
    {#if nativeOpened !== null && channelCount > 1}<div class="device-controls"><Segmented label="Input channel" options={CHANNELS} value={channel} onchange={chooseChannel}/><div class="levels">{#each meters.channelPeaks as peak}<span class="level"><span class="level-fill" style={`transform:scaleX(${level(peak)})`}></span></span>{/each}</div></div>{/if}
    {:else}
    <button class="secondary detect" disabled={detecting || engineState === 'starting'} onclick={detectInputs}>{detecting ? 'Detecting inputs…' : 'Detect audio inputs'}</button>
    <div aria-busy={detecting}>
    <div class="device-controls">{#if devices.length > 0}<label class="field"><span class="t-small">Input device</span><select disabled={detecting} value={deviceId} onchange={e => chooseDevice(e.currentTarget.value)}><option value="">Default input</option>{#each devices as d}<option value={d.id}>{d.label || 'Input'}</option>{/each}</select></label>{/if}{#if channelCount > 1}<Segmented label="Input channel" options={CHANNELS} value={channel} onchange={chooseChannel}/><div class="levels">{#each meters.channelPeaks as peak}<span class="level"><span class="level-fill" style={`transform:scaleX(${level(peak)})`}></span></span>{/each}</div>{/if}{#if outputs.length > 1}<label class="field"><span class="t-small">Output device</span><select value={outputId} onfocus={() => void probeOutputs()} onchange={e => chooseOutput(e.currentTarget.value)}><option value="">Same as input</option>{#each outputs as d}<option value={d.id}>{d.label || 'Output'}{d.outputMs === undefined ? '' : ` — ${d.outputMs.toFixed(0)} ms`}</option>{/each}</select></label>{/if}</div>
    </div>
    {/if}
    {#if settingsError}<p class="failure" role="alert">{settingsError}</p>{/if}
    </section>
    {/if}
    <button class="connect" disabled={detecting || engineState === 'starting'} onclick={() => { settingsDialog?.close(); if (mode === 'musician' && engineState !== 'running') void power(); }}>Done</button>
  </dialog>

  <dialog class="tc-dialog welcome" bind:this={welcomeDialog} aria-labelledby="welcome-title" oncancel={() => (asking = false)}>
    <!-- The glass the amp is lit with: the first screen already wears it. -->
    <div class="welcome-glass" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}images/guilt-stained-glass.webp`} alt="" width="2172" height="724" decoding="async" /></div>
    <div class="welcome-body">
      <!-- Focus lands on the title, not on the first card: a ring on a choice
           nobody has made yet reads as a choice already made. -->
      <!-- svelte-ignore a11y_autofocus -->
      <h2 id="welcome-title" tabindex="-1" autofocus>{text.welcome.title}</h2>
      <p class="welcome-lede">{text.welcome.lede}</p>
      <div class="choices">
        <button class="choice" type="button" onclick={chooseMusician} disabled={engineState === 'starting'}>
          <svg class="choice-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5v5M14.5 2.5v5M7 7.5h10v3.5a5 5 0 0 1-10 0zM12 16v2.5a3 3 0 0 0 3 3h2" /></svg>
          <span class="choice-title">{text.welcome.musician}</span>
          <span class="choice-body">{text.welcome.musicianBody}</span>
          <span class="choice-go" aria-hidden="true">{text.welcome.musicianAction} <span>→</span></span>
        </button>
        <button class="choice" type="button" onclick={chooseTester} disabled={engineState === 'starting'}>
          <svg class="choice-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 16 0v3" /><rect x="3" y="14" width="4" height="7" rx="1.5" /><rect x="17" y="14" width="4" height="7" rx="1.5" /></svg>
          <span class="choice-title">{text.welcome.tester}</span>
          <span class="choice-body">{text.welcome.testerBody}</span>
          <span class="choice-go" aria-hidden="true">{text.welcome.testerAction} <span>→</span></span>
        </button>
      </div>

      {#if problem !== null}
        <!-- Attached to the button that failed, rather than filed at the
             bottom of the page: it is about this action and nothing else. -->
        <p class="failure">
          <span>{problem.cause}</span>
          <span class="fix">{problem.fix}</span>
        </p>
      {/if}
    </div>
    <!-- Closing is exploring: the tester card already offers the sound without a guitar. -->
    <button class="tc-close" type="button" aria-label={text.welcome.explore} title={text.welcome.explore} onclick={() => (asking = false)}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" /></svg></button>
  </dialog>

  {#if touring}<Tour steps={testerTour} terms={TOUR_TERMS} labels={text.tour} onclose={() => (touring = false)} />{/if}
</div>

<style>
  /* The page is the material: the amp does not sit on a web page, the dark
     around it is the room it stands in, to the edge of the screen. */
  :global(html), :global(body) { background: var(--surface-0); }
  :global(body) {
    background:
      radial-gradient(ellipse 70% 45% at 50% 28%, #1d1723 0%, transparent 70%),
      radial-gradient(ellipse 90% 60% at 50% 100%, #110e14 0%, transparent 70%),
      var(--surface-0);
    color: var(--text);
    font-family: var(--body);
  }
  :global(select option) { background: var(--surface-2); color: var(--text); }
  :global(button:focus-visible) { outline: 2px solid var(--iris); outline-offset: 4px; }
  :global(input[type='range']) { accent-color: var(--violet-300); }

  .page {
    display: flex;
    flex-direction: column;
    max-width: 1600px;
    min-height: 100svh;
    margin: auto;
    /* Room under the column: the tuner and metronome launchers are fixed to the
       foot of the screen and would otherwise sit on the last row, and the tour
       needs the page to scroll far enough to put a window at the top. */
    padding: 0 48px 96px;
    box-sizing: border-box;
  }

  .bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; height: 88px; }
  .t-wordmark { font-size: 14px; font-weight: 400; font-stretch: 125%; letter-spacing: 0.36em; color: var(--text); }
  .bar-right { display: flex; align-items: center; gap: 16px; }
  .latency { font: 12px var(--mono); font-variant-numeric: tabular-nums; color: var(--text-3); }

  /* The one eyebrow. Every module name and control label in the studio. */
  .eyebrow, .selector > span {
    font: 400 10px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-2);
  }

  /* Buttons, three weights: primary (one per module), secondary, quiet. */
  .secondary, .start, .loop-main {
    min-height: 36px;
    padding: 0 16px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    font: 13px var(--body);
    cursor: pointer;
  }
  .secondary:hover:not(:disabled), .start:hover:not(:disabled), .loop-main:hover:not(:disabled) { border-color: var(--violet-500); background: #29252f; }
  .connect, .update-button, .tour-button {
    min-height: 38px;
    padding: 0 20px;
    border: 1px solid var(--violet-500);
    border-radius: var(--radius);
    background: var(--action);
    color: var(--action-text);
    font: 500 13px var(--body);
    text-decoration: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
  }
  .connect:hover:not(:disabled), .update-button:hover, .tour-button:hover:not(:disabled) { background: var(--action-hover); }
  .secondary:disabled, .start:disabled, .loop-main:disabled, .connect:disabled, .tour-button:disabled { opacity: .45; cursor: default; }

  select {
    min-height: 34px;
    max-width: 100%;
    padding: 0 30px 0 10px;
    appearance: none;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface-2) var(--chevron) no-repeat right 11px center;
    color: var(--text);
    font: 13px var(--body);
    cursor: pointer;
  }
  select:hover:not(:disabled) { border-color: var(--line-strong); }
  select:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }

  /* Floating launchers: tuner on the left, metronome on the right. */
  .tuner-launch, .metronome-launch, .metronome-toggle {
    position: fixed;
    bottom: 20px;
    z-index: 4;
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    padding: 0;
    border: 1px solid var(--violet-800);
    border-radius: 50%;
    background: var(--surface-1);
    color: var(--text-2);
    box-shadow: var(--shadow);
    cursor: pointer;
  }
  .tuner-launch { left: 22px; }
  .metronome-launch { right: 22px; }
  .metronome-toggle { right: 72px; width: 38px; height: 38px; bottom: 22px; }
  .metronome-toggle.active { color: var(--violet-100); border-color: var(--accent-line); background: var(--violet-900); }
  .tuner-launch:hover, .metronome-launch:hover, .metronome-toggle:hover { color: var(--text); border-color: var(--violet-600); }
  .tuner-launch:disabled, .metronome-launch:disabled, .metronome-toggle:disabled { opacity: .32; cursor: default; }
  .tuner-launch:focus-visible, .metronome-launch:focus-visible, .metronome-toggle:focus-visible { outline: 2px solid var(--iris); outline-offset: 3px; }
  /* A lit disc that pulses three times, and rings that leave it: opacity and
     scale only, never an animated box-shadow. Above the focused reader
     (z-index 50), which is where a tab is often opened. */
  .metronome-launch:has(.metronome-glow) { z-index: 60; }
  .metronome-glow {
    position: absolute;
    inset: -1px;
    border-radius: 50%;
    background: #d9bfdd66;
    pointer-events: none;
    opacity: 0;
    animation: metronome-lit 3.6s ease-out forwards;
  }
  .metronome-glow::before, .metronome-glow::after {
    content: '';
    position: absolute;
    inset: -1px;
    border: 2px solid var(--violet-100);
    border-radius: 50%;
    opacity: 0;
    animation: metronome-ring 1.2s cubic-bezier(.2, 0, 0, 1) 3;
  }
  .metronome-glow::after { animation-delay: .4s; }
  @keyframes metronome-lit {
    0% { opacity: 0; }
    8% { opacity: 1; }
    25% { opacity: .35; }
    36% { opacity: 1; }
    58% { opacity: .35; }
    69% { opacity: 1; }
    100% { opacity: 0; }
  }
  @keyframes metronome-ring {
    0% { opacity: 0; transform: scale(1); }
    12% { opacity: 1; transform: scale(1.1); }
    100% { opacity: 0; transform: scale(2.8); }
  }
  @media (prefers-reduced-motion: reduce) {
    .metronome-glow::before, .metronome-glow::after { animation: none; }
  }

  .workspace { width: 100%; max-width: var(--column); margin: 28px auto 0; }

  /* The global strip: a plate of the same material as the amp's controls, with
     every label on one line and every select in one treatment. */
  .global-controls {
    display: grid;
    grid-template-columns: 110px 96px minmax(180px, 1fr) minmax(210px, 1.2fr) 110px;
    align-items: start;
    gap: 24px;
    padding: 22px 24px 20px;
    background: var(--faceplate);
    border: 1px solid var(--line);
    border-top-color: #3b3441;
    border-radius: var(--radius);
    box-shadow: var(--shadow), inset 0 1px 0 #ffffff08;
  }
  .io-control { display: flex; align-items: flex-start; gap: 14px; }
  .output-control { justify-content: flex-end; }
  .gate-control { position: relative; display: flex; justify-content: center; }
  /* The gate's switch is a lamp beside its name, as the amp's blocks have. */
  .enable {
    position: absolute;
    top: -5px;
    left: calc(50% + 21px);
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
  }
  .enable span { width: 6px; height: 6px; border-radius: 50%; border: 1px solid var(--violet-600); box-sizing: border-box; }
  .enable[aria-pressed='true'] span { background: var(--accent); border-color: var(--accent); box-shadow: 0 0 5px #d6b6e399; }
  .rig-selectors { display: grid; gap: 14px; padding-left: 24px; border-left: 1px solid var(--line); }
  .selector { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .selector select { width: 100%; }
  .tone-selector { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 0 20px; border-right: 1px solid var(--line); }
  .preset-picker { display: flex; align-items: center; gap: 6px; width: 100%; margin-top: 12px; }
  .preset-picker select { flex: 1; min-height: 44px; font: 500 15px var(--body); text-align: center; text-align-last: center; }
  .preset-picker button {
    display: grid;
    place-items: center;
    width: 32px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text-2);
    font-size: 24px;
    cursor: pointer;
  }
  .preset-picker button:hover { color: var(--text); background: var(--surface-2); }

  .amp-head { position: relative; margin-top: 28px; padding: 17px; border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--surface-1); box-shadow: var(--shadow); --knob-accent: var(--violet-400); }
  .glass-window { position: relative; height: 260px; overflow: hidden; background: #101010; border: 2px solid #0e0e10; box-shadow: 0 0 0 1px #55505b; }
  .glass-window img { width: 100%; height: 100%; object-fit: cover; filter: brightness(1.67); }
  .glass-window .veil { position: absolute; inset: 0; background: #000; pointer-events: none; will-change: opacity; }
  .glass-window::after { content: ''; position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 35px 12px #08080bd9; background: linear-gradient(0deg, #09080bb0, transparent 65%); }
  .amp-brand { position: absolute; z-index: 1; bottom: 24px; left: 0; right: 0; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 18px; text-align: center; color: #e4d4e8; text-shadow: 0 2px 8px #000; }
  .amp-brand h1 { margin: 0 -0.3em 0 0; font: 600 46px/1 var(--inscription); letter-spacing: 0.3em; }
  .brand-rule { width: 42px; height: 1px; background: #ad96b777; }
  .amp-brand p { flex-basis: 100%; margin: -8px 0 0; font: 400 8px/1 var(--display); font-stretch: 125%; letter-spacing: 0.5em; }
  .neutral-art { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; background: repeating-linear-gradient(0deg, #1b1b1b 0 2px, #2e2e2e 2px 3px); color: #848484; }
  .neutral-art > span { font-size: 80px; font-weight: 800; letter-spacing: -15px; opacity: .35; }
  .neutral-art small { font-size: 8px; letter-spacing: 6px; }
  .neutral-art + .amp-brand h1 { font: 400 22px var(--display); font-stretch: 125%; letter-spacing: 7px; }
  .bypassed .glass-window { opacity: .5; }

  .amp-panel { display: flex; align-items: center; justify-content: space-around; gap: 20px; padding: 22px 20px 20px; background: var(--faceplate); border: 1px solid var(--line-strong); }
  .control-group { position: relative; padding-left: 20px; border-left: 1px solid #69616a40; }
  .group-label {
    display: block;
    margin: 0 auto 14px;
    padding: 0;
    border: 0;
    background: none;
    font: 400 9px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.24em;
    color: var(--text-2);
    cursor: pointer;
  }
  .group-label span { margin-left: 5px; font-size: 7px; color: var(--knob-accent); }
  .group-label[aria-pressed='false'] { opacity: .45; }
  .knob-row { display: flex; gap: 16px; }
  .amp-signature { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 110px; color: #c6b9cb; }
  .amp-signature > span { font: italic 500 30px/1 var(--inscription); }
  .sig-symbol { color: var(--violet-300); opacity: .85; }
  .amp-signature small { font: 400 7px/1 var(--display); font-stretch: 125%; letter-spacing: 0.3em; }
  .power-indicator { display: flex; flex-direction: column; align-items: center; gap: 15px; min-width: 44px; padding: 8px; border: 0; background: none; color: var(--text-2); cursor: pointer; }
  .power-indicator > span { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: var(--violet-900); border: 3px solid #252227; box-shadow: 0 0 0 1px var(--violet-600); }
  .power-indicator > span.lit { color: #fff; background: var(--violet-600); box-shadow: 0 0 12px #c47adf; }
  .power-indicator small { font: 400 7px/1 var(--display); font-stretch: 125%; letter-spacing: 0.2em; color: var(--text-2); }
  .power-indicator:disabled { opacity: .5; cursor: wait; }
  .screw { position: absolute; width: 5px; height: 5px; border-radius: 50%; background: linear-gradient(135deg, #777, #222 45%, #999 50%, #333 60%); }
  .tl { top: 6px; left: 7px; } .tr { top: 6px; right: 7px; } .bl { bottom: 6px; left: 7px; } .br { bottom: 6px; right: 7px; }
  .amp-foot { display: flex; justify-content: space-between; margin: 0 50px; }
  .amp-foot span { width: 65px; height: 9px; background: #0f0f0f; border-radius: 0 0 3px 3px; }
  .capture-info { margin: 0; }

  .alert, .notice { color: var(--ember); font-size: 13px; }
  .notice { max-width: 52ch; margin: 10px 0; }
  .notice:empty { margin: 0; }
  .engine-update { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin: 0 0 16px; padding: 12px 16px; border: 1px solid var(--accent-line); border-radius: var(--radius); background: var(--violet-900); color: var(--violet-100); font-size: 13px; line-height: 1.5; }

  /* The rack: everything under the amp is cut from one plate, and modules are
     separated by an engraved seam rather than floated as cards. */
  .rack {
    margin-top: 28px;
    background: var(--faceplate);
    border: 1px solid var(--line);
    border-top-color: #3b3441;
    border-radius: var(--radius);
    box-shadow: var(--shadow), inset 0 1px 0 #ffffff08;
  }
  .rack > :global(section + section) { border-top: 1px solid #050407; box-shadow: inset 0 1px 0 #ffffff0a; }
  .rack:empty { display: none; }

  .demo-panel { padding: 20px 24px; }
  .demo-launch { display: flex; align-items: center; gap: 14px; width: 100%; padding: 14px 18px; border: 1px solid var(--accent-line); border-radius: var(--radius); background: var(--violet-900); color: var(--violet-50); font: 15px var(--body); text-align: left; cursor: pointer; }
  .demo-launch:hover:not(:disabled) { background: var(--violet-800); border-color: var(--violet-400); }
  .demo-launch:disabled { opacity: .5; cursor: default; }
  .demo-play { display: grid; place-items: center; width: 38px; height: 38px; margin-left: auto; border-radius: 50%; background: var(--action); color: var(--action-text); font-size: 13px; }
  .file { display: flex; flex-direction: column; gap: var(--u); width: 100%; }
  .transport { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .start.small { min-height: 32px; padding: 0 14px; font-size: 13px; }
  .check { display: flex; align-items: center; gap: 4px; }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .session-bar { display: flex; align-items: center; gap: 24px; padding: 18px 24px; }
  .looper { flex: 1; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .looper > .eyebrow { min-width: 72px; }
  .loop-status { display: flex; align-items: center; gap: 7px; min-width: 96px; font: 11px var(--mono); color: var(--text-2); }
  .loop-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--violet-800); }
  .loop-status[data-state=recording] .loop-dot, .loop-status[data-state=overdubbing] .loop-dot { background: var(--ember); }
  .loop-status[data-state=playing] .loop-dot { background: var(--accent); }
  .loop-main { min-width: 104px; min-height: 40px; }
  .loop-main[data-state=recording], .loop-main[data-state=overdubbing] { border-color: var(--ember-line); color: #f0d5cf; }
  .loop-power { display: grid; place-items: center; width: 40px; height: 40px; padding: 0; border: 1px solid var(--line); border-radius: 50%; background: none; color: var(--text-3); cursor: pointer; }
  .loop-power[aria-pressed=true] { border-color: var(--accent-line); color: var(--accent); }
  .loop-power:hover:not(:disabled) { color: var(--text); border-color: var(--line-strong); }
  .loop-power:disabled { opacity: .4; cursor: default; }
  .loop-level { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  .loop-level input { width: 110px; min-height: 40px; }


  .settings-button { display: grid; place-items: center; width: 40px; height: 40px; padding: 8px; border: 0; border-radius: var(--radius); background: none; color: var(--text-2); cursor: pointer; }
  .settings-button:hover { color: var(--text); background: var(--surface-2); }

  /* Settings: the tuner's frame, a section per subject, a primary done. */
  .settings { width: min(460px, calc(100vw - 40px)); padding-top: 80px; }
  .settings::before { content: ''; position: absolute; top: 58px; left: 0; right: 0; border-top: 1px solid var(--line); }
  .settings[open] { display: flex; flex-direction: column; gap: 22px; }
  .settings-section { display: flex; flex-direction: column; gap: 14px; }
  .settings-section h3 { margin: 0; font-size: 9px; color: var(--text-3); }
  .settings-section + .settings-section { padding-top: 22px; border-top: 1px solid var(--line); }
  .audio-settings { gap: 20px; }
  .detect { align-self: flex-start; }
  .connect { align-self: flex-end; }
  .device-controls { display: flex; flex-direction: column; gap: 16px; }
  .settings select { width: 100%; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .levels { display: flex; gap: var(--u); }
  .level { flex: 1; height: 3px; background: var(--surface-2); overflow: hidden; }
  .level-fill { display: block; height: 100%; background: var(--accent); transform-origin: left center; transform: scaleX(0); }
  .failure { display: flex; flex-direction: column; gap: 2px; max-width: 46ch; margin: 0; font: 14px var(--body); color: var(--ember); }
  .fix { color: var(--text-2); }

  /* Welcome: the lit glass on top, the inscription, and two doors of the same
     size, because neither is the lesser one: half the people who arrive have a
     guitar and half want to know what this is before they fetch it. */
  .welcome { width: min(680px, calc(100vw - 32px)); padding: 0; overflow: hidden auto; }
  .welcome:not([open]) { display: none; }
  .welcome[open] { display: block; }
  .welcome-glass { position: relative; height: 150px; overflow: hidden; background: #000; }
  .welcome-glass img { width: 100%; height: 100%; object-fit: cover; object-position: 50% 42%; opacity: .9; filter: saturate(1.05) brightness(1.15); }
  .welcome-glass::after { content: ''; position: absolute; inset: 0; background: linear-gradient(180deg, #0000 20%, #15131aaa 62%, var(--surface-1)); box-shadow: inset 0 1px 0 #ffffff14; }
  .welcome-body { position: relative; display: flex; flex-direction: column; align-items: center; gap: 10px; margin-top: -34px; padding: 0 36px 34px; text-align: center; }
  .welcome h2 { margin: 0; font: 600 38px/1.05 var(--inscription); letter-spacing: .01em; color: var(--violet-50); text-shadow: 0 2px 12px #000; }
  .welcome h2:focus { outline: none; }
  .welcome-lede { margin: 0 0 18px; font: 14px var(--body); color: var(--text-2); }
  .choices { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; width: 100%; }
  .choice {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
    padding: 22px 22px 18px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--faceplate), var(--surface-2);
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: border-color 160ms ease-out, transform 160ms ease-out;
  }
  .choice:hover:not(:disabled) { border-color: var(--accent-line); transform: translateY(-2px); }
  .choice:disabled { opacity: .4; cursor: default; }
  .choice-icon { margin-bottom: 6px; color: var(--violet-300); }
  .choice-title { font: 400 12px/1 var(--display); font-stretch: 125%; letter-spacing: .24em; text-transform: uppercase; color: var(--violet-100); }
  .choice-body { flex: 1; font: 13px/1.55 var(--body); color: var(--text-2); }
  .choice-go { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 12px; width: 100%; border-top: 1px solid var(--line); font: 500 13px var(--body); color: var(--accent); }
  .choice-go span { transition: transform 160ms ease-out; }
  .choice:hover:not(:disabled) .choice-go span { transform: translateX(4px); }
  .welcome .failure { margin-top: 12px; text-align: left; }
  .welcome .tc-close { color: var(--violet-50); background: #0008; }
  .welcome .tc-close:hover { background: #000c; }
  @media (max-width: 600px) {
    .welcome-glass { height: 110px; }
    .welcome-body { padding: 0 18px 22px; margin-top: -26px; }
    .welcome h2 { font-size: 32px; }
    .choices { grid-template-columns: 1fr; gap: 10px; }
    .choice { padding: 16px 18px 14px; }
    .choice-icon { display: none; }
    .choice-go { margin-top: 4px; padding-top: 10px; }
  }
  @media (prefers-reduced-motion: reduce) { .choice, .choice-go span { transition: none; } }

  @media (min-width: 1500px) { .glass-window { height: 310px; } .workspace { margin-top: 40px; } }
  @media (max-width: 1100px) {
    .page { padding: 0 24px 96px; }
    .global-controls { gap: 14px; padding: 20px 16px; grid-template-columns: 96px 80px 1fr 1fr 96px; }
    .rig-selectors { padding-left: 16px; }
    .tone-selector { padding: 0 10px; }
    .amp-panel { flex-wrap: wrap; gap: 18px 10px; padding: 20px 12px; }
    .amp-signature { min-width: 70px; }
    .control-group { padding-left: 12px; }
    .knob-row { gap: 5px; }
    .tone-group { flex-basis: 100%; border-left: 0; padding-left: 0; }
    .tone-group .knob-row { justify-content: center; gap: 14px; }
    .session-bar { gap: 15px; }
  }
  @media (max-width: 760px) {
    .page { padding: 0 16px 96px; }
    .bar { height: 72px; }
    .bar-right { gap: 10px; }
    .workspace { margin-top: 20px; }
    .global-controls { grid-template-columns: 1fr 1fr 1fr; gap: 22px; }
    .io-control { justify-content: center; }
    .output-control { grid-column: 3; grid-row: 1; }
    .rig-selectors { grid-column: 1 / 3; grid-row: 2; padding: 0; border: 0; }
    .rig-selectors { grid-column: 1 / -1; }
    .tone-selector { grid-column: 1 / -1; grid-row: 3; align-items: stretch; padding: 0; border: 0; min-width: 0; }
    .tone-selector .eyebrow { align-self: flex-start; }
    .preset-picker { margin-top: 0; }
    .preset-picker select { min-width: 0; font-size: 13px; }
    .glass-window { height: 210px; }
    .amp-head { padding: 12px; }
    .amp-panel { flex-wrap: wrap; padding: 18px 10px; gap: 22px 12px; }
    .amp-signature { display: none; }
    .tone-group { flex-basis: 100%; border: 0; padding: 0; }
    .knob-row { justify-content: space-evenly; gap: 15px; }
    .control-group { border: 0; padding: 0; }
    .amp-brand h1 { font-size: 34px; }
    .session-bar { flex-wrap: wrap; padding: 16px; }
    .looper { flex-basis: 100%; }
    .loop-level { margin-left: 0; }
    .demo-panel { padding: 16px; }
  }
  @media (prefers-reduced-motion: reduce) { .glass-window .veil { opacity: .61 !important; } }

  /* GUILT is viewed head-on, just above the cabinet: a shallow, symmetric
     top plane and rounded rails surround the recessed glass and faceplate. */
  .amp-head.guilt {
    --guilt-rim: 26px;
    --guilt-piping: 19px;
    --leather-grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='grain'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.7' numOctaves='3' stitchTiles='stitch'/%3E%3CfeDiffuseLighting surfaceScale='2' diffuseConstant='.65' lighting-color='%23b5a9a3'%3E%3CfeDistantLight azimuth='225' elevation='45'/%3E%3C/feDiffuseLighting%3E%3C/filter%3E%3Cpath fill='%23201c21' filter='url(%23grain)' opacity='.24' d='M0 0h180v180H0z'/%3E%3C/svg%3E");
    --knob-accent: #655e6b;
    --control-label: #c6bcc9;
    isolation: isolate;
    margin-top: 48px;
    margin-right: 0;
    padding: var(--guilt-rim);
    border: 1px solid #454348;
    border-radius: 20px;
    background: linear-gradient(180deg,#b8b0ab22,transparent 7px,#0005 18px,transparent 27px,transparent calc(100% - 22px),#a49b9d14 calc(100% - 12px),#0008),var(--leather-grain),linear-gradient(90deg,#403c40,#252327 7px,#18171a 20px,#201e22 50%,#18171a calc(100% - 20px),#252327 calc(100% - 7px),#373439);
    box-shadow: inset 0 2px 1px #c2b9b54d,inset 2px 0 3px #9d969c33,inset -2px 0 3px #9d969c22,inset 0 -5px 6px #000d,0 2px 0 #080709,0 12px 12px -5px #000b,0 28px 30px -12px #000c;
  }
  .amp-head.guilt::before,.amp-head.guilt::after {
    content: '';
    position: absolute;
    pointer-events: none;
    z-index: -1;
    border: 1px solid #4c494e;
  }
  .amp-head.guilt::before {
    height: 16px;
    left: 5px;
    right: 5px;
    top: -8px;
    clip-path: polygon(12px 0,calc(100% - 12px) 0,100% 100%,0 100%);
    border-radius: 15px 15px 0 0;
    background: var(--leather-grain),linear-gradient(#201e22,#454047 55%,#302d32 80%,#151317);
    box-shadow: inset 0 1px 1px #b1a3ae44;
  }
  .amp-head.guilt::after {
    inset: 5px;
    border-color: #0d0c0f;
    border-radius: 15px;
    box-shadow: 0 1px 0 #b6aeb32b,inset 0 1px 2px #0008;
  }
  .guilt-handle {
    position: absolute;
    z-index: -2;
    top: -23px;
    left: calc(50% - 115px);
    width: 230px;
    height: 17px;
    pointer-events: none;
    border-bottom: 5px solid #161317;
    filter: drop-shadow(0 3px 2px #0008);
  }
  .guilt-handle::before,.guilt-handle::after {
    content: '';
    position: absolute;
    bottom: -4px;
    width: 27px;
    height: 9px;
    border: 1px solid #8b7e69;
    border-radius: 3px;
    background: linear-gradient(#b0a18b,#62594e 40%,#292526 80%);
  }
  .guilt-handle::before { left: 0; }
  .guilt-handle::after { right: 0; }
  .guilt-handle span {
    position: absolute;
    inset: 0 17px 0;
    border: 4px solid #242226;
    border-bottom: 0;
    border-radius: 50% 50% 0 0 / 14px 14px 0 0;
    box-shadow: inset 0 2px 1px #897b8444,0 -1px 0 #615b60;
    background: linear-gradient(#39353b,#201e22 65%,transparent 66%);
  }
  .guilt-corners { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
  /* One continuous piping line ties the glass and control plate into a
     recessed front, while the outer seam describes the rolled leather edge. */
  .guilt-corners::before,.guilt-corners::after {
    content: '';
    position: absolute;
    border-radius: 8px;
  }
  .guilt-corners::before {
    inset: var(--guilt-piping);
    border: 1px solid;
    border-color: #9a8d78 #6c6155 #554c46 #897b69;
    box-shadow: 0 0 0 1px #09080b,0 1px 0 1px #c9bba226,inset 0 1px 1px #e7d8bc22;
  }
  .guilt-corners::after {
    inset: calc(var(--guilt-piping) + 3px);
    border: 1px solid #09080c;
    border-radius: 6px;
    box-shadow: inset 0 7px 7px #000a,inset 3px 0 4px #0006,inset -3px 0 4px #0006,0 0 2px #000;
  }
  .guilt-corners i {
    position: absolute;
    width: 40px;
    height: 40px;
    border: 1px solid #565359;
    background: linear-gradient(135deg,#68636b,#302d33 22%,#1a181d 50%,#332f37 76%,#121014);
    box-shadow: 0 2px 3px #0009,inset 1px 1px 2px #d5cdd033;
  }
  .guilt-corners i:nth-child(1) { top: -1px; left: -1px; border-radius: 20px 4px 5px 4px; clip-path: polygon(0 0,100% 0,100% 27%,27% 27%,27% 100%,0 100%); }
  .guilt-corners i:nth-child(2) { top: -1px; right: -1px; border-radius: 4px 20px 4px 5px; clip-path: polygon(0 0,100% 0,100% 100%,73% 100%,73% 27%,0 27%); }
  .guilt-corners i:nth-child(3) { bottom: -1px; left: -1px; border-radius: 4px 5px 4px 20px; clip-path: polygon(0 0,27% 0,27% 73%,100% 73%,100% 100%,0 100%); }
  .guilt-corners i:nth-child(4) { bottom: -1px; right: -1px; border-radius: 5px 4px 20px 4px; clip-path: polygon(73% 0,100% 0,100% 100%,0 100%,0 73%,73% 73%); }
  .guilt .tl,.guilt .tr { top: 4px; }
  .guilt .bl,.guilt .br { bottom: 4px; }
  .guilt .tl,.guilt .bl { left: 26px; }
  .guilt .tr,.guilt .br { right: 26px; }
  .guilt .screw {
    width: 5px;
    height: 5px;
    z-index: 4;
    background: linear-gradient(135deg,#b5a9ad,#4d444d 40%,#171319 42% 56%,#a0939c 58%,#3d353e);
    box-shadow: 0 1px 2px #000,inset 0 0 0 1px #c0b0b044;
  }
  .guilt .glass-window {
    border: 6px solid;
    border-top-width: 10px;
    border-color: #0c0b10 #211d26 #423b47;
    border-radius: 5px 5px 0 0;
    box-shadow: 0 0 0 1px #0b090e,0 -2px 3px #000c,0 1px 0 #8b7d9144;
  }
  .glass-filters { position: absolute; pointer-events: none; }
  .guilt .glass-window { isolation: isolate; opacity: 1; }
  /* Dim the glass against black, never the cabinet behind it: lowering the
     whole window's opacity let the grey leather show through the dark glass. */
  .glass-night {
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    background: #010104;
    opacity: .94;
    transition: opacity 500ms ease-out;
  }
  .guilt.illuminated .glass-night { opacity: 0; animation: guilt-ignite 1500ms linear; }
  .guilt .glass-window .veil { transition: opacity 150ms linear; }
  .guilt:not(.illuminated) .glass-window .veil { transition-duration: 500ms; }
  /* Two restrained ignition dips, then steady RMS illumination. No loop. */
  @keyframes guilt-ignite {
    0% { opacity: .94; }
    20% { opacity: .18; }
    30% { opacity: .18; }
    36% { opacity: .94; }
    48% { opacity: .08; }
    60% { opacity: .08; }
    66% { opacity: .94; }
    84% { opacity: .04; }
    100% { opacity: 0; }
  }
  .guilt .glass-window>img { filter: url(#guilt-glass-relief) brightness(1.8) contrast(1.13) saturate(.9); }
  .glass-bloom-power {
    position: absolute;
    inset: 0;
    pointer-events: none;
    mix-blend-mode: screen;
    opacity: 0;
    transition: opacity 500ms ease-out;
  }
  .guilt.illuminated .glass-bloom-power { opacity: 1; transition: opacity 1200ms ease-in; }
  .glass-glow {
    position: absolute;
    inset: 0;
    pointer-events: none;
    mix-blend-mode: screen;
    will-change: opacity;
  }
  .guilt .glass-glow img { filter: url(#guilt-glass-bloom); }
  .guilt .glass-window::after {
    z-index: 1;
    border: 1px solid #ddc0f333;
    box-shadow: inset 0 13px 15px #06030bf0,inset 8px 0 12px #08050db3,inset -8px 0 12px #08050db3,inset 0 -3px 6px #0b0610b3;
    background: linear-gradient(0deg,#09060ec2,transparent 40%,transparent 80%,#07030c44);
  }
  .glass-reflections {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(118deg,transparent 4%,#ead8ff12 19%,#f3e9ff24 19.3%,#e8d5ff05 20%,transparent 35%,#e8d5ff12 35.3%,transparent 52%),linear-gradient(175deg,#eedaff14,transparent 35%,#9972b408 70%,transparent);
    box-shadow: inset 0 2px 0 #f4e3ff55,inset 2px 0 0 #eddbff22,inset 0 -2px 0 #ad83ba33;
  }
  .guilt .amp-brand { z-index: 2; bottom: 21px; }
  .guilt .amp-brand h1 {
    color: #e0cedf;
    text-shadow: 0 1px 0 #f7eaf6,0 2px 0 #857087,0 3px 0 #49334e,2px 5px 3px #000,0 8px 13px #000;
  }
  .guilt .amp-brand p { color: #d0b7d4; text-shadow: 0 2px 2px #000; }
  .guilt .amp-panel {
    position: relative;
    margin-top: 2px;
    border: 1px solid;
    border-color: #655d6a #211d27 #111015 #312b38;
    border-radius: 0 0 4px 4px;
    background: repeating-linear-gradient(0deg,#dccbe903 0 1px,transparent 1px 3px),linear-gradient(105deg,#302c34,#211e26 40%,#19171f 75%,#28232d);
    box-shadow: 0 -1px 0 #08070a,inset 0 1px 1px #dfcfe21a,inset 3px 0 6px #0007,inset -3px 0 6px #0007,inset 0 -3px 5px #0007,0 4px 5px #000c;
  }
  .guilt .amp-signature { color: #ccbacc; text-shadow: 0 1px 0 #09070d,0 -1px 0 #ffffff22; }
  .guilt .group-label span { position: relative; display: inline-block; }
  .guilt .group-label span::after {
    content: '●';
    position: absolute;
    inset: 0;
    color: #d7bedf;
    text-shadow: 0 0 5px #d6b6e399;
    opacity: 0;
    transition: opacity 400ms ease-out;
  }
  .guilt.illuminated .group-label[aria-pressed=true] span::after { opacity: 1; transition: opacity 900ms ease-in 120ms; }
  .guilt .power-indicator { gap: 11px; padding: 8px 4px; min-width: 48px; }
  .guilt .power-indicator>span.power-rocker {
    position: relative;
    display: block;
    width: 36px;
    height: 58px;
    padding: 3px;
    border: 1px solid;
    border-color: #645b68 #39313e #84758b #4d4355;
    border-radius: 5px;
    background: #0b080f;
    perspective: 180px;
    box-shadow: 0 0 0 2px #121016,0 3px 5px #000b,inset 0 2px 4px #000;
  }
  .rocker-face {
    position: absolute;
    inset: 4px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-around;
    border: 1px solid #544c5c;
    border-radius: 3px;
    background: linear-gradient(#4c4553,#29232f 48%,#17121e 52%,#211b28);
    transform: rotateX(-13deg);
    box-shadow: 0 -3px 0 #211a29,0 -4px 1px #73677c,inset 0 1px 1px #b2a0bd33;
    color: #9a8dA3;
    font: 10px var(--mono);
    text-shadow: 0 1px 1px #000;
  }
  .rocker-on { color: #7d7187; }
  .rocker-off { color: #ddd1e2; }
  .rocker-lamp { position: relative; width: 15px; height: 3px; border-radius: 2px; background: #312236; box-shadow: inset 0 1px 2px #000; }
  .rocker-lamp::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: #eac0fc;
    box-shadow: 0 0 4px #eccbff,0 0 12px #c875efaa,inset 0 1px 0 #fff8;
    opacity: 0;
    transition: opacity 400ms ease-out;
  }
  .power-rocker.lit .rocker-face {
    transform: rotateX(13deg);
    background: linear-gradient(#201a29,#302637 48%,#494050 52%,#332b3e);
    box-shadow: 0 3px 0 #18111f,0 4px 1px #5b4b67,inset 0 1px 3px #0008;
  }
  .power-rocker.lit .rocker-on { color: #f1e1f7; }
  .power-rocker.lit .rocker-off { color: #85728f; }
  .power-rocker.lit .rocker-lamp::after { opacity: 1; transition: opacity 650ms ease-in; }
  .guilt .power-indicator:hover:not(:disabled) .power-rocker { border-color: #a091aa; }
  .guilt .power-indicator:active:not(:disabled) .rocker-face { transform: rotateX(0deg) translateZ(-1px); }
  .guilt+.amp-foot { margin: 0 58px; }
  .guilt+.amp-foot span { width: 55px; height: 20px; border-radius: 0 0 10px 10px; background: linear-gradient(90deg,#111014,#3a363e 25%,#201d25 75%,#100d14); border-bottom: 3px solid #0b090e; box-shadow: 0 5px 5px #0007,inset 0 5px 6px #000; }
  @media(prefers-reduced-motion:reduce) {
    .glass-night { animation: none !important; transition: none; }
    .glass-bloom-power,.guilt .glass-window .veil,.guilt .group-label span::after,.rocker-lamp::after { transition: none !important; }
    .glass-glow { will-change: auto; }
    .guilt.illuminated .glass-glow { opacity: .34 !important; }
  }
  @media(max-width:760px) {
    .amp-head.guilt { --guilt-rim: 18px; --guilt-piping: 12px; margin-top: 40px; }
    .amp-head.guilt::before { height: 11px; top: -6px; }
    .amp-head.guilt::after { inset: 5px; }
    .guilt-handle { top: -14px; width: 150px; left: calc(50% - 75px); }
    .guilt .glass-window { border-width: 5px; }
    .guilt .amp-panel { padding: 20px 6px; }
    .guilt .tone-group .knob-row { gap: 6px; }
    .guilt .tone-group :global(.knob) { min-width: 0; flex: 1; }
    .guilt .tone-group :global(.dial) { width: 54px; height: 54px; }
    .guilt .tone-group :global(.label) { font-size: 8px; letter-spacing: .8px; }
  }
</style>
