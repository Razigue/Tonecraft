<script lang="ts">
  /**
   * The rig.
   *
   * The chain *is* the interface (DESIGN.md section 4): the signal path runs
   * left to right in the order the audio travels, and there is no navigation,
   * no sidebar and no tabs. The page is the rig.
   *
   * What it says about the sound it makes: a NAM capture is a frozen snapshot
   * of one amplifier at one setting, so the amp module has no gain and no EQ —
   * they are baked into the capture and cannot be driven. The capture and the
   * cabinet are the two real tone choices, which is why they sit *in* their
   * modules rather than in a settings panel. Everything else sets what we send
   * into the model and what we do with what comes back.
   *
   * The round trip is always on screen because FR-35 requires it. A hardware
   * diagnosis, a dropout count and an error appear only when there is one — the
   * product's voice is to state what happened and otherwise stay quiet.
   */
  import { Engine, EngineError, readCatalog, type Meters, type Health,
           type InputChannel, type InputDevice, type Source } from '../engine/engine.ts';
  import { CABS } from '../engine/ir.ts';
  import type { Capture } from '../engine/catalog.ts';
  import { PARAMS, STAGES, type Param } from '../schema/params.ts';
  import { PRESETS, DEFAULT_PRESET, type Preset } from './presets.ts';
  import Fader from './Fader.svelte';
  import Module from './Module.svelte';
  import Meter from './Meter.svelte';
  import Segmented from './Segmented.svelte';
  import Waveform from './Waveform.svelte';
  import './tokens.css';

  type State = 'idle' | 'starting' | 'running' | 'failed';

  const param = (id: string): Param => PARAMS.find((p) => p.id === id)!;

  /**
   * The strand, in signal order. The amp and the cab carry no fader at all:
   * their control is which capture and which cabinet, and inventing a knob that
   * did nothing would be a lie about what a capture is.
   */
  const STRAND: readonly { stage: string; faders: readonly string[] }[] = [
    { stage: 'input', faders: ['in_trim'] },
    { stage: 'gate', faders: ['gate_threshold'] },
    { stage: 'drive', faders: ['drive_gain', 'drive_tone'] },
    { stage: 'amp', faders: [] },
    { stage: 'cab', faders: [] },
    { stage: 'tone', faders: ['tone_bass', 'tone_mid', 'tone_treble', 'tone_presence'] },
    { stage: 'reverb', faders: ['reverb_mix'] },
    { stage: 'output', faders: ['out_master'] },
  ];

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

  const STORE = 'tonecraft-v1';

  let state = $state<State>('idle');
  let problem = $state<{ cause: string; fix: string } | null>(null);
  let health = $state<Health | null>(null);
  let showLatency = $state(false);
  /** The opening sheet. Dismissible: looking around is never blocked. */
  let asking = $state(true);
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
    Object.fromEntries(PARAMS.map((p) => [p.id, p.default])),
  );
  let captures = $state<readonly Capture[]>([]);
  let captureFile = $state('');
  let cab = $state('v30mod');
  /** Whether the player has chosen a cabinet themselves since the last capture. */
  let cabTouched = $state(false);
  let preset = $state<string | null>(DEFAULT_PRESET);

  let devices = $state<InputDevice[]>([]);
  let deviceId = $state('');
  let channel = $state<InputChannel>('follow');
  let channelCount = $state(1);
  let source = $state<Source>('live');
  /** Hearing the guitar as it arrives rather than as the chain leaves it. */
  let direct = $state(false);

  let meters = $state<Meters>({
    input: 0, drive: 0, output: 0, outputRms: 0, gate: 1, channelPeaks: [0], channels: 1,
  });

  let fileName = $state('');
  let filePeaks = $state<Float32Array | null>(null);
  let fileDuration = $state(0);
  let filePosition = $state(0);
  let filePlaying = $state(false);
  let fileLoop = $state(true);
  let dragging = $state(false);

  let engine: Engine | null = null;
  let frame = 0;

  const capture = $derived(captures.find((c) => c.file === captureFile) ?? null);
  const cabInfo = $derived(CABS.find((c) => c.id === cab) ?? CABS[0]!);
  const labelOf = (id: string): string => STAGES.find((s) => s.id === id)?.label ?? id;
  const bypassOf = (id: string): string | null =>
    STAGES.find((s) => s.id === id)?.bypassParam ?? null;

  /**
   * The cord (DESIGN.md section 5). Its opacity per segment is the amplitude at
   * that point in the chain, so a pick attack is visible travelling along it and
   * "no signal is reaching the amp" is obvious rather than deduced.
   *
   * Past the amp there is one measurement, taken at the very end: the captures
   * run inside a worklet that reports nothing of its own, and adding a meter
   * between every node would cost more than it tells anybody.
   */
  const level = (v: number): number => Math.min(1, Math.sqrt(Math.max(0, v)) * 1.6);
  const cordLevels = $derived([
    level(meters.input),                       // in -> gate
    level(meters.input * meters.gate),         // gate -> boost
    level(meters.drive),                       // boost -> amp
    level(meters.output),                      // amp -> cab
    level(meters.output),                      // cab -> tone
    level(meters.output),                      // tone -> reverb
    level(meters.output),                      // reverb -> out
  ]);
  const clipping = $derived(meters.output > 0.98);

  // --------------------------------------------------------------------------
  // Persistence. Local only, and never a reason to fail: a private window that
  // refuses storage still plays.

  function persist(): void {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        values, captureFile, cab, channel, deviceId, source, preset,
      }));
    } catch { /* storage refused */ }
  }

  function restore(): void {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw === null) return;
      const saved = JSON.parse(raw) as Record<string, unknown>;
      const v = saved['values'];
      if (typeof v === 'object' && v !== null) {
        // Only ids the schema still declares, so a stored value cannot outlive
        // the parameter it belonged to.
        for (const p of PARAMS) {
          const n = (v as Record<string, unknown>)[p.id];
          if (typeof n === 'number') values[p.id] = n;
        }
      }
      if (typeof saved['captureFile'] === 'string') captureFile = saved['captureFile'];
      if (typeof saved['cab'] === 'string') cab = saved['cab'];
      if (typeof saved['channel'] === 'string') channel = saved['channel'] as InputChannel;
      if (typeof saved['deviceId'] === 'string') deviceId = saved['deviceId'];
      if (typeof saved['source'] === 'string') source = saved['source'] as Source;
      preset = typeof saved['preset'] === 'string' ? saved['preset'] : null;
    } catch { /* unreadable, so ignored */ }
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
    direct = !direct;
    engine?.setDirect(direct);
  }

  /**
   * The same thing from the keyboard, because an A/B you have to aim at is an
   * A/B people do twice. Ignored while a control has focus, so it cannot fire
   * while somebody is typing in a field or nudging a fader.
   */
  function onWindowKey(event: KeyboardEvent): void {
    if (state !== 'running') return;
    if (event.key.toLowerCase() !== BYPASS_KEY) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) {
      const tag = active.tagName.toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (active.getAttribute('role') === 'slider') return;
    }
    event.preventDefault();
    toggleChain();
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
  }

  async function chooseSource(next: string): Promise<void> {
    source = next as Source;
    persist();
    await engine?.setSource(source);
    if (source === 'file' && filePeaks !== null && state === 'running') play();
    if (source === 'live') { engine?.stopFile(); filePlaying = false; }
  }

  function onModel(file: string, ok: boolean): void {
    if (file === captureFile || file === '') captureLoaded = ok;
  }

  function onEngineError(message: string): void {
    captureLoaded = false;
    notice = `The amplifier engine did not start (${message}). Reload the page; ` +
      'if it persists, run `npm run vendor`.';
  }

  function onMeters(m: Meters): void {
    meters = m;
    channelCount = m.channels;
    health = engine?.health ?? null;
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

  async function loadFile(file: File | undefined): Promise<void> {
    if (file === undefined || engine === null) return;
    try {
      const buffer = await engine.loadFile(file);
      fileName = file.name;
      fileDuration = buffer.duration;
      filePeaks = peaksOf(buffer);
      filePosition = 0;
      notice = null;
      if (source === 'file' && state === 'running') play();
    } catch (error) {
      notice = `That file could not be decoded: ${String((error as Error).message)}`;
    }
  }

  async function loadDemo(): Promise<void> {
    if (engine === null) return;
    try {
      const buffer = await engine.loadDemoTake();
      fileName = 'Demo take (Tonecraft)';
      fileDuration = buffer.duration;
      filePeaks = peaksOf(buffer);
      filePosition = 0;
      notice = null;
      if (source === 'file' && state === 'running') play();
    } catch {
      notice = 'The demo take is not installed. It lives in public/di/.';
    }
  }

  function play(): void {
    if (engine === null || filePeaks === null) return;
    if (state !== 'running') { notice = 'Press start to power the chain.'; return; }
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
   */
  function tick(): void {
    frame = requestAnimationFrame(tick);
    if (filePlaying && engine !== null) {
      filePosition = engine.filePosition;
      if (!engine.filePlaying) filePlaying = false;
    }
  }

  // --------------------------------------------------------------------------

  async function start(): Promise<void> {
    state = 'starting';
    problem = null;
    engine = new Engine({ onMeters, onModel, onEngineError });
    try {
      captures = (await engine.loadCatalog()).models;
      settleCapture();
      engine.setInputChannel(channel);
      await engine.setCapture(captureFile);
      engine.setCab(cab);
      await engine.start();
      // Anything moved before starting carries over — the rig is live-looking
      // from the first frame, so it has to be honest about what it shows.
      for (const p of PARAMS) {
        if (p.deprecated !== true) engine.setParam(p.id, values[p.id] ?? p.default);
      }
      health = engine.health;
      asking = false;
      state = 'running';
      // Labels are withheld until permission has been granted, so the device
      // list is only meaningful from here on.
      devices = await engine.listInputs();
      channelCount = engine.channelCount;
      if (source === 'file' && filePeaks !== null) play();
      frame = requestAnimationFrame(tick);
    } catch (error) {
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
      state = 'failed';
    }
  }

  async function stop(): Promise<void> {
    cancelAnimationFrame(frame);
    await engine?.stop();
    engine = null;
    filePlaying = false;
    health = null;
    captureLoaded = false;
    state = 'idle';
    meters = { input: 0, drive: 0, output: 0, outputRms: 0, gate: 1, channelPeaks: [0], channels: 1 };
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
  // is client:only, so localStorage exists by the time this runs.
  restore();
  void readCatalog().then((catalog) => {
    captures = catalog.models;
    settleCapture();
  });
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="page">
  <header class="bar">
    <span class="t-wordmark">Tonecraft</span>

    <div class="bar-right">
      {#if state === 'running'}
        <button
          class="chain"
          type="button"
          aria-label="Amp simulation"
          aria-pressed={!direct}
          title="Hear the guitar with and without the chain (B)"
          onclick={toggleChain}
        >
          <span class="chain-dot"></span>
          <!-- Both labels occupy the same cell, so the button is always as wide
               as the longer one. A control whose whole purpose is being hit
               repeatedly must not move out from under the pointer. -->
          <span class="chain-label">
            <span class="chain-ghost" aria-hidden="true">Tonecraft</span>
            <span>{direct ? 'Direct' : 'Tonecraft'}</span>
          </span>
        </button>
      {/if}
      {#if health !== null}
        <!-- Three tiers. Under 20 ms it is a number and nothing else; between 20
             and 35 it explains itself on click; above 35 the cause is named. It
             never nags, never hides and never blocks (FR-35). -->
        {#if health.latency.tier === 'explained'}
          <button class="latency link" type="button" onclick={() => (showLatency = !showLatency)}>
            {health.latency.ms.toFixed(1)} ms
          </button>
        {:else}
          <span class="latency" class:alert={health.latency.tier === 'named'}>
            {health.latency.ms.toFixed(1)} ms
          </span>
        {/if}
      {/if}
      <button
        class="start small"
        type="button"
        onclick={() => (state === 'running' ? stop() : start())}
        disabled={state === 'starting'}
      >
        {state === 'starting' ? 'Starting' : state === 'running' ? 'Stop' : 'Start'}
      </button>
    </div>
  </header>

  <!-- Above the strand, only what is playing. -->
  <div
    class="marquee"
    data-capture={health === null ? 'idle' : captureLoaded ? 'loaded' : 'silent'}
  >
    <p class="t-heading">{capture?.name ?? 'No capture installed'}</p>
    {#if state !== 'idle' && health !== null && !captureLoaded}
      <!-- Sound is still coming out, so nothing here can be inferred by ear. -->
      <p class="t-small alert">This capture is not running: you are hearing your
        dry guitar, not an amplifier. Reload the page.</p>
    {:else}
      <p class="t-small">{capture?.note ?? 'Run `npm run vendor` to fetch the captures.'}</p>
    {/if}
    <div class="presets">
      {#each PRESETS as p (p.name)}
        <button
          class="preset"
          class:selected={preset === p.name}
          type="button"
          onclick={() => applyPreset(p)}
        >{p.name}</button>
      {/each}
    </div>
  </div>

  <!-- With the chain off, nothing in the strand is reaching the ears. Saying so
       with the same 40% the bypassed modules use, rather than leaving a live
       looking rig that is doing nothing. -->
  <div class="strand" class:idle={direct}>
    {#each STRAND as block, i (block.stage)}
      {#if i > 0}
        <span
          class="cord"
          class:clip={clipping && i > 3}
          style="opacity: {0.12 + 0.88 * (cordLevels[i - 1] ?? 0)}"
          aria-hidden="true"
        ></span>
      {/if}
      {@const bypass = bypassOf(block.stage)}
      <Module
        name={labelOf(block.stage)}
        bypassed={bypass !== null && values[bypass] === 1}
        onbypass={bypass === null ? undefined : (b) => setParam(bypass, b ? 1 : 0)}
      >
        {#if block.stage === 'input'}
          <Meter level={meters.input} />
        {:else if block.stage === 'output'}
          <Meter level={meters.outputRms} />
        {/if}

        {#each block.faders as id (id)}
          <Fader
            param={param(id)}
            value={values[id] ?? param(id).default}
            onchange={(v) => setParam(id, v)}
          />
        {/each}

        {#if block.stage === 'amp'}
          <!-- A capture is a frozen snapshot: there is nothing to turn. -->
          <p class="fixed t-small">Captured, not modelled. The amp's own controls are in the file.</p>
        {:else if block.stage === 'cab'}
          <p class="fixed t-small">{cabInfo.hint}</p>
        {/if}

        {#snippet footer()}
          {#if block.stage === 'input'}
            <Segmented label="Source" options={SOURCES} value={source} onchange={chooseSource} />
            {#if source === 'live' && state === 'running'}
              {#if devices.length > 1}
                <label class="field">
                  <span class="t-small">Input</span>
                  <select value={deviceId} onchange={(e) => chooseDevice(e.currentTarget.value)}>
                    {#each devices as d (d.id)}
                      <option value={d.id}>{d.label || 'Input'}</option>
                    {/each}
                  </select>
                </label>
              {/if}
              {#if channelCount > 1}
                <Segmented
                  label="Input channel"
                  options={CHANNELS}
                  value={channel}
                  onchange={chooseChannel}
                />
                <!-- Play, and the bar that moves is the channel your guitar is
                     on. Choosing an input is guesswork without this. -->
                <div class="levels" aria-hidden="true">
                  {#each meters.channelPeaks as peak, c (c)}
                    <span class="level">
                      <span class="level-fill" style="transform: scaleX({level(peak)})"></span>
                    </span>
                  {/each}
                </div>
              {:else}
                <p class="t-small">One channel, so there is nothing to choose.</p>
              {/if}
            {/if}
          {:else if block.stage === 'amp'}
            <label class="field">
              <span class="t-small">Capture</span>
              <select value={captureFile} onchange={(e) => chooseCapture(e.currentTarget.value)}>
                {#each captures as c (c.file)}
                  <option value={c.file}>{c.name}</option>
                {/each}
              </select>
            </label>
          {:else if block.stage === 'cab'}
            <label class="field">
              <span class="t-small">Cabinet</span>
              <select value={cab} onchange={(e) => chooseCab(e.currentTarget.value)}>
                {#each CABS as c (c.id)}
                  <option value={c.id}>{c.name}</option>
                {/each}
              </select>
            </label>
          {/if}
        {/snippet}
      </Module>
    {/each}
  </div>

  {#if source === 'file'}
    <!-- Below the strand, and only when it is the source. A DI take through the
         identical chain is how anyone without an interface hears this at all,
         and how two captures get compared on the same performance. -->
    <section class="file">
      {#if filePeaks === null}
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
              onchange={(e) => { fileLoop = e.currentTarget.checked; engine?.setLoop(fileLoop); }}
            /> Loop
          </label>
          <span class="t-small name">{fileName}</span>
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
        </div>
      {/if}
    </section>
  {/if}

  {#if asking && state !== 'running'}
    <!-- A sheet over the rig, not a screen instead of it (DESIGN.md section 4).
         No backdrop blur: the design forbids it, and a plain wash reads calmer
         anyway. -->
    <div class="wash">
      <div class="sheet" role="dialog" aria-modal="false" aria-label="Start playing">
        <p class="t-body">
          Plug in a guitar and press start. The amplifier is a Neural Amp Modeler
          capture; the cabinet is synthesised here, and without it a capture is
          not an amp sound.
        </p>
        <div class="sheet-actions">
          <button class="start" type="button" onclick={start} disabled={state === 'starting'}>
            {state === 'starting' ? 'Starting' : 'Start'}
          </button>
          <button class="quiet" type="button" onclick={() => (asking = false)}>
            Look around first
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Only what is wrong, and only while it is. -->
  <div class="says">
    {#if problem !== null}
      <p class="note"><span>{problem.cause}</span><span class="fix">{problem.fix}</span></p>
    {/if}
    {#if notice !== null}
      <p class="note"><span>{notice}</span></p>
    {/if}
    {#if health !== null}
      {#if health.latency.tier === 'named' || (health.latency.tier === 'explained' && showLatency)}
        <p class="note" class:alert={health.latency.tier === 'named'}>
          <span>{health.latency.cause}</span><span class="fix">{health.latency.remedy}</span>
        </p>
      {/if}
      {#if health.input.problem !== null && source === 'live'}
        <p class="note">
          <span>{health.input.cause}</span><span class="fix">{health.input.remedy}</span>
        </p>
      {/if}
      {#if health.dropouts.audible}
        <p class="note alert">
          <span>{health.dropouts.cause}</span><span class="fix">{health.dropouts.remedy}</span>
        </p>
      {/if}
    {/if}
  </div>
</div>

<style>
  .page {
    min-height: 100svh;
    display: grid;
    grid-template-rows: auto auto 1fr auto auto;
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
  .latency.link {
    background: none;
    border: 0;
    border-bottom: 1px solid currentColor;
    padding: 0;
    cursor: pointer;
  }
  .latency.link:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }
  .alert { color: var(--ember); }

  /* Above the strand, the preset and nothing else. */
  .marquee {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--u);
    text-align: center;
  }
  .marquee p { margin: 0; max-width: 52ch; }

  .presets { display: flex; flex-wrap: wrap; gap: var(--u); justify-content: center; }
  .preset {
    font-family: var(--body);
    font-size: 13px;
    min-height: 32px;
    padding: 0 var(--u);
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--graphite);
    cursor: pointer;
  }
  .preset:hover { color: var(--ink); }
  .preset.selected { color: var(--ink); border-bottom-color: var(--ink); }
  .preset:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }

  /* The chain, vertically centred in roughly the middle third. The emptiness is
     the point: this is a product about not having a cluttered plugin window. */
  .strand {
    align-self: center;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    transition: opacity 200ms cubic-bezier(0.2, 0, 0, 1);
  }

  .strand.idle { opacity: 0.4; }

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

  /* The strand is joined by a hairline that carries the signal (UX-DR10). Only
     opacity animates, so it composites and costs the CPU nothing. */
  .cord {
    width: calc(var(--u) * 3);
    height: 1px;
    background: var(--celadon);
    flex: 0 0 auto;
    transition: opacity 80ms linear;
  }
  .cord.clip { background: var(--ember); }

  @media (prefers-reduced-motion: reduce) {
    /* A steady average rather than transients. */
    .cord { transition: opacity 600ms linear; }
  }

  .fixed { margin: 0; max-width: 22ch; }

  .file {
    display: flex;
    flex-direction: column;
    gap: var(--u);
    max-width: 1100px;
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

  /* The rig stays visible underneath. A wash rather than a blur: DESIGN.md
     forbids backdrop-filter, and only transform and opacity may animate. */
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
    max-width: 38ch;
    animation: rise 200ms cubic-bezier(0.2, 0, 0, 1);
  }

  @keyframes rise {
    from { opacity: 0; transform: translateY(16px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet { animation: none; }
  }

  .sheet-actions {
    display: flex;
    align-items: center;
    gap: calc(var(--u) * 2);
    flex-wrap: wrap;
    justify-content: center;
  }

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

  /* The space is reserved whether or not anything is being said. These messages
     appear and disappear on their own — a diagnosis arrives once the input has
     been measured, a dropout warning comes and goes — and letting them push the
     rig up and down every time makes the whole interface feel unstable. Two
     lines is one message; beyond that they scroll in their own box rather than
     growing into the strand. */
  .says {
    display: flex;
    flex-direction: column;
    gap: var(--u);
    min-height: calc(var(--u) * 6);
    max-height: calc(var(--u) * 16);
    overflow-y: auto;
  }
  .note {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    max-width: 60ch;
    font-family: var(--body);
    font-size: 15px;
  }
  .fix { color: var(--graphite); }

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

  /* The chain wraps rather than scrolls, still in order (UX-DR11). Two things
     the wrap has to get right, and neither is automatic:

     - a wrapped strand must not leave a cord pointing at nothing, so the cords
       go once the row can break;
     - left alone, flex fits as many as it can and drops the remainder, which at
       a 1440px laptop — the commonest size there is — put seven modules on one
       row and left Out orphaned underneath. Capping the width forces the break
       near the middle instead.

     The single-row threshold is where eight modules stop fitting; it moved up
     from 1100px when the amp and cab gained their selectors. */
  @media (max-width: 1599px) {
    .strand {
      gap: calc(var(--u) * 2);
      max-width: 900px;
    }
    .cord { display: none; }
  }

  @media (max-width: 950px) {
    .strand { max-width: 100%; }
  }
</style>
