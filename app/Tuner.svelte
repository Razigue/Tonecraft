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
    ? 'Play a note'
    : inTune ? 'In tune' : reading.cents < 0 ? 'Tune up' : 'Tune down');
  const valueText = $derived(reading === null
    ? 'Waiting for a note'
    : `${reading.note}${reading.octave}, ${Math.round(reading.cents)} cents, ${direction}`);
</script>

<dialog
  class="tuner"
  bind:this={element}
  aria-labelledby="tuner-title"
  oncancel={(event) => { event.preventDefault(); element?.close(); }}
  onclose={onclose}
>
  <button class="close" type="button" aria-label="Close tuner" onclick={() => element?.close()}>×</button>

  <div class="tuner-heading">
    <span class="eyebrow">TUNER</span>
    <p>Monitoring muted</p>
  </div>

  <div class="note-wrap" class:heard={reading !== null} class:in-tune={inTune}>
    <strong id="tuner-title">{reading?.note ?? '—'}</strong>
    <span>{reading === null ? '' : reading.octave}</span>
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
    width: 100vw;
    max-width: none;
    height: 100svh;
    max-height: none;
    margin: 0;
    padding: clamp(28px, 5vw, 72px);
    box-sizing: border-box;
    border: 0;
    color: var(--ink);
    background: #0b0a0d;
    overflow: hidden;
  }
  .tuner[open] {
    display: grid;
    grid-template-rows: auto 1fr auto auto;
    align-items: center;
    animation: tuner-in 200ms cubic-bezier(0.2, 0, 0, 1);
  }
  .tuner::backdrop { background: #000; }
  .close {
    position: absolute;
    top: 24px;
    right: 28px;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 1px solid #3f3a43;
    border-radius: 50%;
    background: #141217;
    color: #c8c2ca;
    font: 300 27px/1 var(--body);
    cursor: pointer;
  }
  .close:hover { border-color: #786a7c; color: #fff; }
  .close:focus-visible { outline: 2px solid var(--iris); outline-offset: 3px; }
  .tuner-heading { align-self: start; display: flex; flex-direction: column; gap: 8px; }
  .eyebrow { font: 9px var(--mono); letter-spacing: 2px; color: #9a909d; }
  .tuner-heading p { margin: 0; font: 12px var(--body); color: #756e78; }
  .note-wrap {
    place-self: end center;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    min-width: min(50vw, 360px);
    padding: 12px 28px 18px;
    border-bottom: 1px solid #332e36;
    color: #4f4852;
  }
  .note-wrap.heard { color: #d7bfdc; border-color: #76627b; background: #161219; }
  .note-wrap.in-tune { color: #eadff0; border-color: #b79abe; background: #1e1822; }
  .note-wrap strong {
    font-family: var(--display);
    font-size: clamp(88px, 15vw, 150px);
    font-weight: 300;
    line-height: .9;
    letter-spacing: .02em;
  }
  .note-wrap span { min-width: 1ch; margin: 10px 0 0 8px; font: 18px var(--mono); color: #817685; }
  .tuner-scale { width: min(820px, 88vw); place-self: center; margin-top: clamp(36px, 8vh, 80px); }
  .rail { position: relative; height: 64px; border-top: 1px solid #4d4650; }
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
  .scale-labels { display: flex; justify-content: space-between; margin-top: -19px; font: 9px var(--mono); letter-spacing: 1.8px; color: #68606b; }
  .scale-labels strong { font-weight: 400; color: #9f92a3; }
  .in-tune .scale-labels strong { color: #d8bfdc; }
  .cents { place-self: start center; min-height: 1em; margin: 6px 0 0; font: 13px var(--mono); color: #8f8592; }
  @keyframes tuner-in { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) {
    .tuner { padding: 24px; }
    .close { top: 18px; right: 18px; }
    .note-wrap { min-width: 58vw; }
    .tuner-scale { width: 90vw; }
  }
  @media (prefers-reduced-motion: reduce) { .tuner[open] { animation: none; } }
</style>
