<script lang="ts">
  /**
   * A level meter (UX-DR9).
   *
   * Two of these exist in the whole product, one at the input and one at the
   * output. No peak-hold line, no printed dB scale — the point is to see at a
   * glance that signal is arriving and that it is not clipping, and anything
   * more is a spectrum analyser wearing a disguise.
   *
   * Fed by the RMS the worklet already computes, so it costs nothing.
   */
  interface Props {
    /** RMS, 0 to 1. */
    level: number;
  }

  const { level }: Props = $props();

  /**
   * Scaled so ordinary playing fills most of the bar. RMS of a signal peaking
   * near full scale sits around 0.3, so linear scaling would leave the meter
   * looking dead at exactly the level everything is meant to be at.
   */
  const height = $derived(Math.min(1, Math.sqrt(Math.max(0, level)) * 1.4));

  /** Clipping is the only thing the ember token is allowed to mean here. */
  const clipping = $derived(level > 0.62);
</script>

<div class="meter" role="meter" aria-label="Level" aria-valuemin={0} aria-valuemax={1}
     aria-valuenow={Number(level.toFixed(3))}>
  <svg width="4" height="96" viewBox="0 0 4 96" aria-hidden="true">
    <rect x="0" y="0" width="4" height="96" fill="var(--graphite)" opacity="0.18" />
    <rect
      x="0"
      y={96 - height * 96}
      width="4"
      height={height * 96}
      fill={clipping ? 'var(--ember)' : 'var(--celadon)'}
    />
  </svg>
</div>

<style>
  .meter {
    /* Aligned with a fader's travel so a row of them shares one baseline. */
    display: grid;
    place-items: center;
    width: calc(var(--u) * 2);
    padding-bottom: calc(var(--u) * 3);
  }
</style>
