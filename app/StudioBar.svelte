<script lang="ts">
  // The top band: the name, the two modes, the round trip and the settings,
  // where the language is changed. The modes are the studio's only navigation, and they are
  // always here: the amp to dial a tone, the tab to play along.
  import type { StudioView } from '../store/session.ts';
  import { lang } from './locale.svelte.ts';

  let { view, onview, latencyMs, latencyDetail, touring, showTour, showModes = true, settingsDisabled, ontour, onsettings }: {
    view: StudioView;
    onview: (next: StudioView) => void;
    latencyMs: number | null;
    latencyDetail: string;
    touring: boolean;
    /** The tester's tutorial can be opened again from here. */
    showTour: boolean;
    /** The modes belong to the musician's studio: a tester reads one page. */
    showModes?: boolean;
    settingsDisabled: boolean;
    ontour: () => void;
    onsettings: () => void;
  } = $props();

  const text = $derived(lang.messages);
  const t = $derived(lang.ui.rig);
  // The landing lives at the root in English and under /fr/ in French.
  const home = $derived(`${import.meta.env.BASE_URL.replace(/\/?$/, '/')}${lang.locale === 'fr' ? 'fr/' : ''}`);
  const MODES: readonly StudioView[] = ['tone', 'play'];
</script>

<header class="bar">
  <a class="t-wordmark" href={home} title={t.home}>tonecraft</a>
  {#if showModes}
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div class="modes" role="tablist" aria-label={t.modeLabel} onkeydown={e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = view === 'tone' ? 'play' : 'tone';
    onview(next);
    (e.currentTarget.querySelector(`[data-mode="${next}"]`) as HTMLElement | null)?.focus();
  }}>
    {#each MODES as mode (mode)}
      <button type="button" role="tab" data-mode={mode} aria-selected={view === mode} tabindex={view === mode ? 0 : -1} title={t.modeTitles[mode]} onclick={() => onview(mode)}>{t.modes[mode]}</button>
    {/each}
    <span class="mode-light" aria-hidden="true" style:transform={`translateX(${MODES.indexOf(view) * 100}%)`}></span>
  </div>
  {:else}
    <span></span>
  {/if}
  <div class="bar-right">
    {#if latencyMs !== null}
      <!-- The round trip is on screen permanently (FR-35), as a number and
           nothing more. It used to explain itself and turn red past 35 ms;
           it does not, because most of what it named is the operating
           system's buffering and saying so on every frame is nagging, not
           informing. -->
      <span class="latency" title={latencyDetail}>{latencyMs.toFixed(1)} ms</span>
    {/if}
    {#if showTour}
      <button class="tour-button" type="button" onclick={ontour} disabled={touring}>{text.tour.open}</button>
    {/if}
    <button class="settings-button" type="button" aria-label={text.settings} title={text.settings} onclick={onsettings} disabled={settingsDisabled}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m9.5 3-.6 2.2-1.7 1L5 5.6 2.5 9.9l1.6 1.6v2L2.5 15 5 19.3l2.2-.6 1.7 1 .6 2.3h5l.6-2.3 1.7-1 2.2.6 2.5-4.3-1.6-1.5v-2l1.6-1.6L19 5.6l-2.2.6-1.7-1L14.5 3z"/><circle cx="12" cy="12.5" r="3.5"/></svg>
    </button>
  </div>
</header>

<style>
  .bar { display: grid; grid-template-columns: 1fr auto 1fr; align-items: stretch; gap: 16px; height: var(--bar-height); padding: 0 8px; box-sizing: border-box; }
  .t-wordmark { align-self: center; justify-self: start; text-decoration: none; border-radius: var(--radius); transition: color var(--dur-settle) var(--ease-out); }
  .t-wordmark:hover { color: var(--text-2); }
  .t-wordmark:focus-visible { outline: 2px solid var(--iris); outline-offset: 4px; }
  /* Two tabs, full height, the chosen one underlined on the bar's own edge. */
  .modes { position: relative; display: flex; }
  .modes button {
    width: 120px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-3);
    font: 400 12px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.28em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .modes button { transition: color var(--dur-settle) var(--ease-out); }
  .modes button:hover { color: var(--text-2); }
  .modes button[aria-selected='true'] { color: var(--text); }
  /* One light under the chosen mode, gliding to the other: a short line with a
     glow drawn once, moved by transform only. */
  .mode-light {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 120px;
    height: 2px;
    pointer-events: none;
    transition: transform var(--dur-settle) var(--ease-out);
  }
  .mode-light::before {
    content: '';
    position: absolute;
    left: 30px;
    right: 30px;
    top: 0;
    height: 2px;
    border-radius: 2px;
    background: var(--violet-100);
    box-shadow: 0 0 10px 1px #c875ef80, 0 -4px 14px #c875ef40;
  }
  @media (prefers-reduced-motion: reduce) { .mode-light, .modes button { transition: none; } }
  .modes button:focus-visible { outline: 2px solid var(--iris); outline-offset: -4px; }
  .t-wordmark { font: 400 14px/1 var(--display); font-stretch: 125%; letter-spacing: 0.36em; text-transform: uppercase; color: var(--text); }
  .bar-right { display: flex; align-items: center; justify-self: end; gap: 12px; }
  .latency { margin-right: 4px; font: 12px var(--body); white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--text-3); }
  .settings-button {
    display: grid;
    place-items: center;
    min-width: 40px;
    height: 40px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text-2);
    cursor: pointer;
  }
  .settings-button:hover:not(:disabled) { color: var(--text); background: var(--surface-2); }
  .settings-button:disabled { opacity: .45; cursor: default; }
  .tour-button {
    display: inline-flex;
    align-items: center;
    min-height: 36px;
    padding: 0 18px;
    border: 1px solid var(--violet-500);
    border-radius: var(--radius);
    background: var(--action);
    color: var(--action-text);
    font: 500 13px var(--body);
    white-space: nowrap;
    cursor: pointer;
  }
  .tour-button:hover:not(:disabled) { background: var(--action-hover); }
  .tour-button:disabled { opacity: .45; cursor: default; }
  /* A phone: the studio is read there, not played; the bar still fits. */
  @media (max-width: 760px) {
    /* Name and settings on the first line, the two modes under them. */
    .bar { grid-template-columns: 1fr auto; gap: 0 8px; height: auto; min-height: var(--bar-height); }
    .t-wordmark { height: 48px; display: flex; align-items: center; }
    .modes { grid-column: 1 / -1; grid-row: 2; justify-self: center; height: 44px; }
    .t-wordmark { font-size: 11px; letter-spacing: .2em; }
    .modes button, .mode-light { width: 68px; }
    .mode-light::before { left: 16px; right: 16px; }
    .bar-right { gap: 4px; }
  }
</style>
