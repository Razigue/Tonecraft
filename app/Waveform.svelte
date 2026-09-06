<script lang="ts">
  /**
   * The file source's timeline.
   *
   * SVG, not a canvas. DESIGN.md section 5 rules out `<canvas>` everywhere in
   * the product, and there is no reason to make an exception here: the envelope
   * is computed once into a fixed number of buckets and drawn as one `<path>`,
   * so scrubbing and playback move a `transform` and nothing redraws.
   *
   * Dragging moves the cursor only; the source is not restarted until release,
   * because restarting an AudioBufferSourceNode per pointer move chops the
   * sound into gravel.
   */

  interface Props {
    /** Min/max pairs, `BUCKETS * 2` long. */
    peaks: Float32Array | null;
    duration: number;
    position: number;
    onseek: (seconds: number) => void;
  }

  const { peaks, duration, position, onseek }: Props = $props();

  /** Enough detail to recognise a riff, few enough nodes to stay cheap. */
  const W = 1000;
  const H = 120;

  let element = $state<SVGSVGElement | null>(null);
  let scrub = $state(-1);

  const shown = $derived(scrub >= 0 ? scrub : position);
  const fraction = $derived(duration > 0 ? Math.min(1, Math.max(0, shown / duration)) : 0);

  /**
   * One path, built once per file. Each bucket is a vertical segment, which is
   * both what a waveform looks like and the cheapest thing SVG can draw.
   */
  const path = $derived.by(() => {
    if (peaks === null) return '';
    const n = peaks.length / 2;
    const mid = H / 2;
    const amp = H / 2 - 2;
    let d = '';
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) * W) / n;
      const lo = mid - peaks[i * 2]! * amp;
      const hi = mid - peaks[i * 2 + 1]! * amp;
      // A silent bucket still gets a hairline, so the take reads as continuous.
      d += `M${x.toFixed(2)} ${Math.min(lo, hi - 0.5).toFixed(2)}V${Math.max(hi, lo + 0.5).toFixed(2)}`;
    }
    return d;
  });

  function timeAt(clientX: number): number {
    if (element === null) return 0;
    const rect = element.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration;
  }

  function onPointerDown(event: PointerEvent): void {
    if (duration === 0) return;
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    scrub = timeAt(event.clientX);
  }

  function onPointerMove(event: PointerEvent): void {
    if (scrub >= 0) scrub = timeAt(event.clientX);
  }

  function release(): void {
    if (scrub < 0) return;
    const t = scrub;
    scrub = -1;
    onseek(t);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (duration === 0) return;
    const step = event.shiftKey ? 5 : 1;
    switch (event.key) {
      case 'ArrowLeft': onseek(position - step); break;
      case 'ArrowRight': onseek(position + step); break;
      case 'Home': onseek(0); break;
      case 'End': onseek(duration); break;
      default: return;
    }
    event.preventDefault();
  }

  const time = (t: number): string => {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
  };
</script>

<div class="wave">
  <svg
    bind:this={element}
    viewBox="0 0 {W} {H}"
    preserveAspectRatio="none"
    role="slider"
    tabindex="0"
    aria-label="Position in the file"
    aria-valuemin={0}
    aria-valuemax={Number(duration.toFixed(2))}
    aria-valuenow={Number(shown.toFixed(2))}
    aria-valuetext={time(shown)}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={release}
    onpointercancel={() => (scrub = -1)}
    onkeydown={onKeyDown}
  >
    <defs>
      <clipPath id="played">
        <rect x="0" y="0" width={fraction * W} height={H} />
      </clipPath>
    </defs>
    <path d={path} stroke="var(--graphite)" stroke-width="1.5" fill="none" vector-effect="non-scaling-stroke" />
    <path
      d={path}
      stroke="var(--celadon)"
      stroke-width="1.5"
      fill="none"
      vector-effect="non-scaling-stroke"
      clip-path="url(#played)"
    />
    <rect
      x="0"
      y="0"
      width="2"
      height={H}
      fill="var(--ink)"
      style="transform: translateX({fraction * W}px)"
    />
  </svg>
  <span class="t-readout">{time(shown)} / {time(duration)}</span>
</div>

<style>
  .wave {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  svg {
    width: 100%;
    height: 72px;
    display: block;
    cursor: text;
    touch-action: none;
  }

  svg:focus-visible {
    outline: 2px solid var(--iris);
    outline-offset: 2px;
  }

  .t-readout {
    color: var(--graphite);
    align-self: flex-end;
  }
</style>
