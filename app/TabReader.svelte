<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import type { AlphaTabApi, model } from '@coderline/alphatab';
  import { loadMedia, saveMedia } from '../store/media.ts';
  import Fretboard from './Fretboard.svelte';
  import { KEYS, SCALES, SCALE_GROUPS, scaleById, scaleOnNeck, scaleNoteNames, keyOfSignature } from '../engine/scales.ts';
  import { STORES, dbGet, dbPut } from '../store/db.ts';
  import { restoreFadedVolume } from '../engine/tab-fades.ts';
  import { syncedSpeed } from '../engine/metronome.ts';
  import { TabPlayback, externalMedia } from '../engine/tab-playback.ts';
  import { startTabRender } from '../engine/tab-audio.ts';
  import type { RecordingTone } from '../engine/recording.ts';
  import { builtInCabIRAt, type Engine } from '../engine/engine.ts';
  import { PRESETS } from './presets.ts';
  import { lang } from './locale.svelte.ts';
  import type { TabDeck } from './tab-deck.svelte.ts';
  import {
    DURATIONS, SIGNATURES, STRING_COUNTS, TUNINGS, addTrack, barTicks, clearString, deleteBeat, emptyTab, layout as layBeats, makeRest, nudgeDuration,
    pickFret, readTab, removeTrack, setDuration, setSignature, setStrings, setTempo, setTuning, stepBeat, stepString, toAlphaTex, toggleDotted, typeDigit,
    type Cursor, type EditTab, type PendingDigit,
  } from '../engine/tab-editor.ts';

  const words = $derived(lang.ui.reader);
  let { deck, ontempo, onopen, onwrite, syncBpm = null, onsyncstart, onsyncstop, tone = null, cleanTone = null, engine = null }: {
    /** Where the studio's transport reads the playback and finds its controls. */
    deck: TabDeck;
    /**
     * The tone on the amp head. A tab played through the amplifier is played
     * through *this* one, so dialling the rig and hearing the song under it are
     * the same act; a clean track takes the clean preset instead, since a clean
     * part through a metal capture is not what anybody wrote.
     */
    tone?: RecordingTone | null;
    /** What a clean track is played through; the rig's own tone is for the loud ones. */
    cleanTone?: RecordingTone | null;
    /** For a cabinet the player loaded themselves, which only the engine can decode. */
    engine?: Engine | null;
    ontempo?: (bpm: number) => void;
    /** A score the player chose was opened, or the editor was: the tab is wanted on screen. */
    onopen?: () => void;
    /** The metronome's tempo while the tab is synced to it; null when it is not. */
    syncBpm?: number | null;
    /**
     * Starts the click if it is not running, and says in how many ms its next
     * measure begins — null when there is no click to follow after all.
     */
    onsyncstart?: () => Promise<number | null>;
    /** Playback stopped: the studio takes back a click it started for this tab. */
    onsyncstop?: () => void;
    /** A note written in the editor, from the keys or the neck. */
    onwrite?: () => void;
  } = $props();

  // Every format alphaTab's own ScoreLoader tries, in its order: Guitar Pro
  // 3-5, 6 (gpx), 7-8 (gp), MusicXML plain and zipped, Capella, alphaTex.
  // Naming one it cannot read would be a promise the importer breaks.
  const ACCEPT = '.gpx,.gp,.gp3,.gp4,.gp5,.musicxml,.xml,.mxl,.cap,.capx,.alphatex,.atex';
  const BASE = import.meta.env.BASE_URL;
  /**
   * alphaTab stacks its rows of effects above the tab — tempo, section names,
   * P.M., harmonics — with 2 px between them, so a section name sat on the tempo
   * it follows. 8 px keeps each row readable on its own.
   */
  const EFFECT_ROW_GAP = 8;
  /**
   * Room between beats on the single line. At alphaTab's 1 a run of notes read as
   * one block; 2 separated everything, at the price of a line twice as long to
   * scroll through. A bar already at its tightest — grace notes, harmonics with
   * their <19> — is laid out at its own minimum whatever this says.
   */
  const STRETCH = 1.5;
  /**
   * The size the zoom menu calls 100%. The tab is read from where the guitar is
   * played, about 1.5 m from the screen, and alphaTab's own 1 is sized for a
   * page held at arm's length. Fixed rather than following the studio's view:
   * the tab is only on screen in Play, and laying it out again at every fold
   * of the amp would hold the main thread for a whole score.
   */
  const BASE_SCALE = 1.35;
  let section: HTMLElement;
  let surface: HTMLDivElement;
  let viewport: HTMLDivElement;
  let picker: HTMLInputElement;
  let api: AlphaTabApi | null = null;
  let loading: Promise<typeof import('@coderline/alphatab')> | null = null;
  let sliding = 0;
  let slid = -1;
  let disposed = false;
  let score = $state.raw<model.Score | null>(null);
  let filename = $state('');
  let busy = $state(false);
  let error = $state('');
  let storageNote = $state('');
  let dragging = $state(false);
  let track = $state(0);
  let ready = $state(false);
  let playing = $state(false);
  let zoom = $state(100);
  let notation = $state('tab');
  let looping = $state(false);
  let selection = $state(false);
  /**
   * Solo and mute belong to each track, not to the one on screen: choosing a
   * track used to clear them all, so muting a second track unmuted the first.
   */
  let soloed = $state.raw<ReadonlySet<number>>(new Set());
  let mutedTracks = $state.raw<ReadonlySet<number>>(new Set());
  /** Each track's level, 0 to 1, as alphaTab's channel mix volume. Absent: full. */
  let trackVolumes = $state.raw<ReadonlyMap<number, number>>(new Map());
  const solo = $derived(soloed.has(track));
  const muted = $derived(mutedTracks.has(track));
  let position = $state(0);
  let duration = $state(0);
  /**
   * The tab through the amplifier rather than through the soundfont.
   *
   * Off, nothing here costs anything: no bank is fetched, no worker starts and
   * alphaTab plays as it always has. On, every track of the score is rendered
   * before a note is heard — the guitars through the chain, the rest through
   * alphaTab — and what plays is those buffers, on one clock.
   */
  let amped = $state(false);
  /** 0 to 1 while rendering, -1 when there is nothing to wait for. */
  let ampProgress = $state(-1);
  let mixLoaded = $state(false);
  /** The tone moved after the render: what is loaded is not what the amp says. */
  let ampStale = $state(false);
  let playback: TabPlayback | null = null;
  let ampRun = 0;
  let ampAbort: AbortController | null = null;
  let following = 0;
  /** Playback has caught up with the render and is holding for it. */
  let waiting = $state(false);
  /**
   * Whether this build shipped the guitar samples. Settled at build time
   * (`astro.config.mjs`): without them there is no amplifier to offer, and an
   * option that can only fail is worse than one that is not there.
   */
  const ampOffered = __DI_BANK__;
  /**
   * The least head start a rendered tab is played on, in seconds of music.
   * Under this there is nothing to listen to yet.
   */
  const HEAD_START = 20;
  /** Wall-clock start of the render, for how fast it is going. */
  let ampStartedAt = 0;

  /**
   * When a tab can be played without catching up with its own render.
   *
   * A track through the amplifier costs about what the player's own guitar
   * costs, so a machine renders a few of them faster than they play and a
   * seven-guitar song on two cores renders at half speed. Waiting out the
   * whole render would be minutes; starting too early is a tab that stops
   * every few bars. So the render's own measured speed decides: if it makes
   * `v` seconds of music per second, starting with `r` rendered is safe when
   * what is left to render, at that speed, finishes before the playhead gets
   * there — `r >= (1 - v) * total`. Above real time that is nothing at all,
   * and the head start alone applies.
   */
  function headStart(ready: number, total: number): number {
    const elapsed = (performance.now() - ampStartedAt) / 1000;
    // Too early to tell: the bank and the amplifier are still being fetched.
    if (ready < 8 || elapsed <= 0) return Math.min(HEAD_START, total);
    const speed = ready / elapsed;
    const safe = speed >= 1 ? 0 : (1 - speed) * total + 2;
    return Math.min(total, Math.max(HEAD_START, safe));
  }
  /** Through the amplifier, ready means the render has arrived, not that alphaTab has. */
  const playable = $derived(amped ? ready && mixLoaded : ready);
  /** Everything about the tone that a render would come out differently for. */
  const toneKey = $derived(tone ? `${tone.capture?.file ?? ''}|${tone.cab}|${tone.cabRevision ?? 0}|${Object.entries(tone.values).map(([k, v]) => `${k}=${v}`).sort().join(',')}` : '');
  /** The one the loaded render was made with. */
  let rendered = '';
  let tail = $state(0);
  /** What the hand is holding right now, on the track being read. */
  let lit = $state.raw<{ string: number; fret: number }[]>([]);
  const time = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

  /**
   * Where each track actually plays. A score is not a band playing throughout:
   * on a real transcription a third solo guitar can own five bars out of 293,
   * and selecting it then sounds broken — the whole band is heard and that
   * track is not, because at that moment it has nothing to play. Nothing on
   * screen said so, so the count is shown per track and the passage is one
   * click away. Counted over every beat of every bar, once per score: 7.7 ms
   * the first time and 1.3 ms after on a 293-bar, 10-track transcription,
   * next to the 700 ms the importer itself has just spent parsing it.
   */
  const activity = $derived.by(() => {
    const master = score?.masterBars ?? [];
    return (score?.tracks ?? []).map(t => {
      let bars = 0, first = -1, last = -1, start = 0;
      for (let index = 0; index < master.length; index++) {
        let sounds = false;
        for (const stave of t.staves) {
          for (const voice of stave.bars[index]?.voices ?? []) {
            for (const beat of voice.beats) if (beat.notes.length > 0) { sounds = true; break; }
            if (sounds) break;
          }
          if (sounds) break;
        }
        if (!sounds) continue;
        if (first < 0) { first = index; start = master[index]!.start; }
        last = index;
        bars++;
      }
      return { bars, first, last, start };
    });
  });
  const selected = $derived(activity[track] ?? { bars: 0, first: -1, last: -1, start: 0 });
  // A neck only makes sense for a staff that has strings: a keyboard or a drum
  // track has none, and gets none.
  const stave = $derived(score?.tracks[track]?.staves.find(s => s.tuning.length > 0) ?? null);

  /**
   * A scale laid over the neck. It stays lit while the tab plays: the point is
   * seeing the notes being played land inside it — or not — so the two lights
   * share the neck rather than taking turns (Fretboard.svelte draws them in
   * layers). Kept on this device like the last score, and never part of a tone.
   */
  const SCALE_KEY = 'reader-scale';
  const NECK_KEY = 'reader-neck';
  /**
   * The height the stage needs before the neck can sit under the tab: the tab,
   * the scale bar and a neck worth looking at. Under it the neck would be a
   * line, and what is being read is the tab — so it moves into a window of its
   * own instead, opened from a handle (see `.neck-window`).
   *
   * Measured here rather than in a container query, because the handle and the
   * window need the same answer, and two sources of it would disagree.
   */
  const NECK_ROOM = 480;
  let stage: HTMLDivElement;
  let stageHeight = $state(0);
  const roomForNeck = $derived(stageHeight >= NECK_ROOM);
  /** The neck's own window, when there is no room for it under the tab. */
  let neckOpen = $state(false);
  function toggleNeck() {
    neckOpen = !neckOpen;
    void dbPut(STORES.state, { open: neckOpen }, NECK_KEY);
  }
  let scaleId = $state('');
  let scaleRoot = $state(0);
  const scaleDef = $derived(scaleById(scaleId) ?? null);
  const scaleNotes = $derived(stave && scaleDef ? scaleOnNeck(stave.tuning, stave.capo, scaleRoot, scaleDef) : []);
  const scaleNames = $derived(scaleDef ? scaleNoteNames(scaleRoot, scaleDef) : []);
  function rememberScale() { void dbPut(STORES.state, { scaleId, scaleRoot }, SCALE_KEY); }

  /** The track on the lectern: its name, and whether anything of it is heard. */
  const followingName = $derived(score?.tracks[track]?.name || words.trackN(track + 1));
  const followingSilent = $derived(mutedTracks.has(track) || (soloed.size > 0 && !soloed.has(track)));

  /**
   * One line, running right to left under a playhead that stays in the middle
   * of the window. A page of music asks the reader to know where the eye is
   * about to jump; a single line asks nothing — the next bar is always the one
   * to the right, and the bar being played is always in the same place.
   *
   * The scroll is animated over the same duration alphaTab gives its beat
   * cursor, linearly, which is what keeps the two locked together: the cursor
   * transitions from `from` to `to` in that time, so the music slides under it
   * instead of jumping bar by bar. Cancelled and restarted on each beat, never
   * queued — a stale animation would fight the next one.
   */
  function follow(x: number, ms: number) {
    if (!viewport) return;
    cancelAnimationFrame(sliding);
    const from = viewport.scrollLeft;
    const to = Math.max(0, x - viewport.clientWidth / 2);
    if (ms <= 0) { viewport.scrollLeft = to; return; }
    const begin = performance.now();
    const step = (now: number) => {
      const done = Math.min(1, (now - begin) / ms);
      viewport.scrollLeft = from + (to - from) * done;
      if (done < 1) sliding = requestAnimationFrame(step);
    };
    sliding = requestAnimationFrame(step);
  }
  /**
   * Puts the paper back under the cursor, wherever alphaTab left it.
   *
   * Paused, alphaTab freezes its beat cursor part way through the beat it was
   * crossing, and then re-issues that beat's cursor update with a duration of
   * zero — whose `fromX` is the beat's *start*. Following that snapped the line
   * back to the beat's first note while the cursor stayed where it had stopped:
   * measured, 78 px of paper one way and 11 px of cursor the other, so the tab
   * stopped 84 px from the playhead it is read under. The event cannot say
   * where the cursor is, so the cursor is asked.
   */
  /**
   * Where alphaTab's beat cursor stands, in the paper's own pixels.
   *
   * The last one, not the first: a layout can leave a cursor layer behind it —
   * `fitSurface` already has to size every `.at-cursors` it finds — and a
   * stale one still reports a box.
   */
  function cursorX(): number | null {
    const marks = surface?.parentElement?.querySelectorAll<HTMLElement>('.at-cursor-beat');
    if (!marks || !viewport) return null;
    for (let i = marks.length - 1; i >= 0; i--) {
      const box = marks[i]!.getBoundingClientRect();
      if (box.width > 0 || box.height > 0) return box.left - viewport.getBoundingClientRect().left + viewport.scrollLeft;
    }
    return null;
  }
  /**
   * Puts the paper under the cursor, once the cursor has stopped moving.
   *
   * The re-pin does not land in one frame — alphaTab moves the cursor again
   * after the state change — so this waits for two frames that read the same
   * place and only then moves the line, once. Following it every frame while
   * it was still moving sent the line 29 px past where it belonged and back.
   */
  function settleOnCursor(previous: number | null = null, frames = 8) {
    cancelAnimationFrame(settling);
    const x = cursorX();
    if (x === null) return;
    if (x === previous || frames <= 0) { slid = -1; follow(x, 0); return; }
    settling = requestAnimationFrame(() => settleOnCursor(x, frames - 1));
  }
  let settling = 0;
  /**
   * Set at a pause and held until the score plays again: while it is up, every
   * scroll alphaTab asks for is answered from the cursor instead.
   *
   * Three different things ask for one on a pause — a zero-duration cursor
   * re-pin, a `forceScrollTo`, and a seek reported at the same moment — and
   * all three carry the start of the beat, or worse. alphaTab's synthesiser
   * runs ahead of the beat it is drawing, and the pause re-synchronises the
   * position to where the *sound* had reached: on a long score that arrives as
   * a seek a good many bars past the cursor, and late — after any window of a
   * few frames one could wait out. So the flag is not a window. It stays up
   * until the score plays again, and while it is up the answer to "scroll
   * here" is always the cursor, wherever alphaTab has ended up putting it.
   * That is what a paused reader is for: the line under the mark.
   */
  let pausing = false;
  function showBar(index: number) {
    const bounds = api?.boundsLookup?.findMasterBarByIndex(index);
    if (bounds) { slid = -1; follow(bounds.realBounds.x, 0); }
  }
  /**
   * The bar being read. `activeBeatsChanged` knows it exactly; before a note
   * has sounded there is nothing to ask, and the tick is the best that is
   * left — which is right on every score without a repeat in it.
   */
  let currentBar = $state(-1);
  function readBar() { return currentBar >= 0 ? currentBar : barAt(currentTick); }
  function barAt(tick: number) {
    const bars = score?.masterBars ?? [];
    let low = 0, high = bars.length - 1, found = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (bars[middle]!.start <= tick) { found = middle; low = middle + 1; } else high = middle - 1;
    }
    return found;
  }
  function goToTrack() {
    if (!api || selected.first < 0) return;
    pausing = false;
    api.tickPosition = selected.start;
    showBar(selected.first);
  }
  function seek(ms: number) {
    if (!api) return;
    // Asked for by hand, so the pause's own scroll is over and the line should
    // move with the scrubber rather than wait for the cursor to hold still.
    pausing = false;
    position = ms;
    api.timePosition = ms;
  }

  /**
   * alphaTab sizes its surface to the layout's unscaled width while the parts
   * inside it are scaled: zoomed out, the line ended well before the surface
   * did and scrolled on as blank paper; zoomed in, its last bars lay past the
   * end, out of reach. The surface, and the cursor layer over it, are fitted
   * to the parts actually drawn.
   */
  function fitSurface(reader: AlphaTabApi) {
    const element = (reader.canvasElement as unknown as { element?: HTMLElement } | null)?.element;
    if (!element) return;
    let right = 0;
    for (const child of element.children) {
      if (child instanceof HTMLElement && 'layoutResultId' in child) right = Math.max(right, child.offsetLeft + child.offsetWidth);
    }
    if (right <= 0) return;
    const width = `${Math.ceil(right)}px`;
    element.style.width = width;
    for (const layer of element.parentElement?.querySelectorAll<HTMLElement>(':scope > .at-cursors') ?? []) layer.style.width = width;
  }

  /* In one horizontal line, a system is as tall as the tallest bar of the
     whole score, and for a long score that is mostly blank reserved above the
     staff. Left at the top of it, the lectern showed that blank and the staff
     fell below the fold. The bar's visual bounds are the staff itself — the
     whitespace is exactly what they leave out — so the paper is parked on it. */
  function centreStaff(reader: AlphaTabApi) {
    const staff = reader.boundsLookup?.findMasterBarByIndex(0)?.visualBounds;
    if (!viewport || !staff) return;
    viewport.scrollTop = Math.max(0, staff.y + staff.h / 2 - viewport.clientHeight / 2);
  }

  /** The engine, the notation fonts and the soundfont: fetched at the first file opened, never before. */
  function library() {
    loading ??= import('@coderline/alphatab').catch(e => { loading = null; throw e; });
    return loading;
  }

  /**
   * The instruments, fetched once and patched once for every reader after it.
   * Not handed to alphaTab as a URL: MuseScore_General is voiced for
   * FluidSynth, and alphaTab reads it otherwise — a piano that silenced the
   * whole tab, an instrument 100 dB down, synths with their filters shut.
   * `prepareSoundFont` corrects a copy in memory (engine/soundfont.ts), in a
   * worker of its own, because it would hold the main thread for 45-75 ms.
   * alphaTab copies what it is given to its worker, so the same bytes serve
   * the next file opened too.
   */
  let instruments: Promise<Uint8Array> | null = null;
  function soundFont() {
    instruments ??= new Promise<Uint8Array>((resolve, reject) => {
      const worker = new Worker(new URL('../engine/soundfont-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ bytes?: Uint8Array; error?: string }>) => {
        worker.terminate();
        if (e.data.bytes) resolve(e.data.bytes); else reject(new Error(e.data.error ?? words.instrumentsFailed));
      };
      worker.onerror = e => { worker.terminate(); reject(new Error(e.message || words.instrumentsFailed)); };
      worker.postMessage(new URL(`${BASE}musescore-general/MuseScore_General.sf3`, location.href).href);
    }).catch(e => { instruments = null; throw e; });
    return instruments;
  }

  /**
   * One reader per score, rather than a new score into the reader on screen.
   * A layout runs in alphaTab's own worker and what comes back is resolved
   * against whatever score the api holds by then, so replacing the score under
   * a render still in flight — a second import after a resize or after switching
   * the studio's view — throws on bars that no longer exist. `destroy()` terminates
   * that worker and closes its audio context, so nothing from the previous
   * score can arrive at all. It costs one soundfont decode per import, on a
   * deliberate action that already shows Opening…, and it is why every display
   * setting below is passed from the current state instead of a default.
   */
  async function reader(alpha: typeof import('@coderline/alphatab')) {
    api?.destroy();
    api = null;
    ready = false;
    slid = -1;
    tail = 0;
    await tick();
    if (disposed) throw new Error('Reader closed.');
    api = new alpha.AlphaTabApi(surface, {
      // SVG, spelled out rather than relied on: canvas is forbidden here
      // (CLAUDE.md section 4) and alphaTab renders either way.
      // Every part of the line drawn as soon as it is laid out, not when it
      // scrolls into view: alphaTab's intersection-driven drawing left parts
      // blank for good after a zoom — while playing, or after a change of view — some
      // requested and never drawn, some never reported visible at all.
      core: { fontDirectory: `${BASE}font/`, engine: 'svg', enableLazyLoading: false },
      display: { scale: BASE_SCALE * zoom / 100, padding: [24, 28, 24, 28], layoutMode: alpha.LayoutMode.Horizontal,
        effectBandPaddingBottom: EFFECT_ROW_GAP, stretchForce: STRETCH,
        staveProfile: notation === 'tab' ? alpha.StaveProfile.Tab : alpha.StaveProfile.ScoreTab },
      // The footer — the copyright and its "All Rights Reserved" second line,
      // which alphaTab draws only under a copyright — is a page of print, not
      // a line to read along. The header above the music stays.
      notation: { elements: new Map([[alpha.NotationElement.ScoreCopyright, false]]) },
      player: {
        // The soundfont is loaded below rather than named here: see soundFont().
        // Through the amplifier, alphaTab plays nothing at all: it follows the
        // render on the clock below, and the cursor is what it contributes.
        playerMode: amped ? alpha.PlayerMode.EnabledExternalMedia : alpha.PlayerMode.EnabledSynthesizer,
        scrollElement: viewport, enableCursor: true, enableUserInteraction: true,
      },
    });
    // Not alphaTab's bundled SONiVOX: at 2.3 MB its guitars sound like a toy.
    // MuseScore_General is FluidR3 retuned, and as SF3 (Ogg samples) it is
    // 38 MB instead of 206 — fetched with the first file, never before.
    const created = api;
    void soundFont().then(bytes => {
      if (api !== created || disposed) return;
      // In external media mode there is no synthesiser to load it into: the
      // same bytes render the band into a buffer instead.
      if (amped) return;
      if (!created.loadSoundFont(bytes, false)) error = words.noSynth;
    }).catch(e => {
      if (api === created) error = words.unavailable(e instanceof Error ? e.message : String(e));
    });
    api.masterVolume = deck.volume / 100;
    // alphaTab's own handler for this layout parks the cursor on the left edge.
    api.customScrollHandler = {
      [Symbol.dispose]() {},
      // Paused, this carries the beat's own notes — the start of the beat the
      // cursor is part way across, or of one the synthesiser had already run
      // to. Answered from the cursor instead.
      forceScrollTo: beat => { if (pausing) { settleOnCursor(); return; } slid = -1; follow(beat.onNotesX, 0); },
      onBeatCursorUpdating: (_start, _end, _mode, fromX, toX, ms) => {
        if (toX === slid && ms > 0) return;
        slid = ms > 0 ? toX : -1;
        // Same again: paused, `fromX` is this beat's *start*, not where the
        // cursor stopped. Following it threw the paper back 78 px.
        if (ms <= 0 && pausing) { settleOnCursor(); return; }
        follow(fromX, 0);
        if (ms > 0) follow(toX, ms);
      },
    };
    // The room the last bar needs to reach the middle, and only when the line
    // is longer than the window: on a short one it would be paper to nowhere.
    api.postRenderFinished.on(() => {
      rendering = false;
      if (api === created && editing) { if (redraw) { redraw = false; void renderDraft(); } else { placeCursor(); soundWritten(); } }
      if (!viewport || !surface) return;
      fitSurface(created);
      centreStaff(created);
      layout++;
      tail = 0;
      const width = surface.scrollWidth;
      if (width > viewport.clientWidth) tail = Math.round(viewport.clientWidth / 2);
    });
    api.renderStarted.on(() => { rendering = true; });
    api.playerReady.on(() => { ready = true; });
    api.playerStateChanged.on(e => {
      const was = playing;
      playing = e.state === 1;
      // Paused, stopped, or run to the last bar: all three are the tab no longer
      // asking for a beat.
      // A frame later, so alphaTab's own re-snap of the cursor has happened
      // and the paper is put back under where it actually ended up.
      // The slide of the beat that was being crossed is stopped with it: the
      // paper holds where the cursor held, and `settleOnCursor` makes up the
      // difference once alphaTab has finished re-pinning it.
      if (was && !playing) { onsyncstop?.(); pausing = true; cancelAnimationFrame(sliding); settleOnCursor(); }
      if (playing) { stringCursor = null; pausing = false; cancelAnimationFrame(settling); }
      // Only a pause moves the cursor to where playback stopped: every new
      // layout reloads the player, which reports "stopped" at tick 0, and
      // typing fast sent the cursor back to the first beat mid-chord.
      else if (was && editing) cursorAtTick(currentTick);
    });
    api.playerPositionChanged.on(e => {
      position = e.currentTime; duration = e.endTime; currentTick = e.currentTick;
      // Every jump, ours or a click on a note, lands centred. Keyed on the
      // event's own flag rather than on a pending one we set before seeking:
      // a stray position update from the pause that preceded it consumed the
      // flag, and the seek that followed then scrolled nowhere. Writing, the
      // cursor scrolls itself, to the beat rather than to its bar.
      // A pause reports a seek of its own — to the bar the cursor stopped in,
      // or to the one the sound had reached, which is further on. Either way
      // the cursor is the truth while paused, and a seek the player asked for
      // has moved the cursor too, so answering from it is right in both cases.
      if (e.isSeek && !editing) { if (playing) { lit = []; showBar(readBar()); } else if (pausing) settleOnCursor(); else showBar(readBar()); }
    });
    api.beatMouseDown.on(beat => { if (editing && !playing) cursorAtTick(beat.absolutePlaybackStart); });
    // What is sounding, replaced whole on every beat: the previous position
    // goes out as the next comes in, which is the whole point of the neck.
    api.activeBeatsChanged.on(e => {
      // The bar that is actually being read, from the beat alphaTab is
      // drawing. Not from the tick: `barAt` searches the written bars by their
      // start, and the player's ticks run over the *expanded* timeline, so
      // after a repeated section of eleven bars the tick says bar 90 while the
      // cursor is on 79. This is the number the cursor agrees with.
      const first = e.activeBeats[0];
      if (first) currentBar = first.voice.bar.index;
      if (!playing) return;
      const held: { string: number; fret: number }[] = [];
      for (const beat of e.activeBeats) {
        if (beat.voice.bar.staff.track.index !== track) continue;
        for (const note of beat.notes) if (note.string > 0) held.push({ string: note.string, fret: note.fret });
      }
      lit = held;
    });
    api.playbackRangeChanged.on(e => { selection = e.playbackRange !== null; });
    // alphaTab's own errors are for the console, not the player: a line like
    // "Cannot read properties of undefined" says nothing they can act on.
    api.error.on(e => { console.warn('[tab reader]', e); busy = false; rendering = false; });
    // A player built while a render is loaded takes it: every path that
    // replaces the player — a zoom, a layout, the editor — would otherwise
    // leave the tab playing with no cursor on it.
    if (amped && mixLoaded) attachPlayback();
    return api;
  }

  async function open(file: File, remember = true) {
    if (busy) return;
    if (!/\.(gp[345x]?|musicxml|xml|mxl|capx?|alphatex|atex)$/i.test(file.name)) {
      error = words.unsupported; return;
    }
    if (file.size > 20 * 1024 * 1024) { error = 'This score exceeds the 20 MB import limit.'; return; }
    busy = true; error = ''; storageNote = '';
    try {
      const alpha = await library();
      // Parsed before anything on screen is touched: a file that turns out not
      // to be a score leaves the one being read exactly as it was.
      const parsed = alpha.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(await file.arrayBuffer()), new alpha.Settings());
      if (disposed) return;
      restoreFadedVolume(parsed, alpha);
      // A file opened while writing is a file to read: the draft stays kept.
      editing = false; clearTimeout(drawTimer);
      score = parsed; filename = file.name;
      track = Math.max(0, parsed.tracks.findIndex(t => t.staves.some(s => s.tuning.length > 0)));
      // The key follows the song until a scale is chosen: picking one then
      // starts in the key being played. A scale already lit is the player's,
      // and a new file does not move it.
      if (scaleId === '') {
        const first = parsed.tracks[track]?.staves[0]?.bars[0];
        if (first) scaleRoot = keyOfSignature(first.keySignature, first.keySignatureType === 1);
      }
      mutedTracks = new Set(); soloed = new Set(); trackVolumes = new Map(); stringCursor = null; looping = false; selection = false; position = 0; duration = 0; lit = []; pausing = false; currentBar = -1;
      const fresh = await reader(alpha);
      fresh.renderScore(parsed, [track]);
      applySpeed(fresh);
      ready = fresh.isReadyForPlayback;
      if (amped) { mixLoaded = false; void renderAmp(); }
      if (remember) {
        // Only a file the player just opened: the one restored at start-up
        // would overwrite a tempo they may have changed since.
        ontempo?.(Math.round(parsed.tempo));
        onopen?.();
        const saved = await saveMedia(file, 'score', 'last-score');
        if (saved === null) storageNote = words.sessionOnly;
      }
    } catch (e) {
      console.warn('[tab reader]', e);
      error = words.cannotOpen(file.name);
    } finally { busy = false; }
  }

  function chooseTrack(index: number) {
    if (!score || !api) return;
    track = index; lit = []; stringCursor = null;
    if (editing) { cursor = { track: index, beat: 0, string: draft.tracks[index]?.tuning.length ?? 6 }; void renderDraft(); return; }
    api.renderTracks([score.tracks[index]!]);
  }
  function toggled(set: ReadonlySet<number>): Set<number> {
    const next = new Set(set);
    if (!next.delete(track)) next.add(track);
    return next;
  }
  function setTrackVolume(index: number, level: number) {
    if (!score || !api) return;
    trackVolumes = new Map(trackVolumes).set(index, level);
    api.changeTrackVolume([score.tracks[index]!], level);
    applyMixGains();
  }
  function toggleSolo() {
    if (!score || !api) return;
    soloed = toggled(soloed);
    api.changeTrackSolo([score.tracks[track]!], soloed.has(track));
    applyMixGains();
  }
  function toggleMute() {
    if (!score || !api) return;
    mutedTracks = toggled(mutedTracks);
    api.changeTrackMute([score.tracks[track]!], mutedTracks.has(track));
    applyMixGains();
  }

  function updateDisplay() {
    if (!api) return;
    // Numeric enum values come from the installed library, loaded on demand.
    void library().then(alpha => {
      if (!api || disposed) return;
      api.settings.display.scale = BASE_SCALE * zoom / 100;
      api.settings.display.staveProfile = notation === 'tab' ? alpha.StaveProfile.Tab : alpha.StaveProfile.ScoreTab;
      api.updateSettings(); api.render({ reuseViewport: true });
    });
  }
  /**
   * The tab, rendered through the amplifier.
   *
   * Every guitar track of the score is played by the sample bank and run
   * through the chain, and everything else by alphaTab, all of it before a
   * note is heard and all of it off the main thread. What comes back is one
   * buffer per track, which is what keeps the mixer working afterwards: a
   * level, a solo or a mute is a gain, not another render.
   *
   * The tone is taken as it stands at the press. Turning a knob afterwards
   * does not creep into what is already rendered — it says so, and offers to
   * render again — because a tab that quietly disagreed with the amp head
   * would be worse than one that waits.
   */
  async function renderAmp() {
    if (!amped || !score || !api || !tone?.capture) return;
    // The reader this render is for: a layout, a zoom or the editor can replace
    // it while the worker is busy, and a render handed to a player that no
    // longer exists is a tab that never plays.
    const reader = api, sheet = score;
    const run = ++ampRun;
    ampAbort?.abort();
    const abort = new AbortController();
    ampAbort = abort;
    ampProgress = 0;
    ampStale = false;
    mixLoaded = false;
    ampStartedAt = performance.now();
    try {
      const alpha = await library();
      // The player's own gesture opened the tab, so a context is allowed here.
      playback ??= new TabPlayback();
      const player = playback;
      const rate = player.rate;
      const cab = async (id: string) => (engine ? engine.cabIRAt(rate, id) : builtInCabIRAt(rate, id));
      const clean = cleanTone ?? tone;
      const [font, cabIR, cleanIR] = await Promise.all([soundFont(), cab(tone.cab), cab(clean.cab)]);
      if (run !== ampRun || disposed || api !== reader) return;
      const render = startTabRender({
        score: sheet, api: reader, alphaTab: alpha, soundFont: font,
        tone: { ...tone, cabIR }, clean: { ...clean, cabIR: cleanIR },
        rate, base: BASE,
        onChunk: chunk => { if (run === ampRun) player.append(chunk.index, chunk.at, chunk.samples, chunk.right); },
        onBand: (index, at, left, right) => { if (run === ampRun) player.append(index, at, left, right); },
        onReady: seconds => {
          if (run !== ampRun) return;
          player.ready = seconds;
          ampProgress = Math.min(1, seconds / Math.max(1, player.seconds));
          // Playable as soon as there is a head start on it, not when it is
          // finished: the render runs faster than the song, so what is ahead
          // stays ahead.
          if (!mixLoaded && seconds >= headStart(seconds, player.seconds)) {
            mixLoaded = true;
            rendered = toneKey;
            ampStale = false;
          }
        },
        signal: abort.signal,
      });
      player.open(render.seconds, render.tracks);
      applyMixGains();
      attachPlayback();
      await render.finished;
      if (run !== ampRun || disposed) return;
      mixLoaded = true;
    } catch (e) {
      if (run !== ampRun || disposed || abort.signal.aborted) return;
      console.warn('[tab amp]', e);
      error = e instanceof Error ? e.message : words.unavailable(String(e));
      amped = false;
    } finally {
      if (run === ampRun) ampProgress = -1;
    }
  }

  /** alphaTab's side of it: play, pause and seek come here, and nothing else. */
  function attachPlayback() {
    const output = api?.player?.output as { handler?: unknown } | undefined;
    if (!output || !playback) return;
    output.handler = externalMedia(playback);
  }

  /**
   * Where the audio is, told to alphaTab frame by frame while it runs — and
   * only while it runs: a position pushed at a paused player drags the cursor
   * off the beat it stopped on, and a frame loop that never ends keeps a tab
   * awake for nothing.
   */
  $effect(() => {
    if (!amped || !playing || !mixLoaded) { cancelAnimationFrame(following); following = 0; waiting = false; return; }
    const follow = () => {
      following = requestAnimationFrame(follow);
      const port = api?.player?.output as { updatePosition?: (ms: number) => void } | undefined;
      if (!playback) return;
      // Caught up with the render: hold, rather than play the silence that has
      // not been rendered yet, and carry on once there is a second of it.
      if (playback.starved) { playback.pause(); waiting = true; }
      else if (waiting && playback.ready > playback.position + 1) { playback.play(); waiting = false; }
      if (playback.playing) port?.updatePosition?.(playback.position * 1000);
    };
    following = requestAnimationFrame(follow);
    return () => { cancelAnimationFrame(following); following = 0; };
  });

  function dropPlayback() {
    rendered = '';
    waiting = false;
    cancelAnimationFrame(following);
    following = 0;
    ampAbort?.abort();
    ampRun++;
    mixLoaded = false;
    ampProgress = -1;
    ampStale = false;
    void playback?.close();
    playback = null;
  }

  /** Solo, mute and every track's level, as gains on what is already rendered. */
  function applyMixGains() {
    if (!playback || !score) return;
    const anySolo = soloed.size > 0;
    for (const t of score.tracks) {
      const level = trackVolumes.get(t.index) ?? 1;
      const heard = !mutedTracks.has(t.index) && (!anySolo || soloed.has(t.index));
      playback.setTrackVolume(t.index, heard ? level : 0);
    }
    playback.setMasterVolume(deck.volume / 100);
  }

  /**
   * Turning the amplifier on or off reloads the player: the mode is settled
   * when alphaTab's own player is built, not after. The score on screen is
   * kept — only what plays it changes.
   */
  async function setAmped(on: boolean) {
    if (on === amped || busy || !score) return;
    api?.stop();
    amped = on;
    if (!on) dropPlayback();
    busy = true;
    try {
      const alpha = await library();
      const fresh = await reader(alpha);
      fresh.renderScore(score, [track]);
      applySpeed(fresh);
      ready = fresh.isReadyForPlayback;
    } catch (e) {
      console.warn('[tab amp]', e);
      error = words.unavailable(e instanceof Error ? e.message : String(e));
    } finally { busy = false; }
    if (on) void renderAmp();
  }

  /**
   * Synced to the metronome, the score plays at the click's tempo: the speed
   * is the ratio between the two, and the Speed menu steps aside.
   *
   * Through the amplifier it stays at 1. A rendered tab can only be slowed by
   * rendering it again — resampling it would drop the whole song a tone — and
   * that is a change of speed the player asks for, not one a menu applies to
   * a render that is already playing.
   */
  function applySpeed(reader: AlphaTabApi) {
    reader.playbackSpeed = amped ? 1 : syncBpm !== null && score ? syncedSpeed(syncBpm, score.tempo) : deck.speed / 100;
  }
  $effect(() => {
    void syncBpm; void deck.speed; void score; void ready;
    if (api) applySpeed(api);
  });

  /**
   * Synced, play waits for the click: the tab goes back to the start of its
   * bar and begins on the metronome's next first beat. The two have separate
   * audio clocks, so the start is placed by a timer on the main thread — a few
   * ms of jitter, not a drift, since both then run at the same tempo. Pressed
   * again while it waits, the start is called off.
   */
  let cueing = $state(false);
  let cue = 0;
  function cancelCue() { clearTimeout(cue); cueing = false; }
  function toggleLoop() { looping = !looping; if (api) api.isLooping = looping; }

  // The transport shows this and presses these. Svelte writes a field only
  // when it changes, so the position ticking is the one write per update.
  $effect(() => {
    deck.loaded = score !== null; deck.ready = playable; deck.busy = busy || (ampProgress >= 0 && !mixLoaded); deck.playing = playing; deck.cueing = cueing;
    deck.fixedSpeed = amped;
    deck.position = position; deck.duration = duration; deck.looping = looping; deck.selection = selection;
    deck.title = score ? (score.title || filename) : '';
    deck.bars = score?.masterBars.length ?? 0;
    deck.bar = score ? readBar() + 1 : 0;
    deck.bpm = score ? (syncBpm ?? Math.round(score.tempo * deck.speed / 100)) : 0;
  });
  $effect(() => { const level = deck.volume / 100; if (api) api.masterVolume = level; playback?.setMasterVolume(level); });
  /**
   * A tone dialled after the render is a tone the tab is not playing. Said,
   * not silently applied: the render is what it is until it is redone.
   *
   * Compared against the tone the render was made with, rather than raised by
   * anything that happens to change — landing a render moves `mixLoaded`, and
   * an effect that watched it called its own render stale.
   */
  $effect(() => { const now = toneKey; if (rendered !== '') ampStale = now !== rendered; });
  $effect(() => {
    deck.open = file => void open(file);
    deck.write = () => { if (!editing) void startEditing(); };
    deck.toggle = () => void togglePlay();
    deck.stop = () => { const cued = cueing; cancelCue(); pausing = false; api?.stop(); if (cued) onsyncstop?.(); };
    deck.seek = seek;
    deck.loop = toggleLoop;
    deck.clearSelection = () => { if (api) api.playbackRange = null; };
  });
  async function togglePlay() {
    if (!playable || busy || !api) return;
    // Cued but not yet playing: the player changed their mind before the first
    // beat, and the click started for the count-in goes with it.
    if (cueing) { cancelCue(); onsyncstop?.(); return; }
    // Raised before the press, not in the state change alphaTab sends after it:
    // its zero-duration cursor re-pin can arrive first, and then the paper has
    // already jumped back to the start of the beat.
    if (playing) pausing = true;
    if (playing || syncBpm === null || !onsyncstart || !score) { api.playPause(); return; }
    const reader = api;
    reader.tickPosition = score.masterBars[barAt(positionTick())]?.start ?? 0;
    cueing = true;
    const ms = await onsyncstart();
    if (!cueing || api !== reader) return;
    if (ms === null) { cueing = false; reader.play(); return; }
    cue = window.setTimeout(() => { cueing = false; if (api === reader) reader.play(); }, ms);
  }

  /**
   * The arrows step through the song: a bar at a time while it plays, a beat
   * at a time while it is paused — the beats with notes on the track being
   * read, or every beat of a track with none.
   */
  const beatTicks = $derived.by(() => {
    const t = score?.tracks[track];
    if (!t) return [];
    const withNotes = new Set<number>(), every = new Set<number>();
    for (const staff of t.staves) for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) {
      every.add(beat.absolutePlaybackStart);
      if (beat.notes.length > 0) withNotes.add(beat.absolutePlaybackStart);
    }
    return [...(withNotes.size > 0 ? withNotes : every)].sort((a, b) => a - b);
  });
  /** Where the last step went: alphaTab lands a seek a few ticks short, and the next step must not find the same beat. */
  let stepped = -1;
  /** The player's position in ticks, as alphaTab last reported it. */
  let currentTick = $state(0);
  const positionTick = (): number => (stepped >= 0 && Math.abs(currentTick - stepped) < 60 ? stepped : currentTick);

  /**
   * A string cursor, while paused: the arrows up and down move it across the
   * strings at the beat being read, like an editor's cursor, and the neck then
   * lights only the note on that string. Playing hides it; the neck goes back
   * to what is sounding.
   */
  let stringCursor = $state<number | null>(null);
  let stringMark = $state<{ x: number; y: number } | null>(null);
  /** Bumped after every render, so the mark follows a new layout. */
  let layout = $state(0);
  const staveBeats = $derived.by(() => {
    if (!stave) return [];
    const beats: model.Beat[] = [];
    for (const bar of stave.bars) for (const voice of bar.voices) beats.push(...voice.beats);
    return beats.sort((a, b) => a.absolutePlaybackStart - b.absolutePlaybackStart);
  });
  function beatAt(tick: number): model.Beat | null {
    let found: model.Beat | null = null;
    for (const beat of staveBeats) { if (beat.absolutePlaybackStart > tick) break; found = beat; }
    return found;
  }
  /** Every beat of the stave sounding at a tick, across its voices. */
  function beatsAt(tick: number): model.Beat[] {
    const sounding: model.Beat[] = [];
    for (const beat of staveBeats) {
      if (beat.absolutePlaybackStart > tick) break;
      if (tick < beat.absolutePlaybackStart + beat.playbackDuration) sounding.push(beat);
    }
    return sounding;
  }
  function moveString(direction: 1 | -1) {
    if (!stave || stave.tuning.length === 0) return;
    if (stringCursor === null) {
      const beat = beatAt(positionTick());
      stringCursor = beat && beat.notes.length > 0 ? Math.max(...beat.notes.map(n => n.string)) : stave.tuning.length;
      return;
    }
    stringCursor = Math.max(1, Math.min(stave.tuning.length, stringCursor + direction));
  }
  // Paused, the neck is lit from the position: alphaTab reports the notes
  // sounding only while it plays, and a seek had left the neck dark.
  $effect(() => {
    void layout;
    const tick = currentTick >= 0 ? positionTick() : 0;
    const string = stringCursor, beat = beatAt(tick), reader = api;
    if (playing || !stave) { stringMark = null; return; }
    // Reading, the string cursor picks one note out of the beat. Writing, it is
    // where the next fret goes, and the neck shows the whole beat: a chord
    // written one string at a time used to show only its last note.
    const held = beatsAt(tick).flatMap(b => b.notes).filter(n => n.string > 0 && (string === null || editing || n.string === string));
    lit = held.map(n => ({ string: n.string, fret: n.fret }));
    if (string === null || !beat || !reader) { stringMark = null; return; }
    const bounds = reader.boundsLookup?.findBeat(beat);
    if (!bounds) { stringMark = null; return; }
    // alphaTab gives bar bounds for the score staff only when both staves are
    // shown, so the tab's lines are found from the bounds aligned with every
    // staff's lines: their bottom is the tab's lowest line, string 1, and the
    // strings above it are tabLineSpacing apart.
    const lines = bounds.barBounds.masterBarBounds.lineAlignedBounds;
    const resources = reader.settings.display.resources as unknown as { engravingSettings: { tabLineSpacing: number } };
    const spacing = resources.engravingSettings.tabLineSpacing * reader.settings.display.scale;
    stringMark = { x: bounds.onNotesX, y: lines.y + lines.h - (string - 1) * spacing };
  });
  function step(direction: 1 | -1) {
    if (!api || !score || !ready) return;
    const now = api.tickPosition;
    const at = stepped >= 0 && Math.abs(now - stepped) < 60 ? stepped : now;
    let target: number | undefined;
    if (playing) {
      const bars = score.masterBars;
      target = bars[Math.max(0, Math.min(bars.length - 1, barAt(at) + direction))]?.start;
    } else if (direction > 0) {
      target = beatTicks.find(t => t > at);
    } else {
      for (const t of beatTicks) { if (t >= at) break; target = t; }
    }
    if (target === undefined) return;
    stepped = target;
    api.tickPosition = target;
  }
  /**
   * The section holds the key handler, so it has to hold the focus: clicking a
   * score seeks, it does not focus anything, and space then went to the page.
   * Controls keep their own focus — space on a select or a button is theirs.
   */
  function grabKeys(e: PointerEvent) {
    // Element, not HTMLElement: a click on the score lands on alphaTab's SVG,
    // which is an SVGElement and was falling straight through this guard.
    if (!(e.target instanceof Element) || e.target.closest('input,select,button,a,textarea')) return;
    section?.focus({ preventScroll: true });
  }
  function keydown(e: KeyboardEvent) {
    if (editKey(e)) return;
    if (e.code === 'Space' && e.target instanceof Element && !e.target.closest('input,select,button')) {
      e.preventDefault(); e.stopPropagation(); void togglePlay();
    }
    // Not from a slider or a select, whose arrows are their own.
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.altKey && !e.ctrlKey && !e.metaKey
        && e.target instanceof Element && !e.target.closest('input,select,textarea')) {
      e.preventDefault(); e.stopPropagation(); step(e.key === 'ArrowRight' ? 1 : -1);
    }
    // Up and down: another track while playing, another string while paused.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.ctrlKey && !e.metaKey
        && e.target instanceof Element && !e.target.closest('input,select,textarea') && score) {
      e.preventDefault(); e.stopPropagation();
      const up = e.key === 'ArrowUp';
      if (playing) chooseTrack(Math.max(0, Math.min(score.tracks.length - 1, track + (up ? -1 : 1))));
      else moveString(up ? 1 : -1);
    }
  }
  /**
   * Writing a tab. The editor holds the tab as written (engine/tab-editor.ts)
   * and the reader shows it read back from alphaTex, so what is written is laid
   * out, played, lit on the neck and exported by the same reader as a file.
   * One layout at a time: a score handed to alphaTab while it lays out the
   * previous one throws on bars that no longer exist, so an edit made during a
   * layout waits for it, and only the latest tab is drawn.
   */
  const DRAFT_KEY = 'tab-draft';
  let editing = $state(false);
  let draft = $state.raw<EditTab>(emptyTab());
  let cursor = $state.raw<Cursor>({ track: 0, beat: 0, string: 6 });
  let pendingDigit: PendingDigit | null = null;
  /**
   * The note just written, to be heard. Played once its layout is finished and
   * not as it is typed: every layout reloads the player's MIDI, and a reload
   * stops a note already sounding. The wait is the 40 ms of `commit` plus one
   * layout, well under what reads as late for a note being placed.
   */
  let written: Cursor | null = null;
  /** The tab the last layout was made from: a layout of an older one would sound the fret before the edit. */
  let drawn: EditTab | null = null;
  let rendering = false;
  let redraw = false;
  let drawTimer = 0;
  const editTrack = $derived(draft.tracks[cursor.track] ?? draft.tracks[0]!);
  const editBeat = $derived(editTrack.beats[cursor.beat] ?? null);
  const tunings = $derived(TUNINGS[editTrack.tuning.length] ?? []);
  const tuningIndex = $derived(tunings.findIndex(t => t.notes.join() === editTrack.tuning.join()));

  async function startEditing() {
    if (busy) return;
    // Writing a tab is the synthesiser's job: it plays the note under the
    // cursor, and an external media player has no note to play.
    if (amped) await setAmped(false);
    busy = true; error = ''; storageNote = '';
    try {
      const alpha = await library();
      const saved = readTab(await dbGet<unknown>(STORES.state, DRAFT_KEY));
      if (disposed) return;
      if (saved) draft = saved;
      cursor = { track: 0, beat: 0, string: draft.tracks[0]!.tuning.length };
      pendingDigit = null;
      editing = true; filename = ''; track = 0;
      // The editor's bar is on screen from here: the keys have to reach it from
      // here too, not a render later, or the first digit typed falls nowhere.
      section?.focus({ preventScroll: true });
      onopen?.();
      mutedTracks = new Set(); soloed = new Set(); trackVolumes = new Map(); looping = false; selection = false; position = 0; duration = 0; lit = [];
      const fresh = await reader(alpha);
      applySpeed(fresh);
      rendering = false; redraw = false;
      await renderDraft();
      // The button pressed was disabled while the editor loaded, and the focus
      // went with it: the first digit typed reached nothing.
      section?.focus({ preventScroll: true });
    } catch (e) {
      console.warn('[tab reader]', e);
      editing = false;
      error = words.editorFailed;
    } finally { busy = false; }
  }

  /** Back to reading: the last file opened, if there is one. */
  async function stopEditing() {
    editing = false;
    clearTimeout(drawTimer);
    api?.destroy(); api = null;
    score = null; ready = false; playing = false; pausing = false; stringCursor = null; lit = []; tail = 0; currentBar = -1;
    const file = await loadMedia('last-score');
    if (file && !disposed && !editing && !score) void open(file, false);
  }

  async function renderDraft() {
    clearTimeout(drawTimer);
    const shown = api;
    if (!shown || !editing) return;
    if (rendering) { redraw = true; return; }
    const alpha = await library();
    if (api !== shown || !editing) return;
    if (rendering) { redraw = true; return; }
    const importer = new alpha.importer.AlphaTexImporter();
    drawn = draft;
    importer.initFromString(toAlphaTex(draft), new alpha.Settings());
    const parsed = importer.readScore();
    parsed.tracks.forEach((t, i) => { t.playbackInfo.isMute = mutedTracks.has(i); t.playbackInfo.isSolo = soloed.has(i); });
    score = parsed; track = cursor.track;
    rendering = true;
    shown.renderScore(parsed, [cursor.track]);
    for (const [i, level] of trackVolumes) if (parsed.tracks[i]) shown.changeTrackVolume([parsed.tracks[i]], level);
  }

  /** `sound`: the edit wrote a note at `at`, to be heard. */
  function commit(next: EditTab, at: Cursor = cursor, sound = false) {
    const t = next.tracks[Math.min(at.track, next.tracks.length - 1)]!;
    cursor = { track: next.tracks.indexOf(t), beat: Math.max(0, Math.min(at.beat, t.beats.length - 1)), string: Math.max(1, Math.min(t.tuning.length, at.string)) };
    if (sound) { written = cursor; onwrite?.(); }
    if (next === draft) { placeCursor(); return; }
    draft = next;
    clearTimeout(drawTimer);
    drawTimer = window.setTimeout(() => { void renderDraft(); void dbPut(STORES.state, draft, DRAFT_KEY); }, 40);
  }
  /**
   * The track being written goes; the one before it is written next. Solo,
   * mute and level are held by track index, so the tracks after it keep
   * theirs by moving down one.
   */
  function deleteTrack() {
    const gone = cursor.track;
    if (draft.tracks.length <= 1) return;
    const shift = <T,>(held: ReadonlyMap<number, T>) => new Map([...held].filter(([i]) => i !== gone).map(([i, v]) => [i > gone ? i - 1 : i, v]));
    const shiftSet = (held: ReadonlySet<number>) => new Set([...held].filter(i => i !== gone).map(i => (i > gone ? i - 1 : i)));
    mutedTracks = shiftSet(mutedTracks); soloed = shiftSet(soloed); trackVolumes = shift(trackVolumes);
    const track = Math.max(0, gone - 1);
    act(removeTrack(draft, gone), { track, beat: 0, string: draft.tracks[track === gone ? gone + 1 : track]!.tuning.length });
  }
  /** A position clicked on the neck, written on the beat under the cursor; the cursor moves to its string. */
  function pickOnNeck(note: { string: number; fret: number }) {
    pendingDigit = null;
    const next = pickFret(draft, cursor, note.string, note.fret);
    const added = next.tracks[cursor.track]?.beats[cursor.beat]?.notes.some(n => n.string === note.string) ?? false;
    act(next, { ...cursor, string: note.string }, added);
  }
  /** From a control: the keys go back to the tab. */
  function act(next: EditTab, at: Cursor = cursor, sound = false) {
    commit(next, at, sound);
    section?.focus({ preventScroll: true });
  }
  /** The note written, once laid out: alphaTab plays it alone, on its track's instrument. */
  function soundWritten() {
    if (drawn !== draft) return;
    const at = written, shown = api;
    written = null;
    const beats = draft.tracks[at?.track ?? -1]?.beats, staff = score?.tracks[at?.track ?? -1]?.staves[0];
    if (!at || !shown || !ready || !beats || !staff) return;
    const [bar, index] = layBeats(beats, barTicks(draft.signature)).at[at.beat] ?? [-1, -1];
    const note = staff.bars[bar]?.voices[0]?.beats[index]?.notes.find(n => n.string === at.string);
    if (note) shown.playNote(note);
  }

  /** The cursor drawn where the beat being written was laid out: alphaTab's own, the string mark and the neck. */
  function placeCursor() {
    const shown = api, beats = draft.tracks[cursor.track]?.beats, staff = score?.tracks[cursor.track]?.staves[0];
    if (!editing || !shown || !beats || !staff) return;
    const [bar, index] = layBeats(beats, barTicks(draft.signature)).at[cursor.beat] ?? [0, 0];
    const beat = staff.bars[bar]?.voices[0]?.beats[index];
    if (!beat) return;
    stringCursor = cursor.string;
    stepped = beat.absolutePlaybackStart;
    currentTick = stepped;
    if (!playing) shown.tickPosition = stepped;
    const x = shown.boundsLookup?.findBeat(beat)?.onNotesX;
    if (x !== undefined && viewport && (x < viewport.scrollLeft + 60 || x > viewport.scrollLeft + viewport.clientWidth - 60)) follow(x, 0);
  }
  /** The beat written at a tick; a rest closing a bar belongs to the beat before it. */
  function cursorAtTick(at: number) {
    const beats = draft.tracks[cursor.track]?.beats, staff = score?.tracks[cursor.track]?.staves[0];
    if (!beats || !staff) return;
    let found = 0;
    layBeats(beats, barTicks(draft.signature)).at.forEach(([bar, index], i) => {
      const beat = staff.bars[bar]?.voices[0]?.beats[index];
      if (beat && beat.absolutePlaybackStart <= at + 1) found = i;
    });
    cursor = { ...cursor, beat: found };
    placeCursor();
  }

  /**
   * Keys while writing. Digits by the key pressed, not the character: the row
   * above the letters types `&é"'` on a French keyboard, and a fret all the
   * same. A keypad with Num Lock off sends arrows from the same keys, and they
   * move the cursor.
   */
  function editKey(e: KeyboardEvent): boolean {
    if (!editing || playing || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.target instanceof Element && e.target.closest('input,select,textarea')) return false;
    const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
    if (digit && e.key.length === 1) {
      const typed = typeDigit(draft, cursor, Number(digit[1]), pendingDigit, performance.now());
      pendingDigit = typed.pending;
      commit(typed.tab, cursor, true);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const moved = stepBeat(draft, cursor, e.key === 'ArrowRight' ? 1 : -1);
      commit(moved.tab, moved.cursor);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      commit(draft, stepString(draft, cursor, e.key === 'ArrowUp' ? 1 : -1));
    } else if (e.code === 'NumpadAdd' || e.key === '+') commit(nudgeDuration(draft, cursor, true));
    else if (e.code === 'NumpadSubtract' || e.key === '-') commit(nudgeDuration(draft, cursor, false));
    else if (e.code === 'NumpadDecimal' || e.key === '.') commit(toggleDotted(draft, cursor));
    else if (e.key === 'r' || e.key === 'R') commit(makeRest(draft, cursor));
    else if (e.key === 'Delete') commit(clearString(draft, cursor));
    else if (e.key === 'Backspace') { const removed = deleteBeat(draft, cursor); commit(removed.tab, removed.cursor); }
    else return false;
    e.preventDefault(); e.stopPropagation();
    return true;
  }

  async function exportGp() {
    const alpha = await library();
    const importer = new alpha.importer.AlphaTexImporter();
    importer.initFromString(toAlphaTex(draft), new alpha.Settings());
    const bytes = new alpha.exporter.Gp7Exporter().export(importer.readScore(), new alpha.Settings());
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${words.untitled}.gp`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /**
   * alphaTab signs every layout with "rendered by alphaTab" under the last
   * line, and has no setting to leave it out. It is not a licence condition
   * (MPL-2.0 asks for nothing on screen), and in a reader of one line it is a
   * caption under the music that says nothing about it. The signature arrives
   * as a part of its own, holding that one text: it is hidden as it is added,
   * looking only at added parts and at how many texts they hold, never at the
   * text of the whole score.
   */
  const SIGNATURE = 'rendered by alphaTab';
  const signature = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement || node instanceof SVGElement)) continue;
      const texts = node.getElementsByTagName('text');
      if (texts.length === 1 && texts[0]!.textContent?.trim() === SIGNATURE) (node as HTMLElement).style.display = 'none';
    }
  });

  onMount(() => {
    signature.observe(surface, { childList: true, subtree: true });
    // The stage is sized by what surrounds it — the transport, the recorder's
    // tracks, the window — never by what it holds, so measuring it cannot loop.
    const room = new ResizeObserver(([entry]) => { stageHeight = entry?.contentRect.height ?? 0; });
    room.observe(stage);
    void dbGet<{ open?: unknown }>(STORES.state, NECK_KEY).then(saved => {
      if (!disposed && typeof saved?.open === 'boolean') neckOpen = saved.open;
    });
    void dbGet<{ scaleId?: unknown; scaleRoot?: unknown }>(STORES.state, SCALE_KEY).then(saved => {
      if (disposed || !saved) return;
      if (typeof saved.scaleId === 'string' && (saved.scaleId === '' || scaleById(saved.scaleId))) scaleId = saved.scaleId;
      if (typeof saved.scaleRoot === 'number' && Number.isInteger(saved.scaleRoot) && saved.scaleRoot >= 0 && saved.scaleRoot < 12) scaleRoot = saved.scaleRoot;
    });
    void loadMedia('last-score').then(file => { if (file && !disposed && !busy && !score) void open(file, false); });
  });
  onDestroy(() => { disposed = true; cancelCue(); cancelAnimationFrame(settling); signature.disconnect(); dropPlayback(); api?.destroy(); });
</script>

<section class="reader" role="application" aria-label={words.region} tabindex="-1"
  bind:this={section} onkeydown={keydown} onpointerdown={grabKeys}>
  <!-- One row: what is on the lectern, how it is shown, and where another comes
       from. Playing it is the studio's transport, at the foot of the screen. -->
  <div class="reader-heading">
    <div class="reader-title">
      {#if editing || !score}<span class="eyebrow">{editing ? words.editor : words.title}</span>{/if}
      {#if score && !editing}<h2 title={score.title || filename}>{score.title || filename}{#if score.artist}<span> · {score.artist}</span>{/if}</h2>{/if}
      <!-- Which track is being read and played. A score with several parts
           looks the same whichever one is on the lectern, and the only place
           that said so was a panel nobody opens while playing. -->
      {#if score && !editing && score.tracks.length > 1}
        <p class="following" class:silent={followingSilent} aria-label={(followingSilent ? words.followingSilent : words.following)(followingName)}>
          <span class="following-lamp" aria-hidden="true"></span>
          <span class="track-number" aria-hidden="true">{String(track + 1).padStart(2, '0')}</span>
          <span class="following-name">{followingName}</span>
        </p>
      {/if}
    </div>
    {#if score}
      <div class="display">
        <label>{words.view}<select aria-label={words.viewLabel} bind:value={notation} onchange={updateDisplay}><option value="tab">{words.viewTab}</option><option value="both">{words.viewBoth}</option></select></label>
        <label>{words.zoom}<select aria-label={words.zoomLabel} bind:value={zoom} onchange={updateDisplay}>{#each [75, 90, 100, 110, 125, 150] as n}<option value={n}>{n}%</option>{/each}</select></label>
        <!-- The tab through the rig, or through the soundfont as it always was.
             Without a capture there is no amplifier to play it in, and it says so. -->
        {#if ampOffered}
          <label>{words.plays}<select aria-label={words.playsLabel} disabled={busy || !tone?.capture}
            title={tone?.capture ? '' : words.ampNeedsCapture} value={amped ? 'amp' : 'soundfont'}
            onchange={e => void setAmped(e.currentTarget.value === 'amp')}>
            <option value="soundfont">{words.soundfont}</option>
            <option value="amp">{words.amp}</option>
          </select></label>
        {/if}
      </div>
    {/if}
    <div class="heading-actions">
      <button class="secondary write-tab" aria-pressed={editing} disabled={busy} onclick={() => (editing ? stopEditing() : startEditing())}>{editing ? words.closeEditor : words.write}</button>
      <button class="primary" class:settled={!!score} disabled={busy} onclick={() => picker.click()}>{busy ? words.opening : score ? words.openAnother : words.import}</button>
    </div>
    <input bind:this={picker} type="file" accept={ACCEPT} aria-label={words.importLabel} onchange={e => { const f = e.currentTarget.files?.[0]; if (f) void open(f); e.currentTarget.value = ''; }} />
  </div>
  {#if ampProgress >= 0}
    <p class="amp-state" role="status">
      <span class="amp-bar" aria-hidden="true"><span style:width={`${Math.round(ampProgress * 100)}%`}></span></span>
      {waiting ? words.ampWaiting : words.ampRendering(Math.round(ampProgress * 100))}
    </p>
  {:else if ampStale && mixLoaded}
    <p class="amp-state" role="status">{words.ampStale}
      <button class="quiet" type="button" onclick={() => void renderAmp()}>{words.ampAgain}</button>
    </p>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if storageNote}<p class="storage-note" role="status">{storageNote}</p>{/if}
  <div class="drop-surface" class:dragging role="region" aria-label={words.dropFile}
    ondragover={e => { e.preventDefault(); dragging = true; }}
    ondragleave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) dragging = false; }}
    ondrop={e => { e.preventDefault(); dragging = false; const f = e.dataTransfer?.files[0]; if (f) void open(f); }}>
    {#if editing && score}
      <div class="editor-bar" role="toolbar" aria-label={words.editor}>
        <label>{words.bpm}<input class="tempo" type="number" aria-label={words.tempo} min="30" max="300" step="1" value={draft.tempo}
          onchange={e => act(setTempo(draft, Number(e.currentTarget.value)))} /></label>
        <label>{words.time}<select class="signature-select" aria-label={words.signature} value={`${draft.signature.numerator}/${draft.signature.denominator}`}
          onchange={e => { const [n, d] = e.currentTarget.value.split('/').map(Number); act(setSignature(draft, n!, d!)); }}>
          {#each SIGNATURES as s}<option value={`${s.numerator}/${s.denominator}`}>{s.numerator}/{s.denominator}</option>{/each}
        </select></label>
        <div class="durations" role="group" aria-label={words.duration}>
          {#each DURATIONS as d}<button aria-pressed={editBeat?.duration === d} onclick={() => act(setDuration(draft, cursor, d))}>1/{d}</button>{/each}
          <button aria-pressed={editBeat?.dotted ?? false} onclick={() => act(toggleDotted(draft, cursor))}>{words.dotted}</button>
          <button aria-pressed={editBeat !== null && editBeat.notes.length === 0} onclick={() => act(makeRest(draft, cursor))}>{words.rest}</button>
        </div>
        <button title={words.deleteKey} disabled={!editBeat?.notes.some(n => n.string === cursor.string)} onclick={() => act(clearString(draft, cursor))}>{words.deleteNote}</button>
        <button title={words.backspaceKey} disabled={editTrack.beats.length <= 1 && editBeat?.notes.length === 0} onclick={() => { const removed = deleteBeat(draft, cursor); act(removed.tab, removed.cursor); }}>{words.deleteBeat}</button>
        <label>{words.strings}<select aria-label={words.stringCount} value={editTrack.tuning.length}
          onchange={e => { const n = Number(e.currentTarget.value); act(setStrings(draft, cursor.track, n), { ...cursor, string: cursor.string + n - editTrack.tuning.length }); }}>
          {#each STRING_COUNTS as n}<option value={n}>{n}</option>{/each}
        </select></label>
        <label>{words.tuning}<select class="tuning-select" aria-label={words.tuning} value={tuningIndex}
          onchange={e => { const t = tunings[Number(e.currentTarget.value)]; if (t) act(setTuning(draft, cursor.track, t.notes)); }}>
          {#each tunings as t, i}<option value={i}>{words.tuningName(t.name)}</option>{/each}
        </select></label>
        <button onclick={() => act(addTrack(draft), { track: draft.tracks.length, beat: 0, string: 6 })}>{words.addTrack}</button>
        <button disabled={draft.tracks.length <= 1} onclick={deleteTrack}>{words.deleteTrack}</button>
        <button class="primary export" onclick={exportGp}>{words.exportGp}</button>
      </div>
    {/if}
    <div class="reader-body" class:empty={!score}>
      {#if score}
        <!-- Opened from the studio's transport, over everything: the tab keeps
             the whole width, and the list is there when a track is wanted. -->
        <aside id="tab-tracks" class="tc-popover" popover aria-label={words.scoreTracks}>
          <span class="eyebrow">{words.tracks(score.tracks.length)}</span>
          <div class="tracks">{#each score.tracks as t, i}
            <div class="track-row">
              <button class:selected={track === i} class:muted={mutedTracks.has(i)} class:silenced={soloed.size > 0 && !soloed.has(i)} aria-pressed={track === i} onclick={() => chooseTrack(i)}><span class="track-number">{String(i + 1).padStart(2, '0')}</span><span class="track-name">{t.name || words.trackN(i + 1)}</span>{#if soloed.has(i)}<span class="flag solo" title={words.soloTitle}>{words.soloFlag}</span>{/if}{#if mutedTracks.has(i)}<span class="flag mute" title={words.mutedTitle}>{words.muteFlag}</span>{/if}<span class="track-bars" title={words.barsWithNotes(activity[i]?.bars ?? 0, score.masterBars.length)}>{activity[i]?.bars ?? 0}</span></button>
              <input class="track-volume" type="range" min="0" max="100" step="1" aria-label={words.volumeOf(t.name || words.trackN(i + 1))}
                value={Math.round((trackVolumes.get(i) ?? 1) * 100)}
                oninput={e => setTrackVolume(i, Number(e.currentTarget.value) / 100)} />
            </div>
          {/each}</div>
          <div class="track-tools">
            <button aria-pressed={solo} class:active={solo} onclick={toggleSolo}>{words.solo}</button>
            <button aria-pressed={muted} class:active={muted} onclick={toggleMute}>{words.mute}</button>
          </div>
          <p class="plays">
            {#if selected.first >= 0}<b>{selected.first + 1}–{selected.last + 1}</b> · {selected.bars}/{score.masterBars.length}
              <button class="jump quiet" onclick={goToTrack}>{words.firstBar}</button>
            {:else}0/{score.masterBars.length}{/if}
          </p>
          <p>{deck.bpm} BPM <span>· {words.bars(score.masterBars.length)}</span></p>
        </aside>
      {/if}
      <div class="stage" class:cramped={!roomForNeck} bind:this={stage}>
      <div class="score-viewport" class:has-score={!!score} bind:this={viewport}>
        {#if !score}
          <div class="empty-state">
            <div class="tab-mark" aria-hidden="true"><span>TAB</span><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <span class="formats">GP · GPX · GP3 / GP4 / GP5 · MUSICXML · CAPELLA · ALPHATEX</span>
          </div>
        {/if}
        <div class="score-paper" class:hidden={!score} bind:this={surface}></div>
        {#if stringMark}<span class="string-cursor" aria-hidden="true" style:transform={`translate(${stringMark.x}px, ${stringMark.y}px)`}></span>{/if}
        {#if tail > 0}<div class="score-tail" style:width={`${tail}px`}></div>{/if}
      </div>
      {#if score && stave && roomForNeck}
        <div class="scale-bar">
          <span class="eyebrow">{words.scale}</span>
          <label>{words.key}<select aria-label={words.scaleKey} bind:value={scaleRoot} onchange={rememberScale}>{#each KEYS as k}<option value={k.root}>{k.label}</option>{/each}</select></label>
          <label>{words.scale}<select aria-label={words.scale} bind:value={scaleId} onchange={rememberScale}>
            <option value="">{words.none}</option>
            {#each SCALE_GROUPS as group}<optgroup label={words.scaleGroups[group] ?? group}>{#each SCALES.filter(s => s.group === group) as s}<option value={s.id}>{words.scales[s.id] ?? s.name}</option>{/each}</optgroup>{/each}
          </select></label>
          {#if scaleDef}
            <span class="scale-notes" aria-label={words.scaleNotes}>{scaleNames.join(' · ')}</span>
            <span class="legend" aria-hidden="true"><i class="root"></i>{words.root}<i class="tone"></i>{words.scaleTone}<i class="play"></i>{words.playing}</span>
          {/if}
        </div>
        <Fretboard strings={stave.tuning} {lit} capo={stave.capo} scale={scaleNotes} onpick={editing && !playing ? pickOnNeck : undefined} />
      {:else if score && stave}
        <!-- No room under the tab: the neck becomes a window over it, opened
             and closed at will. Same neck, same lights, same paper — only the
             room it is given changes (CLAUDE.md section 4). -->
        {#if neckOpen}
          <div class="neck-window">
            <Fretboard strings={stave.tuning} {lit} capo={stave.capo} scale={scaleNotes} onpick={editing && !playing ? pickOnNeck : undefined} />
            <button class="neck-close" aria-label={words.hideNeck} title={words.hideNeck} onclick={toggleNeck}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>
            </button>
          </div>
        {:else}
          <button class="neck-handle" aria-label={words.showNeck} title={words.showNeck} onclick={toggleNeck}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
              <path d="M2 3.5h12M2 6h12M2 8.5h12M2 11h12" />
              <path d="M5.5 2v11M10.5 2v11" stroke-opacity="0.5" />
            </svg>
            <span>{words.neck}</span>
          </button>
        {/if}
      {/if}
      </div>
    </div>
  </div>
</section>

<style>
  /* The whole stage of the Play view: the studio gives it a height and the
     reader fills it, the track list and the neck included, never the page. */
  .reader { display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0; }
  .reader:focus { outline: none; }
  .reader-heading { display: flex; align-items: center; gap: 16px; min-height: 56px; padding: 8px 20px; box-sizing: border-box; }
  .reader-title { display: flex; flex-direction: column; gap: 6px; flex: 1 1 0; min-width: 0; }
  .eyebrow { font: 400 10px/1 var(--display); font-stretch: 125%; letter-spacing: 0.16em; text-transform: uppercase; color: var(--text-2); }
  h2 { margin: 0; overflow: hidden; font: 500 var(--type-title)/1.2 var(--body); color: var(--text); text-overflow: ellipsis; white-space: nowrap; }
  h2 span { color: var(--text-2); font-weight: 400; }
  /* Under the title, on the module step every name in the studio is set on.
     A lamp, because that is what the studio uses to say a thing is live: lit
     while the track is heard, dark while it is muted or soloed out. */
  .following {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    margin: 0;
    font: 400 10px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-2);
  }
  .following-lamp {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 5px #d6b6e399;
  }
  .following-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
  .following.silent .following-lamp { background: none; box-shadow: none; border: 1px solid var(--violet-700); }
  .following.silent .following-name { color: var(--text-3); text-decoration: line-through; }
  .display { display: flex; align-items: center; gap: 14px; }
  .heading-actions { display: flex; gap: 10px; }
  .reader-heading > input { display: none; }

  /* Buttons and selects: the studio's secondary, primary and quiet weights. */
  button, select {
    min-height: 34px;
    padding: 0 12px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    font: 12px var(--body);
    cursor: pointer;
  }
  button:hover:not(:disabled), select:hover:not(:disabled) { border-color: var(--violet-500); }
  button:hover:not(:disabled) { background: #29252f; }
  button:disabled { opacity: .45; cursor: wait; }
  select { appearance: none; padding-right: 28px; background: var(--surface-2) var(--chevron) no-repeat right 10px center; }
  select:focus-visible, input:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }
  .primary { border-color: var(--violet-500); background: var(--action); color: var(--action-text); font-weight: 500; }
  .primary:hover:not(:disabled) { background: var(--action-hover); }
  .primary.settled { border-color: var(--line-strong); background: var(--surface-2); color: var(--text); font-weight: 400; }
  .primary.settled:hover:not(:disabled) { background: #29252f; }
  .quiet { border-color: transparent; background: none; color: var(--text-2); }
  .quiet:hover:not(:disabled) { border-color: transparent; background: none; color: var(--text); }
  [aria-pressed='true'], .active { border-color: var(--accent-line); background: var(--violet-900); color: var(--violet-100); }
  .error, .storage-note, .amp-state { margin: 0; padding: 0 20px 10px; font-size: 13px; }
  .error { color: var(--ember); }
  /* What the render is doing, on the row under the title: the transport says
     the tab is not ready, and this says why and how far along it is. */
  .amp-state { display: flex; align-items: center; gap: 10px; color: var(--text-2); }
  .amp-bar { flex: 0 0 120px; height: 3px; border-radius: 2px; background: var(--surface-2); overflow: hidden; }
  .amp-bar span { display: block; height: 100%; background: var(--accent); transform-origin: left; transition: width var(--fast, 120ms) linear; }
  .amp-state button { color: var(--accent); }
  .storage-note { color: var(--text-2); }

  .drop-surface { display: flex; flex: 1; flex-direction: column; min-height: 0; }
  .dragging { outline: 2px dashed var(--accent-line); outline-offset: -5px; }
  .editor-bar, .scale-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 20px; border-top: 1px solid #050407; box-shadow: inset 0 1px 0 #ffffff0a; }
  .display label, .editor-bar label, .scale-bar label { display: flex; align-items: center; gap: 8px; font: 400 9px/1 var(--display); font-stretch: 125%; letter-spacing: 0.16em; text-transform: uppercase; color: var(--text-3); }
  .tempo { width: 62px; box-sizing: border-box; min-height: 34px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--surface-2); color: var(--text); font: 12px var(--body); }
  .durations { display: flex; flex-wrap: wrap; gap: 3px; }
  .durations button { padding: 0 8px; font: 11px var(--body); }
  .export { margin-left: auto; }

  .reader-body { display: flex; flex: 1; flex-direction: column; min-height: 0; border-top: 1px solid #050407; box-shadow: inset 0 1px 0 #ffffff0a; }
  .reader-body.empty { justify-content: center; }
  /* Rises from the transport's Tracks button, at the left of the screen. */
  aside {
    position: fixed;
    inset: auto auto calc(var(--transport-height, 64px) + 8px) 16px;
    width: 280px;
    max-height: calc(100dvh - 240px);
    margin: 0;
    padding: 16px 14px;
    /* The panel itself does not scroll: its list does. Solo, mute, the jump to
       the first bar and the counts under them are what the list is operated
       with, and on a score of twenty parts they scrolled off the bottom of it. */
    overflow: hidden;
    box-sizing: border-box;
  }
  aside:popover-open { display: flex; flex-direction: column; }
  /* Over the button that opened it, where anchoring exists; the corner otherwise. */
  @supports (position-anchor: --a) {
    aside { position-anchor: --tab-tracks; inset: auto; bottom: anchor(top); left: anchor(left); margin-bottom: 8px; position-try-fallbacks: flip-inline; }
  }
  /* The one part that scrolls. `min-height: 0` because a grid in a flex column
     takes its content's height by default and would push the tools out again. */
  .tracks { flex: 1 1 auto; min-height: 0; display: grid; align-content: start; gap: 4px; margin-top: 14px; overflow-y: auto; overscroll-behavior: contain; }
  .track-row { display: grid; min-width: 0; }
  .tracks button { display: flex; align-items: baseline; gap: 10px; padding: 9px 8px; border-color: transparent; background: none; text-align: left; line-height: 1.5; overflow-wrap: anywhere; font-size: 13px; }
  .tracks button:hover:not(:disabled) { border-color: var(--line); background: var(--surface-2); }
  .tracks .selected, .tracks .selected:hover:not(:disabled) { border-color: var(--accent-line); background: var(--violet-900); color: var(--text); }
  .track-volume { width: calc(100% - 16px); height: 18px; margin: 0 8px 4px; cursor: pointer; }
  .track-number { flex-shrink: 0; font: 10px var(--body); color: var(--text-3); }
  .track-name { min-width: 0; }
  .track-bars { flex-shrink: 0; margin-left: auto; font: 10px var(--body); color: var(--text-3); }
  .tracks .selected .track-bars { color: var(--text-2); }
  .flag { flex-shrink: 0; align-self: center; margin-left: auto; padding: 3px 5px; border-radius: 2px; font: 9px/1 var(--body); }
  .flag + .flag, .flag ~ .track-bars { margin-left: 0; }
  .flag.mute { background: var(--ember-line); color: #f6ddd6; }
  .flag.solo { background: var(--violet-600); color: var(--violet-50); }
  .tracks .muted .track-name, .tracks .silenced .track-name { opacity: .45; }
  .tracks .muted .track-name { text-decoration: line-through; }
  /* Pinned under the list, with the light along its top lip that every other
     edge in the studio has, so it reads as a foot rather than as a last row. */
  .track-tools { flex-shrink: 0; display: flex; gap: 6px; margin: 0 8px; padding-top: 12px; border-top: 1px solid var(--line); box-shadow: 0 -1px 0 #ffffff0a; }
  .track-tools button { flex: 1; min-height: 30px; font-size: 11px; }
  aside p { margin: 0; padding: 0 8px; font: 11px/1.7 var(--body); color: var(--text-2); }
  aside p span { color: var(--text-3); }
  aside > p { flex-shrink: 0; }
  .plays { margin-top: 14px !important; font: 12px/1.7 var(--body) !important; }
  .plays b { color: var(--text); font-weight: 500; }
  .jump { display: block; min-height: 28px; margin: 2px 0 6px -8px; padding: 0 8px; font-size: 12px; text-decoration: underline; text-decoration-color: var(--violet-500); text-underline-offset: 3px; }

  /* The lectern: paper under a lamp, framed and set into the plate, fading in
     when a score lands on it. The paper stays light because notation is read. */
  /* The line sits in the middle of the height it is given, the neck under it. */
  .stage { position: relative; display: flex; flex: 1; flex-direction: column; justify-content: center; gap: 14px; min-width: 0; min-height: 0; padding: 16px; overflow: hidden; container: lectern / size; }
  /* Under a neck's worth of room the neck is not drawn under the tab at all
     (see NECK_ROOM): alone, the paper is a whole sheet — no dark band above and
     below a line — and it takes the stage's height, never more. At `0 auto` a
     tall system overflowed a stage that clips, and the tab lost its top and
     bottom. */
  .stage.cramped .score-viewport.has-score { flex: 1 1 auto; }
  /* The neck's window: the same neck, over the tab rather than under it, with
     a handle in the corner it rises from. Both sit above the paper and below
     anything the studio opens over the whole stage. */
  /* Closed, a handle in the corner the window rises from; open, the window
     carries its own way out. Both are plate on the stage, never on the paper:
     a button the colour of the neck it sits on is a button nobody finds. */
  .neck-handle, .neck-close {
    position: absolute; z-index: 3;
    display: flex; align-items: center; gap: 7px;
    border: 1px solid var(--line-strong); border-radius: var(--radius);
    background: var(--surface-2); color: var(--text-2);
    box-shadow: 0 6px 16px #0008;
    font: 400 9px/1 var(--display); font-stretch: 125%; letter-spacing: 0.16em; text-transform: uppercase;
  }
  .neck-handle { right: 16px; bottom: 14px; padding: 9px 12px; }
  .neck-close { top: 8px; right: 8px; padding: 6px; }
  .neck-handle:hover, .neck-close:hover { color: var(--text); border-color: var(--accent-line); }
  .neck-window {
    position: absolute; left: 16px; right: 16px; bottom: 14px; z-index: 2;
    display: flex; padding: 5px;
    border: 1px solid var(--line-strong); border-radius: var(--radius);
    background: var(--faceplate), var(--surface-1);
    box-shadow: 0 18px 40px #000b, inset 0 1px 0 #ffffff0a;
    animation: neck-in var(--dur-settle) var(--ease-out);
  }
  .neck-window > :global(.neck) { flex: 1; min-height: 104px; max-height: 40cqh; }
  @keyframes neck-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .neck-window { animation: none; } }
  /* The paper takes what it needs and gives back the rest: a system alphaTab
     lays out taller than the lectern — a header, a tempo mark and a section
     name above one staff — used to push the neck out of the stage, which
     clips, so the neck was drawn below it, cut in half. It keeps a readable
     floor and scrolls inside itself instead. */
  .score-viewport { position: relative; flex: 0 1 auto; min-width: 0; min-height: 140px; overflow-x: auto; overflow-y: auto; scrollbar-color: var(--violet-400) #e9e3d7; }
  .has-score {
    display: flex;
    align-items: stretch;
    border-radius: var(--radius);
    background: radial-gradient(ellipse 80% 120% at 50% 0%, #fffdf8 0%, #f6f1e7 55%, #ebe4d6 100%);
    color: #222;
    box-shadow: var(--shadow), 0 0 0 1px #000, inset 0 0 0 1px #ffffff80;
    animation: lectern-in var(--dur-settle) var(--ease-out);
  }
  @keyframes lectern-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .has-score { animation: none; } }
  .score-tail { flex: 0 0 auto; }
  .score-paper { flex: 0 0 auto; min-width: 100%; min-height: 120px; background: transparent; color: #171717; }
  .hidden { display: none; }
  .string-cursor { position: absolute; left: -10px; top: -8px; z-index: 2; width: 20px; height: 16px; box-sizing: border-box; border: 1.5px solid #a37320; border-radius: 3px; background: #a373201f; pointer-events: none; will-change: transform; }
  .empty-state { padding: 44px 24px 48px; text-align: center; }
  .formats { display: block; margin-top: 22px; font: 10px var(--body); letter-spacing: 1px; color: var(--text-3); }
  .tab-mark { position: relative; width: 124px; margin: auto; padding: 4px 0; }
  .tab-mark i { display: block; height: 1px; margin: 7px 0; background: var(--violet-700); }
  .tab-mark span { position: absolute; inset: 0; display: grid; place-items: center; font: 400 15px/1 var(--display); font-stretch: 125%; letter-spacing: 0.3em; color: var(--violet-200); background: linear-gradient(90deg, transparent, #141218 32%, #141218 68%, transparent); }

  .scale-bar { margin: 0 -16px; padding: 10px 16px 0; }
  .scale-notes { font: 11px var(--body); color: var(--text); letter-spacing: .5px; }
  .legend { display: flex; align-items: center; gap: 6px; margin-left: auto; font: 10px var(--body); color: var(--text-2); }
  .legend i { display: inline-block; width: 10px; height: 10px; margin-left: 8px; border-radius: 50%; box-sizing: border-box; }
  .legend .root { background: var(--violet-400); }
  .legend .tone { border: 1.5px solid var(--violet-400); }
  .legend .play { background: #c08a32; }


  :global(.at-cursor-bar) { background: #bda77230; }
  :global(.at-cursor-beat) { background: #866329; width: 3px; }
  :global(.at-selection div) { background: #bda77244; }
  :global(.at-highlight *) { fill: #a37320 !important; stroke: #a37320 !important; }
  @media (max-width: 760px) {
    .reader { height: auto; }
    /* The page scrolls here: the lectern has no height to be a size container of. */
    .stage { container-type: normal; }
    .reader-heading { flex-wrap: wrap; }
    .display { order: 3; flex-basis: 100%; }
    .editor-bar { padding: 10px 12px; gap: 8px; }
    .scale-bar { gap: 8px; }
    .legend { display: none; }
    .reader-heading { padding: 14px; }
    .heading-actions { gap: 6px; }
    .heading-actions button { padding: 0 8px; }
    aside { left: 8px; right: 8px; width: auto; }
    .stage { padding: 10px; }
    .empty-state { padding: 32px 18px; }
  }
</style>
