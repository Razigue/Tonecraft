<script lang="ts">
  /**
   * The bare harness for story 1.3. Deliberately plain: the design system, the
   * faders and the cord are epic 2, and building them against an engine that
   * does not exist yet would be building against nothing.
   *
   * What this proves is the path — guitar to headphones through real WASM — and
   * that the numbers coming back are real.
   */
  import { Engine, EngineError, type Meters } from '../engine/engine.ts';
  import { probeEnvironment, canRunEngine, type EnvironmentReport } from '../engine/input.ts';
  import { STAGES } from '../schema/params.ts';

  type State = 'idle' | 'starting' | 'running' | 'failed';

  let state = $state<State>('idle');
  let problem = $state<{ cause: string; fix: string } | null>(null);
  let rms = $state<number[]>(new Array(STAGES.length).fill(0));
  let dropouts = $state(0);
  let roundTrip = $state<number | null>(null);
  let info = $state<import('../engine/engine.ts').EngineInfo | null>(null);

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
  }

  async function start(): Promise<void> {
    state = 'starting';
    problem = null;
    engine = new Engine({ onMeters });
    try {
      await engine.start();
      roundTrip = engine.roundTripMs;
      info = engine.info;
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

    {#if roundTrip !== null}
      <span class="readout">{roundTrip.toFixed(1)} ms round trip</span>
    {/if}
    {#if state === 'running'}
      <span class="readout">{dropouts} dropouts</span>
    {/if}
    {#if info !== null}
      <span class="readout">
        {info.deviceRate} Hz{info.resampling
          ? ` · +${info.conversionLatencyMs.toFixed(1)} ms converting to 48 kHz`
          : ' · no conversion'}
      </span>
    {/if}
  </div>

  {#if problem !== null}
    <p class="problem">
      <span>{problem.cause}</span>
      {#if problem.fix !== ''}<span class="fix">{problem.fix}</span>{/if}
    </p>
  {/if}

  {#if state === 'running'}
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
      Every stage between the input and the output reports the same level: there
      is no DSP between them yet. Stories 1.6 to 1.10 change that.
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

  .problem { display: flex; flex-direction: column; gap: 0.25rem; }
  .fix { color: var(--muted); }

  .meters { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem; }
  .meters li { display: grid; grid-template-columns: 4rem 1fr 4rem; gap: 0.75rem; align-items: center; }
  .label { font-size: 13px; }
  .bar { height: 4px; background: currentColor; opacity: calc(0.15 + var(--level) * 0.85); }
  .value { font-family: ui-monospace, monospace; font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; color: var(--muted); }

  .note { font-size: 13px; }

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
