<script lang="ts">
  // The amplifier's head: the one object in the studio with a material, and
  // the only part of the screen an amplifier owns. The Tone mode's stage.
  import Knob from './Knob.svelte';
  import { PARAMS, type Param } from '../schema/params.ts';
  import { lang } from './locale.svelte.ts';

  let { isGuilt, ampIlluminated, poweredOff, light, veil, values, resetValues,
    powerBusy, powerDisabled, onparam, onpower }: {
    isGuilt: boolean;
    /** Running and not bypassed: the lamps are on. */
    ampIlluminated: boolean;
    poweredOff: boolean;
    /** 0 to 1, from the output RMS; drives the glow's opacity only. */
    light: number;
    /** The black veil's opacity over the glass, derived from the same light. */
    veil: number;
    values: Record<string, number>;
    resetValues: Record<string, number>;
    powerBusy: boolean;
    powerDisabled: boolean;
    onparam: (id: string, value: number) => void;
    onpower: () => void;
  } = $props();

  const t = $derived(lang.ui);
  const param = (id: string): Param => PARAMS.find((p) => p.id === id)!;
</script>

<div class="amp-stand">
  <section class="amp-head" class:guilt={isGuilt} class:illuminated={isGuilt && ampIlluminated} class:bypassed={poweredOff} aria-label={isGuilt ? t.rig.guiltAmp : t.rig.neutralAmp}>
    {#if isGuilt}
      <div class="guilt-handle" aria-hidden="true"><span></span></div>
      <div class="guilt-shell" aria-hidden="true"></div>
      <!-- Static image filters; only the glow layer's opacity follows the meters. -->
      <svg class="glass-filters" width="0" height="0" aria-hidden="true" focusable="false">
        <defs>
          <filter id="guilt-glass-relief" color-interpolation-filters="sRGB">
            <feColorMatrix type="saturate" values="0" />
            <feGaussianBlur stdDeviation="0.45" />
            <feConvolveMatrix order="3" kernelMatrix="-1 -1 0 -1 0 1 0 1 1" divisor="2" bias="0.5" preserveAlpha="true" result="bevel" />
            <feBlend in="bevel" in2="SourceGraphic" mode="soft-light" />
          </filter>
          <filter id="guilt-glass-bloom" x="-5%" y="-10%" width="110%" height="120%" color-interpolation-filters="sRGB">
            <feComponentTransfer>
              <feFuncR type="linear" slope="3.2" intercept="-1.55" />
              <feFuncG type="linear" slope="3.2" intercept="-1.55" />
              <feFuncB type="linear" slope="3.2" intercept="-1.55" />
            </feComponentTransfer>
            <feGaussianBlur stdDeviation="3" result="nearGlow" />
            <feGaussianBlur stdDeviation="8" />
            <feBlend in2="nearGlow" mode="screen" />
          </filter>
        </defs>
      </svg>
    {/if}
    <span class="screw tl"></span><span class="screw tr"></span><span class="screw bl"></span><span class="screw br"></span>
    <div class="glass-window">
      {#if isGuilt}<img src={`${import.meta.env.BASE_URL}images/guilt-stained-glass.webp`} alt={t.rig.glassAlt} width="2172" height="724" decoding="async" /><div class="veil" style={`opacity:${veil}`}></div>{:else}<div class="neutral-art"><span>TC</span><small>AMPLIFICATION</small></div>{/if}
      {#if isGuilt}
        <div class="glass-bloom-power" aria-hidden="true">
          <div class="glass-glow" style={`opacity:${0.12 + light * 0.3}`}>
            <img src={`${import.meta.env.BASE_URL}images/guilt-stained-glass.webp`} alt="" width="2172" height="724" decoding="async" />
          </div>
        </div>
      {/if}
      {#if isGuilt}
        <div class="glass-walls" aria-hidden="true"></div>
        <div class="glass-night" aria-hidden="true"></div>
        <div class="glass-night lag" aria-hidden="true"></div>
      {/if}
      <div class="amp-brand"><span class="brand-rule"></span><h1>{isGuilt ? 'GUILT' : 'TONECRAFT'}</h1><span class="brand-rule"></span><p>{isGuilt ? 'LUX EX SONO' : t.rig.neutralMotto}</p></div>
    </div>
    <div class="amp-panel">
      {#if isGuilt}
        <!-- The guitar is plugged in: a nut on the plate, the plug, and its lead
             falling off the front of the head. Static; nothing here moves. -->
        <div class="guilt-jack" aria-hidden="true">
          <svg class="jack-cable" width="340" height="140" viewBox="0 0 340 140">
            <defs>
              <linearGradient id="guilt-lead-fade" gradientUnits="userSpaceOnUse" x1="0" x2="150"><stop offset="0" stop-color="#fff" stop-opacity="0" /><stop offset="1" stop-color="#fff" /></linearGradient>
              <mask id="guilt-lead-mask"><rect width="340" height="140" fill="url(#guilt-lead-fade)" /></mask>
            </defs>
            <g mask="url(#guilt-lead-mask)" fill="none" stroke-linecap="round">
              <path d="M160 131 L0 132" stroke="#00000070" stroke-width="14" />
              <path d="M320.8 2 C313.8 24 309 64 305 88 C290 113 236 124 168 126 L0 128" stroke="#09080b" stroke-width="9" />
              <path d="M318.4 1.2 C311.4 23 306.6 62.5 303.5 85.5 C289 110 236 121.5 168 123.5 L0 125.5" stroke="#7a7280" stroke-opacity=".6" stroke-width="1.6" />
            </g>
          </svg>
        </div>
      {/if}
      <div class="amp-signature"><svg class="sig-symbol" width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><circle cx="15" cy="15" r="13.5"/><path d="M15 3.8a5.6 5.6 0 0 1 0 11.2 5.6 5.6 0 0 1 0-11.2ZM15 15a5.6 5.6 0 0 1 0 11.2A5.6 5.6 0 0 1 15 15ZM3.8 15a5.6 5.6 0 0 1 11.2 0 5.6 5.6 0 0 1-11.2 0ZM15 15a5.6 5.6 0 0 1 11.2 0A5.6 5.6 0 0 1 15 15Z"/><circle cx="15" cy="15" r="2"/></svg><span>{isGuilt ? 'Guilt' : 'Tonecraft'}</span><small>{isGuilt ? t.rig.leadAmplifier : t.rig.captureSeries}</small></div>
      <div class="control-group tone-group"><button class="group-label" aria-label={t.rig.groupEnabled.tone} aria-pressed={values.tone_bypass !== 1} onclick={() => onparam('tone_bypass',values.tone_bypass === 1 ? 0 : 1)}>{t.rig.groups.tone.toUpperCase()} <span>{values.tone_bypass === 1 ? '○' : '●'}</span></button><div class="knob-row">{#each ['tone_bass','tone_mid','tone_treble','tone_presence'] as id}<Knob param={param(id)} label={t.params[id]} value={values[id]!} powered={isGuilt ? ampIlluminated : undefined} resetValue={resetValues[id]} onchange={v => onparam(id,v)} />{/each}</div></div>
      <div class="control-group"><button class="group-label" aria-label={t.rig.groupEnabled.pitch} aria-pressed={values.pitch_bypass !== 1} onclick={() => onparam('pitch_bypass',values.pitch_bypass === 1 ? 0 : 1)}>{t.rig.groups.pitch.toUpperCase()} <span>{values.pitch_bypass === 1 ? '○' : '●'}</span></button><div class="knob-row">{#each ['pitch_shift','pitch_mix'] as id}<Knob param={param(id)} label={t.params[id]} value={values[id]!} powered={isGuilt ? ampIlluminated : undefined} resetValue={resetValues[id]} onchange={v => onparam(id,v)} />{/each}</div></div>
      <div class="control-group"><button class="group-label" aria-label={t.rig.groupEnabled.boost} aria-pressed={values.drive_bypass !== 1} onclick={() => onparam('drive_bypass',values.drive_bypass === 1 ? 0 : 1)}>{t.rig.groups.boost.toUpperCase()} <span>{values.drive_bypass === 1 ? '○' : '●'}</span></button><div class="knob-row">{#each ['drive_gain','drive_tone'] as id}<Knob param={param(id)} label={t.params[id]} value={values[id]!} powered={isGuilt ? ampIlluminated : undefined} resetValue={resetValues[id]} onchange={v => onparam(id,v)} />{/each}</div></div>
      <div class="control-group"><button class="group-label" aria-label={t.rig.groupEnabled.reverb} aria-pressed={values.reverb_bypass !== 1} onclick={() => onparam('reverb_bypass',values.reverb_bypass === 1 ? 0 : 1)}>{t.rig.groups.reverb.toUpperCase()} <span>{values.reverb_bypass === 1 ? '○' : '●'}</span></button><div class="knob-row"><Knob param={param('reverb_mix')} label={t.params.reverb_mix} value={values.reverb_mix!} powered={isGuilt ? ampIlluminated : undefined} resetValue={resetValues.reverb_mix} onchange={v => onparam('reverb_mix',v)} /></div></div>
      <button class="power-indicator" type="button" aria-label={t.rig.amplifierPower} aria-pressed={ampIlluminated} aria-busy={powerBusy} disabled={powerDisabled} onclick={onpower}>
        {#if isGuilt}
          <span class="power-rocker" class:lit={ampIlluminated} aria-hidden="true">
            <span class="rocker-face"><span class="rocker-on">I</span><span class="rocker-lamp"></span><span class="rocker-off">O</span></span>
          </span>
        {:else}
          <span class:lit={ampIlluminated}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 2v10M6 5a9 9 0 1 0 12 0"/></svg></span>
        {/if}
        <small>{t.rig.power.toUpperCase()}</small>
      </button>
    </div>
  </section>
  <div class="amp-foot"><span></span><span></span></div>
</div>

<style>
  /* The head is an object with one size and one shape. It never reflows and
     never changes proportion: the studio scales it whole to the room it has
     (`ampZoom` in Rig.svelte), the way moving away from an amp makes it
     smaller rather than shorter. */
  .amp-stand { width: var(--column); }

  .amp-head { position: relative; margin-top: 0; padding: 17px; border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--surface-1); box-shadow: var(--shadow); --knob-accent: var(--violet-400); }
  /* The glass is what gives way when the screen is short: everything else on
     the head is a control. 580 px is the bands and gutters (276) and the rest
     of the head; a tall screen gives the chain band its full knobs (+56). */
  .glass-window { position: relative; height: 300px; overflow: hidden; background: #101010; border: 2px solid #0e0e10; box-shadow: 0 0 0 1px #55505b; }
  .glass-window img { width: 100%; height: 100%; object-fit: cover; filter: brightness(1.67); }
  .glass-window .veil { position: absolute; inset: 0; background: #000; pointer-events: none; will-change: opacity; }
  .glass-window::after { content: ''; position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 35px 12px #08080bd9; background: linear-gradient(0deg, #09080bb0, transparent 65%); }
  .amp-brand { position: absolute; z-index: 1; bottom: 24px; left: 0; right: 0; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 18px; text-align: center; color: #e4d4e8; text-shadow: 0 2px 8px #000; }
  .amp-brand h1 { margin: 0 -0.3em 0 0; font: 600 46px/1 var(--inscription); letter-spacing: 0.3em; }
  .brand-rule { width: 42px; height: 1px; background: #ad96b777; }
  .amp-brand p { flex-basis: 100%; margin: -8px 0 0; font: 400 8px/1 var(--display); font-stretch: 125%; letter-spacing: 0.5em; }
  .neutral-art { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; background: repeating-linear-gradient(0deg, #1b1b1b 0 2px, #2e2e2e 2px 3px); color: #848484; }
  .neutral-art > span { font-size: 80px; font-weight: 800; letter-spacing: -15px; opacity: .35; }
  .neutral-art small { font-size: 8px; letter-spacing: 6px; }
  .neutral-art + .amp-brand h1 { font: 400 22px var(--display); font-stretch: 125%; letter-spacing: 7px; }
  .bypassed .glass-window { opacity: .5; }

  .amp-panel { display: flex; align-items: center; justify-content: space-around; gap: 20px; padding: 22px 20px 20px; background: var(--faceplate); border: 1px solid var(--line-strong); }
  .control-group { position: relative; padding-left: 20px; border-left: 1px solid #69616a40; }
  .group-label {
    display: block;
    margin: 0 auto 14px;
    padding: 0;
    border: 0;
    background: none;
    font: 400 9px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.24em;
    color: var(--text-2);
    cursor: pointer;
  }
  .group-label span { margin-left: 5px; font-size: 7px; color: var(--knob-accent); }
  .group-label[aria-pressed='false'] { opacity: .45; }
  .knob-row { display: flex; gap: 16px; }
  .amp-signature { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 110px; color: #c6b9cb; }
  .amp-signature > span { font: italic 500 30px/1 var(--inscription); }
  .sig-symbol { color: var(--violet-300); opacity: .85; }
  .amp-signature small { font: 400 7px/1 var(--display); font-stretch: 125%; letter-spacing: 0.3em; }
  .power-indicator { display: flex; flex-direction: column; align-items: center; gap: 15px; min-width: 44px; padding: 8px; border: 0; background: none; color: var(--text-2); cursor: pointer; }
  .power-indicator > span { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: var(--violet-900); border: 3px solid #252227; box-shadow: 0 0 0 1px var(--violet-600); }
  .power-indicator > span.lit { color: #fff; background: var(--violet-600); box-shadow: 0 0 12px #c47adf; }
  .power-indicator small { font: 400 7px/1 var(--display); font-stretch: 125%; letter-spacing: 0.2em; color: var(--text-2); }
  .power-indicator:disabled { opacity: .5; cursor: wait; }
  .screw { position: absolute; width: 5px; height: 5px; border-radius: 50%; background: linear-gradient(135deg, #777, #222 45%, #999 50%, #333 60%); }
  .tl { top: 6px; left: 7px; } .tr { top: 6px; right: 7px; } .bl { bottom: 6px; left: 7px; } .br { bottom: 6px; right: 7px; }
  .amp-foot { display: flex; justify-content: space-between; margin: 0 50px; }
  .amp-foot span { width: 65px; height: 9px; background: #0f0f0f; border-radius: 0 0 3px 3px; }
  @media (prefers-reduced-motion: reduce) { .glass-window .veil { opacity: .61 !important; } }


  /* GUILT is a cabinet seen head-on and a little from above. Its rim is a
     lit height map baked by scripts/bake-guilt-textures.py: a rounded outer
     edge, a satin powder coat, a softbox caught along the top, and the
     shadow the rim casts into the recessed front. CSS cannot light a shape. */
  .amp-head.guilt {
    --guilt-rim: 26px;
    --guilt-front-radius: 6px;
    --knob-accent: #655e6b;
    --control-label: #d3c7d8;
    isolation: isolate;
    margin-top: 48px;
    margin-right: 0;
    padding: var(--guilt-rim);
    border: 0;
    border-radius: 22px;
    background: #231f27;
    box-shadow: 0 16px 14px -8px #000c,0 36px 40px -16px #000d;
  }
  /* The top of the cabinet, foreshortened: a thin plane behind the front edge. */
  .amp-head.guilt::before {
    content: '';
    position: absolute;
    z-index: -1;
    top: -7px;
    left: 9px;
    right: 9px;
    height: 20px;
    pointer-events: none;
    border-radius: 14px 14px 0 0;
    clip-path: polygon(10px 0,calc(100% - 10px) 0,100% 100%,0 100%);
    background: linear-gradient(#1c1920,#342e39 60%,#2a2530);
    box-shadow: inset 0 1px 0 #ffffff1c;
  }
  .guilt-handle {
    position: absolute;
    z-index: -2;
    top: -27px;
    left: calc(50% - 150px);
    width: 300px;
    height: 17px;
    pointer-events: none;
    border-bottom: 5px solid #161317;
    filter: drop-shadow(0 3px 2px #0008);
  }
  .guilt-handle::before,.guilt-handle::after {
    content: '';
    position: absolute;
    bottom: -4px;
    width: 27px;
    height: 9px;
    border: 1px solid #0b0a0d;
    border-radius: 4px 4px 1px 1px;
    background: linear-gradient(#8a8390,#48434d 35%,#1e1c22 80%);
    box-shadow: inset 0 1px 0 #ffffff40;
  }
  .guilt-handle::before { left: 0; }
  .guilt-handle::after { right: 0; }
  .guilt-handle span {
    position: absolute;
    inset: 0 17px 0;
    border: 5px solid #3a3540;
    border-bottom: 0;
    border-radius: 50% 50% 0 0 / 14px 14px 0 0;
    box-shadow: inset 0 1px 0 #ffffff26,0 -1px 0 #7b7482;
    background: linear-gradient(#39353b,#201e22 65%,transparent 66%);
  }
  /* A 9-slice: the corners keep their shape, the top and bottom edges tile
     (the grain keeps its scale), the sides stretch (the light falls off down
     the whole cabinet). The inner 44 px of each slice is the rim's shadow,
     laid over the front. */
  .guilt-shell {
    position: absolute;
    z-index: 4;
    inset: 0;
    pointer-events: none;
    border: 70px solid transparent;
    border-image: url("/images/guilt-shell.webp") 140 / 70px round stretch;
  }
  .guilt .screw { display: none; }
  .guilt .glass-window {
    border: 0;
    border-radius: var(--guilt-front-radius) var(--guilt-front-radius) 0 0;
    box-shadow: none;
  }
  .glass-filters { position: absolute; pointer-events: none; }
  .guilt .glass-window { isolation: isolate; opacity: 1; }
  /* Dim the glass against black, never the cabinet behind it: lowering the
     whole window's opacity let the grey shell show through the dark glass. */
  .glass-night {
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    background: #010104;
    opacity: .94;
    transition: opacity 500ms ease-out;
  }
  .guilt.illuminated .glass-night { opacity: 0; animation: guilt-ignite 2300ms linear; }
  /* The right end of the tube strikes last: a static mask, so only opacity moves. */
  .glass-night.lag {
    opacity: 0;
    transition: none;
    -webkit-mask-image: linear-gradient(90deg, transparent 50%, #000 66%);
    mask-image: linear-gradient(90deg, transparent 50%, #000 66%);
  }
  .guilt.illuminated .glass-night.lag { animation: guilt-ignite-lag 2300ms linear; }
  .guilt .glass-window .veil { transition: opacity 150ms linear; }
  .guilt:not(.illuminated) .glass-window .veil { transition-duration: 500ms; }
  /* A cold neon tube does not fade in: the gas fails to strike, flashes dim
     for a few tens of ms, drops out, retries, then catches and warms up.
     steps(1) makes each keyframe a hard cut; only the final warm-up is linear.
     Irregular spacing on purpose: an even rhythm reads as a CSS blink. */
  @keyframes guilt-ignite {
    0% { opacity: .94; animation-timing-function: steps(1, end); }
    7% { opacity: .66; animation-timing-function: steps(1, end); }
    8.5% { opacity: .94; animation-timing-function: steps(1, end); }
    15% { opacity: .42; animation-timing-function: steps(1, end); }
    16.2% { opacity: .94; animation-timing-function: steps(1, end); }
    17.4% { opacity: .55; animation-timing-function: steps(1, end); }
    19% { opacity: .94; animation-timing-function: steps(1, end); }
    31% { opacity: .24; animation-timing-function: steps(1, end); }
    33% { opacity: .72; animation-timing-function: steps(1, end); }
    34% { opacity: .18; animation-timing-function: steps(1, end); }
    37.5% { opacity: .94; animation-timing-function: steps(1, end); }
    45% { opacity: .34; animation-timing-function: linear; }
    52% { opacity: .14; animation-timing-function: steps(1, end); }
    52.6% { opacity: .62; animation-timing-function: steps(1, end); }
    54.2% { opacity: .12; animation-timing-function: linear; }
    63% { opacity: .07; animation-timing-function: steps(1, end); }
    63.5% { opacity: .38; animation-timing-function: steps(1, end); }
    65% { opacity: .06; animation-timing-function: linear; }
    100% { opacity: 0; }
  }
  @keyframes guilt-ignite-lag {
    0% { opacity: 0; animation-timing-function: steps(1, end); }
    30% { opacity: .8; animation-timing-function: steps(1, end); }
    58% { opacity: .1; animation-timing-function: steps(1, end); }
    59.5% { opacity: .8; animation-timing-function: steps(1, end); }
    68% { opacity: .3; animation-timing-function: steps(1, end); }
    69.5% { opacity: .75; animation-timing-function: steps(1, end); }
    71.5% { opacity: .2; animation-timing-function: linear; }
    80% { opacity: 0; }
    100% { opacity: 0; }
  }
  /* The halo only exists once the gas holds: none on the failed strikes. */
  @keyframes guilt-bloom-ignite {
    0% { opacity: 0; animation-timing-function: steps(1, end); }
    31% { opacity: .25; animation-timing-function: steps(1, end); }
    34% { opacity: .35; animation-timing-function: steps(1, end); }
    37.5% { opacity: 0; animation-timing-function: steps(1, end); }
    45% { opacity: .3; animation-timing-function: linear; }
    52% { opacity: .5; animation-timing-function: steps(1, end); }
    52.6% { opacity: .1; animation-timing-function: steps(1, end); }
    54.2% { opacity: .55; animation-timing-function: linear; }
    100% { opacity: 1; }
  }
  .guilt .glass-window>img { filter: url(#guilt-glass-relief) brightness(1.8) contrast(1.13) saturate(.9); }
  .glass-bloom-power {
    position: absolute;
    inset: 0;
    pointer-events: none;
    mix-blend-mode: screen;
    opacity: 0;
    transition: opacity 500ms ease-out;
  }
  .guilt.illuminated .glass-bloom-power { opacity: 1; animation: guilt-bloom-ignite 2300ms linear; }
  .glass-glow {
    position: absolute;
    inset: 0;
    pointer-events: none;
    mix-blend-mode: screen;
    will-change: opacity;
  }
  .guilt .glass-glow img { filter: url(#guilt-glass-bloom); }
  .guilt .glass-window::after {
    z-index: 1;
    border-radius: inherit;
    box-shadow: none;
    background: linear-gradient(0deg,#09060ea0,transparent 35%);
  }
  /* The glass sits at the back of a box. Its four walls are baked in
     perspective (the top one faces away from the light, the bottom one into
     it) together with the shadow they throw across the art: long from above,
     short from below. A 9-slice, so the walls keep their depth whatever the
     window's height. */
  .glass-walls {
    position: absolute;
    z-index: 2;
    inset: 0;
    pointer-events: none;
    border: 33px solid transparent;
    border-image: url("/images/guilt-box.webp") 66 / 33px stretch;
  }
  .guilt .amp-brand { z-index: 2; bottom: 21px; }
  .guilt .amp-brand h1 {
    color: #e0cedf;
    text-shadow: 0 1px 0 #f7eaf6,0 2px 0 #857087,0 3px 0 #49334e,2px 5px 3px #000,0 8px 13px #000;
  }
  .guilt .amp-brand p { color: #d0b7d4; text-shadow: 0 2px 2px #000; }
  /* The control plate: brushed, anodised metal, a shade lighter than the
     cabinet, held by four screws. Its top edge is the lip where the glass
     ends; everything on it is printed, only knobs and switch stand off it. */
  .guilt .amp-panel {
    position: relative;
    justify-content: flex-start;
    gap: 10px;
    padding: 20px 56px 16px 96px;
    border: 0;
    border-radius: 0 0 var(--guilt-front-radius) var(--guilt-front-radius);
    background:
      radial-gradient(circle at 10px 10px,#bdb3c2 0 .8px,#4d4653 1.3px 2.6px,#0000 3px),
      radial-gradient(circle at calc(100% - 10px) 10px,#bdb3c2 0 .8px,#4d4653 1.3px 2.6px,#0000 3px),
      radial-gradient(circle at 10px calc(100% - 10px),#bdb3c2 0 .8px,#4d4653 1.3px 2.6px,#0000 3px),
      radial-gradient(circle at calc(100% - 10px) calc(100% - 10px),#bdb3c2 0 .8px,#4d4653 1.3px 2.6px,#0000 3px),
      url("/images/guilt-brushed.webp") 0 0 / 512px 256px,
      linear-gradient(100deg,#ffffff00 15%,#ffffff10 40%,#ffffff04 55%,#ffffff00 75%),
      linear-gradient(180deg,#48424e,#3a3540 40%,#322d37);
    box-shadow:
      inset 0 1px 0 #ffffff40,inset 0 2px 2px #ffffff10,
      inset 0 -1px 0 #0009,inset 1px 0 0 #ffffff14,inset -1px 0 0 #0006;
  }
  /* The plate stands proud of the glass: from above, its top face shows as a
     thin lit band, narrowing as it recedes, with a dark line where it meets
     the box. */
  .guilt .amp-panel::before {
    content: '';
    position: absolute;
    z-index: 1;
    left: 0;
    right: 0;
    top: -7px;
    height: 7px;
    pointer-events: none;
    clip-path: polygon(7px 0,calc(100% - 7px) 0,100% 100%,0 100%);
    background: linear-gradient(#1a171d,#58515f 30%,#7b7382 80%,#9c94a3);
    box-shadow: inset 0 1px 0 #000;
  }
  .guilt .amp-signature { order: 1; margin-left: auto; }
  .guilt .power-indicator { order: 2; }
  /* No rules between groups: spacing and the printed labels group the knobs. */
  .guilt .control-group { border-left: 0; }
  .guilt .knob-row { gap: 12px; }
  .guilt .group-label { white-space: nowrap; color: #d9cddd; text-shadow: 0 1px 0 #0006; }
  .guilt :global(.label) { color: #e2d7e6; text-shadow: 0 1px 0 #0007; }
  .guilt :global(.value) { color: #a99dae; font-size: 9px; }
  /* Knobs stand on the plate: a printed scale, a cast shadow, a machined
     cap (baked). The powered sweep stays, inside the scale. */
  .guilt :global(.dial) {
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='62' height='62'%3E%3Cpath d='M12.26 49.74L9.08 52.92M4.85 39.50L1.99 40.43M3.84 26.70L0.88 26.23M8.75 14.84L6.32 13.07M18.52 6.50L17.15 3.82M31.00 4.50L31.00 0.00M43.48 6.50L44.85 3.82M53.25 14.84L55.68 13.07M58.16 26.70L61.12 26.23M57.15 39.50L60.01 40.43M49.74 49.74L52.92 52.92' stroke='%23cdbfd3' stroke-width='1.2' stroke-linecap='round' opacity='.6'/%3E%3C/svg%3E") center / 62px 62px no-repeat;
    box-shadow: none;
  }
  .guilt :global(.dial::before) {
    inset: 8px;
    background: radial-gradient(circle,#000c 50%,#0000 72%);
    box-shadow: none;
    transform: translate(2px,5px);
  }
  .guilt :global(.power-dial .dial-light) { inset: 5px; }
  .guilt :global(.sweep-half::before) { border-width: 2px; }
  .guilt :global(.cap) {
    inset: 7px;
    border: 0;
    border-radius: 50%;
    background: url("/images/guilt-knob.webp") center / 100% 100%;
    box-shadow: none;
    transform: none;
  }
  .guilt :global(.indicator) {
    top: 8px;
    height: 9px;
    background: #efe6f2;
    box-shadow: 0 0 0 .5px #0008;
    transform-origin: 1px 16px;
    transform: rotate(var(--angle));
  }
  /* The input: a nut on the plate, the plug in it, the lead in front of the cabinet. */
  /* The input: a knurled nut and the plug in it, both baked with the rest of
     the materials; only the lead is drawn, and it never moves. */
  .guilt-jack {
    position: absolute;
    z-index: 5;
    left: 22px;
    top: calc(50% - 16px);
    width: 52px;
    height: 56px;
    pointer-events: none;
    background: url("/images/guilt-jack.webp") center / 100% 100% no-repeat;
    filter: drop-shadow(2px 4px 4px #000a);
  }
  .jack-cable { position: absolute; left: -301px; top: 51px; overflow: visible; }
  .guilt .amp-signature { color: #dccfe0; text-shadow: 0 1px 0 #09070d,0 -1px 0 #ffffff22; }
  .guilt .group-label span { position: relative; display: inline-block; }
  .guilt .group-label span::after {
    content: '●';
    position: absolute;
    inset: 0;
    color: #d7bedf;
    text-shadow: 0 0 5px #d6b6e399;
    opacity: 0;
    transition: opacity 400ms ease-out;
  }
  .guilt.illuminated .group-label[aria-pressed=true] span::after { opacity: 1; transition: opacity 900ms ease-in 120ms; }
  .guilt .power-indicator { gap: 11px; padding: 8px 4px; min-width: 48px; }
  .guilt .power-indicator>span.power-rocker {
    position: relative;
    display: block;
    width: 36px;
    height: 58px;
    padding: 3px;
    border: 1px solid;
    border-color: #645b68 #39313e #84758b #4d4355;
    border-radius: 5px;
    background: #0b080f;
    perspective: 180px;
    box-shadow: 0 0 0 2px #121016,0 3px 5px #000b,inset 0 2px 4px #000;
  }
  .rocker-face {
    position: absolute;
    inset: 4px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-around;
    border: 1px solid #544c5c;
    border-radius: 3px;
    background: linear-gradient(#4c4553,#29232f 48%,#17121e 52%,#211b28);
    transform: rotateX(-13deg);
    box-shadow: 0 -3px 0 #211a29,0 -4px 1px #73677c,inset 0 1px 1px #b2a0bd33;
    color: #9a8dA3;
    font: 10px var(--mono);
    text-shadow: 0 1px 1px #000;
  }
  .rocker-on { color: #7d7187; }
  .rocker-off { color: #ddd1e2; }
  .rocker-lamp { position: relative; width: 15px; height: 3px; border-radius: 2px; background: #312236; box-shadow: inset 0 1px 2px #000; }
  .rocker-lamp::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: #eac0fc;
    box-shadow: 0 0 4px #eccbff,0 0 12px #c875efaa,inset 0 1px 0 #fff8;
    opacity: 0;
    transition: opacity 400ms ease-out;
  }
  .power-rocker.lit .rocker-face {
    transform: rotateX(13deg);
    background: linear-gradient(#201a29,#302637 48%,#494050 52%,#332b3e);
    box-shadow: 0 3px 0 #18111f,0 4px 1px #5b4b67,inset 0 1px 3px #0008;
  }
  .power-rocker.lit .rocker-on { color: #f1e1f7; }
  .power-rocker.lit .rocker-off { color: #85728f; }
  .power-rocker.lit .rocker-lamp::after { opacity: 1; transition: opacity 650ms ease-in; }
  .guilt .power-indicator:hover:not(:disabled) .power-rocker { border-color: #a091aa; }
  .guilt .power-indicator:active:not(:disabled) .rocker-face { transform: rotateX(0deg) translateZ(-1px); }
  /* Rubber feet, tapered, lit from the left like the cabinet above them. */
  .guilt + .amp-foot { position: relative; margin: -2px 70px 0; }
  .guilt + .amp-foot::before {
    content: '';
    position: absolute;
    z-index: -1;
    left: -90px;
    right: -90px;
    top: -18px;
    height: 44px;
    pointer-events: none;
    background: radial-gradient(closest-side,#000000d0,#0000);
  }
  .guilt + .amp-foot span { width: 70px; height: 20px; clip-path: polygon(0 0,100% 0,88% 100%,12% 100%); background: linear-gradient(90deg,#0a090c 12%,#34303a 30%,#1c1a20 60%,#0b0a0d 88%); box-shadow: inset 0 6px 5px -2px #000; }
  @media(prefers-reduced-motion:reduce) {
    .glass-night,.glass-bloom-power { animation: none !important; transition: none; }
    .glass-night.lag { display: none; }
    .glass-bloom-power,.guilt .glass-window .veil,.guilt .group-label span::after,.rocker-lamp::after { transition: none !important; }
    .glass-glow { will-change: auto; }
    .guilt.illuminated .glass-glow { opacity: .22 !important; }
  }
</style>
