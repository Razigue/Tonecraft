<script lang="ts">
  import type { PitchReading } from '../engine/tuner.ts';
  import { lang } from './locale.svelte.ts';

  interface Props {
    reading: PitchReading | null;
    onclose: () => void;
    element?: HTMLDialogElement | null;
  }

  let { reading, onclose, element = $bindable(null) }: Props = $props();
  const words = $derived(lang.ui.tuner);

  const cents = $derived(reading === null ? 0 : Math.max(-50, Math.min(50, reading.cents)));
  const position = $derived(50 + cents);
  const inTune = $derived(reading !== null && Math.abs(reading.cents) <= 5);
  const direction = $derived(reading === null
    ? ''
    : inTune ? words.inTune : reading.cents < 0 ? words.tuneUp : words.tuneDown);
  const valueText = $derived(reading === null
    ? words.waiting
    : words.reading(`${reading.note}${reading.octave}`, Math.round(reading.cents), direction));
</script>

<dialog
  class="tc-dialog tuner"
  bind:this={element}
  aria-label={words.dialog}
  oncancel={(event) => { event.preventDefault(); element?.close(); }}
  onclose={onclose}
>
  <button class="tc-close" type="button" aria-label={words.close} onclick={() => element?.close()}>
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  </button>

  <div class="note-wrap" class:heard={reading !== null} class:in-tune={inTune}>
    <strong>{reading?.note ?? '—'}</strong>
  </div>

  <div
    class="tuner-scale"
    class:in-tune={inTune}
    role="meter"
    aria-label={words.accuracy}
    aria-valuemin={-50}
    aria-valuemax={50}
    aria-valuenow={Math.round(cents)}
    aria-valuetext={valueText}
  >
    <div class="rail">
      <span class="tick low"></span>
      <span class="tick quarter-low"></span>
      <span class="centre"><i></i></span>
      <span class="tick quarter-high"></span>
      <span class="tick high"></span>
      {#if reading !== null}
        <span class="position" style={`left:${position}%`}></span>
      {/if}
    </div>
    <div class="scale-labels"><span>{words.low.toUpperCase()}</span><strong>{direction.toUpperCase()}</strong><span>{words.high.toUpperCase()}</span></div>
  </div>

  <p class="cents" aria-hidden="true">
    {reading === null ? '—' : words.cents(`${reading.cents > 0 ? '+' : ''}${Math.round(reading.cents)}`)}
  </p>
</dialog>

<style>
  .tuner { width: min(680px, calc(100vw - 40px)); padding: 64px 48px 38px; overflow: hidden; }
  .tuner[open] { display: grid; grid-template-rows: auto auto auto; align-items: center; row-gap: 26px; }
  .note-wrap {
    place-self: center;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 20px;
    width: min(390px, 76vw);
    min-height: 120px;
    padding: 8px 0 14px;
    box-sizing: border-box;
    color: var(--violet-700);
  }
  .note-wrap::before, .note-wrap::after { content: ''; width: 100%; height: 1px; background: var(--violet-800); }
  .note-wrap.heard { color: var(--accent); }
  .note-wrap.heard::before, .note-wrap.heard::after { background: var(--violet-600); }
  .note-wrap.in-tune { color: var(--violet-50); }
  .note-wrap.in-tune::before, .note-wrap.in-tune::after { background: var(--violet-400); }
  .note-wrap strong { font-family: var(--display); font-size: clamp(78px, 12vw, 112px); font-weight: 300; line-height: .9; letter-spacing: .02em; }
  .tuner-scale { width: 100%; place-self: center; }
  .rail { position: relative; height: 54px; border-top: 1px solid var(--violet-700); }
  .tick, .centre { position: absolute; top: -1px; width: 1px; height: 13px; background: var(--violet-700); }
  .low { left: 0; }.quarter-low { left: 25%; }.quarter-high { left: 75%; }.high { right: 0; }
  .centre { left: 50%; height: 31px; background: var(--violet-500); transform: translateX(-50%); }
  .centre i { position: absolute; top: -5px; left: -4px; width: 9px; height: 9px; border-radius: 50%; background: var(--violet-300); }
  .position { position: absolute; top: -9px; width: 3px; height: 48px; background: var(--accent); transform: translateX(-50%); box-shadow: 0 0 16px #c79bd3aa; }
  .in-tune .position { background: var(--violet-50); box-shadow: 0 0 22px #d8b7df; }
  .scale-labels {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    margin-top: -19px;
    font: 400 10px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.2em;
    color: var(--text-3);
  }
  .scale-labels strong { min-height: 1em; font-weight: 400; color: var(--text-2); text-align: center; }
  .scale-labels span:last-child { text-align: right; }
  .in-tune .scale-labels strong { color: var(--accent); }
  .cents { place-self: start center; min-height: 1em; margin: 6px 0 0; font: 13px var(--mono); color: var(--text-2); }
  @media (max-width: 600px) { .tuner { padding: 58px 24px 30px; } }
</style>
