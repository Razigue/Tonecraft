<script lang="ts">
  // The foot of the studio, the same in both modes, and the closest the
  // product comes to a DAW: the keys, the display, how the tab is practised,
  // the looper and the tools on one row, and under it the tracks, always on
  // screen. Only the levels rise above it. The tuner and the metronome float
  // in the room's corners (Rig.svelte), as the settings do at the top.
  import type { Snippet } from 'svelte';
  import type { LoopMeters } from '../engine/engine.ts';
  import type { StudioView } from '../store/session.ts';
  import type { TabDeck } from './tab-deck.svelte.ts';
  import type { RecorderDeck } from './recorder-deck.svelte.ts';
  import TabTransport from './TabTransport.svelte';
  import LooperControls from './LooperControls.svelte';
  import { lang } from './locale.svelte.ts';

  let { deck, recorder, view, syncBpm, musician, running, loop, loopLevel, demo, tracks, height = $bindable(0),
    onlooppress, onlooppower, onlooplevel }: {
    deck: TabDeck;
    recorder: RecorderDeck;
    view: StudioView;
    syncBpm: number | null;
    /** A tester has no input: no take, no looper, no tuner, no tracks. */
    musician: boolean;
    running: boolean;
    loop: LoopMeters;
    loopLevel: number;
    /** The tester's demo player, in place of the looper. */
    demo?: Snippet;
    /** The recorder's tracks, under the row. */
    tracks?: Snippet;
    /** What the plate takes, tracks included: the stage above gives it up. */
    height?: number;
    onlooppress: () => void;
    onlooppower: () => void;
    onlooplevel: (value: number) => void;
  } = $props();

  const t = $derived(lang.ui.rig);
  const clock = (s: number): string => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s) % 60).padStart(2, '0')}`;
</script>

{#snippet takeKey()}
  <button class="tc-button icon round take-record" class:recording={recorder.recording} type="button" aria-label={recorder.recording ? t.stopTake : t.recordTake}
    aria-busy={recorder.busy} disabled={!recorder.available || recorder.busy} title={recorder.error || (recorder.recording ? t.stopTake : t.recordTake)}
    onclick={() => (recorder.recording ? recorder.stop() : recorder.record())}>
    <span class="take-lamp" class:stop={recorder.recording}></span>
  </button>
{/snippet}

{#snippet takeStatus()}
  {#if recorder.recording || recorder.filled}
    <span class="take-status" class:recording={recorder.recording}><span class="rec-dot"></span>{t.take}<span class="take-time">{clock(recorder.seconds)}</span></span>
  {/if}
{/snippet}

<footer class="transport tc-plate" class:roomy={view === 'play'} class:with-tracks={!!tracks} aria-label={t.transport} bind:clientHeight={height}>
  <div class="transport-row">
    <TabTransport {deck} {view} {syncBpm} keys={musician ? takeKey : undefined} status={musician ? takeStatus : undefined} />

    {#if musician}
      <LooperControls {loop} {running} onpress={onlooppress} onpower={onlooppower} />
    {:else if demo}
      <section class="tc-group demo-panel" aria-label={t.demo}>
        <span class="tc-group-label">{t.demo}</span>
        <div class="tc-row">{@render demo()}</div>
      </section>
    {/if}

    <div class="tc-group tools" role="group" aria-label={t.levels}>
      <span class="tc-group-label">{t.levels}</span>
      <div class="tc-row">
        <button class="tc-button icon levels-button" type="button" popovertarget="studio-levels" aria-label={t.levels} title={t.levels}>
          <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M3 2v12M8 2v12M13 2v12" /><rect x="1.5" y="8.5" width="3" height="2.5" rx=".6" fill="currentColor" /><rect x="6.5" y="4" width="3" height="2.5" rx=".6" fill="currentColor" /><rect x="11.5" y="10" width="3" height="2.5" rx=".6" fill="currentColor" /></svg>
          <span class="tool-name">{t.levels}</span>
        </button>
      </div>
    </div>
  </div>

  {#if tracks}
    <div class="transport-tracks">{@render tracks()}</div>
  {/if}

  <div id="studio-levels" class="levels tc-popover" popover aria-label={t.levels}>
    <label><span>{t.tabLevel}</span><input type="range" min="0" max="100" step="1" aria-label={lang.ui.reader.volumeLabel} bind:value={deck.volume} /></label>
    {#if musician}
      <label><span>{t.looper}</span><input type="range" min="0" max="1" step="0.01" value={loopLevel} aria-label={t.loopLevel} oninput={e => onlooplevel(Number(e.currentTarget.value))} /></label>
    {/if}
  </div>
</footer>

<style>
  /* One plate: the row of keys and groups, then the tracks under a seam. */
  .transport { display: flex; flex-direction: column; }
  .transport-row {
    display: flex;
    align-items: center;
    gap: 36px;
    height: var(--transport-height);
    padding: 0 24px 0 20px;
    box-sizing: border-box;
  }
  .transport-row > :global(.display) { margin-right: 4px; }
  /* The groups keep their size and the display gives way: a clipped group name
     reads as broken, a shorter groove does not. */
  .transport-row > :global(.tc-group) { flex-shrink: 0; }
  /* The last group sits on the plate's right edge, as the track tools under it
     do: its key aligns with theirs, under its name. */
  .tools { align-items: flex-end; }
  /* Tone: the plate is the head's width, too narrow for one line. The keys and
     the display take the first, whole; the groups the second, the tools at its
     right end. */
  .transport:not(.roomy) .transport-row { flex-wrap: wrap; height: auto; gap: 14px 36px; padding-top: 14px; padding-bottom: 14px; }
  .transport:not(.roomy) .transport-row > :global(.display) { flex: 1 1 calc(100% - 260px); }
  @media (max-height: 820px) { .transport:not(.roomy) .transport-row { row-gap: 8px; padding-top: 10px; padding-bottom: 10px; } }
  .transport:not(.roomy) .tools { margin-left: auto; }
  .transport:not(.roomy) .transport-row > :global(.practice + .looper) { margin-left: auto; }
  .transport:not(.roomy) .transport-row > :global(.practice ~ .tools) { margin-left: 0; }
  .transport-tracks { border-top: 1px solid #050407; box-shadow: inset 0 1px 0 #ffffff0a; }

  /* Record: a dark round key with an ember lamp. Taking, the lamp becomes a
     square and breathes; the key itself never flashes. */
  .take-lamp { width: 14px; height: 14px; border-radius: 50%; background: radial-gradient(circle at 40% 35%, #f3b3a2, var(--ember) 70%); box-shadow: 0 0 0 2px #00000059, 0 0 8px #ec987f55; transition: border-radius var(--dur-settle) var(--ease-out), transform var(--dur-settle) var(--ease-out); }
  .take-lamp.stop { border-radius: 2px; transform: scale(.85); animation: rec 1.6s ease-in-out infinite alternate; }
  @keyframes rec { to { opacity: .55; } }
  .take-record.recording { border-color: var(--ember-line); background: linear-gradient(#b24a3433, #b24a3414); }
  .take-record:disabled .take-lamp { background: var(--text-3); box-shadow: none; }
  @media (prefers-reduced-motion: reduce) { .take-lamp { transition: none; } .take-lamp.stop { animation: none; } }

  .take-status { display: flex; align-items: baseline; gap: 8px; font: 400 10px/1 var(--display); font-stretch: 125%; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3); }
  .rec-dot { align-self: center; width: 6px; height: 6px; border-radius: 50%; background: var(--violet-700); }
  .take-time { font: var(--type-rec)/1 var(--mono); letter-spacing: 0; font-variant-numeric: tabular-nums; color: var(--text-2); }
  .take-status.recording { color: var(--ember); }
  .take-status.recording .rec-dot { background: var(--ember); animation: rec 1.6s ease-in-out infinite alternate; }
  .take-status.recording .take-time { color: var(--ember); }
  @media (prefers-reduced-motion: reduce) { .take-status.recording .rec-dot { animation: none; } }

  .demo-panel { flex: 0 1 420px; }
  .demo-panel .tc-row { width: 100%; }

  .levels-button { anchor-name: --studio-levels; }
  .levels {
    position: fixed;
    inset: auto var(--gutter) calc(var(--transport-height) + 24px) auto;
    padding: 18px 20px;
  }
  .levels:popover-open { display: grid; gap: 14px; }
  @supports (position-anchor: --a) {
    .levels { position-anchor: --studio-levels; inset: auto; bottom: anchor(top); right: anchor(right); margin-bottom: 12px; position-try-fallbacks: flip-inline; }
  }
  .levels label { display: grid; grid-template-columns: 64px 160px; align-items: center; gap: 12px; }
  .levels span { font: 400 10px/1 var(--display); font-stretch: 125%; letter-spacing: 0.16em; text-transform: uppercase; color: var(--text-2); }
  .levels input { min-height: 32px; }

  /* The tools name themselves where there is room: the full width of Play on a
     wide screen. Elsewhere the icon and its tooltip. */
  .tool-name { display: none; }
  @media (min-width: 1700px) {
    .roomy .tools .tc-button.icon { width: auto; padding: 0 14px; }
    .roomy .tool-name { display: inline; }
  }
  @media (max-width: 1600px) { .transport-row { gap: 28px; } }
  @media (max-width: 1366px) { .transport-row { gap: 24px; padding: 0 16px; } }
  /* A phone, or a window too short for the bands: the row is a stack, not a
     line. The display takes one of its own — the fraction it keeps beside the
     keys on a laptop is too narrow there to open a tab in, and its two buttons
     end up printed over each other. */
  @media (max-width: 760px), (max-height: 560px) {
    .demo-panel { flex: 1 1 100%; }
    .transport:not(.roomy) .transport-row > :global(.display) { flex: 1 1 100%; }
  }
</style>
