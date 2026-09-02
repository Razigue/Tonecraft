<script lang="ts">
  /**
   * The bare harness for story 1.3. Deliberately plain: the design system, the
   * faders and the cord are epic 2, and building them against an engine that
   * does not exist yet would be building against nothing.
   *
   * What this proves is the path — guitar to headphones through real WASM — and
   * that the numbers coming back are real.
   */
  import { Engine, EngineError, type Meters, type Health } from '../engine/engine.ts';
  import { probeEnvironment, canRunEngine, type EnvironmentReport } from '../engine/input.ts';
  import { STAGES, PARAMS } from '../schema/params.ts';

  type State = 'idle' | 'starting' | 'running' | 'failed';

  let state = $state<State>('idle');
  let problem = $state<{ cause: string; fix: string } | null>(null);
  let rms = $state<number[]>(new Array(STAGES.length).fill(0));
  let dropouts = $state(0);
  let roundTrip = $state<number | null>(null);
  let info = $state<import('../engine/engine.ts').EngineInfo | null>(null);
  let ampLoaded = $state(false);
  let health = $state<Health | null>(null);
  let showLatencyDetail = $state(false);

  // Enough control to judge by ear what is actually built. The real interface —
  // faders, the cord, the design system — is epic 2.
  const CONTROLS = ['in_trim', 'gate_threshold', 'out_master'] as const;
  const BYPASSES = STAGES.filter((st) => st.bypassParam !== null);

  let values = $state<Record<string, number>>(
    Object.fromEntries(PARAMS.map((p) => [p.id, p.default])),
  );

  function setParam(id: string, value: number): void {
    values = { ...values, [id]: value };
    engine?.setParam(id, value);
  }

  let engine: Engine | null = null;
  let env = $state<EnvironmentReport | null>(null);

  // Probed before any engine loads: no AudioContext, no WASM, no permission
  // prompt (FR-7). Nothing here decides anything — the Start button is
  // available in every state, including the ones this reports as broken (FR-12).
  $effect(() => {
    void probeEnvironment(
      navigator,
      window.isSecureContext,
      typeof AudioWorkletNode !== 'undefined',
    ).then((report) => { env = report; });
  });

  // Labels are withheld until permission is granted, so before the first Start
  // this is usually a count rather than a list. That is the browser's rule, not
  // a limitation worth explaining to a player.
  const named = $derived((env?.inputs ?? []).filter((d) => d.label !== ''));

  function onMeters(meters: Meters): void {
    rms = Array.from(meters.rms);
    dropouts = meters.dropouts;
    health = engine?.health ?? null;
  }

  async function start(): Promise<void> {
    state = 'starting';
    problem = null;
    engine = new Engine({ onMeters });
    try {
      await engine.start();
      roundTrip = engine.roundTripMs;
      info = engine.info;
      ampLoaded = engine.ampLoaded;
      state = 'running';
    } catch (error) {
      // Cause in one sentence, fix in one sentence. No apology, and nothing
      // blocks: the button stays available.
      if (error instanceof EngineError) {
        const [cause, fix] = error.message.split(/(?<=\.)\s+/, 2);
        problem = { cause: cause ?? error.message, fix: fix ?? '' };
      } else {
        problem = { cause: 'The audio engine did not start.', fix: 'Reload the page and try again.' };
      }
      state = 'failed';
    }
  }

  async function stop(): Promise<void> {
    await engine?.stop();
    engine = null;
    state = 'idle';
    roundTrip = null;
    info = null;
  }
</script>

<section>
  <header>
    <h2>Pass-through harness</h2>
    <p>
      Your signal crosses the real WebAssembly chain and comes back unaltered,
      except for the output limiter — which is always on and has no control,
      here or anywhere else. Any interface rate works: the chain runs at 48 kHz
      and converts at its boundary, so no stage ever learns what your hardware
      runs at.
    </p>
  </header>

  {#if env !== null}
    <dl class="env">
      <div><dt>Secure context</dt><dd>{env.secureContext ? 'yes' : 'no'}</dd></div>
      <div><dt>AudioWorklet</dt><dd>{env.audioWorklet ? 'yes' : 'no'}</dd></div>
      <div><dt>WASM SIMD</dt><dd>{env.wasmSimd ? 'yes' : 'no'}</dd></div>
      <div><dt>Audio inputs</dt><dd>{env.inputs.length}</dd></div>
    </dl>
    {#if named.length > 0}
      <ul class="devices">
        {#each named as device (device.id)}
          <li><span class="kind">{device.kind}</span>{device.label}</li>
        {/each}
      </ul>
    {/if}
    {#if !canRunEngine(env)}
      <p class="problem">
        <span>This browser cannot run the engine here.</span>
        <span class="fix">
          It needs a secure context, AudioWorklet and WebAssembly SIMD. You can
          still press start — nothing is blocked.
        </span>
      </p>
    {/if}
  {/if}

  <div class="controls">
    {#if state === 'running'}
      <button type="button" onclick={stop}>Stop</button>
    {:else}
      <button type="button" onclick={start} disabled={state === 'starting'}>
        {state === 'starting' ? 'Starting…' : 'Start'}
      </button>
    {/if}

    {#if roundTrip !== null && health !== null}
      <!-- Three tiers: silent, explains itself on click, names the cause. It
           never nags, never hides, and never blocks (FR-35). -->
      {#if health.latency.tier === 'quiet'}
        <span class="readout">{roundTrip.toFixed(1)} ms</span>
      {:else if health.latency.tier === 'explained'}
        <button class="readout link" type="button"
                onclick={() => (showLatencyDetail = !showLatencyDetail)}>
          {roundTrip.toFixed(1)} ms
        </button>
      {:else}
        <span class="readout alert">{roundTrip.toFixed(1)} ms</span>
      {/if}
    {/if}
    {#if state === 'running' && health !== null}
      <span class="readout">
        {dropouts} dropouts · ±{health.jitter.deviationMs.toFixed(1)} ms jitter
      </span>
    {/if}
    {#if info !== null}
      <span class="readout">
        {info.deviceRate} Hz{info.resampling
          ? ` · +${info.conversionLatencyMs.toFixed(1)} ms converting`
          : ''}
      </span>
    {/if}
    {#if health?.timeToFirstNoteMs != null}
      <span class="readout">{(health.timeToFirstNoteMs / 1000).toFixed(1)} s to first note</span>
    {/if}
  </div>

  {#if health !== null}
    {#if health.latency.tier === 'named' || (health.latency.tier === 'explained' && showLatencyDetail)}
      <p class="problem" class:alert={health.latency.tier === 'named'}>
        <span>{health.latency.cause}</span>
        <span class="fix">{health.latency.remedy}</span>
      </p>
    {/if}
    {#if health.input.problem !== null}
      <p class="problem">
        <span>{health.input.cause}</span>
        <span class="fix">{health.input.remedy}</span>
      </p>
    {/if}
    {#if health.dropouts.audible}
      <p class="problem alert">
        <span>{health.dropouts.cause}</span>
        <span class="fix">{health.dropouts.remedy}</span>
      </p>
    {/if}
  {/if}

  {#if problem !== null}
    <p class="problem">
      <span>{problem.cause}</span>
      {#if problem.fix !== ''}<span class="fix">{problem.fix}</span>{/if}
    </p>
  {/if}

  {#if state === 'running'}
    {#if ampLoaded}
      <p class="warn">
        <span>The amp is running placeholder weights — deterministic noise, not
        an amplifier.</span>
        <span class="fix">Bypass it below to hear the chain without a model.
        Real weights need a captured amplifier and do not exist yet.</span>
      </p>
    {/if}

    <div class="controls-grid">
      {#each CONTROLS as id (id)}
        {@const p = PARAMS.find((q) => q.id === id)!}
        <label>
          <span class="name">{p.label}</span>
          <input
            type="range"
            min={p.min}
            max={p.max}
            step={(p.max - p.min) / 200}
            value={values[id]}
            oninput={(e) => setParam(id, Number(e.currentTarget.value))}
          />
          <span class="value">{values[id]?.toFixed(1)} {p.unit}</span>
        </label>
      {/each}
    </div>

    <div class="bypasses">
      {#each BYPASSES as stage (stage.id)}
        <label class="bypass">
          <input
            type="checkbox"
            checked={values[stage.bypassParam!] === 1}
            onchange={(e) => setParam(stage.bypassParam!, e.currentTarget.checked ? 1 : 0)}
          />
          bypass {stage.label}
        </label>
      {/each}
    </div>

    <ol class="meters">
      {#each STAGES as stage, i (stage.id)}
        <li>
          <span class="label">{stage.label}</span>
          <span class="bar" style="--level: {Math.min(1, (rms[i] ?? 0) * 3)}"></span>
          <span class="value">{(rms[i] ?? 0).toFixed(3)}</span>
        </li>
      {/each}
    </ol>
    <p class="note">
      Drive, cab and reverb do not exist yet, so those stages report the level
      that passed through them. Stories 1.8 and 1.10.
    </p>
  {/if}
</section>

<style>
  section { display: flex; flex-direction: column; gap: 1.5rem; }
  header { display: flex; flex-direction: column; gap: 0.5rem; }
  h2 { font-size: 1rem; font-weight: 500; margin: 0; }
  p { margin: 0; color: var(--muted); max-width: 34rem; }

  .controls { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }

  button {
    font: inherit;
    padding: 0.5rem 1.25rem;
    min-height: 40px;
    border: 1px solid currentColor;
    border-radius: 2px;
    background: none;
    color: inherit;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }

  .readout {
    font-family: ui-monospace, monospace;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }

  .problem { display: flex; flex-direction: column; gap: 0.25rem; max-width: 40rem; }
  .alert { color: #B24A34; }
  .readout.link {
    background: none; border: 0; border-bottom: 1px solid currentColor;
    padding: 0; min-height: 0; cursor: pointer; color: inherit; font: inherit;
    font-family: ui-monospace, monospace; font-size: 13px;
  }
  .fix { color: var(--muted); }

  .meters { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem; }
  .meters li { display: grid; grid-template-columns: 4rem 1fr 4rem; gap: 0.75rem; align-items: center; }
  .label { font-size: 13px; }
  .bar { height: 4px; background: currentColor; opacity: calc(0.15 + var(--level) * 0.85); }
  .value { font-family: ui-monospace, monospace; font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; color: var(--muted); }

  .note { font-size: 13px; }

  .warn { display: flex; flex-direction: column; gap: 0.25rem; }

  .controls-grid { display: flex; flex-direction: column; gap: 0.5rem; }
  label { display: grid; grid-template-columns: 6rem 1fr 5rem; gap: 0.75rem; align-items: center; }
  .name { font-size: 13px; }
  input[type="range"] { width: 100%; min-height: 40px; }

  .bypasses { display: flex; flex-wrap: wrap; gap: 1rem; }
  .bypass { display: flex; gap: 0.4rem; align-items: center; font-size: 13px; grid-template-columns: none; }
  input[type="checkbox"] { width: 18px; height: 18px; }

  .env { display: flex; flex-wrap: wrap; gap: 0 2rem; margin: 0; }
  .env div { display: flex; gap: 0.5rem; align-items: baseline; }
  dt { font-size: 13px; color: var(--muted); }
  dd { margin: 0; font-family: ui-monospace, monospace; font-size: 13px; }

  .devices { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem; }
  .devices li { display: flex; gap: 0.75rem; align-items: baseline; font-size: 13px; }
  .kind {
    font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted);
    border: 1px solid currentColor; border-radius: 2px; padding: 0 4px; min-width: 5.5rem; text-align: center;
  }
</style>
