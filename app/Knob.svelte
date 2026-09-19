<script lang="ts">
  import type { Param } from '../schema/params.ts';
  let {
    param,
    value,
    onchange,
    label = param.label,
    resetValue = param.default,
    powered,
    compact = false,
  }: {
    param: Param;
    value: number;
    onchange: (v: number) => void;
    label?: string;
    resetValue?: number;
    /** Opt-in cabinet illumination; absent on the neutral studio controls. */
    powered?: boolean;
    /** The chain band's size: a smaller dial with its name and value beside it. */
    compact?: boolean;
  } = $props();

  const logarithmic = $derived(param.taper === 'logarithmic' && param.min > 0);
  const position = $derived(logarithmic ? Math.log(value / param.min) / Math.log(param.max / param.min) : (value - param.min) / (param.max - param.min));
  /* Semitones read as an interval, with their sign: a transposition of -2 is
     "two down", and "-2.0" would be a number about nothing. */
  const shown = $derived(
    param.unit === 'semitones' ? `${value > 0 ? '+' : ''}${Math.round(value)} st`
    : param.unit === 'ratio' ? `${Math.round(value * 100)}%`
    : param.unit === 'Hz' ? `${(value / 1000).toFixed(1)} kHz`
    : param.unit === 'ms' ? `${Math.round(value)} ms`
    : `${value.toFixed(1)}${param.unit === 'dB' ? ' dB' : ''}`);

  let dragging = false;
  let originY = 0;
  let originPosition = 0;

  function update(t: number) {
    const clamped = Math.min(1, Math.max(0, t));
    const v = logarithmic
      ? param.min * Math.pow(param.max / param.min, clamped)
      : param.min + clamped * (param.max - param.min);
    // A stepped control lands on whole units. The wire format still carries a
    // number, and the chain still accepts anything between them (AD-9).
    onchange(param.taper === 'stepped' ? Math.round(v) : v);
  }

  function beginDrag(event: PointerEvent): void {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    dragging = true;
    originY = event.clientY;
    originPosition = position;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function drag(event: PointerEvent): void {
    if (!dragging) return;
    const sensitivity = event.shiftKey ? 480 : 120;
    update(originPosition + (originY - event.clientY) / sensitivity);
  }

  function endDrag(event: PointerEvent): void {
    dragging = false;
    if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }
</script>
<label class="knob" class:compact>
  <span class="label">{label}</span>
  <span class="dial" class:power-dial={powered !== undefined} class:powered={powered === true} style={`--angle:${-135 + position * 270}deg;--progress:${position * 270}deg`}>
    {#if powered !== undefined}
      <span class="dial-light" aria-hidden="true"><span class="sweep-half first"></span><span class="sweep-half second"></span></span>
    {/if}
    <span class="cap"><span class="indicator"></span></span>
    <input
      type="range"
      aria-label={label}
      aria-valuetext={shown}
      min="0"
      max="1"
      step="0.0025"
      value={position}
      oninput={(event) => update(Number(event.currentTarget.value))}
      onpointerdown={beginDrag}
      onpointermove={drag}
      onpointerup={endDrag}
      onpointercancel={endDrag}
      ondblclick={(event) => { event.preventDefault(); onchange(resetValue); }}
    />
  </span>
  <span class="value">{shown}</span>
</label>
<style>
  /* One knob family for the whole studio: a dark well, a ring that fills in
     the accent, a machined cap. The amp head only dims the ring and lights it
     with its power (the sweep below); nothing else differs. */
  .knob { display: flex; flex-direction: column; align-items: center; gap: 10px; min-width: 66px; }
  .label {
    font: 400 10px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--control-label, var(--text-2));
  }
  .dial {
    position: relative;
    display: grid;
    place-items: center;
    width: 62px;
    height: 62px;
    border-radius: 50%;
    background: conic-gradient(from 225deg, var(--knob-accent, var(--violet-400)) 0deg var(--progress), var(--violet-800) var(--progress) 270deg, transparent 270deg);
    box-shadow: 0 1px 0 #d5c0de1a, 0 -1px 2px #000b;
  }
  .dial::before {
    content: '';
    position: absolute;
    inset: 3px;
    border-radius: 50%;
    background: radial-gradient(circle at 40% 32%, #332c38, #110d16 75%);
    box-shadow: inset 0 2px 4px #000;
  }
  .cap {
    position: absolute;
    inset: 9px;
    border: 1px solid;
    border-color: #9a899d #4b414f #27202e #796c80;
    border-radius: 50%;
    background: conic-gradient(from 35deg, #27232a, #89818d 55deg, #49424e 105deg, #211e24 175deg, #514a57 260deg, #a39aa6 310deg, #27232a);
    box-shadow: 2px 5px 5px #000b, 0 2px 0 2px #141018, inset 0 0 0 2px #c5b0d022, inset 0 1px 2px #eee2f455;
    transform: rotate(var(--angle));
  }
  .indicator {
    position: absolute;
    top: 4px;
    left: calc(50% - 1px);
    width: 2px;
    height: 10px;
    border-radius: 2px;
    background: var(--knob-accent, var(--violet-200));
  }
  input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: ns-resize; touch-action: none; }
  .dial:focus-within { outline: 2px solid var(--iris); outline-offset: 5px; }
  .value { font: 10px var(--mono); font-variant-numeric: tabular-nums; color: var(--control-label, var(--text-2)); white-space: nowrap; }
  .knob:hover .label { color: var(--text); }
  /* Name above value, both to the right of a 44 px dial: 44 px tall in all. */
  .compact { display: grid; grid-template: auto auto / 44px auto; column-gap: 10px; row-gap: 6px; align-items: center; min-width: 0; }
  .compact .dial { grid-row: 1 / 3; width: 44px; height: 44px; }
  .compact .label { align-self: end; }
  .compact .value { align-self: start; }
  .compact .cap { inset: 7px; }
  .compact .indicator { top: 3px; height: 7px; }
  /* Two rotating half-rings reveal a fixed light texture. The static mask
     clips the sweep at the saved value; no gradient or filter animates. */
  .power-dial .dial-light {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    pointer-events: none;
    transform: rotate(225deg);
    mask-image: conic-gradient(#000 0deg var(--progress),transparent var(--progress));
    opacity: 0;
    transition: opacity 400ms ease-out;
  }
  .sweep-half { position: absolute; inset: 0; clip-path: inset(0 0 0 50%); }
  .sweep-half.second { transform: rotate(180deg); }
  .sweep-half::before {
    content: '';
    position: absolute;
    inset: 0;
    border: 3px solid var(--violet-200);
    border-radius: 50%;
    clip-path: inset(0 50% 0 0);
    transform: rotate(0deg);
    transition: transform 0s 400ms;
  }
  .power-dial.powered .dial-light { opacity: 1; transition: opacity 250ms ease-in; }
  .powered .first::before { transform: rotate(180deg); transition: transform 600ms linear 100ms; }
  .powered .second::before { transform: rotate(90deg); transition: transform 300ms linear 700ms; }
  .power-dial .indicator { background: var(--violet-600); }
  .power-dial .indicator::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--violet-200);
    box-shadow: 0 0 4px #d6b6e388;
    opacity: 0;
    transition: opacity 400ms ease-out;
  }
  .power-dial.powered .indicator::after { opacity: 1; transition: opacity 850ms ease-in 100ms; }
  @starting-style {
    .power-dial.powered .dial-light,.power-dial.powered .indicator::after { opacity: 0; }
    .powered .first::before,.powered .second::before { transform: rotate(0deg); }
  }
  @media(prefers-reduced-motion:reduce) {
    .power-dial .dial-light,.sweep-half::before,.power-dial .indicator::after { transition: none !important; }
  }
</style>
