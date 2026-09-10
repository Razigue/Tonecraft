<script lang="ts">
  import type { PitchReading } from '../engine/tuner.ts';

  interface Props {
    reading: PitchReading | null;
    onclose: () => void;
    element?: HTMLDialogElement | null;
  }

  let { reading, onclose, element = $bindable(null) }: Props = $props();

  const cents = $derived(reading === null ? 0 : Math.max(-50, Math.min(50, reading.cents)));
  const position = $derived(50 + cents);
  const inTune = $derived(reading !== null && Math.abs(reading.cents) <= 5);
  const direction = $derived(reading === null
    ? ''
    : inTune ? 'In tune' : reading.cents < 0 ? 'Tune up' : 'Tune down');
  const valueText = $derived(reading === null
    ? 'Waiting for a note'
    : `${reading.note}${reading.octave}, ${Math.round(reading.cents)} cents, ${direction}`);
</script>

<dialog
  class="tuner"
  bind:this={element}
  aria-label="Tuner"
  oncancel={(event) => { event.preventDefault(); element?.close(); }}
  onclose={onclose}
>
  <button class="close" type="button" aria-label="Close tuner" onclick={() => element?.close()}>
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
    aria-label="Tuning accuracy"
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
    <div class="scale-labels"><span>LOW</span><strong>{direction.toUpperCase()}</strong><span>HIGH</span></div>
  </div>

  <p class="cents" aria-hidden="true">
    {reading === null ? '—' : `${reading.cents > 0 ? '+' : ''}${Math.round(reading.cents)} cents`}
  </p>
</dialog>

<style>
  .tuner {
    width: min(680px, calc(100vw - 40px));
    max-width: 680px;
    margin: auto;
    padding: 64px 48px 38px;
    box-sizing: border-box;
    border: 1px solid #403a43;
    border-radius: 10px;
    color: var(--ink);
    background: #111013;
    box-shadow: 0 24px 70px #000c;
    overflow: hidden;
  }
  .tuner[open] {
    display: grid;
    grid-template-rows: auto auto auto;
    align-items: center;
    row-gap: 26px;
    animation: tuner-in 200ms cubic-bezier(0.2, 0, 0, 1);
  }
  .tuner::backdrop { background: #000c; }
  .close {
    position: absolute;
    top: 14px;
    right: 14px;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: #c8c2ca;
    cursor: pointer;
  }
  .close svg { display: block; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
  .close:hover { background: #1d1a20; color: #fff; }
  .close:focus-visible { outline: 2px solid var(--iris); outline-offset: 3px; }
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
    color: #4f4852;
  }
  .note-wrap::before, .note-wrap::after {
    content: '';
    width: 100%;
    height: 1px;
    background: #302b32;
  }
  .note-wrap.heard { color: #d7bfdc; }
  .note-wrap.heard::before, .note-wrap.heard::after { background: #695b6c; }
  .note-wrap.in-tune { color: #eadff0; }
  .note-wrap.in-tune::before, .note-wrap.in-tune::after { background: #a287a8; }
  .note-wrap strong {
    font-family: var(--display);
    font-size: clamp(78px, 12vw, 112px);
    font-weight: 300;
    line-height: .9;
    letter-spacing: .02em;
  }
  .tuner-scale { width: 100%; place-self: center; }
  .rail { position: relative; height: 54px; border-top: 1px solid #4d4650; }
  .tick, .centre { position: absolute; top: -1px; width: 1px; height: 13px; background: #4d4650; }
  .low { left: 0; }.quarter-low { left: 25%; }.quarter-high { left: 75%; }.high { right: 0; }
  .centre { left: 50%; height: 31px; background: #918595; transform: translateX(-50%); }
  .centre i { position: absolute; top: -5px; left: -4px; width: 9px; height: 9px; border-radius: 50%; background: #b9a7be; }
  .position {
    position: absolute;
    top: -9px;
    width: 3px;
    height: 48px;
    background: #d7bfdc;
    transform: translateX(-50%);
    box-shadow: 0 0 16px #c79bd3aa;
  }
  .in-tune .position { background: #f0e5f2; box-shadow: 0 0 22px #d8b7df; }
  .scale-labels { display: grid; grid-template-columns: 1fr 1fr 1fr; margin-top: -19px; font: 9px var(--mono); letter-spacing: 1.8px; color: #68606b; }
  .scale-labels strong { min-height: 1em; font-weight: 400; color: #9f92a3; text-align: center; }
  .scale-labels span:last-child { text-align: right; }
  .in-tune .scale-labels strong { color: #d8bfdc; }
  .cents { place-self: start center; min-height: 1em; margin: 6px 0 0; font: 13px var(--mono); color: #8f8592; }
  @keyframes tuner-in { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) {
    .tuner { width: calc(100vw - 28px); padding: 58px 24px 30px; }
    .close { top: 10px; right: 10px; }
  }
  @media (prefers-reduced-motion: reduce) { .tuner[open] { animation: none; } }
</style>
