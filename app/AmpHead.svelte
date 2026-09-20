<script lang="ts">
  // The amplifier's head: the one object in the studio with a material, and
  // the only part of the screen an amplifier owns. The Tone mode's stage.
  //
  // GUILT is a photograph of a head, not a drawing of one. A single raster
  // carries the cabinet, the handle, the tracery, the plate, its engraved
  // names, the signature and the lead, and nothing is redrawn over it. The DOM
  // adds only what has to move — seven indices, a boost lever, a rocker — and
  // two filtered copies of that same raster, which are what puts the light in
  // the glass. Drawing the cabinet in CSS cost several hundred lines and never
  // looked cast; one image does it in 210 kB, decoded once, off the audio path.
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
  const skin = `${import.meta.env.BASE_URL}images/guilt.webp`;
  const shade = `${import.meta.env.BASE_URL}images/guilt-glass-shade.webp`;
  const bloom = `${import.meta.env.BASE_URL}images/guilt-glass-bloom.webp`;
  const boostOn = `${import.meta.env.BASE_URL}images/guilt-boost-on.webp`;
  const boostOff = `${import.meta.env.BASE_URL}images/guilt-boost-off.webp`;

  /**
   * The head's own image, in its own pixels. Every control below is placed in
   * these coordinates and scales with the image, so the plate and what sits on
   * it can never drift apart.
   */
  const SKIN_W = 1672;
  const SKIN_H = 941;
  /** Measured off the raster: the row of caps, and one cap across. */
  const CAP_Y = 731;
  const CAP_D = 74;

  /**
   * The plate is the map. A control exists on the head only where the image
   * has a place engraved for it — seven caps, a lever under BOOST, a rocker
   * past the signature. Everything else in the chain lives in the chain band,
   * where there is room to name it. The engraved names read as an amplifier's
   * do: GAIN is what goes into the capture, LEVEL what the boost adds.
   */
  const PLATE: readonly { id: string; x: number }[] = [
    { id: 'in_trim', x: 318.5 },
    { id: 'tone_bass', x: 463 },
    { id: 'tone_mid', x: 606.5 },
    { id: 'tone_treble', x: 798.5 },
    { id: 'tone_presence', x: 937.5 },
    { id: 'out_master', x: 1079 },
    { id: 'drive_gain', x: 1218.5 },
  ];
  /** The tracery window plus the halo's margin: the two light layers' crop. */
  const GLASS = { x: 95, y: 174, w: 1486, h: 477 };
  /** Under the engraved BOOST, and past the signature. Same coordinates. */
  const BOOST = { x: 707, y: 731, w: 39, h: 62.5 };
  const ROCKER = { x: 1508, y: 729, w: 56, h: 78 };

  const px = (v: number, total: number): string => `${(v / total) * 100}%`;
  const slot = (x: number, y: number, w: number, h: number): string =>
    `left:${px(x, SKIN_W)};top:${px(y, SKIN_H)};width:${px(w, SKIN_W)};aspect-ratio:${w}/${h}`;
  /** The light layers sit in the same coordinates, from their top-left. */
  const glassSlot = `left:${px(GLASS.x, SKIN_W)};top:${px(GLASS.y, SKIN_H)};width:${px(GLASS.w, SKIN_W)};height:${px(GLASS.h, SKIN_H)}`;
  const boosted = $derived(values.drive_bypass !== 1);
</script>

<div class="amp-stand" class:guilt={isGuilt}>
  {#if isGuilt}
    <section class="amp-head guilt" class:illuminated={ampIlluminated} class:bypassed={poweredOff} aria-label={t.rig.guiltAmp}>
      <img class="skin-base" src={skin} alt={t.rig.glassAlt} width={SKIN_W} height={SKIN_H} decoding="async" />
      <!-- The light, in two layers chroma-keyed out of the raster at build
           (`scripts/make-guilt-layers.mjs`). Nothing here is filtered at
           runtime: only their opacity moves, which is what the meters move. -->
      <img class="skin-night" src={shade} alt="" aria-hidden="true" width={GLASS.w} height={GLASS.h} decoding="async" style={glassSlot} />
      <img class="skin-veil" src={shade} alt="" aria-hidden="true" width={GLASS.w} height={GLASS.h} decoding="async" style={`${glassSlot};opacity:${veil * 0.5}`} />
      <div class="skin-bloom" aria-hidden="true" style={glassSlot}>
        <img src={bloom} alt="" width={GLASS.w} height={GLASS.h} decoding="async" style={`opacity:${0.12 + light * 0.3}`} />
      </div>

      {#each PLATE as c (c.id)}
        <span class="cap-slot" style={slot(c.x, CAP_Y, CAP_D, CAP_D)}>
          <Knob skin param={param(c.id)} label={t.params[c.id]} value={values[c.id]!} resetValue={resetValues[c.id]} onchange={(v) => onparam(c.id, v)} />
        </span>
      {/each}

      <button class="boost-lever tc-tip-host" type="button" style={slot(BOOST.x, BOOST.y, BOOST.w, BOOST.h)}
        aria-label={t.rig.groupEnabled.boost} aria-pressed={boosted} onclick={() => onparam('drive_bypass', boosted ? 1 : 0)}>
        <!-- The switch is its own photograph, up and down, cut from two
             renders and aligned on the escutcheon they share
             (`scripts/make-boost-switch.mjs`). Both are laid over each other
             and only their opacity changes, so the lever moves and the metal
             it is bolted to does not. Drawing it by hand never read as cast. -->
        <img class="lever" class:shown={boosted} src={boostOn} alt="" aria-hidden="true" width="196" height="314" decoding="async" />
        <img class="lever" class:shown={!boosted} src={boostOff} alt="" aria-hidden="true" width="196" height="314" decoding="async" />
        <span class="tc-tip"><b>{t.rig.groups.boost}</b>{boosted ? t.rig.on : t.rig.off}</span>
      </button>

      <button class="rocker tc-tip-host" type="button" style={slot(ROCKER.x, ROCKER.y, ROCKER.w, ROCKER.h)}
        aria-label={t.rig.amplifierPower} aria-pressed={ampIlluminated} aria-busy={powerBusy} disabled={powerDisabled} onclick={onpower}>
        <span class="rocker-well" aria-hidden="true"><span class="rocker-face" class:lit={ampIlluminated}><span class="rocker-lamp"></span></span></span>
        <span class="tc-tip"><b>{t.rig.power}</b>{ampIlluminated ? t.rig.on : t.rig.off}</span>
      </button>
    </section>
  {:else}
    <section class="amp-head neutral" class:bypassed={poweredOff} aria-label={t.rig.neutralAmp}>
      <span class="screw tl"></span><span class="screw tr"></span><span class="screw bl"></span><span class="screw br"></span>
      <div class="glass-window">
        <div class="neutral-art"><span>TC</span><small>AMPLIFICATION</small></div>
        <div class="amp-brand"><span class="brand-rule"></span><h1>TONECRAFT</h1><span class="brand-rule"></span><p>{t.rig.neutralMotto}</p></div>
      </div>
      <div class="amp-panel">
        <div class="knob-row">
          {#each PLATE as c, i (c.id)}
            {#if i === 3}
              <button class="boost-toggle" aria-label={t.rig.groupEnabled.boost} aria-pressed={boosted} onclick={() => onparam('drive_bypass', boosted ? 1 : 0)}>
                {t.rig.groups.boost.toUpperCase()} <span>{boosted ? '●' : '○'}</span>
              </button>
            {/if}
            <Knob param={param(c.id)} label={t.params[c.id]} value={values[c.id]!} resetValue={resetValues[c.id]} onchange={(v) => onparam(c.id, v)} />
          {/each}
        </div>
        <button class="power-indicator" type="button" aria-label={t.rig.amplifierPower} aria-pressed={ampIlluminated} aria-busy={powerBusy} disabled={powerDisabled} onclick={onpower}>
          <span class:lit={ampIlluminated}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 2v10M6 5a9 9 0 1 0 12 0"/></svg></span>
          <small>{t.rig.power.toUpperCase()}</small>
        </button>
      </div>
    </section>
    <div class="amp-foot"><span></span><span></span></div>
  {/if}
</div>

<style>
  /* The head is an object with one size and one shape. It never reflows and
     never changes proportion: the studio scales it whole to the room it has
     (`ampZoom` in Rig.svelte), the way moving away from an amp makes it
     smaller rather than shorter. */
  .amp-stand { width: var(--column); }

  /* --- GUILT: one raster, and only what moves over it -------------------- */
  .amp-head.guilt {
    position: relative;
    isolation: isolate;
    aspect-ratio: 1672 / 941;
    --knob-accent: #79608d;
  }
  .amp-head.guilt img { display: block; width: 100%; height: 100%; }
  /* The glass is lit in the raster. Turning the amplifier off does not turn a
     lamp off in the image — it lays black over the glass alone, in the shape
     the glass has, so the cast silver around it is untouched. */
  .skin-night,.skin-veil {
    position: absolute;
    pointer-events: none;
    transition: opacity 650ms ease-out;
  }
  .skin-night { opacity: .74; }
  .skin-veil { opacity: 0; transition-duration: 150ms; }
  .guilt.illuminated .skin-night { opacity: 0; }
  .guilt.bypassed .skin-night { opacity: .86; }
  .skin-bloom { position: absolute; opacity: 0; pointer-events: none; mix-blend-mode: screen; transition: opacity 1100ms ease-in; }
  .guilt.illuminated .skin-bloom { opacity: 1; }
  .skin-bloom img { will-change: opacity; }

  /* Every control is placed in the image's own pixels and centred on what the
     image already draws there, so a knob cannot slide off its cap. */
  .cap-slot,.boost-lever,.rocker { position: absolute; transform: translate(-50%, -50%); }
  .boost-lever,.rocker { padding: 0; border: 0; background: none; cursor: pointer; }
  /* The two positions sit in the same place; only which one is opaque moves. */
  .lever { position: absolute; inset: 0; opacity: 0; transition: opacity var(--dur-quick) ease-out; filter: drop-shadow(0 2px 3px #2b262440); }
  .lever.shown { opacity: 1; }
  .boost-lever:focus-visible,.rocker:focus-visible { outline: 2px solid var(--iris); outline-offset: 3px; border-radius: var(--radius); }

  /* The rocker is the one control the raster has no place drawn for: it sits
     in its own bezel, cut into the plate past the signature. */
  .rocker-well {
    position: absolute;
    inset: 0;
    display: block;
    padding: 3px;
    border: 1px solid #8e8883;
    border-radius: 5px;
    background: #6d6763;
    perspective: 190px;
    box-shadow: 0 -1px 0 2px #f2efe9,0 1px 0 2px #b3aca6,0 3px 0 2px #8b8580,0 6px 6px #2b262633,inset 0 2px 5px #3a3633;
  }
  .rocker-face {
    position: absolute;
    inset: 3px;
    display: grid;
    place-items: center;
    border: 1px solid #efece6;
    border-radius: 3px;
    background: linear-gradient(#fdfbf7,#e6e2db 46%,#c9c4bd 53%,#ded9d2);
    transform: rotateX(-13deg);
    box-shadow: 0 -2px 0 #a49e98,0 -3px 1px #fffdf9,inset 1px 0 1px #fffefb,inset -1px 0 1px #fffefbaa;
    transition: transform var(--dur-quick) var(--ease-out);
  }
  .rocker-lamp { position: relative; width: 10px; height: 5px; border-radius: 2.5px; background: #4a3d54; box-shadow: 0 0 0 1px #a39d97,0 1px 0 1px #fffdf8,inset 0 1px 2px #221b28; }
  .rocker-lamp::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: #c9a6de;
    box-shadow: 0 0 5px #d9b7ee,0 0 10px #a56bb388,inset 0 1px 0 #fff9;
    opacity: 0;
    transition: opacity 550ms ease-in;
  }
  .rocker-face.lit {
    background: linear-gradient(#bdb7b1,#d8d3cc 45%,#f6f3ee 53%,#e9e5de);
    transform: rotateX(13deg);
    box-shadow: 0 3px 0 #a49e98,0 4px 1px #efebe4,inset 0 1px 3px #6f6963aa,inset 1px 0 1px #fffefb,inset -1px 0 1px #fffefbaa;
  }
  .rocker-face.lit .rocker-lamp::after { opacity: 1; }
  .rocker:hover:not(:disabled) .rocker-well { border-color: var(--violet-300); }
  .rocker:active:not(:disabled) .rocker-face { transform: rotateX(0deg); }
  .rocker:disabled { cursor: wait; }
  @starting-style { .rocker-face.lit .rocker-lamp::after { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .skin-veil { opacity: .2 !important; }
    .skin-night,.skin-veil,.skin-bloom,.rocker-lamp::after,.rocker-face,.lever { transition: none; }
    .skin-bloom img { opacity: .22 !important; will-change: auto; }
  }

  /* --- The neutral head: the same seven controls, drawn ------------------ */
  .amp-head.neutral { position: relative; margin-top: 0; padding: 17px; border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--surface-1); box-shadow: var(--shadow); --knob-accent: var(--violet-400); }
  .glass-window { position: relative; height: 300px; overflow: hidden; background: #101010; border: 2px solid #0e0e10; box-shadow: 0 0 0 1px #55505b; }
  .glass-window::after { content: ''; position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 35px 12px #08080bd9; background: linear-gradient(0deg, #09080bb0, transparent 65%); }
  .amp-brand { position: absolute; z-index: 1; bottom: 24px; left: 0; right: 0; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 18px; text-align: center; color: #e4d4e8; text-shadow: 0 2px 8px #000; }
  .amp-brand h1 { margin: 0 -0.3em 0 0; font: 400 22px var(--display); font-stretch: 125%; letter-spacing: 7px; }
  .brand-rule { width: 42px; height: 1px; background: #ad96b777; }
  .amp-brand p { flex-basis: 100%; margin: -8px 0 0; font: 400 8px/1 var(--display); font-stretch: 125%; letter-spacing: 0.5em; }
  .neutral-art { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; background: repeating-linear-gradient(0deg, #1b1b1b 0 2px, #2e2e2e 2px 3px); color: #848484; }
  .neutral-art > span { font-size: 80px; font-weight: 800; letter-spacing: -15px; opacity: .35; }
  .neutral-art small { font-size: 8px; letter-spacing: 6px; }
  .bypassed .glass-window { opacity: .5; }

  .amp-panel { display: flex; align-items: center; justify-content: space-around; gap: 20px; padding: 22px 20px 20px; background: var(--faceplate); border: 1px solid var(--line-strong); }
  .knob-row { display: flex; align-items: center; gap: 16px; }
  .boost-toggle {
    align-self: flex-start;
    margin: 0 4px;
    padding: 0;
    border: 0;
    background: none;
    font: 400 9px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.24em;
    color: var(--text-2);
    white-space: nowrap;
    cursor: pointer;
  }
  .boost-toggle span { margin-left: 5px; font-size: 7px; color: var(--knob-accent); }
  .boost-toggle[aria-pressed='false'] { opacity: .45; }
  .boost-toggle:focus-visible,.power-indicator:focus-visible { outline: 2px solid var(--iris); outline-offset: 3px; border-radius: 3px; }
  .power-indicator { display: flex; flex-direction: column; align-items: center; gap: 15px; min-width: 44px; padding: 8px; border: 0; background: none; color: var(--text-2); cursor: pointer; }
  .power-indicator > span { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: var(--violet-900); border: 3px solid #252227; box-shadow: 0 0 0 1px var(--violet-600); }
  .power-indicator > span.lit { color: #fff; background: var(--violet-600); box-shadow: 0 0 12px #c47adf; }
  .power-indicator small { font: 400 7px/1 var(--display); font-stretch: 125%; letter-spacing: 0.2em; color: var(--text-2); }
  .power-indicator:disabled { opacity: .5; cursor: wait; }
  .screw { position: absolute; width: 5px; height: 5px; border-radius: 50%; background: linear-gradient(135deg, #777, #222 45%, #999 50%, #333 60%); }
  .tl { top: 6px; left: 7px; } .tr { top: 6px; right: 7px; } .bl { bottom: 6px; left: 7px; } .br { bottom: 6px; right: 7px; }
  .amp-foot { display: flex; justify-content: space-between; margin: 0 50px; }
  .amp-foot span { width: 65px; height: 9px; background: #0f0f0f; border-radius: 0 0 3px 3px; }
</style>
