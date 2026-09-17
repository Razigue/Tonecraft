<script lang="ts">
  // The chain band: what stays within reach whatever the stage shows — the
  // level in, the gate, which amp and cabinet, the preset, the level out. In
  // signal order, on one 80 px row.
  import Knob from './Knob.svelte';
  import Meter from './Meter.svelte';
  import { PARAMS, type Param } from '../schema/params.ts';
  import { CABS, CUSTOM_CAB } from '../engine/ir.ts';
  import type { Capture } from '../engine/catalog.ts';
  import { PRESETS, type Preset } from './presets.ts';
  import { lang } from './locale.svelte.ts';
  import { TONE_NAME_MAX } from '../store/tones.ts';

  let { roomy = false, inputPeak, outputRms, values, resetValues, captures, captureFile, cab, customCab, preset, tones, baseTone, power,
    onparam, oncapture, oncab, oncabfile, onpreset, onstep, onsavetone, ondeletetone }: {
    /** Room for the knobs at full size, names above and values below. */
    roomy?: boolean;
    inputPeak: number;
    outputRms: number;
    values: Record<string, number>;
    resetValues: Record<string, number>;
    captures: readonly Capture[];
    captureFile: string;
    cab: string;
    customCab: File | null;
    preset: string | null;
    /** Factory presets first, then the player's saved tones (those with a label). */
    tones: readonly Preset[];
    /** The tone the current sound started from, kept after an edit. */
    baseTone: string | null;
    /** The amp's power, when the head and its switch are not on screen. */
    power?: { on: boolean; busy: boolean; disabled: boolean; onpress: () => void };
    onparam: (id: string, value: number) => void;
    oncapture: (file: string) => void;
    oncab: (id: string) => void;
    oncabfile: (file: File) => void;
    onpreset: (name: string) => void;
    onstep: (direction: number) => void;
    onsavetone: (name: string) => void;
    ondeletetone: (key: string) => void;
  } = $props();

  const t = $derived(lang.ui);
  const param = (id: string): Param => PARAMS.find((p) => p.id === id)!;
  /** A select value that is an action, not a cabinet. */
  const LOAD_CAB = 'load-ir';
  /** Rail length: the compact dial's height, or the full knob's label to value. */
  const travel = $derived(roomy ? 84 : 44);
  let cabFileInput = $state<HTMLInputElement>();

  /** Select values that are actions on the tones, not tones. */
  const SAVE_TONE = 'action:save';
  const DELETE_TONE = 'action:delete';
  const factory = $derived(tones.filter((p) => p.label === undefined));
  const saved = $derived(tones.filter((p) => p.label !== undefined));
  const current = $derived(saved.find((p) => p.name === preset));
  /** While naming, the dropdown gives its place to a text field. */
  let naming = $state(false);
  let draft = $state('');
  let nameInput = $state<HTMLInputElement>();
  const replacing = $derived(saved.some((p) => p.label!.toLocaleLowerCase() === draft.trim().toLocaleLowerCase()));

  function choose(select: HTMLSelectElement): void {
    const value = select.value;
    if (value === SAVE_TONE || value === DELETE_TONE) select.value = preset ?? '';
    if (value === SAVE_TONE) {
      // After an edit, the name offered is the tone it started from: saving updates it.
      draft = saved.find((p) => p.name === baseTone)?.label ?? '';
      naming = true;
      queueMicrotask(() => nameInput?.select());
    } else if (value === DELETE_TONE) {
      if (current !== undefined) ondeletetone(current.name);
    } else {
      onpreset(value);
    }
  }
  function commit(): void {
    if (draft.trim() !== '') onsavetone(draft);
    naming = false;
  }
</script>

<section class="global-controls tc-plate" class:roomy aria-label={t.rig.globalControls}>
  <div class="io-control">
    <Meter level={inputPeak} kind="peak" {travel} label={roomy ? t.rig.meterIn : undefined} />
    <Knob compact={!roomy} param={param('in_trim')} value={values.in_trim!} resetValue={resetValues.in_trim} onchange={v => onparam('in_trim', v)} label={t.params.in_trim} />
  </div>
  <div class="gate-control">
    <Knob compact={!roomy} param={param('gate_threshold')} value={values.gate_threshold!} resetValue={resetValues.gate_threshold} onchange={v => onparam('gate_threshold', v)} label={t.params.gate_threshold} />
    <button class="enable" aria-label={t.rig.gateEnabled} title={values.gate_bypass === 1 ? t.rig.gateOff : t.rig.gateOn} aria-pressed={values.gate_bypass !== 1} onclick={() => onparam('gate_bypass', values.gate_bypass === 1 ? 0 : 1)}><span></span></button>
  </div>
  <div class="rig-selectors">
    <label class="selector"><span>{t.rig.amplifier}</span><select aria-label={t.rig.capture} value={captureFile} onchange={e => oncapture(e.currentTarget.value)}>{#each captures as c}<option value={c.file}>{c.file === PRESETS[0]?.capture ? 'GUILT · Lead' : c.name}</option>{/each}</select></label>
    <label class="selector"><span>{t.rig.cabinet}</span><select aria-label={t.rig.cabinet} value={cab} onchange={e => { const id = e.currentTarget.value; e.currentTarget.value = cab; if (id === LOAD_CAB) cabFileInput?.click(); else oncab(id); }}>{#each CABS as c}<option value={c.id}>{t.rig.cabs[c.id] ?? c.name}</option>{/each}{#if customCab !== null}<option value={CUSTOM_CAB}>IR · {customCab.name.replace(/\.[^.]+$/, '')}</option>{/if}<option value={LOAD_CAB}>{t.rig.loadIr}</option></select></label>
    <input bind:this={cabFileInput} aria-label={t.rig.cabinetIrFile} type="file" accept=".wav,.aif,.aiff,.flac,audio/*" hidden onchange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) oncabfile(f); }} />
  </div>
  <div class="tone-selector">
    <span class="eyebrow">{t.rig.tonePreset}</span>
    {#if naming}
      <form class="preset-picker" onsubmit={e => { e.preventDefault(); commit(); }}
        onfocusout={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) naming = false; }}>
        <input bind:this={nameInput} bind:value={draft} aria-label={t.rig.toneName} placeholder={t.rig.toneName} maxlength={TONE_NAME_MAX}
          onkeydown={e => { if (e.key === 'Escape') { e.preventDefault(); naming = false; } }} />
        <button class="confirm" type="submit" disabled={draft.trim() === ''}>{replacing ? t.rig.replaceTone : t.rig.saveToneConfirm}</button>
      </form>
    {:else}
      <div class="preset-picker">
        <button aria-label={t.rig.previousPreset} onclick={() => onstep(-1)}>‹</button>
        <select aria-label={t.rig.tonePreset} value={preset ?? ''} onchange={e => choose(e.currentTarget)}>
          <option value="" disabled>{t.rig.customTone}</option>
          {#each factory as p}<option value={p.name}>{t.rig.presets[p.name] ?? p.name}</option>{/each}
          {#if saved.length > 0}<optgroup label={t.rig.myTones}>{#each saved as p}<option value={p.name}>{p.label}</option>{/each}</optgroup>{/if}
          <optgroup label={t.rig.manageTones}>
            <option value={SAVE_TONE}>{t.rig.saveTone}</option>
            {#if current !== undefined}<option value={DELETE_TONE}>{t.rig.deleteTone(current.label!)}</option>{/if}
          </optgroup>
        </select>
        <button aria-label={t.rig.nextPreset} onclick={() => onstep(1)}>›</button>
      </div>
    {/if}
  </div>
  {#if power}
    <div class="power-control">
      <button class="power" type="button" aria-label={t.rig.amplifierPower} aria-pressed={power.on} aria-busy={power.busy} disabled={power.disabled} onclick={power.onpress}>
        <span class="lamp" class:lit={power.on}></span>{t.rig.power}
      </button>
    </div>
  {/if}
  <div class="io-control output-control">
    <Knob compact={!roomy} param={param('out_master')} value={values.out_master!} resetValue={resetValues.out_master} onchange={v => onparam('out_master', v)} label={t.params.out_master} />
    <Meter level={outputRms} {travel} label={roomy ? t.rig.meterOut : undefined} />
  </div>
</section>

<style>
  /* One row, in signal order, seams between the stages. */
  .global-controls {
    display: flex;
    align-items: center;
    gap: 24px;
    height: 80px;
    padding: 0 24px;
  }
  /* Full knobs: the band the original studio had over the head. */
  .roomy { height: 136px; gap: 32px; padding: 0 32px; }
  .roomy > * + * { padding-left: 32px; }
  .roomy .io-control, .roomy .gate-control { gap: 16px; }
  .roomy .rig-selectors { flex-direction: column; gap: 12px; }
  .roomy .selector { gap: 8px; }
  .roomy .tone-selector { align-items: center; gap: 14px; }
  .roomy .preset-picker { width: 100%; }
  .roomy .preset-picker select { min-height: 44px; font-size: 16px; }
  /* Beside its name, as the head's blocks carry theirs. */
  .roomy .gate-control { position: relative; }
  .roomy .enable { position: absolute; top: -8px; left: calc(50% + 30px); }
  .global-controls > * + * { padding-left: 24px; border-left: 1px solid var(--line); }
  .io-control, .gate-control { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  .output-control { margin-left: auto; }
  .power-control + .output-control { margin-left: 0; }
  .power-control { margin-left: auto; }
  .power { transition: color var(--dur-quick) ease-out, border-color var(--dur-quick) ease-out; }
  .power { display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--surface-2); color: var(--text-2); font: 400 10px/1 var(--display); font-stretch: 125%; letter-spacing: 0.2em; text-transform: uppercase; white-space: nowrap; cursor: pointer; }
  .power:hover:not(:disabled) { border-color: var(--violet-500); color: var(--text); }
  .power:disabled { opacity: .5; cursor: wait; }
  .power:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }
  /* The lamp warms up: its glow is a layer that fades in, never an animated shadow. */
  .lamp { position: relative; width: 8px; height: 8px; border-radius: 50%; background: var(--violet-900); box-shadow: 0 0 0 1px var(--violet-600); transition: background-color 650ms ease-in; }
  .lamp::after { content: ''; position: absolute; inset: -5px; border-radius: 50%; background: radial-gradient(circle, #c875efaa, transparent 70%); opacity: 0; transition: opacity 650ms ease-in; }
  .lamp.lit { background: #eac0fc; }
  .lamp.lit::after { opacity: 1; }
  @media (prefers-reduced-motion: reduce) { .lamp, .lamp::after, .enable span { transition: none; } }
  /* The gate's switch is a lamp beside its dial, as the amp's blocks have. */
  .enable { display: grid; flex-shrink: 0; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; background: none; cursor: pointer; }
  .enable span { width: 7px; height: 7px; border-radius: 50%; border: 1px solid var(--violet-600); box-sizing: border-box; transition: background-color var(--dur-settle) var(--ease-out), border-color var(--dur-settle) var(--ease-out); }
  .enable[aria-pressed='true'] span { background: var(--accent); border-color: var(--accent); box-shadow: 0 0 5px #d6b6e399; }
  .enable:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }

  .eyebrow, .selector > span {
    font: 400 10px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-2);
  }
  .rig-selectors { display: flex; flex: 1 1 360px; gap: 16px; min-width: 0; }
  .selector { display: flex; flex: 1; flex-direction: column; gap: 7px; min-width: 0; }
  .tone-selector { display: flex; flex: 0 1 260px; flex-direction: column; gap: 7px; min-width: 200px; }
  .preset-picker { display: flex; align-items: center; gap: 4px; }
  select {
    width: 100%;
    min-width: 0;
    min-height: 36px;
    padding: 0 30px 0 10px;
    appearance: none;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface-2) var(--chevron) no-repeat right 11px center;
    color: var(--text);
    font: 13px var(--body);
    text-overflow: ellipsis;
    cursor: pointer;
  }
  select:hover { border-color: var(--line-strong); }
  select:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }
  .preset-picker select { flex: 1; font: 500 14px var(--body); text-align: center; text-align-last: center; }
  .preset-picker button {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 28px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text-2);
    font-size: 22px;
    cursor: pointer;
  }
  .preset-picker button:hover { color: var(--text); background: var(--surface-2); }
  .preset-picker input {
    flex: 1;
    min-width: 0;
    min-height: 36px;
    padding: 0 10px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text);
    font: 500 14px var(--body);
  }
  .preset-picker input:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }
  .preset-picker .confirm { width: auto; padding: 0 10px; color: var(--accent); font: 500 12px var(--body); }
  .preset-picker .confirm:disabled { opacity: .5; cursor: default; }
  .roomy .preset-picker input { min-height: 44px; font-size: 16px; }

  /* Narrower, the knobs keep their dials and lose their words first. */
  @media (max-width: 1240px) {
    .global-controls, .global-controls > * + * { gap: 14px; padding-left: 14px; }
    .global-controls { padding-right: 14px; }
    .global-controls :global(.compact .value) { display: none; }
  }
</style>
