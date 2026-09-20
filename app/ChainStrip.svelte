<script lang="ts">
  // The chain band: what stays within reach whatever the stage shows — the
  // level in, the gate, which amp and cabinet, the preset, the doubler, the
  // level out. In signal order, on one 80 px row.
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
  /**
   * The stages the amplifier's plate has no place for. They are pedals in the
   * chain either way — a transposer and a screamer in front, a reverb behind —
   * so they are grouped as pedals rather than squeezed onto a faceplate that
   * was never engraved for them. Boost keeps its switch on the head too: in
   * Play the head is off screen, and a stage must stay reachable from the band.
   */
  const PEDALS = [
    { stage: 'pitch', bypass: 'pitch_bypass', knobs: ['pitch_shift', 'pitch_mix'] },
    { stage: 'boost', bypass: 'drive_bypass', knobs: ['drive_tone'] },
    { stage: 'reverb', bypass: 'reverb_bypass', knobs: ['reverb_mix'] },
  ] as const;
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

<section class="global-controls tc-plate tc-panel tc-band" class:roomy aria-label={t.rig.globalControls}>
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
  <!-- What the head has no place engraved for. Its plate is a map of seven
       controls and a lever; these three stages are real and have to be
       reachable, so they live here, behind one key, rather than being drawn
       onto an amplifier that does not have them. -->
  <div class="pedals-control">
    <button class="tc-button icon pedals-button" type="button" popovertarget="chain-pedals" aria-label={t.rig.pedals} title={t.rig.pedals}>
      <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1.6" /><circle cx="8" cy="6.2" r="1.9" /><path d="M4.6 11.4h6.8" stroke-linecap="round" /></svg>
    </button>
  </div>
  {#if power}
    <div class="power-control">
      <button class="power" type="button" aria-label={t.rig.amplifierPower} title={t.rig.amplifierPower} aria-pressed={power.on} aria-busy={power.busy} disabled={power.disabled} onclick={power.onpress}>
        <span class="lamp" class:lit={power.on}></span><span class="power-word">{t.rig.power}</span>
      </button>
    </div>
  {/if}
  <div class="out-group">
  <div class="doubler-control">
    <Knob compact={!roomy} param={param('doubler_spread')} value={values.doubler_spread!} resetValue={resetValues.doubler_spread} onchange={v => onparam('doubler_spread', v)} label={t.params.doubler_spread} />
    <button class="enable" aria-label={t.rig.doublerEnabled} title={values.doubler_bypass === 1 ? t.rig.doublerOff : t.rig.doublerOn} aria-pressed={values.doubler_bypass !== 1} onclick={() => onparam('doubler_bypass', values.doubler_bypass === 1 ? 0 : 1)}>{#if !roomy}<b>{t.params.doubler_spread}</b>{/if}<span></span></button>
  </div>
  <div class="io-control output-control">
    <Knob compact={!roomy} param={param('out_master')} value={values.out_master!} resetValue={resetValues.out_master} onchange={v => onparam('out_master', v)} label={t.params.out_master} />
    <Meter level={outputRms} {travel} label={roomy ? t.rig.meterOut : undefined} />
  </div>
  </div>

  <div id="chain-pedals" class="pedals tc-popover" popover aria-label={t.rig.pedals}>
    {#each PEDALS as pedal (pedal.stage)}
      <div class="pedal">
        <button class="enable" aria-label={t.rig.groupEnabled[pedal.stage]} aria-pressed={values[pedal.bypass] !== 1}
          onclick={() => onparam(pedal.bypass, values[pedal.bypass] === 1 ? 0 : 1)}><b>{t.rig.groups[pedal.stage]}</b><span></span></button>
        <div class="pedal-knobs">
          {#each pedal.knobs as id (id)}
            <Knob param={param(id)} value={values[id]!} resetValue={resetValues[id]} onchange={(v) => onparam(id, v)} label={t.params[id]} />
          {/each}
        </div>
      </div>
    {/each}
  </div>
</section>

<style>
  /* One row, in signal order, seams between the stages. */
  .global-controls {
    anchor-name: --chain-band;
    display: flex;
    align-items: center;
    gap: 24px;
    height: 80px;
    padding: 0 24px;
  }
  /* Full knobs: the band the original studio had over the head. */
  /* Full size, the row carries one more stage than it used to — the pedals'
     key — and 32 px seams no longer leave the meters their names. The seam is
     the compact row's, which is the same band at the same rhythm. */
  .roomy { height: 136px; gap: 24px; padding: 0 24px; }
  .roomy > * + * { padding-left: 24px; }
  .roomy .io-control, .roomy .gate-control, .roomy .doubler-control { gap: 16px; }
  .roomy .rig-selectors { flex-direction: column; gap: 12px; }
  .roomy .selector { gap: 8px; }
  .roomy .tone-selector { align-items: center; gap: 14px; }
  .roomy .preset-picker { width: 100%; }
  .roomy .preset-picker select { min-height: 44px; font-size: 16px; }
  /* Beside its name, as the head's blocks carry theirs. */
  .roomy .gate-control { position: relative; }
  /* The band's own two lamps, and only those: the pedals' panel is a child of
     this section too, and its switches must stay in their own flow. */
  .roomy .gate-control .enable,.roomy .doubler-control .enable { position: absolute; top: -8px; left: calc(50% + 30px); }
  .global-controls > * + * { padding-left: 24px; border-left: 1px solid var(--line); }
  .io-control, .gate-control, .doubler-control { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  /* The doubler is the last stage before the output and sits against it, one
     group with no seam between them, which wraps as one. The power, when it is
     here, and that group close the row, pushed to its end. */
  .out-group { display: flex; align-items: center; gap: inherit; flex-shrink: 0; }
  .out-group, .power-control { margin-left: auto; }
  .power-control + .out-group { margin-left: 0; }
  /* Compact, the row has no room for a name beside the dial and a lamp beside
     that: the selectors are what would pay for them. So the name is the switch,
     over the dial, as a block's name is on the head ("PITCH ●"), and the dial
     keeps only its value. The knob still carries its name for a screen reader. */
  .roomy .doubler-control { position: relative; }
  /* No offset of its own: it takes the gate's, above. Its own was 48 px, which
     put the lamp past the knob's box and into the output's name beside it —
     the two groups are 24 px apart and the lamp is 24 px wide. */
  .global-controls:not(.roomy) .doubler-control { flex-direction: column; align-items: flex-start; gap: 4px; }
  .global-controls:not(.roomy) .doubler-control .enable { order: -1; display: flex; gap: 7px; width: auto; height: 16px; }
  .global-controls:not(.roomy) .doubler-control :global(.compact .label) { display: none; }
  /* Its value is all the dial has left: it stays when the other knobs drop theirs. */
  .global-controls:not(.roomy) .doubler-control :global(.compact .value) { display: block; grid-row: 1 / 3; align-self: center; }
  .enable b { font: 400 10px/1 var(--display); font-stretch: 125%; letter-spacing: 0.16em; text-transform: uppercase; color: var(--text-2); }
  .enable:hover b { color: var(--text); }
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
  /* The gate's and the doubler's switches are lamps by their dials, as the amp's blocks have. */
  .enable { display: grid; flex-shrink: 0; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; background: none; cursor: pointer; }
  .enable span { width: 7px; height: 7px; border-radius: 50%; border: 1px solid var(--violet-600); box-sizing: border-box; transition: background-color var(--dur-settle) var(--ease-out), border-color var(--dur-settle) var(--ease-out); }
  .enable[aria-pressed='true'] span { background: var(--accent); border-color: var(--accent); box-shadow: 0 0 5px #d6b6e399; }
  .enable:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }

  /* One key in the row, and three stages behind it, each with its switch as
     its name — the same shape the gate and the doubler use in the band. */
  .pedals-control { flex-shrink: 0; }
  /* A key, not a word: the row is full at both sizes, and a named key here is
     paid for by the preset's own width. It names itself in its tooltip, in the
     panel it opens, and in the tutorial, which rings it. */
  .pedals-button { anchor-name: --chain-pedals; }
  /* It hangs from the band's own bottom edge, not from the key's: the key sits
     inside a 136 px plate, and a panel opening under it would cover the stages
     beside it. Where anchors are not supported yet, it is simply centred. */
  .pedals { position: fixed; inset: 50% auto auto 50%; translate: -50% -50%; padding: 20px 24px; }
  .pedals:popover-open { display: flex; align-items: flex-start; }
  @supports (position-anchor: --a) {
    .pedals { position-anchor: --chain-pedals; inset: auto; top: anchor(--chain-band bottom); left: anchor(center); translate: -50% 0; margin-top: 12px; position-try-fallbacks: flip-block; }
  }
  /* A stage is as wide as its knobs and nothing else, and the seam is drawn in
     the middle of the gutter rather than against a column's edge. Both matter:
     the name used to set the width whenever it was wider than the single knob
     it names — "REVERB ●" is — and the seam, placed at a fixed distance from
     that edge, then landed off centre, against the dial next door. Now the
     name hangs over its knobs, free to overhang a gutter 56 px wide, and the
     seam is 28 px from the knobs on either side of it, at every stage. */
  .pedal { position: relative; display: flex; flex-direction: column; align-items: center; padding-top: 30px; }
  /* The gutter is a margin and the seam is drawn inside it, so a stage's own
     box stays exactly its knobs: that is what keeps `left: 50%` the middle of
     the knobs for the name above, and the seam 28 px from the dial on both
     sides of it. */
  .pedal + .pedal { margin-left: 56px; }
  .pedal + .pedal::before { content: ''; position: absolute; top: 0; bottom: 0; left: -28px; border-left: 1px solid var(--line); }
  .pedal .enable { position: absolute; top: 0; left: 50%; translate: -50% 0; display: flex; gap: 8px; width: auto; height: 16px; white-space: nowrap; }
  .pedal-knobs { display: flex; gap: 20px; }

  .eyebrow, .selector > span {
    font: 400 10px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-2);
  }
  /* The selectors name what is playing and the preset only which tone it
     started from: the preset gives up its width first. */
  .rig-selectors { display: flex; flex: 1 1 360px; gap: 16px; min-width: 190px; }
  .selector { display: flex; flex: 1; flex-direction: column; gap: 7px; min-width: 0; }
  .tone-selector { display: flex; flex: 0 4 260px; flex-direction: column; gap: 7px; min-width: 170px; }
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

  /* Until the band reaches its full column (1180 px, from a 1360 px window),
     the seams tighten before the selectors are made to give anything up. */
  @media (max-width: 1359px) {
    .global-controls, .global-controls > * + * { gap: 14px; padding-left: 14px; }
    .global-controls { padding-right: 14px; }
  }
  /* In Play the power joins the row, which then has no room for its word
     until the band is 1260 px wide: the lamp alone is the switch, as on the
     head, and the word stays in its name and its tooltip. */
  @media (max-width: 1439px) {
    .power-word { display: none; }
    .power { padding: 0 13px; }
  }
  /* Narrower, the knobs keep their dials and lose their words first. */
  @media (max-width: 1240px) {
    .global-controls :global(.compact .value) { display: none; }
  }
  /* A tablet: the row runs out of width before the studio runs out of height,
     and a squeezed row is worse than a second one — the selectors collapse to
     their chevrons and their names print over each other. So the band wraps:
     the levels and the gate keep the first line, the selectors and the preset
     take the width they need on the next. The seams go with it; a border left
     hanging at the start of a wrapped line reads as a stray rule. */
  @media (max-width: 1279px) {
    .global-controls {
      flex-wrap: wrap;
      height: auto;
      min-height: 80px;
      padding-top: 10px;
      padding-bottom: 10px;
      row-gap: 12px;
    }
    .global-controls > * + * { padding-left: 0; border-left: 0; }
    .rig-selectors { flex: 1 1 280px; min-width: 0; }
    .tone-selector { flex: 1 1 220px; min-width: 0; }
    /* Wrapped, `margin-left: auto` would push the output onto a line of its
       own; it sits at the end of whichever line it lands on. */
    .out-group, .power-control { margin-left: 0; }
  }
</style>
