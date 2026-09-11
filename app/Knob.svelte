<script lang="ts">
  import type { Param } from '../schema/params.ts';
  let {
    param,
    value,
    onchange,
    label = param.label,
    resetValue = param.default,
  }: {
    param: Param;
    value: number;
    onchange: (v: number) => void;
    label?: string;
    resetValue?: number;
  } = $props();

  const logarithmic = $derived(param.taper === 'logarithmic' && param.min > 0);
  const position = $derived(logarithmic ? Math.log(value / param.min) / Math.log(param.max / param.min) : (value - param.min) / (param.max - param.min));
  /* Semitones read as an interval, with their sign: a transposition of -2 is
     "two down", and "-2.0" would be a number about nothing. */
  const shown = $derived(
    param.unit === 'semitones' ? `${value > 0 ? '+' : ''}${Math.round(value)} st`
    : param.unit === 'ratio' ? `${Math.round(value * 100)}%`
    : param.unit === 'Hz' ? `${(value / 1000).toFixed(1)} kHz`
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
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }
</script>
<label class="knob">
  <span class="label">{label}</span>
  <span class="dial" style={`--angle:${-135 + position * 270}deg;--progress:${position * 270}deg`}>
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
  .knob{display:flex;flex-direction:column;align-items:center;gap:11px;min-width:66px}.label{font-size:10px;text-transform:uppercase;letter-spacing:1.7px;color:var(--control-label,#adadad)}.dial{position:relative;width:62px;height:62px;border-radius:50%;background:conic-gradient(from 225deg,var(--knob-accent,#b7b7b7) 0deg var(--progress),#454545 var(--progress) 270deg,transparent 270deg);display:grid;place-items:center}.dial:before{content:'';position:absolute;inset:3px;border-radius:50%;background:#232323}.cap{position:absolute;inset:9px;border:1px solid #686868;border-radius:50%;background:var(--knob-material,linear-gradient(140deg,#5a5a5a,#262626 60%,#191919));box-shadow:0 3px 6px #0009,inset 0 1px 1px #ffffff30;transform:rotate(var(--angle))}.indicator{position:absolute;top:4px;left:calc(50% - 1px);height:10px;width:2px;background:var(--knob-accent,#cfcfcf);border-radius:2px}input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:ns-resize;touch-action:none}.dial:focus-within{outline:2px solid var(--iris);outline-offset:5px}.value{font:10px var(--mono);color:var(--control-label,#adadad);white-space:nowrap}.knob:hover .label{color:#eee}
</style>
