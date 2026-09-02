<script lang="ts">
  /**
   * The rig.
   *
   * The chain *is* the interface (DESIGN.md section 4): the signal path runs
   * left to right in the order the audio travels, and there is no navigation,
   * no sidebar and no tabs. The page is the rig.
   *
   * It says nothing it does not need to. The round trip is always on screen
   * because FR-35 requires it. A hardware diagnosis, a dropout count and an
   * error appear only when there is one — the product's voice is to state what
   * happened and otherwise stay quiet.
   *
   * Modules appear as their stages are built. Drive and reverb are absent
   * because they do not exist; an empty module that did nothing would be a lie.
   */
  import { Engine, EngineError, type Meters, type Health } from '../engine/engine.ts';
  import { PARAMS, STAGES, type Param } from '../schema/params.ts';
  import Fader from './Fader.svelte';
  import Module from './Module.svelte';
  import Meter from './Meter.svelte';
  import Segmented from './Segmented.svelte';
  import type { InputDevice, InputChannel } from '../engine/engine.ts';
  import './tokens.css';

  type State = 'idle' | 'starting' | 'running' | 'failed';

  const param = (id: string): Param => PARAMS.find((p) => p.id === id)!;

  /** The strand, in signal order. */
  const STRAND: readonly { stage: string; faders: readonly string[] }[] = [
    { stage: 'input', faders: ['in_trim'] },
    { stage: 'gate', faders: ['gate_threshold'] },
    { stage: 'amp', faders: ['amp_gain', 'amp_bass', 'amp_mid', 'amp_treble', 'amp_master'] },
    { stage: 'cab', faders: ['cab_mix'] },
    { stage: 'output', faders: ['out_master'] },
  ];

  let state = $state<State>('idle');
  let problem = $state<{ cause: string; fix: string } | null>(null);
  let health = $state<Health | null>(null);
  let showLatency = $state(false);
  /** The opening sheet. Dismissible: looking around is never blocked. */
  let asking = $state(true);
  let rms = $state<number[]>(new Array(STAGES.length).fill(0));
  let values = $state<Record<string, number>>(
    Object.fromEntries(PARAMS.map((p) => [p.id, p.default])),
  );

  let engine: Engine | null = null;
  let devices = $state<InputDevice[]>([]);
  let deviceId = $state('');
  let channel = $state<InputChannel>('left');
  let channelCount = $state(1);

  /**
   * A two-input interface puts its instrument jack on the second channel — a
   * Scarlett Solo carries the XLR left and the jack right — so the choice only
   * exists when there is one to make.
   */
  const CHANNELS = [
    { value: 'left', label: 'Left' },
    { value: 'right', label: 'Right' },
    { value: 'sum', label: 'Both' },
  ] as const;

  async function refreshDevices(): Promise<void> {
    devices = (await engine?.listInputs()) ?? [];
    channelCount = engine?.channelCount ?? 1;
  }

  async function chooseDevice(id: string): Promise<void> {
    deviceId = id;
    await engine?.useDevice(id);
    channelCount = engine?.channelCount ?? 1;
  }

  function chooseChannel(next: string): void {
    channel = next as InputChannel;
    engine?.setInputChannel(channel);
  }

  const labelOf = (id: string): string => STAGES.find((s) => s.id === id)?.label ?? id;
  const slotOf = (id: string): number => STAGES.find((s) => s.id === id)?.meterSlot ?? 0;
  const bypassOf = (id: string): string | null =>
    STAGES.find((s) => s.id === id)?.bypassParam ?? null;

  function setParam(id: string, value: number): void {
    values = { ...values, [id]: value };
    engine?.setParam(id, value);
  }

  function onMeters(meters: Meters): void {
    rms = Array.from(meters.rms);
    health = engine?.health ?? null;
  }

  async function start(): Promise<void> {
    state = 'starting';
    problem = null;
    engine = new Engine({ onMeters });
    try {
      await engine.start();
      // Anything moved before starting carries over — the rig is live-looking
      // from the first frame, so it has to be honest about what it shows.
      for (const p of PARAMS) {
        const v = values[p.id];
        if (v !== undefined && v !== p.default) engine.setParam(p.id, v);
      }
      health = engine.health;
      asking = false;
      state = 'running';
      // Labels are withheld until permission has been granted, so the device
      // list is only meaningful from here on.
      await refreshDevices();
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
</script>

<div class="page">
  <header class="bar">
    <span class="t-wordmark">Tonecraft</span>

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
    {:else}
      <!-- Always reachable, so dismissing the sheet never strands anyone. -->
      <button class="start small" type="button" onclick={start} disabled={state === 'starting'}>
        {state === 'starting' ? 'Starting' : 'Start'}
      </button>
    {/if}
  </header>

  <div class="strand">
      {#each STRAND as block, i (block.stage)}
        {#if i > 0}<span class="cord" aria-hidden="true"></span>{/if}
        {@const bypass = bypassOf(block.stage)}
        <Module
          name={labelOf(block.stage)}
          bypassed={bypass !== null && values[bypass] === 1}
          onbypass={bypass === null ? undefined : (b) => setParam(bypass, b ? 1 : 0)}
        >
          {#if block.stage === 'input' || block.stage === 'output'}
            <Meter level={rms[slotOf(block.stage)] ?? 0} />
          {/if}
          {#each block.faders as id (id)}
            <Fader
              param={param(id)}
              value={values[id] ?? param(id).default}
              onchange={(v) => setParam(id, v)}
            />
          {/each}

          {#snippet footer()}
            {#if block.stage === 'input' && state === 'running'}
              {#if devices.length > 1}
                <label class="source">
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
              {/if}
            {/if}
          {/snippet}
        </Module>
      {/each}
  </div>

  {#if asking && state !== 'running'}
    <!-- A sheet over the rig, not a screen instead of it (DESIGN.md section 4).
         No backdrop blur: the design forbids it, and a plain wash reads calmer
         anyway. -->
    <div class="wash">
      <div class="sheet" role="dialog" aria-modal="false" aria-label="Start playing">
        <p class="t-body">
          Plug in a guitar and press start. There is an amplifier and a cabinet;
          the drive and the reverb are not built yet.
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
    {#if health !== null}
      {#if health.latency.tier === 'named' || (health.latency.tier === 'explained' && showLatency)}
        <p class="note" class:alert={health.latency.tier === 'named'}>
          <span>{health.latency.cause}</span><span class="fix">{health.latency.remedy}</span>
        </p>
      {/if}
      {#if health.input.problem !== null}
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
    grid-template-rows: auto 1fr auto;
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

  /* The chain, vertically centred in roughly the middle third. The emptiness is
     the point: this is a product about not having a cluttered plugin window. */
  .strand {
    align-self: center;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
  }

  /* The strand is joined by a hairline. Its opacity per segment will follow the
     signal once the cord lands (UX-DR10); today it is the connection itself. */
  .cord {
    width: calc(var(--u) * 3);
    height: 1px;
    background: var(--celadon);
    flex: 0 0 auto;
  }

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

  .says { display: flex; flex-direction: column; gap: var(--u); }
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

  .source { display: flex; flex-direction: column; gap: 2px; }
  select {
    font-family: var(--body);
    font-size: 13px;
    min-height: 40px;
    max-width: 18ch;
    background: none;
    border: 0;
    border-bottom: 1px solid var(--graphite);
    color: var(--ink);
    padding: 0;
  }
  select:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }

  /* Below 1100px the chain wraps, still in order (UX-DR11). */
  @media (max-width: 1100px) {
    .strand { gap: calc(var(--u) * 2); }
    .cord { display: none; }
  }
</style>
