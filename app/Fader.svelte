<script lang="ts">
  /**
   * The one continuous control in the product (UX-DR4).
   *
   * There are no round knobs anywhere in Tonecraft. DESIGN.md section 1 calls
   * this the one risk the design takes, and gives the reasons: a row of faders
   * is legible at a glance, maps to drag on any input device, and reads as
   * software rather than as a photograph of hardware.
   *
   * SVG and `transform`, never a canvas and never a sprite sheet — the cap is
   * composited by the GPU and costs the CPU nothing, which matters because the
   * CPU budget is the dropout budget.
   */
  import type { Param } from '../schema/params.ts';

  interface Props {
    param: Param;
    value: number;
    onchange: (value: number) => void;
  }

  const { param, value, onchange }: Props = $props();

  /** 96px of travel, as specified. */
  const TRAVEL = 96;
  const CAP_W = 20;
  const CAP_H = 6;

  let dragging = $state(false);
  let element = $state<HTMLDivElement | null>(null);

  const span = param.max - param.min;

  /**
   * The taper lives here and only here (AD-9). The wire format carries the
   * value in its engineering unit, so retuning a taper changes how the fader
   * feels and cannot change what an existing tone sounds like.
   *
   * A frequency control is logarithmic because hearing is: half of a 400 Hz to
   * 6 kHz sweep laid out linearly would be spent above 3 kHz.
   */
  const log = $derived(param.taper === 'logarithmic' && param.min > 0);

  /** 0 at the bottom, 1 at the top. */
  const toTravel = (v: number): number =>
    log
      ? Math.log(v / param.min) / Math.log(param.max / param.min)
      : (v - param.min) / span;

  const fromTravel = (t: number): number =>
    log ? param.min * Math.pow(param.max / param.min, t) : param.min + t * span;

  const position = $derived(toTravel(value));

  function clamp(v: number): number {
    return Math.min(param.max, Math.max(param.min, v));
  }

  /** One step of travel, so a keystroke moves the same distance everywhere. */
  const stepAt = (v: number, fine: boolean): number =>
    fromTravel(Math.min(1, toTravel(v) + 1 / (fine ? 400 : 60))) - v;

  function fromPointer(clientY: number): void {
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    const top = rect.top + (rect.height - TRAVEL) / 2;
    const t = 1 - (clientY - top) / TRAVEL;
    onchange(clamp(fromTravel(Math.min(1, Math.max(0, t)))));
  }

  function onPointerDown(event: PointerEvent): void {
    dragging = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    fromPointer(event.clientY);
  }

  function onPointerMove(event: PointerEvent): void {
    // 1:1 with the pointer and never animated. Direct manipulation that lags
    // reads as a broken control rather than a smooth one.
    if (dragging) fromPointer(event.clientY);
  }

  function onPointerUp(event: PointerEvent): void {
    dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    const step = stepAt(value, event.shiftKey);
    onchange(clamp(value - Math.sign(event.deltaY) * step));
  }

  function onKeyDown(event: KeyboardEvent): void {
    const step = stepAt(value, event.shiftKey);
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight': onchange(clamp(value + step)); break;
      case 'ArrowDown':
      case 'ArrowLeft': onchange(clamp(value - step)); break;
      case 'Home': onchange(param.max); break;
      case 'End': onchange(param.min); break;
      default: return;
    }
    event.preventDefault();
  }

  /** Double-click resets to the preset default, not to zero. */
  function onDoubleClick(): void {
    onchange(param.default);
  }

  /**
   * Reads as an amount, not as a raw number. A fader marked `-72.9 dB` says
   * nothing about a gate threshold; `-72.9` next to a unit does. Signs are
   * explicit on dB, because whether the EQ is cutting or boosting is the whole
   * information, and a ratio reads as a percentage because that is how anyone
   * talks about a mix control.
   */
  const shown = $derived.by(() => {
    switch (param.unit) {
      case 'dB':
        return `${value >= 0 ? '+' : '\u2212'}${Math.abs(value).toFixed(1)} dB`;
      case 'Hz':
        return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${Math.round(value)} Hz`;
      case 'ratio':
        return `${Math.round(value * 100)}%`;
      case 'ms':
        return `${value.toFixed(1)} ms`;
      default:
        return value.toFixed(1);
    }
  });
</script>

<div class="fader">
  <!-- The 40px hit area is the div; the visible hairline is 2px inside it. -->
  <div
    bind:this={element}
    class="track"
    class:dragging
    role="slider"
    tabindex="0"
    aria-label={param.label}
    aria-valuemin={param.min}
    aria-valuemax={param.max}
    aria-valuenow={value}
    aria-valuetext={shown}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onwheel={onWheel}
    onkeydown={onKeyDown}
    ondblclick={onDoubleClick}
  >
    <svg width="40" height={TRAVEL + CAP_H} viewBox="0 0 40 {TRAVEL + CAP_H}" aria-hidden="true">
      <!-- The hairline the cap travels along. -->
      <rect x="19" y={CAP_H / 2} width="2" height={TRAVEL} fill="var(--graphite)" />
      <!-- Active fill sits above the cap, in the accent. -->
      <rect
        x="19"
        y={CAP_H / 2 + (1 - position) * TRAVEL}
        width="2"
        height={position * TRAVEL}
        fill="var(--celadon)"
      />
      <!-- One flat cap. Moved by transform so it composites on the GPU. -->
      <rect
        x={(40 - CAP_W) / 2}
        y="0"
        width={CAP_W}
        height={CAP_H}
        fill="var(--ink)"
        style="transform: translateY({(1 - position) * TRAVEL}px)"
      />
    </svg>
  </div>

  <!-- The value replaces the label while dragging, and only then. -->
  <span class="caption" class:numeric={dragging}>
    {dragging ? shown : param.label}
  </span>
</div>

<style>
  .fader {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--u);
  }

  .track {
    width: 40px; /* hit area, regardless of the 2px the eye sees */
    display: grid;
    place-items: center;
    cursor: ns-resize;
    touch-action: none;
  }

  .track:focus-visible {
    outline: 2px solid var(--iris);
    outline-offset: 2px;
    border-radius: var(--radius);
  }

  .caption {
    font-family: var(--display);
    font-size: 11px;
    letter-spacing: 0.24em;
    text-transform: uppercase;
    color: var(--graphite);
    white-space: nowrap;
  }

  /* Numbers get the mono face with tabular figures so they do not jitter. */
  .caption.numeric {
    font-family: var(--mono);
    font-size: 13px;
    letter-spacing: 0;
    text-transform: none;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }

  /* Hover lifts the label and changes the cursor. That is all it does. */
  .track:hover + .caption { color: var(--ink); }
</style>
