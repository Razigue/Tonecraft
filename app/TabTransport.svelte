<script lang="ts">
  // The tab's playback, as the studio's DAW reads it: the keys — stop, play,
  // and the take's record key the transport hands in — then the display, where
  // the song is, and how it is practised — loop, speed, tracks. The reader may
  // be out of sight while the song plays under a tone being dialled: this only
  // reads what the reader reports and presses what it installed
  // (tab-deck.svelte.ts). With no tab open, the display is where one is opened,
  // in either mode.
  import type { Snippet } from 'svelte';
  import type { TabDeck } from './tab-deck.svelte.ts';
  import type { StudioView } from '../store/session.ts';
  import { lang } from './locale.svelte.ts';

  let { deck, view, syncBpm = null, keys, status }: {
    deck: TabDeck;
    view: StudioView;
    syncBpm?: number | null;
    /** More keys after play: the take's record key and its drawer. */
    keys?: Snippet;
    /** A line at the display's top right: the take's state while there is one. */
    status?: Snippet;
  } = $props();
  const words = $derived(lang.ui.reader);
  const t = $derived(lang.ui.rig);
  const SPEEDS = [25, 50, 60, 70, 80, 90, 100, 110, 125, 150];
  /** Every format the reader's importer tries (TabReader.svelte). */
  const ACCEPT = '.gpx,.gp,.gp3,.gp4,.gp5,.musicxml,.xml,.mxl,.cap,.capx,.alphatex,.atex';
  const time = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  let picker = $state<HTMLInputElement>();
</script>

<!-- The keys, in the order a hand finds them on any recorder. Arrow functions,
     not the handlers themselves: the reader installs them when it mounts,
     which may be after this has rendered. -->
<div class="keys" role="group" aria-label={t.transport}>
  <button class="tc-button icon quiet stop" aria-label={words.stopTab} disabled={!deck.loaded} onclick={() => deck.stop()}>
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2" /></svg>
  </button>
  <button class="tc-button icon round primary play" class:cueing={deck.cueing} aria-label={deck.cueing ? words.cancelCue : deck.playing ? words.pauseTab : words.playTab}
    disabled={!deck.ready || deck.busy} onclick={() => deck.toggle()}>
    {#if deck.playing || deck.cueing}
      <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx=".8" /><rect x="9.5" y="2.5" width="3" height="11" rx=".8" /></svg>
    {:else}
      <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 2.9v10.2c0 .5.5.8.9.5l8-5.1a.6.6 0 0 0 0-1L5.9 2.4c-.4-.3-.9 0-.9.5z" /></svg>
    {/if}
  </button>
  {@render keys?.()}
</div>

<!-- The display: a window set into the plate, lit from inside. -->
<div class="display" class:empty={!deck.loaded} role="group" aria-label={t.tab}>
  <div class="display-head">
    <span class="display-name">{t.tab}</span>
    {#if deck.loaded}<span class="display-title">{deck.title}</span>{/if}
    <span class="display-status">{@render status?.()}</span>
  </div>
  <input bind:this={picker} type="file" accept={ACCEPT} aria-label={t.openTab} hidden
    onchange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) deck.open(f); }} />
  {#if !deck.loaded}
    <div class="display-open">
      <button class="tc-button" disabled={deck.busy} onclick={() => picker?.click()}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9z" /><path d="M9.5 1.5v3h3M5.5 8.5h5M5.5 11h5" /></svg>
        {deck.busy ? words.opening : t.openTab}
      </button>
      <button class="tc-button quiet" disabled={deck.busy} onclick={() => deck.write()}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 2.5l3 3-8 8h-3v-3z" /></svg>
        {words.write}
      </button>
    </div>
  {:else}
    <div class="display-main">
      <span class="clock">{time(deck.position)}</span>
      <div class="position">
        <input class="scrub" type="range" aria-label={words.position} min="0" max={Math.max(1, deck.duration)} step="100"
          style:--fill={`${deck.duration ? (deck.position / deck.duration) * 100 : 0}%`}
          value={deck.position} disabled={deck.duration === 0} oninput={e => deck.seek(Number(e.currentTarget.value))} />
      </div>
      <span class="total">{time(deck.duration)}</span>
      <span class="readout" title={t.bar}><span class="unit">{t.bar}</span><span class="figure">{deck.bar}<span class="of">/{deck.bars}</span></span></span>
      <span class="readout" class:synced={syncBpm !== null} title={syncBpm !== null ? words.syncedTitle : undefined}><span class="unit">BPM</span><span class="figure">{deck.bpm}</span></span>
    </div>
  {/if}
</div>

<!-- How a tab is practised means nothing before there is one. -->
{#if deck.loaded}
  <div class="tc-group practice" role="group" aria-label={t.practice}>
    <span class="tc-group-label">{t.practice}</span>
    <div class="tc-row">
      <button class="tc-button" aria-pressed={deck.looping} onclick={() => deck.loop()}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8V6.5a2 2 0 0 1 2-2h8.5M11 2.5l2 2-2 2M13.5 8v1.5a2 2 0 0 1-2 2H3M5 13.5l-2-2 2-2" /></svg>
        {deck.selection ? words.loopSelection : words.loopSong}
      </button>
      {#if deck.selection}<button class="tc-button quiet" onclick={() => deck.clearSelection()}>{words.clearSelection}</button>{/if}
      {#if syncBpm !== null}<span class="synced-note" title={words.syncedTitle}>{words.synced(syncBpm)}</span>
      {:else}<select class="tc-button" aria-label={words.speedLabel} title={words.speed} bind:value={deck.speed}>{#each SPEEDS as n}<option value={n}>{n}%</option>{/each}</select>{/if}
      {#if view === 'play'}
        <button class="tc-button tracks" popovertarget="tab-tracks">{t.tracks}</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .keys { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .play svg { margin-left: 1px; }
  .stop { color: var(--text-2); }
  /* Waiting for the metronome's count-in: the key breathes, it does not blink. */
  .play.cueing svg { animation: cue 900ms ease-in-out infinite alternate; }
  @keyframes cue { to { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .play.cueing svg { animation: none; opacity: .6; } }
  select.tc-button { flex-shrink: 0; min-width: 88px; appearance: none; padding-right: 30px; background: var(--chevron) no-repeat right 11px center, linear-gradient(#ffffff0a, #ffffff03); }

  /* A window cut into the plate: darker than it, lit faintly violet from
     within, its edge the plate's own bevel. The numbers live here. */
  .display {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    justify-content: center;
    gap: 8px;
    min-width: 0;
    height: 68px;
    padding: 0 18px;
    box-sizing: border-box;
    border-radius: var(--radius);
    background:
      radial-gradient(ellipse 70% 120% at 30% 0%, #7b3fa01f, transparent 70%),
      linear-gradient(#050407, #0b0a0e);
    box-shadow: inset 0 1px 3px #000c, inset 0 0 0 1px #00000080, 0 1px 0 #ffffff0d;
  }
  .display-head { display: flex; align-items: baseline; gap: 12px; min-width: 0; height: 12px; }
  .display-name { font: 400 10px/1 var(--display); font-stretch: 125%; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3); }
  .display-title { overflow: hidden; font: 500 12px/1 var(--body); color: var(--text-2); text-overflow: ellipsis; white-space: nowrap; }
  .display-status { display: flex; margin-left: auto; }
  /* Centred in the window, not pinned to its left edge. With no tab open the
     window is an invitation and nothing else, and it is as wide as the whole
     transport: two keys in its top-left corner read as a toolbar that had lost
     its toolbar. Once a tab is open the window fills with the clock and the
     scrub, and that lays itself out from the left as a readout does. */
  .display-open { display: flex; align-items: center; justify-content: center; gap: 4px; }
  .display-open .tc-button { height: 36px; }

  /* Elapsed left of the groove, length right of it, then where in the song. */
  .display-main { display: flex; align-items: center; gap: 14px; min-width: 0; height: 30px; }
  .clock, .total, .figure { font-family: var(--body); font-variant-numeric: tabular-nums; white-space: nowrap; line-height: 1; }
  .clock { min-width: 4ch; font-size: var(--type-clock); color: var(--violet-50); }
  .total { font-size: var(--type-clock); color: var(--text-3); }
  .position { display: flex; flex: 1 1 200px; min-width: 60px; }
  .readout { display: flex; align-items: baseline; gap: 8px; padding-left: 16px; border-left: 1px solid #ffffff12; }
  .figure { font-size: var(--type-bar); color: var(--text); }
  .of { color: var(--text-3); }
  .readout.synced .figure { color: var(--accent); }
  .unit { font: 400 10px/1 var(--display); font-stretch: 125%; letter-spacing: 0.16em; text-transform: uppercase; color: var(--text-3); }

  /* The position: a groove, the played part lit, a small cap. */
  .scrub { width: 100%; height: 28px; margin: 0; appearance: none; background: none; cursor: pointer; }
  .scrub::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(90deg, var(--violet-300) var(--fill), #ffffff17 var(--fill)); }
  .scrub::-moz-range-track { height: 4px; border-radius: 2px; background: #ffffff17; }
  .scrub::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--violet-300); }
  .scrub::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; margin-top: -5px; border: 0; border-radius: 50%; background: var(--violet-50); box-shadow: 0 1px 3px #000c, 0 0 8px #c875ef66; transition: transform var(--dur-quick) ease-out; }
  .scrub::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: var(--violet-50); box-shadow: 0 1px 3px #000c; }
  .scrub:hover::-webkit-slider-thumb { transform: scale(1.2); }
  .scrub:disabled { opacity: .4; }
  .scrub:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; border-radius: 2px; }
  .synced-note { font: 12px var(--body); color: var(--accent); white-space: nowrap; }
  .tracks { anchor-name: --tab-tracks; }
  @media (max-width: 1366px) { .total { display: none; } .readout { padding-left: 12px; } }
  @media (max-width: 760px) {
    .display { height: auto; padding: 10px 14px; }
    .display-main { flex-wrap: wrap; height: auto; row-gap: 6px; }
    .position { flex-basis: 100%; order: 3; }
  }
</style>
