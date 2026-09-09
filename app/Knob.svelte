<script lang="ts">
  import type { Param } from '../schema/params.ts';
  let { param, value, onchange, label = param.label }: { param: Param; value: number; onchange: (v: number) => void; label?: string } = $props();
  const logarithmic = $derived(param.taper === 'logarithmic' && param.min > 0);
  const position = $derived(logarithmic ? Math.log(value / param.min) / Math.log(param.max / param.min) : (value - param.min) / (param.max - param.min));
  const shown = $derived(param.unit === 'ratio' ? `${Math.round(value * 100)}%` : param.unit === 'Hz' ? `${(value / 1000).toFixed(1)} kHz` : `${value.toFixed(1)}${param.unit === 'dB' ? ' dB' : ''}`);
  function update(t: number) { onchange(logarithmic ? param.min * Math.pow(param.max / param.min, t) : param.min + t * (param.max - param.min)); }
</script>
<label class="knob">
  <span class="label">{label}</span>
  <span class="dial" style={`--angle:${-135 + position * 270}deg;--progress:${position * 270}deg`}>
    <span class="cap"><span class="indicator"></span></span>
    <input type="range" aria-label={label} aria-valuetext={shown} min="0" max="1" step="0.0025" value={position} oninput={(e) => update(Number(e.currentTarget.value))} ondblclick={() => onchange(param.default)} />
  </span>
  <span class="value">{shown}</span>
</label>
<style>
  .knob{display:flex;flex-direction:column;align-items:center;gap:11px;min-width:66px}.label{font-size:10px;text-transform:uppercase;letter-spacing:1.7px;color:var(--control-label,#adadad)}.dial{position:relative;width:62px;height:62px;border-radius:50%;background:conic-gradient(from 225deg,var(--knob-accent,#b7b7b7) 0deg var(--progress),#454545 var(--progress) 270deg,transparent 270deg);display:grid;place-items:center}.dial:before{content:'';position:absolute;inset:3px;border-radius:50%;background:#232323}.cap{position:absolute;inset:9px;border:1px solid #686868;border-radius:50%;background:var(--knob-material,linear-gradient(140deg,#5a5a5a,#262626 60%,#191919));box-shadow:0 3px 6px #0009,inset 0 1px 1px #ffffff30;transform:rotate(var(--angle))}.indicator{position:absolute;top:4px;left:calc(50% - 1px);height:10px;width:2px;background:var(--knob-accent,#cfcfcf);border-radius:2px}input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:ew-resize}.dial:focus-within{outline:2px solid var(--iris);outline-offset:5px}.value{font:10px var(--mono);color:var(--control-label,#adadad);white-space:nowrap}.knob:hover .label{color:#eee}
</style>
