<script lang="ts">
  /**
   * A level meter (UX-DR9).
   *
   * Two of these exist in the whole product, one at the input and one at the
   * output. No peak-hold line, no printed dB scale — the point is to see at a
   * glance that signal is arriving and that it is not clipping, and anything
   * more is a spectrum analyser wearing a disguise.
   *
   * Fed by what the worklet already computes, so it costs nothing.
   */
  import { untrack } from 'svelte';
  import { PEAK_CLIPPING } from '../engine/diagnosis';
  import { lang } from './locale.svelte.ts';

  interface Props {
    /** 0 to 1: RMS at the output, peak at the input. */
    level: number;
    /**
     * `peak` is the interface's own level, before the trim: the one place a
     * player can clip, and the one place a target level means something.
     */
    kind?: 'rms' | 'peak';
    /** A short name under the meter: two thin bars side by side are otherwise anonymous. */
    label?: string;
  }

  const { level, kind = 'rms', label }: Props = $props();

  /**
   * The input window, in dBFS. -18 to -6 is the usual target for a DI into an
   * amp sim: loud enough that the trim is not lifting the converter's noise,
   * with 6 dB left for a pick digging in before the converter hits its ceiling.
   * Below -48 there is nothing a meter needs to show apart from "something".
   */
  const FLOOR_DB = -48;
  const SWEET_LOW_DB = -18;
  const SWEET_HIGH_DB = -6;
  /** A clipped sample lasts one 30 Hz frame; this keeps it long enough to be seen. */
  const CLIP_HOLD_MS = 1500;
  /**
   * The sweet spot is judged on a peak that falls slowly, not on each frame:
   * playing peaks come and go between notes, and a light that flickers at 30 Hz
   * says nothing.
   */
  const HOLD_FALL_DB_PER_S = 20;

  const H = 96;
  const DOT = 4;
  const GAP = 4;
  const TOP = DOT + GAP;

  const toDb = (x: number) => 20 * Math.log10(Math.max(1e-6, x));
  const dbToHeight = (db: number) => Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));

  let heldDb = $state(FLOOR_DB);
  let heldAt = 0;
  let clipped = $state(false);
  let clipTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (kind !== 'peak') return;
    const x = level;
    untrack(() => {
      const t = performance.now();
      const fallen = heldDb - ((t - heldAt) / 1000) * HOLD_FALL_DB_PER_S;
      heldDb = Math.max(toDb(x), fallen, FLOOR_DB);
      heldAt = t;
    });
    if (x >= PEAK_CLIPPING) {
      clipped = true;
      clearTimeout(clipTimer);
      // A timer rather than the next frame: the input can go silent, and a frame repeating 0 changes nothing.
      clipTimer = setTimeout(() => { clipped = false; }, CLIP_HOLD_MS);
    }
  });

  $effect(() => () => clearTimeout(clipTimer));

  /**
   * RMS of a signal peaking near full scale sits around 0.3, so linear scaling
   * would leave the output meter looking dead at exactly the level everything is
   * meant to be at. A peak reads in dB, where the sweet spot is a fixed band.
   */
  const height = $derived(kind === 'peak'
    ? dbToHeight(toDb(level))
    : Math.min(1, Math.sqrt(Math.max(0, level)) * 1.4));

  /** Clipping is the only thing the ember token is allowed to mean here. */
  const clipping = $derived(kind === 'peak' ? clipped : level > 0.62);
  const sweet = $derived(kind === 'peak' && !clipping && heldDb >= SWEET_LOW_DB && heldDb <= SWEET_HIGH_DB);

  const bandTop = TOP + H - dbToHeight(SWEET_HIGH_DB) * H;
  const bandHeight = (dbToHeight(SWEET_HIGH_DB) - dbToHeight(SWEET_LOW_DB)) * H;

  const valueText = $derived(kind !== 'peak' ? undefined
    : clipping ? lang.ui.meter.clipping
    : level < 1e-4 ? lang.ui.meter.silent
    : `${toDb(level).toFixed(0)} dBFS${sweet ? lang.ui.meter.sweet : heldDb < SWEET_LOW_DB ? lang.ui.meter.low : heldDb > SWEET_HIGH_DB ? lang.ui.meter.hot : ''}`);
</script>

<div class="meter" class:sweet class:clipping role="meter" aria-label={kind === 'peak' ? lang.ui.meter.input : lang.ui.meter.level}
     aria-valuemin={0} aria-valuemax={1} aria-valuenow={Number(level.toFixed(3))} aria-valuetext={valueText}>
  <svg width="9" height={TOP + H} viewBox={`0 0 9 ${TOP + H}`} aria-hidden="true">
    {#if kind === 'peak'}
      <rect class="clip" x="0" y="0" width={DOT} height={DOT} rx="2" />
      <rect class="band" x="7" y={bandTop} width="2" height={bandHeight} />
    {/if}
    <rect class="rail" x="0" y={TOP} width="5" height={H} rx="1" />
    <rect class="fill" x="0" y={TOP + H - height * H} width="5" height={height * H} rx="1" />
  </svg>
  {#if label}<span class="meter-label" aria-hidden="true">{label}</span>{/if}
</div>

<style>
  .meter {
    /* Aligned with a fader's travel so a row of them shares one baseline. */
    display: grid;
    place-items: center;
    gap: 6px;
    width: calc(var(--u) * 2.5);
  }
  .rail { fill: var(--violet-800); }
  .meter-label {
    font: 400 9px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .fill { fill: var(--celadon); }
  .clipping .fill { fill: var(--ember); }
  .band {
    fill: var(--celadon);
    opacity: 0.3;
  }
  .sweet .band { opacity: 1; }
  .clip {
    fill: var(--ember);
    opacity: 0;
  }
  .clipping .clip { opacity: 1; }
</style>
