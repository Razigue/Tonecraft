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
  const sculptedGlass = `${import.meta.env.BASE_URL}images/guilt-sculpted-glass.webp`;
</script>

<div class="amp-stand">
  <section class="amp-head" class:guilt={isGuilt} class:illuminated={isGuilt && ampIlluminated} class:bypassed={poweredOff} aria-label={isGuilt ? t.rig.guiltAmp : t.rig.neutralAmp}>
    {#if isGuilt}
      <!-- The handle stands on the top face, halfway back, cast like the rest. -->
      <svg class="guilt-handle" width="300" height="46" viewBox="0 0 300 46" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="guilt-handle-bar" gradientUnits="userSpaceOnUse" x1="0" y1="2" x2="0" y2="40"><stop offset="0" stop-color="#f1e9e4" /><stop offset=".25" stop-color="#c3bab6" /><stop offset="1" stop-color="#6e6563" /></linearGradient>
          <linearGradient id="guilt-handle-foot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ece4df" /><stop offset=".3" stop-color="#b5aca8" /><stop offset=".35" stop-color="#8f8683" /><stop offset="1" stop-color="#5b5351" /></linearGradient>
        </defs>
        <path d="M26 38V22Q26 6 46 6H254Q274 6 274 22V38" fill="none" stroke="#3f3837" stroke-width="10" />
        <path d="M26 38V22Q26 6 46 6H254Q274 6 274 22V38" fill="none" stroke="url(#guilt-handle-bar)" stroke-width="8" />
        <path d="M24 30V22Q24 3.8 46 3.8H254Q276 3.8 276 22V30" fill="none" stroke="#fffaf6" stroke-opacity=".5" stroke-width="1.2" />
        <path d="M5 46 7 38.5Q8 35 11.5 35H40.5Q44 35 45 38.5L47 46Z" fill="url(#guilt-handle-foot)" stroke="#4a4240" stroke-width=".8" />
        <path d="M253 46 255 38.5Q256 35 259.5 35H288.5Q292 35 293 38.5L295 46Z" fill="url(#guilt-handle-foot)" stroke="#4a4240" stroke-width=".8" />
      </svg>
      <div class="guilt-shell" aria-hidden="true"></div>
      <!-- Static image filters; only the glow layer's opacity follows the meters. -->
      <svg class="glass-filters" width="0" height="0" aria-hidden="true" focusable="false">
        <defs>
          <!-- Chroma isolates the glass: the silver relief keeps its studio
               lighting when power is off. These masks are rasterised once. -->
          <filter id="guilt-glass-shade" color-interpolation-filters="sRGB">
            <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.5 -3 1.5 0 0" />
          </filter>
          <filter id="guilt-glass-bloom" x="-5%" y="-10%" width="110%" height="120%" color-interpolation-filters="sRGB">
            <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  1.5 -3 1.5 0 0" />
            <feGaussianBlur stdDeviation="5" />
          </filter>
        </defs>
      </svg>
    {/if}
    <span class="screw tl"></span><span class="screw tr"></span><span class="screw bl"></span><span class="screw br"></span>
    <div class="glass-window">
      {#if isGuilt}
        <img src={sculptedGlass} alt={t.rig.glassAlt} width="2172" height="724" decoding="async" />
        <img class="veil" src={sculptedGlass} alt="" aria-hidden="true" width="2172" height="724" decoding="async" style={`opacity:${veil * 0.65}`} />
      {:else}<div class="neutral-art"><span>TC</span><small>AMPLIFICATION</small></div>{/if}
      {#if isGuilt}
        <div class="glass-bloom-power" aria-hidden="true">
          <div class="glass-glow" style={`opacity:${0.12 + light * 0.3}`}>
            <img src={sculptedGlass} alt="" width="2172" height="724" decoding="async" />
          </div>
        </div>
      {/if}
      {#if isGuilt}
        <div class="glass-walls" aria-hidden="true"></div>
        <img class="glass-night" src={sculptedGlass} alt="" aria-hidden="true" width="2172" height="724" decoding="async" />
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
  /* Each model keeps its natural proportions; Rig scales the whole head. */
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


  /* Head-on cabinet: the rim, handle and feet share the glass's centreline. */
  .amp-head.guilt {
    --guilt-rim: 27px;
    --guilt-front-radius: 5px;
    --knob-accent: #79608d;
    --control-label: #353039;
    --guilt-metal: #aaa7a5;
    isolation: isolate;
    margin: 48px 0 0;
    padding: var(--guilt-rim);
    border: 1px solid #746e6c;
    border-radius: 23px;
    /* Plain cast silver: narrow polished edges and darker oxidised flats,
       matching the glass bezel's material without repeating its ornament. */
    background:
      url('/images/guilt-cast.webp') 0 0 / 192px 192px,
      radial-gradient(ellipse at 24% 0%,#eee9e147,transparent 38%),
      radial-gradient(ellipse at 80% 100%,#302b3040,transparent 42%),
      linear-gradient(105deg,#625d5d,#9e9895 19%,#807a79 40%,#a8a29e 66%,#716b6b 88%,#938b88);
    box-shadow: inset 0 1px 0 #ece8e2,inset 0 3px 1px #c7c1bc,inset 0 6px 4px #3b373688,inset 0 -2px 1px #d0c8c1,inset 0 -5px 4px #302b2c,inset 2px 0 1px #d5cec6,inset -2px 0 1px #d5cec6,0 2px 0 #322e34,0 18px 16px -9px #000d,0 36px 45px -17px #000e;
  }
  /* The top of the cabinet, seen from a little above: the front outline
     pushed back and narrowed by perspective, one layer per pixel of depth.
     Being the front's own shape, it meets the rounded corners exactly. Outer
     shadows never paint inside the box, so only the top face shows. */
  .amp-head.guilt::before {
    content: '';
    position: absolute;
    z-index: -1;
    inset: -1px;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: 0 -1.55px 0 -0.55px #d8d0cb,0 -3.1px 0 -1.1px #d1c9c4,0 -4.65px 0 -1.65px #cac2bd,0 -6.2px 0 -2.2px #c3bab6,0 -7.75px 0 -2.75px #bdb4b0,0 -9.3px 0 -3.3px #b9b0ac,0 -10.85px 0 -3.85px #b4aba8,0 -12.4px 0 -4.4px #b0a7a4,0 -13.95px 0 -4.95px #aca3a0,0 -15.5px 0 -5.5px #a89f9c,0 -17.05px 0 -6.05px #a49b98,0 -18.6px 0 -6.6px #a09794,0 -20.15px 0 -7.15px #9c9390,0 -21.7px 0 -7.7px #534c4a;
  }
  .guilt-shell {
    position: absolute;
    z-index: 4;
    inset: 12px;
    border: 1px solid #45403f;
    border-radius: 12px;
    box-shadow: 0 -1px 0 #d4ccc4bb,0 1px 0 #c4bbb4aa,inset 0 1px 2px #29252699;
    pointer-events: none;
  }
  .guilt-handle {
    position: absolute;
    z-index: -1;
    top: -50px;
    left: calc(50% - 150px);
    pointer-events: none;
    filter: drop-shadow(0 3px 2px #0008);
  }
  .guilt .screw { display: none; }
  .glass-filters { position: absolute; pointer-events: none; }
  .guilt .glass-window {
    isolation: isolate;
    height: auto;
    aspect-ratio: 3;
    border: 0;
    border-radius: var(--guilt-front-radius) var(--guilt-front-radius) 0 0;
    background: #100a19;
    opacity: 1;
    box-shadow: 0 0 0 1px #4b444e,0 -1px 0 1px #2a252d;
  }
  .guilt .glass-window img { display: block; object-fit: fill; filter: none; }
  .guilt .glass-window .veil,.guilt .glass-window .glass-night {
    position: absolute;
    inset: 0;
    background: none;
    filter: url(#guilt-glass-shade);
    pointer-events: none;
    transition: opacity 650ms ease-out;
  }
  .guilt .glass-window .veil { transition-duration: 150ms; }
  .glass-night { opacity: .72; }
  .guilt.illuminated .glass-night { opacity: 0; }
  .glass-bloom-power { position: absolute; inset: 0; opacity: 0; pointer-events: none; mix-blend-mode: screen; transition: opacity 1100ms ease-in; }
  .guilt.illuminated .glass-bloom-power { opacity: 1; }
  .glass-glow { position: absolute; inset: 0; will-change: opacity; }
  .guilt .glass-glow img { filter: url(#guilt-glass-bloom); }
  .guilt .glass-window::after {
    z-index: 1;
    background: linear-gradient(0deg,#09060e45,transparent 18%);
    box-shadow: inset 0 3px 6px -3px #100d1744;
  }
  /* The glass sits behind the rim. Lit from above, the rim shades the top
     of the opening and the floor of the opening catches the light; the
     glass's own silver bezel is the only frame, so nothing is drawn over it. */
  .glass-walls {
    position: absolute;
    z-index: 2;
    inset: 0;
    box-shadow: inset 0 0 0 1px #2a232e,inset 0 2px 3px -2px #0006,inset 0 -1px 0 #d8cdc844;
    pointer-events: none;
  }
  .guilt .amp-brand {
    z-index: 3;
    bottom: 21px;
  }
  .guilt .amp-brand h1 { color: #e0cedf; text-shadow: 0 1px 0 #f7eaf6,0 2px 0 #857087,0 3px 0 #49334e,0 5px 3px #000,0 8px 13px #000; }
  .guilt .amp-brand p { color: #d0b7d4; text-shadow: 0 2px 2px #000; }

  /* Front-lit, concentric caps: only their indicators rotate. */
  .guilt .amp-panel {
    position: relative;
    /* A physical plate has a fixed height, including at fractional zoom
       where the browser rounds the labels' font metrics differently. */
    height: 132px;
    justify-content: center;
    gap: 24px;
    padding: 24px 150px 18px;
    border: 0;
    border-radius: 0 0 var(--guilt-front-radius) var(--guilt-front-radius);
    background:
      url('/images/guilt-cast.webp') 0 0 / 192px 192px,
      radial-gradient(ellipse at 30% 0%,#dfd8cf40,transparent 65%),
      linear-gradient(180deg,#827b79,#aba39e 7%,#a59e9a 48%,#99918e 90%,#716967);
    box-shadow: inset 0 1px 0 #d4ccc5,inset 0 -2px 2px #423b3d,0 1px 0 #b9b0a8;
  }
  .guilt .amp-panel::before {
    content: '';
    position: absolute;
    z-index: 3;
    left: 0;
    right: 0;
    top: -3px;
    height: 3px;
    pointer-events: none;
    background: linear-gradient(#3a333f,#b3a9ae 45%,#f1e7de);
  }
  .guilt .control-group { border-left: 0; padding-left: 0; flex: none; }
  .guilt .knob-row { gap: 12px; }
  .guilt .group-label { min-height: 36px; margin-top: -8px; margin-bottom: 1px; white-space: nowrap; color: #3e3542; font-size: 8px; font-weight: 500; text-shadow: 0 1px 0 #f6ebe555; }
  .guilt .group-label[aria-pressed='false'] { opacity: .65; }
  .guilt .group-label span { color: #58455f; }
  .guilt.illuminated .group-label[aria-pressed='true'] span { color: #6d347e; }
  .guilt .group-label:focus-visible,.guilt .power-indicator:focus-visible { outline: 2px solid var(--iris); outline-offset: 3px; border-radius: 3px; }
  .guilt :global(.label) { color: #39313d; font-size: 9px; font-weight: 500; letter-spacing: .13em; text-shadow: 0 1px 0 #f8eee966; }
  .guilt :global(.knob:hover .label) { color: #211629; }
  .guilt :global(.value) { color: #403546; font-size: 9px; text-shadow: 0 1px 0 #f8eee944; }
  .guilt :global(.dial) {
    background: conic-gradient(from 225deg,#746573 0deg,transparent 1deg 26deg,#746573 27deg 28deg,transparent 29deg 53deg,#746573 54deg 55deg,transparent 56deg 80deg,#746573 81deg 82deg,transparent 83deg 107deg,#746573 108deg 109deg,transparent 110deg 134deg,#746573 135deg 136deg,transparent 137deg 161deg,#746573 162deg 163deg,transparent 164deg 188deg,#746573 189deg 190deg,transparent 191deg 215deg,#746573 216deg 217deg,transparent 218deg 242deg,#746573 243deg 244deg,transparent 245deg 269deg,#746573 270deg,transparent 271deg);
    box-shadow: none;
  }
  .guilt :global(.dial::before) { inset: 3px; background: radial-gradient(circle,#595253 57%,#b6aca5 65%,#7a7170 68%,#aaa19b 72%); box-shadow: none; }
  .guilt :global(.power-dial .dial-light) { inset: 5px; }
  .guilt :global(.sweep-half::before) { border-width: 2px; }
  /* Seen from the same point above as the cabinet: the cap's side shows
     below its face, and it rests on the plate by a soft contact shadow. */
  .guilt :global(.cap) {
    inset: 8px;
    border: 0;
    /* A broad polished bevel over a finely fluted, oxidised silver skirt. */
    background:
      radial-gradient(circle,transparent 57%,#d8d4d0 59%,#787473 64%,transparent 69%,#39363640 88%,#dedad699 95%,#4d4a49 100%),
      conic-gradient(#dad7d2,#7f7c79 65deg,#b2afaa 105deg,#6e6a69 155deg,#494645 180deg,#6e6a69 205deg,#b2afaa 255deg,#7f7c79 295deg,#dad7d2),
      repeating-conic-gradient(#989491 0 4deg,#6e6b68 4deg 8deg);
    background-blend-mode: normal,soft-light,normal;
    box-shadow: 0 1px 0 #aba6a2,0 2px 0 #7c7874,0 3px 0 #5c5755,0 4px 0 #403c3b,0 6px 4px #25222266,0 10px 9px -3px #25222266;
    transform: none;
  }
  /* A shallow dished face. The reflection stays fixed while the engraved
     index rotates, so the metal never appears to turn with the lighting. */
  .guilt :global(.cap::before) {
    content: '';
    position: absolute;
    inset: 6px;
    border-radius: 50%;
    background:
      url('/images/guilt-cast.webp') center / 96px 96px,
      radial-gradient(ellipse at 50% 88%,#dcd8d299,transparent 62%),
      linear-gradient(#706c6a,#a39f9a 28%,#b8b4af 65%,#c2beb9);
    box-shadow: 0 0 0 1px #5d5956,0 1px 0 1px #dcd9d5,inset 0 2px 3px #2f2a2877,inset 0 -1px 1px #ede9e3aa;
  }
  /* A line engraved from the rim toward the centre; it turns about the
     cap's centre (23 px), never about its own. */
  .guilt :global(.indicator) { z-index: 1; top: 3px; left: calc(50% - 1px); width: 2px; height: 9px; border-radius: 1px; background: #352d32; box-shadow: 1px 0 0 #d9d5cfaa; transform-origin: 1px 20px; transform: rotate(var(--angle)); }
  .guilt :global(.indicator::after) { display: none; }
  .guilt .amp-signature { position: absolute; right: 76px; top: 50%; transform: translateY(-50%); min-width: 84px; color: #403341; text-shadow: 0 1px 0 #e9dcd080; }
  .guilt .sig-symbol { color: #56455f; width: 24px; height: 24px; }
  .guilt .amp-signature>span { font-size: 27px; }
  .guilt .amp-signature small { font-size: 6px; letter-spacing: .22em; }
  .guilt-jack { position: absolute; z-index: 5; left: 15px; top: calc(50% - 12px); width: 52px; height: 56px; pointer-events: none; background: url('/images/guilt-jack.webp') center / 100% 100% no-repeat; filter: drop-shadow(4px 7px 4px #291d3466); }
  .jack-cable { position: absolute; left: -301px; top: 51px; overflow: visible; }
  .guilt .power-indicator { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); gap: 12px; min-width: 42px; padding: 8px 4px; }
  .guilt .power-indicator small { color: #403341; }
  .guilt .power-indicator>span.power-rocker { position: relative; display: block; width: 30px; height: 51px; padding: 3px; border: 1px solid #4c4847; border-radius: 5px; background: #292626; perspective: 180px; box-shadow: 0 -1px 0 2px #d0ccc7,0 1px 0 2px #736f6b,0 3px 0 2px #4c4746,0 6px 5px #2b272666,inset 0 2px 4px #000; }
  .rocker-face { position: absolute; inset: 3px; display: flex; flex-direction: column; align-items: center; justify-content: space-around; border: 1px solid #aca7a2; border-radius: 3px; background: linear-gradient(#cbc6c0,#a7a29c 45%,#7e7974 52%,#9d9893); transform: rotateX(-13deg); box-shadow: 0 -2px 0 #605c58,0 -3px 1px #d9d5d0,inset 1px 0 1px #e8e4de99,inset -1px 0 1px #e8e4de66; color: #3d3938; font: 9px var(--mono); text-shadow: 0 1px 0 #d8d3cc99; }
  .rocker-on { color: #534e4c; }
  .rocker-off { color: #2c2928; }
  .rocker-lamp { position: relative; width: 9px; height: 4px; border-radius: 2px; background: #35263e; box-shadow: 0 0 0 1px #524d4c,0 1px 0 1px #d6d1ca,inset 0 1px 2px #000; }
  .rocker-lamp::after { content: ''; position: absolute; inset: 0; border-radius: inherit; background: #c3a2d8; box-shadow: 0 0 4px #d9b7ee,0 0 8px #a56bb377,inset 0 1px 0 #fff9; opacity: 0; transition: opacity 550ms ease-in; }
  .power-rocker.lit .rocker-face { transform: rotateX(13deg); background: linear-gradient(#86807c,#a39e98 45%,#c9c4bd 52%,#b1aca6); box-shadow: 0 3px 0 #615c58,0 4px 1px #c8c3bc,inset 0 1px 3px #2e2a2788,inset 1px 0 1px #e8e4de99,inset -1px 0 1px #e8e4de66; }
  .power-rocker.lit .rocker-on { color: #2c2928; }
  .power-rocker.lit .rocker-off { color: #534e4c; }
  .power-rocker.lit .rocker-lamp::after { opacity: 1; }
  .guilt .power-indicator:hover:not(:disabled) .power-rocker { border-color: #e1c8ef; }
  .guilt .power-indicator:active:not(:disabled) .rocker-face { transform: rotateX(0deg); }
  /* Seen from above, the feet are only their front edge under the cabinet,
     in its shadow, with the floor's contact shadow beneath. */
  .guilt + .amp-foot { position: relative; margin: -2px 58px 0; padding-bottom: 12px; }
  .guilt + .amp-foot::before { content: ''; position: absolute; z-index: -1; inset: -6px -40px 2px; pointer-events: none; border-radius: 50%; background: radial-gradient(closest-side,#000d,#0006 60%,transparent); }
  .guilt + .amp-foot span { width: 62px; height: 14px; border-radius: 0 0 7px 7px; background: linear-gradient(90deg,#141116,#3a343d 30%,#4a444c 50%,#3a343d 70%,#141116); box-shadow: inset 0 4px 3px -1px #000d,inset 0 -1px 0 #6a626c,0 2px 2px #000a; }
  @media(prefers-reduced-motion:reduce) {
    .guilt .glass-window .veil { opacity: .26 !important; }
    .guilt .glass-window .glass-night,.glass-bloom-power,.guilt .glass-window .veil,.rocker-lamp::after { transition: none; }
    .glass-glow { opacity: .22 !important; will-change: auto; }
  }

</style>
