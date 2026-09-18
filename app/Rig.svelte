<script lang="ts">
  // Studio shell owns audio state; amplifier materials are scoped to its head.
  import { onDestroy, untrack } from 'svelte';
  import { Engine, EngineError, checkCabIR, readCatalog, type Meters, type Backend, type LoopMeters,
           type InputChannel, type InputDevice, type OutputDevice, type Source } from '../engine/engine.ts';
  import type { NativeOpened } from '../engine/native-host.ts';
  import { openInput } from '../engine/input.ts';
  import { CUSTOM_CAB, DEFAULT_CAB } from '../engine/ir.ts';
  import { detectPitch, noteFromFrequency, type PitchReading } from '../engine/tuner.ts';
  import { bpmFromFourTaps, Metronome, MIN_BPM, MAX_BPM } from '../engine/metronome.ts';
  import type { Capture } from '../engine/catalog.ts';
  import { PARAMS, STAGES, type Param } from '../schema/params.ts';
  import { PRESETS, DEFAULT_PRESET, type Preset } from './presets.ts';
  import { cleanToneName, loadTones, saveTones, type SavedTone } from '../store/tones.ts';
  import { loadSession, saveSession, type StudioView } from '../store/session.ts';
  import { loadMedia, saveMedia } from '../store/media.ts';
  import Segmented from './Segmented.svelte';
  import Waveform from './Waveform.svelte';
  import Tuner from './Tuner.svelte';
  import MetronomePanel from './Metronome.svelte';
  import EngineSettings from './EngineSettings.svelte';
  import TabReader from './TabReader.svelte';
  import { TabDeck } from './tab-deck.svelte.ts';
  import { RecorderDeck } from './recorder-deck.svelte.ts';
  import Recorder from './Recorder.svelte';
  import StudioBar from './StudioBar.svelte';
  import ChainStrip from './ChainStrip.svelte';
  import AmpHead from './AmpHead.svelte';
  import Transport from './Transport.svelte';
  import TabTransport from './TabTransport.svelte';
  import Tour, { type TourFigure, type TourStep } from './Tour.svelte';
  import type { Locale } from './i18n.ts';
  import { lang, engineMessage, failure } from './locale.svelte.ts';
  import { NativeLink, detectPlatform, downloadUrl, releasesUrl } from '../engine/native-host.ts';
  import { engineUpdate } from '../engine/engine-update.ts';
  import './tokens.css';

  let mode = $state<'musician' | 'tester'>('musician');
  /**
   * The studio is one screen that never scrolls, and two uses want opposite
   * things of it. The amp is dialled once at the start of a session and left
   * alone; the tab is read for forty minutes with the guitar in hand. So the
   * stage has two modes, switched from the bar: Tone gives it to the head,
   * Play to the tab. The chain and the transport are in both.
   */
  let view = $state<StudioView>('tone');
  /** A tester reads a page; only a musician gets the instrument's bands. */
  const tester = $derived(mode === 'tester');
  /**
   * A screen tall enough for the chain band's knobs at full size, beside the
   * head in Tone. In Play, and on anything shorter, the band stays compact so
   * the stage keeps the height. Width counts too: a tablet held upright is
   * tall, and the band's full form needs the room to spread the two selectors
   * and the preset across one line.
   */
  let tall = $state(false);
  $effect(() => {
    const query = window.matchMedia('(min-height: 900px) and (min-width: 1100px)');
    tall = query.matches;
    const follow = (e: MediaQueryListEvent) => { tall = e.matches; };
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  });
  /** A phone or a very short window: the page scrolls as a page, and nothing is fitted to the screen. */
  let paged = $state(false);
  $effect(() => {
    const query = window.matchMedia('(max-width: 760px), (max-height: 560px)');
    paged = query.matches;
    const follow = (e: MediaQueryListEvent) => { paged = e.matches; };
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  });
  function chooseView(next: StudioView): void {
    if (next === view) return;
    view = next;
    persist();
  }
  /** The tab's playback, shared with the transport at the foot of the screen. */
  const deck = new TabDeck();
  /** The take, shared with the transport's record key; its tracks sit under the transport. */
  const recorderDeck = new RecorderDeck();
  /** The transport's height, tracks included, which the head's glass gives way to. */
  let dockHeight = $state(76);
  /**
   * The head's scale. It has one size and one shape (AmpHead.svelte); what
   * changes with the window is how big it is drawn, never its proportions, so
   * it is scaled to whichever of the two dimensions runs out first. `zoom`,
   * not a transform: it changes the box the stage lays out, and it opens no
   * stacking context, so the tutorial can still lift a block of the head above
   * its shade.
   */
  let slotHeight = $state(0);
  let slotWidth = $state(0);
  let pageWidth = $state(0);
  let ampFrame = $state<HTMLElement | null>(null);
  let ampZoom = $state(1);
  /**
   * A floor low enough never to bite on a phone: the head is 1180 px of layout
   * whatever the screen, and the narrowest one sold still has to show it whole.
   */
  const MIN_AMP_ZOOM = 0.16;
  /** Air between the head's feet and the transport, so they never touch. */
  const AMP_BREATH = 16;
  /**
   * The head's own height, the scale in force taken back out of the box it is
   * drawn in. Watched rather than read once: the head settles over the first
   * seconds as its shell image and its faces load, and a height read before
   * that leaves the head overlapping the transport for the rest of the session.
   * A scale applied to the frame does not fire the observer — `zoom` does not
   * change the element's own box — so there is no loop here.
   */
  let ampHeight = $state(0);
  $effect(() => {
    const frame = ampFrame;
    if (frame === null) return;
    const measure = (): void => {
      const height = frame.getBoundingClientRect().height / untrack(() => ampZoom);
      // Half a pixel is the rounding of the scale, not a head that changed.
      if (height > 0 && Math.abs(height - untrack(() => ampHeight)) > 0.5) ampHeight = height;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  });
  $effect(() => {
    const room = slotHeight;
    // The slot's room, bounded by the window's: the head is laid out at its own
    // size and can be wider than the slot, so the slot is read from a box that
    // cannot be forced open by it (the grid column is `minmax(0, 1fr)`), and the
    // page is the second opinion in case one ever is.
    const across = slotWidth === 0 ? pageWidth : Math.min(slotWidth, pageWidth);
    const frame = ampFrame;
    if (across === 0 || frame === null) return;
    const current = untrack(() => ampZoom);
    const natural = ampHeight;
    /**
     * Declared, never measured. The head is `--column` wide by construction
     * (`.amp-stand` in AmpHead.svelte), and measuring it instead would be
     * circular: inside a scaled box the room the head is given reads as
     * `room / scale` of its own units, so the ratio comes back as the scale
     * already in force and the head settles at whatever size it happened to
     * have. That is the bug where a phone was handed the desktop's head.
     */
    const naturalWidth = parseFloat(getComputedStyle(frame).getPropertyValue('--column'));
    if (natural === 0 || !(naturalWidth > 0)) return;
    // A page that scrolls gives the slot the head's own height, so fitting to
    // it would shrink the head a step at a time: there — a phone, and the
    // tester's column, which are both pages — only the width runs out.
    const byHeight = paged || tester || room === 0 ? 1 : (room - AMP_BREATH) / natural;
    const next = Math.max(MIN_AMP_ZOOM, Math.min(1, across / naturalWidth, byHeight));
    // Fitting wins over settling: a tolerance in scale is six pixels of head at
    // its full width, which is six pixels of it cut off. Shrinking is taken at
    // once and only growing has to clear the threshold, so the scale can never
    // hunt around the fit.
    if (next < current - 0.0002 || next > current + 0.005) ampZoom = next;
  });
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
      settingsError = error instanceof Error ? engineMessage(error.message) : t.rig.detectFailed;
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
      notice = error instanceof Error ? engineMessage(error.message) : t.rig.tunerFailed;
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
      notice = t.rig.metronomeFailed;
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
    // Started by hand, it is the player's own click from here on, and the tab
    // stopping no longer takes it with it.
    metronomeBySync = false;
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
      notice = t.rig.metronomeFailed;
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
   * Whether the click that is ticking was started by the tab rather than by the
   * player. A tab that starts the click owns it and stops it again when it
   * pauses; a click the player started themselves is theirs, and keeps going.
   */
  let metronomeBySync = false;

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
      notice = t.rig.metronomeFailed;
      return null;
    }
    metronome.setVolume(metronomeVolume);
    metronome.play(metronomeBpm);
    metronomePlaying = true;
    metronomeBySync = true;
    return metronome.msToDownbeat() ?? 0;
  }

  /**
   * The tab stopped — paused, stopped, or run to its end. A click it started
   * for itself stops with it: the tab was what asked for the beat, and leaving
   * it ticking over a silent page means reaching for the corner to stop a sound
   * nothing on screen claims.
   */
  function syncTabStop(): void {
    if (!metronomeBySync) return;
    metronomeBySync = false;
    metronome.pause();
    metronomePlaying = false;
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
    signature: '.editor-bar .signature-select, .tour-figure [data-term="signature"]',
    tuning: '.editor-bar .tuning-select, .tour-figure [data-term="tuning"]',
    digits: '.tour-figure [data-term="digits"]',
    arrows: '.tour-figure [data-term="arrows"]',
    metronome: '.metronome-launch',
    metronomePlay: '.metronome-toggle',
    tutorial: '.tour-button',
  };
  let touring = $state(false);
  /** A step that names the amp shows the amp; one that names the reader shows the tab. */
  function tourStep(targets: readonly string[]): void {
    if (targets.includes('.amp-head')) view = 'tone';
    else if (targets.includes('.reader')) view = 'play';
  }
  /** The composing step's task: a note written during this tutorial, not one left in a draft. */
  let wroteNote = $state(false);
  $effect(() => { if (!touring) wroteNote = false; });

  const locale = $derived(lang.locale);
  const text = $derived(lang.messages);
  const t = $derived(lang.ui);
  const testerTour = $derived<readonly TourStep[]>(text.tour.steps.map((step, i) => ({ ...step, ...TOUR_LAYOUT[i]!, done: wroteNote })));
  $effect(() => { document.documentElement.lang = locale; });
  const LANGUAGES = [{ value: 'en', label: 'English' }, { value: 'fr', label: 'Français' }] as const;
  function chooseLocale(next: Locale): void {
    lang.set(next);
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
  const CHANNELS = $derived((['follow', 'left', 'right', 'sum'] as const).map((value) => ({ value, label: t.rig.channels[value] })));

  let engineState = $state<State>('idle');
  let problemKind = $state<Parameters<typeof failure>[0] | null>(null);
  // Derived, so a failure already on screen follows a change of language.
  const problem = $derived(problemKind === null ? null : failure(problemKind));
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
  let cab = $state(PRESETS.find((p) => p.name === DEFAULT_PRESET)?.cab ?? DEFAULT_CAB);
  /** Whether the player has chosen a cabinet themselves since the last capture. */
  let cabTouched = $state(false);
  /** The cabinet IR the player loaded; one at a time, kept on their machine. */
  let customCab = $state<File | null>(null);
  let cabRevision = $state(0);
  const CAB_IR_MEDIA = 'cabinet-ir';
  let preset = $state<string | null>(DEFAULT_PRESET);
  /** The preset double-click returns to; survives an edit, unlike `preset`. */
  let resetPreset = $state<string | null>(DEFAULT_PRESET);
  /** The player's own tones, after the factory ones in the same dropdown. */
  let savedTones = $state<SavedTone[]>([]);
  const SAVED_TONE = 'saved:';
  const tones = $derived<readonly Preset[]>([
    ...PRESETS,
    ...savedTones.map((s) => ({
      name: SAVED_TONE + s.id, label: s.name, pack: 'saved', capture: s.capture, cab: s.cab, values: s.values,
    })),
  ]);

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
    const index = tones.findIndex(p => p.name === preset);
    void applyPreset(tones[(index + direction + tones.length) % tones.length]!);
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
      source, takeId, fileLoop, metronomeBpm, metronomeVolume, metronomeSync, loopLevel, view,
    }));
  }

  async function restore(): Promise<void> {
    const [saved, kept] = await Promise.all([loadSession(), loadTones()]);
    savedTones = kept;
    if (saved.values !== undefined) values = { ...DEFAULT_VALUES, ...saved.values };
    if (saved.resetPreset !== undefined) {
      resetPreset = saved.resetPreset;
      const from = tones.find((p) => p.name === resetPreset);
      resetValues = { ...DEFAULT_VALUES, ...(from?.values ?? {}) };
    }
    // A saved tone deleted from another tab is no longer what is playing.
    if (saved.preset !== undefined) preset = tones.some((p) => p.name === saved.preset) ? saved.preset : null;
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
    if (saved.view !== undefined) view = saved.view;
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
    // A saved tone may name the loaded IR after it was replaced by nothing.
    cab = p.cab === CUSTOM_CAB && customCab === null ? DEFAULT_CAB : p.cab;
    engine?.setCab(cab);
    if (wanted !== undefined && wanted !== captureFile) {
      captureFile = wanted;
      await engine?.setCapture(wanted);
    }
    preset = p.name;
    persist();
  }

  /**
   * Keeps what is playing under a name. The same name replaces that tone, so
   * "save" after an edit updates the tone the player started from.
   */
  async function saveTone(raw: string): Promise<void> {
    const name = cleanToneName(raw);
    if (name === '') return;
    const same = savedTones.find((s) => s.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    const tone: SavedTone = {
      id: same?.id ?? crypto.randomUUID(),
      name, capture: captureFile, cab, values: $state.snapshot(values), savedAt: Date.now(),
    };
    const next = same !== undefined ? savedTones.map((s) => (s.id === tone.id ? tone : s)) : [...savedTones, tone];
    savedTones = next;
    preset = resetPreset = SAVED_TONE + tone.id;
    resetValues = { ...DEFAULT_VALUES, ...tone.values };
    persist();
    notice = (await saveTones($state.snapshot(next))) ? null : t.rig.toneNotKept;
  }

  /** The sound stays as it is: deleting a tone never changes what is heard. */
  async function deleteTone(key: string): Promise<void> {
    const next = savedTones.filter((s) => SAVED_TONE + s.id !== key);
    savedTones = next;
    if (preset === key) preset = null;
    if (resetPreset === key) resetPreset = null;
    persist();
    await saveTones($state.snapshot(next));
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
      ? t.rig.captureFailed
      : null;
  }

  async function loadCabFile(file: File): Promise<void> {
    const ok = engine !== null ? await engine.loadCab(file) : await checkCabIR(file);
    if (!ok) {
      notice = t.rig.cabUnreadable(file.name);
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

  const LOOP_KEY = 'l';


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
      ? t.rig.nativeStopped(engineMessage(message))
      : t.rig.engineFailed(engineMessage(message));
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
      `${locale}/${backend}/${parts.input.toFixed(1)}/${parts.output.toFixed(1)}/${outputs.length > 1}/${m.pitchDelayMs > 0.05}`;
    if (key !== latencyKey) {
      latencyKey = key;
      latencyDetail = parts === null ? '' : backend === 'native'
        ? t.rig.latencyNative(parts.input.toFixed(1), parts.output.toFixed(1), nativeOpened?.bufferSize ?? null)
        : t.rig.latencyBrowser(parts.input.toFixed(1), parts.output.toFixed(1), outputs.length > 1);
      if (m.pitchDelayMs > 0.05) latencyDetail += t.rig.latencyPitch(m.pitchDelayMs.toFixed(1));
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

  /** A sentinel, never shown: the name on screen is the page's language. */
  const DEMO_NAME = 'demo';

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
      notice = t.rig.demoMissing;
    }
  }

  function play(): void {
    if (engine === null || filePeaks === null) return;
    if (engineState !== 'running') { notice = t.rig.pressStart; return; }
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
    problemKind = null;
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
        notice = t.rig.loadAgain;
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
          notice = t.rig.nativeFallback;
        }
        return;
      }
      // Cause in one sentence, fix in one sentence, no apology. Nothing is
      // blocked: the control stays available (FR-12).
      problemKind = error instanceof EngineError ? error.failure.kind : 'unknown';
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

<!-- Two layouts, one studio. A musician gets the instrument: four fixed bands,
     nothing scrolling. A tester arrived with no guitar to try any of it with, so
     they get a page to read: the same bar, the same chain, the same head, the
     demo and the reader under it, scrolling as a page does (CLAUDE.md §4). -->
<div class="page" class:tester class:touring data-view={tester ? 'tone' : view} style:--dock={`${dockHeight}px`} bind:clientWidth={pageWidth}>
  <StudioBar view={tester ? 'tone' : view} onview={chooseView} {latencyMs} {latencyDetail} {touring} showTour={tester} showModes={!tester} settingsDisabled={engineState === 'starting'}
    ontour={() => (touring = true)} onsettings={openSettings} />

  <ChainStrip roomy={tall && view === 'tone' && !tester} inputPeak={meters.input} outputRms={meters.outputRms} {values} {resetValues} {captures} {captureFile} {cab} {customCab} {preset}
    onparam={setParam} oncapture={f => void chooseCapture(f)} oncab={chooseCab} oncabfile={f => void loadCabFile(f)}
    {tones} baseTone={resetPreset} onsavetone={saveTone} ondeletetone={deleteTone}
    onpreset={name => { const p = tones.find(p => p.name === name); if (p) void applyPreset(p); }} onstep={nextPreset}
    power={view === 'play' && !tester ? { on: ampIlluminated, busy: engineState === 'starting', disabled: engineState === 'starting' || detecting, onpress: () => void power() } : undefined} />

  <main class="stage">
    <div class="capture-info" data-capture={latencyMs === null ? 'idle' : captureLoaded ? 'loaded' : 'silent'}></div>
    <!-- Over the top of the stage, so a message never moves what is under it. -->
    <div class="messages">
      <!-- Both speak to someone playing through the rig: a tester has no guitar
           to hear dry and no engine of their own to update. -->
      {#if engineState === 'running' && !captureLoaded && !tester}<p class="alert">{t.rig.captureSilent}</p>{/if}
      <p class="notice" role="status">{notice ?? ''}</p>
      {#if engineLatest !== null && backend === 'native' && !tester}
        <div class="engine-update" role="status">
          <span>{t.rig.engineUpdate(engineLatest.latest, engineLatest.current)}</span>
          <a class="update-button" href={engineDownload} rel="noopener">{t.rig.updateEngine}</a>
        </div>
      {/if}
    </div>

    {#if tester || view === 'tone'}
      <div class="amp-slot" bind:clientHeight={slotHeight} bind:clientWidth={slotWidth}>
        <!-- The room's light: violet from behind the head, brighter as it plays.
             One static gradient; only its opacity follows the signal. -->
        <div class="room-light" aria-hidden="true" style:opacity={ampIlluminated ? 0.55 + light * 0.45 : 0.25}></div>
        <div class="amp-frame" bind:this={ampFrame} style:zoom={ampZoom === 1 ? null : ampZoom}>
          <AmpHead {isGuilt} {ampIlluminated} {poweredOff} {light} {veil} {values} {resetValues}
            powerBusy={engineState === 'starting'} powerDisabled={engineState === 'starting' || detecting}
            onparam={setParam} onpower={() => void power()} />
        </div>
      </div>
    {/if}
    {#if tester}
      <!-- The demo and the reader, one under the other, each on its own plate:
           there is no transport to hold them, and nothing here is played by
           hand — the tab keeps the transport's own row above it. -->
      <section class="demo-panel tc-plate" aria-label={t.rig.demo}>{@render demoPanel()}</section>
      <section class="tab-column tc-plate" class:reading={deck.loaded}>
        <!-- Only once a score is open: with none, the reader's own header is
             already where a tab is opened, and two invitations is one too many. -->
        {#if deck.loaded}<div class="tab-row"><TabTransport {deck} view="play" syncBpm={metronomeSync ? metronomeBpm : null} /></div>{/if}
        <div class="tab-stage">
          <TabReader {deck} ontempo={takeScoreTempo} syncBpm={metronomeSync ? metronomeBpm : null} onsyncstart={syncTabStart} onsyncstop={syncTabStop} onwrite={() => { if (touring) wroteNote = true; }} />
        </div>
      </section>
    {:else}
      <!-- Mounted in both views, and only stowed in Tone: a song keeps playing
           under a tone being dialled, and alphaTab keeps a width to lay out in. -->
      <div class="tab-stage tc-plate" class:stowed={view !== 'play'} inert={view !== 'play'}>
        <TabReader {deck} ontempo={takeScoreTempo} onopen={() => chooseView('play')} syncBpm={metronomeSync ? metronomeBpm : null} onsyncstart={syncTabStart} onsyncstop={syncTabStop} onwrite={() => { if (touring) wroteNote = true; }} />
      </div>
    {/if}

  </main>

  {#snippet takeTracks()}
    <Recorder deck={recorderDeck} engine={engineState === 'running' ? engine : null} sinkId={engine?.outputId ?? outputId}
      tone={{ values, capture: captures.find(c => c.file === captureFile) ?? null, cab, cabRevision }} />
  {/snippet}

  {#snippet demoPanel()}
    {#if !demoOpen}
      <button class="demo-launch" type="button" disabled={engineState === 'starting'} onclick={() => void openDemo()}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 16 0v3" /><rect x="3" y="14" width="4" height="7" rx="1.5" /><rect x="17" y="14" width="4" height="7" rx="1.5" /></svg>
        <span>{t.rig.listenDemo}</span>
        <span class="demo-play" aria-hidden="true">▶</span>
      </button>
    {:else if filePeaks !== null}
      <div class="file">
        <Waveform peaks={filePeaks} duration={fileDuration} position={filePosition} onseek={seek} />
        <div class="demo-transport">
          <button class="start small" type="button" onclick={() => (filePlaying ? pause() : play())}>
            {filePlaying ? t.rig.pause : t.rig.play}
          </button>
          <label class="check t-small">
            <input
              type="checkbox"
              checked={fileLoop}
              onchange={(e) => { fileLoop = e.currentTarget.checked; engine?.setLoop(fileLoop); persist(); }}
            /> {t.rig.loop}
          </label>
          <span class="t-small name">{fileName === DEMO_NAME ? t.rig.demoName : fileName}</span>
        </div>
      </div>
    {/if}
  {/snippet}

  {#if !tester}
  <Transport {deck} recorder={recorderDeck} {view} syncBpm={metronomeSync ? metronomeBpm : null}
    musician={mode === 'musician'} running={engineState === 'running'} tracks={mode === 'musician' ? takeTracks : undefined} bind:height={dockHeight}
    {loop} {loopLevel} demo={mode === 'tester' ? demoPanel : undefined}
    onlooppress={loopPress} onlooppower={loopPower} onlooplevel={setLoopLevel} />
  {/if}

  <!-- The tuner and the metronome float in the room's bottom corners, drawn as
       the settings are at the top: always in the same place, whatever the mode. -->
  {#if mode === 'musician'}
    <button class="launcher tuner-launch" type="button" aria-label={t.rig.openTuner} title={t.rig.tuner} aria-busy={tunerOpening}
      disabled={engineState === 'starting' || tunerOpening} onclick={() => void openTuner()}>
      <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" aria-hidden="true"><path d="M7 3v7a5 5 0 0 0 10 0V3M7 6h3M14 6h3M12 15v6M9.5 21h5" /></svg>
    </button>
  {/if}
  <div class="launcher-group metronome">
    <button class="metronome-toggle" type="button"
      aria-label={metronomePlaying ? t.rig.pauseMetronome : t.rig.startMetronome}
      title={metronomeBpm === null ? t.rig.setTempoFirst : metronomePlaying ? t.rig.pauseMetronome : t.rig.startMetronome}
      aria-pressed={metronomePlaying} disabled={metronomeBpm === null || metronomeOpening} onclick={() => void toggleMetronome()}>
      {#if metronomePlaying}
        <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="2.5" width="3.5" height="11" rx=".5"/><rect x="9.5" y="2.5" width="3.5" height="11" rx=".5"/></svg>
      {:else}
        <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5 13 8l-9 5.5z"/></svg>
      {/if}
      {#if metronomeBpm !== null}<span class="bpm">{metronomeBpm}</span>{/if}
    </button>
    <button class="launcher metronome-launch" type="button" aria-label={t.rig.openMetronome}
      title={metronomeBpm === null ? t.rig.metronome : `${t.rig.metronome} · ${metronomeBpm} BPM`}
      aria-busy={metronomeOpening} disabled={metronomeOpening} onclick={() => void openMetronome()}>
      <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 20h8M9 20l2-16h2l2 16M12 7l4 5M16 12l1.5-1.5" /></svg>
      {#key metronomeGlow}{#if metronomeGlow > 0}<span class="metronome-glow" aria-hidden="true"></span>{/if}{/key}
    </button>
  </div>

  {#if mode === 'musician'}<Tuner bind:element={tunerDialog} reading={tunerReading} onclose={() => void onTunerClosed()} />{/if}
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
    <button class="tc-close" type="button" aria-label={t.rig.closeSettings} onclick={() => settingsDialog?.close()}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" /></svg></button>
    <h2 class="tc-dialog-title" id="settings-title">{text.settings}</h2>
    <section class="settings-section" aria-labelledby="settings-language">
      <h3 class="eyebrow" id="settings-language">{text.language}</h3>
      <Segmented label={text.language} options={LANGUAGES} value={locale} onchange={v => chooseLocale(v as Locale)} />
    </section>
    {#if mode === 'musician'}
    <section class="settings-section audio-settings" aria-labelledby="settings-audio">
    <h3 class="eyebrow" id="settings-audio">{t.rig.audio}</h3>
    <EngineSettings {backend} opened={nativeOpened} onbackend={chooseBackend} />
    {#if backend === 'native'}
    {#if nativeOpened !== null && channelCount > 1}<div class="device-controls"><Segmented label={t.rig.inputChannel} options={CHANNELS} value={channel} onchange={chooseChannel}/><div class="levels">{#each meters.channelPeaks as peak}<span class="level"><span class="level-fill" style={`transform:scaleX(${level(peak)})`}></span></span>{/each}</div></div>{/if}
    {:else}
    <button class="secondary detect" disabled={detecting || engineState === 'starting'} onclick={detectInputs}>{detecting ? t.rig.detecting : t.rig.detect}</button>
    <div aria-busy={detecting}>
    <div class="device-controls">{#if devices.length > 0}<label class="field"><span class="t-small">{t.rig.inputDevice}</span><select disabled={detecting} value={deviceId} onchange={e => chooseDevice(e.currentTarget.value)}><option value="">{t.rig.defaultInput}</option>{#each devices as d}<option value={d.id}>{d.label || t.rig.input}</option>{/each}</select></label>{/if}{#if channelCount > 1}<Segmented label={t.rig.inputChannel} options={CHANNELS} value={channel} onchange={chooseChannel}/><div class="levels">{#each meters.channelPeaks as peak}<span class="level"><span class="level-fill" style={`transform:scaleX(${level(peak)})`}></span></span>{/each}</div>{/if}{#if outputs.length > 1}<label class="field"><span class="t-small">{t.rig.outputDevice}</span><select value={outputId} onfocus={() => void probeOutputs()} onchange={e => chooseOutput(e.currentTarget.value)}><option value="">{t.rig.sameAsInput}</option>{#each outputs as d}<option value={d.id}>{d.label || t.rig.output}{d.outputMs === undefined ? '' : ` — ${d.outputMs.toFixed(0)} ms`}</option>{/each}</select></label>{/if}</div>
    </div>
    {/if}
    {#if settingsError}<p class="failure" role="alert">{settingsError}</p>{/if}
    </section>
    {/if}
    <button class="connect" disabled={detecting || engineState === 'starting'} onclick={() => { settingsDialog?.close(); if (mode === 'musician' && engineState !== 'running') void power(); }}>{t.rig.done}</button>
  </dialog>

  <dialog class="tc-dialog welcome" bind:this={welcomeDialog} aria-labelledby="welcome-title" oncancel={() => (asking = false)}>
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

  {#if touring}<Tour steps={testerTour} terms={TOUR_TERMS} labels={text.tour} onstep={tourStep} onclose={() => (touring = false)} />{/if}
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

  /* An instrument, not a page: one screen, four full-width bands, and nothing
     scrolls or reflows. The stage takes whatever height the bar, the chain and
     the transport leave; what opens rises over it rather than pushing it.
     Nothing here opens a stacking context either, so the tutorial can still
     lift a window above its shade by z-index alone. */
  .page {
    /* The room at each side of the bands: the gutter, and the floating tuner
       and metronome standing in it. The bar spans it; nothing else does. */
    --side: calc(var(--gutter) + 74px);
    display: grid;
    grid-template-rows: var(--bar-height) auto minmax(0, 1fr) auto;
    /* One column no wider than the window: a laid-out score is kilometres of
       min-content, and an auto column would take all of it. */
    grid-template-columns: minmax(0, 1fr);
    row-gap: var(--gutter);
    height: 100dvh;
    padding: 0 var(--side) var(--gutter);
    box-sizing: border-box;
    /* The head is laid out at its own size and scaled down to fit; until that
       lands it must never widen the page under it. */
    overflow: hidden;
    /* Labels are engravings, not prose: a knob dragged past its edge or
       double-clicked back to its preset value would otherwise paint a
       selection across the head. */
    -webkit-user-select: none;
    user-select: none;
  }
  /* What a player may want to paste somewhere (a message to search, a
     program name to find) stays selectable, and so does what they type. */
  .page :global(:is([role='alert'], [role='status'], .alert, code, input, textarea, [contenteditable])) {
    -webkit-user-select: text;
    user-select: text;
  }
  /* In Tone the bands are the head's own column: one object, as the amp is.
     In Play they open to the tab's width. */
  .page > :global(.global-controls), .page > :global(.transport) { justify-self: center; width: min(100%, var(--column)); }
  [data-view='play'] > :global(.global-controls), [data-view='play'] > :global(.transport) { width: 100%; }
  /* The bar reaches the window's edges in both modes, so the name and the
     settings never move. */
  .page > :global(.bar) { margin-inline: calc(var(--gutter) - var(--side)); }

  /* The corner launchers: bare icons, no tile. A tile would read as a button
     of the shell, and these are tools standing in the room; the only thing
     that answers the pointer is the icon dimming. A dot under one says it is
     on. The 44px box stays for the pointer and for focus, the icon inside it
     is what is seen. */
  .launcher, .metronome-toggle {
    position: fixed;
    bottom: var(--gutter);
    z-index: 4;
    display: grid;
    place-items: center;
    width: 66px;
    height: 66px;
    padding: 0;
    border: 0;
    border-radius: 9px;
    background: none;
    color: var(--text);
    cursor: pointer;
    transition: color var(--dur-quick) ease-out;
  }
  .launcher:hover:not(:disabled), .metronome-toggle:hover:not(:disabled) { color: var(--text-2); }
  .launcher:active:not(:disabled), .metronome-toggle:active:not(:disabled) { color: var(--text-3); }
  .launcher:disabled, .metronome-toggle:disabled { color: var(--text-3); opacity: .55; cursor: default; }
  .launcher::after, .metronome-toggle::after {
    content: '';
    position: absolute;
    bottom: 2px;
    left: 50%;
    width: 4px;
    height: 4px;
    margin-left: -2px;
    border-radius: 50%;
    background: var(--violet-100);
    opacity: 0;
    transition: opacity var(--dur-settle) var(--ease-out);
  }
  .launcher[aria-busy='true']::after, .metronome-toggle[aria-pressed='true']::after { opacity: 1; }
  .tuner-launch { left: calc((var(--side) - 66px) / 2); }
  .metronome-launch { right: calc((var(--side) - 66px) / 2); }
  /* The metronome's start and tempo, above its launcher: the corner is one
     icon wide. */
  .metronome-toggle {
    right: calc((var(--side) - 66px) / 2);
    bottom: calc(var(--gutter) + 60px);
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 3px;
    height: 62px;
    font: 12px/1 var(--mono);
    font-variant-numeric: tabular-nums;
  }
  .metronome-toggle[aria-pressed='true'] { color: var(--violet-50); }
  .metronome-toggle[aria-pressed='true']:hover:not(:disabled) { color: var(--violet-100); }
  /* Glowing, above whatever the tab has open. */
  .metronome-launch:has(.metronome-glow) { z-index: 60; }
  /* No side room — a phone, or a window too short for the bands, which gives
     the gutter back the same way: the tiles sit in the corner side by side
     rather than in a margin that is no longer there. */
  @media (max-width: 760px), (max-height: 560px) {
    .tuner-launch { left: var(--gutter); }
    .metronome-launch { right: var(--gutter); }
    .metronome-toggle { right: calc(var(--gutter) + 70px); bottom: var(--gutter); height: 66px; }
  }
  /* A score set the tempo: the metronome glows three times, a soft light
     under it rather than rings leaving it. Opacity only. */
  .metronome-glow {
    position: absolute;
    inset: -14px;
    border-radius: 50%;
    background: radial-gradient(circle, #d8c2dd59 0%, #a38aa926 40%, transparent 70%);
    pointer-events: none;
    opacity: 0;
    animation: metronome-lit 2.7s ease-in-out forwards;
  }
  @keyframes metronome-lit {
    0%, 100% { opacity: 0; }
    15%, 48%, 81% { opacity: 1; }
    33%, 66% { opacity: .25; }
  }
  @keyframes metronome-once { 0%, 100% { opacity: 0; } 30% { opacity: .8; } }
  @media (prefers-reduced-motion: reduce) {
    .launcher, .metronome-toggle { transition: none; }
    .metronome-glow { animation-duration: 1.2s; animation-name: metronome-once; }
  }

  /* A change of mode is one authored moment: the bands settle into their new
     width (their contents fade back rather than being dragged there), and the
     stage's new occupant rises out of the dark. Opacity and transform only.
     Two keyframe names, one per view, so the animation restarts on each change. */
  [data-view='tone'] > :global(.global-controls), [data-view='tone'] > :global(.transport) { animation: band-tone var(--dur-settle) var(--ease-out); }
  [data-view='play'] > :global(.global-controls), [data-view='play'] > :global(.transport) { animation: band-play var(--dur-settle) var(--ease-out); }
  @keyframes band-tone { from { opacity: .3; } }
  @keyframes band-play { from { opacity: .3; } }
  .amp-slot { animation: stage-in 700ms var(--ease-out); }
  .tab-stage:not(.stowed) { animation: stage-in var(--dur-settle) var(--ease-out); }
  @keyframes stage-in { from { opacity: 0; transform: translateY(10px) scale(.985); } }
  @media (prefers-reduced-motion: reduce) {
    .page > :global(.global-controls), .page > :global(.transport), .amp-slot, .tab-stage:not(.stowed) { animation-duration: 1ms; }
  }

  /* The stage belongs to one mode at a time. Tone: the head in the middle of
     it. Play: the tab, edge to edge. */
  .stage { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  /* The slot is the stage's height whatever the head measures: the head is
     scaled to it, never the other way round. */
  .amp-slot { position: relative; display: flex; flex: 1 1 0; flex-direction: column; align-items: center; justify-content: center; min-height: 0; }
  /* The box hugs the head, so scaling it scales the box the stage centres.
     Nothing here may clamp the head: the stage reads the frame to learn the
     head's own size, and a `max-width` or a shrinkable item inside would hand
     it back the room it already has. The page clips across while the scale
     settles. */
  .amp-frame { position: relative; display: flex; justify-content: center; width: max-content; }
  .amp-frame > :global(.amp-stand) { position: relative; flex: none; }
  .room-light {
    position: absolute;
    inset: -16px calc(-1 * var(--gutter));
    pointer-events: none;
    background:
      radial-gradient(ellipse 46% 42% at 50% 44%, #7b3fa044, transparent 72%),
      radial-gradient(ellipse 30% 6% at 50% 96%, #000c, transparent 70%);
    will-change: opacity;
    transition: opacity 150ms linear;
  }
  @media (prefers-reduced-motion: reduce) { .room-light { transition: none; } }
  .tab-stage { flex: 1; min-height: 0; overflow: hidden; }

  /* The tester's page. The bands keep their material and their contents; only
     the frame changes: the window stops being fixed, the stage stops being
     fitted to it, and the plates stack down a column that scrolls. */
  .page.tester {
    display: flex;
    flex-direction: column;
    align-items: center;
    height: auto;
    min-height: 100dvh;
    overflow: visible;
    /* Vertically it is a page; across, the head laid out at its own size must
       never widen it while it is being scaled down to fit. */
    overflow-x: clip;
    /* The corner launchers stand in the room under the last plate. */
    padding-bottom: calc(var(--gutter) + 66px);
  }
  /* One centred column, as the page was before the studio became an
     instrument: the bands do not stretch to the window, they are the head's
     own width and stack under it. The bands, and only them — what floats over
     the page is a child of it too, and owns its own size: a column forced on a
     dialog made it as wide as the head, and on the tutorial's shade it darkened
     the column instead of the screen. */
  .page.tester > :global(.global-controls) { width: min(100%, var(--column)); }
  .page.tester > :global(.bar) { width: 100%; }
  .page.tester .stage { display: flex; flex: none; flex-direction: column; gap: var(--gutter); width: min(100%, var(--column)); }
  /* While the tutorial runs, and only then: it brings each window to the top of
     the screen to explain it, and the last one can only get there if the page
     has somewhere left to scroll. Empty room under a page nobody is being
     walked through would just be empty room. */
  .page.tester.touring { padding-bottom: calc(var(--gutter) + 66px + 30vh); }
  .page.tester .amp-slot { flex: none; padding: calc(var(--u) * 3) 0 calc(var(--u) * 5); }
  .page.tester .demo-panel { padding: 18px 20px; }
  .page.tester .tab-column { display: flex; flex-direction: column; overflow: hidden; }
  /* The same row the transport has, on the tester's own plate. It wraps for the
     same reason: under about 900 px the keys, the display and how the tab is
     practised do not share a line, and unwrapped they were printed over each
     other rather than merely tight. */
  .page.tester .tab-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 14px;
    min-height: var(--transport-height);
    padding: 10px 16px;
    border-bottom: 1px solid #050407;
    box-shadow: 0 1px 0 #ffffff0a;
  }
  @media (max-width: 900px) {
    .page.tester .tab-row > :global(.display) { flex: 1 1 100%; }
  }
  /* The reader fills the slot rather than sitting at the top of it: the
     tutorial lights this box, and an empty state floating in a tall dark
     rectangle reads as a bug. */
  /* A firm height, not a minimum: the reader asks for 100% of its slot, and a
     slot that only has a minimum is still auto to a percentage. Open, the slot
     is tall enough for the score, the scale bar and the neck under them — the
     reader drops the neck when its own stage falls under 480 px. */
  .page.tester .tab-stage { display: flex; flex: none; height: 420px; overflow: hidden; }
  .page.tester .reading .tab-stage { height: 660px; }
  .page.tester .tab-stage > :global(.reader) { flex: 1; min-height: 0; }
  /* On a phone the page is already scrolling: the reader grows with its neck
     rather than clipping it inside a fixed box. */
  @media (max-width: 760px) {
    .page.tester .tab-stage, .page.tester .reading .tab-stage { display: block; height: auto; min-height: 520px; overflow: visible; }
    .page.tester .tab-stage > :global(.reader) { height: auto; }
  }

  /* Stowed, it keeps its box, so alphaTab never lays out into zero width. */
  .tab-stage.stowed { position: absolute; inset: 0; visibility: hidden; pointer-events: none; }

  /* The one eyebrow. Every module name and control label in the studio. */
  .eyebrow {
    font: 400 10px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-2);
  }

  /* Buttons, three weights: primary (one per module), secondary, quiet. */
  .secondary, .start {
    min-height: 36px;
    padding: 0 16px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    font: 13px var(--body);
    cursor: pointer;
  }
  .secondary:hover:not(:disabled), .start:hover:not(:disabled) { border-color: var(--violet-500); background: #29252f; }
  .connect, .update-button {
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
  .connect:hover:not(:disabled), .update-button:hover { background: var(--action-hover); }
  .secondary:disabled, .start:disabled, .connect:disabled { opacity: .45; cursor: default; }

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


  .capture-info { margin: 0; }

  .messages { position: absolute; z-index: 4; top: 12px; left: 24px; right: 24px; display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; }
  .messages > * { pointer-events: auto; }
  .alert:not(:empty), .notice:not(:empty) { padding: 8px 14px; border-radius: var(--radius); background: var(--surface-1); box-shadow: var(--shadow); }
  .alert, .notice { margin: 0; color: var(--ember); font-size: 13px; }
  .notice { max-width: 80ch; }
  .engine-update { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin: 0; padding: 12px 16px; border: 1px solid var(--accent-line); border-radius: var(--radius); background: var(--violet-900); color: var(--violet-100); font-size: 13px; line-height: 1.5; }

  .demo-launch { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 2px 4px 2px 12px; border: 1px solid var(--accent-line); border-radius: var(--radius); background: var(--violet-900); color: var(--violet-50); font: 15px var(--body); text-align: left; cursor: pointer; }
  .demo-launch:hover:not(:disabled) { background: var(--violet-800); border-color: var(--violet-400); }
  .demo-launch:disabled { opacity: .5; cursor: default; }
  .demo-play { display: grid; place-items: center; width: 32px; height: 32px; margin-left: auto; border-radius: 50%; background: var(--action); color: var(--action-text); font-size: 13px; }
  .file { display: flex; flex-direction: row-reverse; align-items: center; gap: 14px; width: 100%; }
  .file > :global(.wave) { flex: 1; min-width: 0; }
  .file > :global(.wave svg) { height: 32px; }
  .demo-transport { display: flex; align-items: center; gap: 12px; }
  .demo-transport .name { max-width: 160px; }
  .start.small { min-height: 32px; padding: 0 14px; font-size: 13px; }
  .check { display: flex; align-items: center; gap: 4px; }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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

  /* Welcome: the inscription, and two doors of the same
     size, because neither is the lesser one: half the people who arrive have a
     guitar and half want to know what this is before they fetch it. */
  .welcome { width: min(680px, calc(100vw - 32px)); padding: 0; overflow: hidden auto; }
  .welcome:not([open]) { display: none; }
  .welcome[open] { display: block; }
  .welcome-body { position: relative; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 48px 36px 34px; text-align: center; }
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
    transition: border-color 160ms ease-out;
  }
  .choice:hover:not(:disabled) { border-color: var(--accent-line); }
  .choice:disabled { opacity: .4; cursor: default; }
  .choice-icon { margin-bottom: 6px; color: var(--violet-300); }
  .choice-title { font: 400 12px/1 var(--display); font-stretch: 125%; letter-spacing: .24em; text-transform: uppercase; color: var(--violet-100); }
  .choice-body { flex: 1; font: 13px/1.55 var(--body); color: var(--text-2); }
  .choice-go { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 12px; width: 100%; border-top: 1px solid var(--line); font: 500 13px var(--body); color: var(--accent); }
  .welcome .failure { margin-top: 12px; text-align: left; }
  @media (max-width: 600px) {
    .welcome-body { padding: 44px 18px 22px; }
    .welcome h2 { font-size: 32px; }
    .choices { grid-template-columns: 1fr; gap: 10px; }
    .choice { padding: 16px 18px 14px; }
    .choice-icon { display: none; }
    .choice-go { margin-top: 4px; padding-top: 10px; }
  }
  @media (prefers-reduced-motion: reduce) { .choice { transition: none; } }

  /* A phone, or a screen too short for an instrument: the bands stack and the
     page scrolls, as a page. The play path is not offered on mobile anyway;
     this keeps what can be read there readable. */
  @media (max-width: 760px), (max-height: 560px) {
    .page { --side: var(--gutter); display: flex; flex-direction: column; height: auto; min-height: 100dvh; overflow: visible; overflow-x: clip; }
    .page :global(.global-controls), .page :global(.transport-row) { flex-wrap: wrap; height: auto; padding-top: 10px; padding-bottom: 10px; }
    /* The corner tools float over the page here rather than standing in a
       margin it no longer has: the last plate ends above them. */
    .page { padding-bottom: calc(var(--gutter) + 66px); }
    [data-view='play'] > :global(.global-controls), [data-view='play'] > :global(.transport) { width: 100%; }
    [data-view='play'] > .stage { margin-inline: 0; }
    .stage { flex: none; }
    /* The stage takes no share of a page that scrolls, so the slot has none to
       divide: it is the head's own height here, or the head hangs out of a box
       of nothing and lies over the band above it. */
    .amp-slot { flex: none; padding: calc(var(--u) * 2) 0; }
    .tab-stage { min-height: 520px; }
  }
</style>
