<script lang="ts" module>
  export interface TourStep {
    /** The windows lit for this step; none puts the card in the middle of the screen. */
    readonly targets: readonly string[];
    readonly title: string;
    readonly body: readonly string[];
  }
</script>

<script lang="ts">
  import { onDestroy, tick } from 'svelte';

  let { steps, labels, onclose }: {
    steps: readonly TourStep[];
    labels: { readonly skip: string; readonly back: string; readonly next: string; readonly done: string };
    onclose: () => void;
  } = $props();

  /**
   * One window at a time, the rest of the page in the dark. The windows are
   * not copied into the tour: the real one is lifted above the shade, so what
   * is explained is what is there, and it still works while it is explained —
   * the demo can be started from its own step. Lifted by its z-index alone, as
   * no ancestor of a window opens a stacking context; a fixed button keeps its
   * position.
   */
  const LIFT = '71';
  const GAP = 16;
  let index = $state(0);
  let card = $state<HTMLDivElement | null>(null);
  let next = $state<HTMLButtonElement | null>(null);
  let place = $state<{ x: number; y: number } | null>(null);
  let lit: { el: HTMLElement; position: string; zIndex: string }[] = [];
  let frame = 0;
  const step = $derived(steps[index]!);
  const last = $derived(index === steps.length - 1);

  function release(): void {
    for (const { el, position, zIndex } of lit) {
      el.style.position = position;
      el.style.zIndex = zIndex;
      el.classList.remove('tour-lit');
    }
    lit = [];
  }

  function light(targets: readonly string[]): void {
    release();
    for (const selector of targets) {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) continue;
      lit.push({ el, position: el.style.position, zIndex: el.style.zIndex });
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      el.style.zIndex = LIFT;
      el.classList.add('tour-lit');
    }
    const first = lit[0]?.el;
    if (!first || getComputedStyle(first).position === 'fixed') return;
    // With room for the card, the window goes to the top and the card under it:
    // centred, a window half the screen high left no room on either side, and
    // the card covered what it explained. Taller than that, it is read from its
    // top and the card sits at the foot of the screen.
    const r = first.getBoundingClientRect();
    const room = r.height + (card?.offsetHeight ?? 0) + GAP * 3 <= innerHeight;
    if (room) scrollTo({ top: scrollY + r.top - GAP, behavior: 'smooth' });
    else first.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /**
   * Beside the lit windows: under them, else over them, else to their left or
   * right, else at the foot of the screen. The sides are for a small window
   * near the end of the page, which cannot scroll up far enough to leave room
   * above or below: the card had nowhere to go but over it.
   */
  function position(): void {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!card) return;
      const w = card.offsetWidth, h = card.offsetHeight;
      const rects = lit.map(l => l.el.getBoundingClientRect());
      if (rects.length === 0) { place = { x: Math.round((innerWidth - w) / 2), y: Math.round((innerHeight - h) / 2) }; return; }
      const top = Math.min(...rects.map(r => r.top)), bottom = Math.max(...rects.map(r => r.bottom));
      const left = Math.min(...rects.map(r => r.left)), right = Math.max(...rects.map(r => r.right));
      let x = Math.min(Math.max(GAP, (left + right) / 2 - w / 2), innerWidth - w - GAP);
      let y = innerHeight - h - GAP;
      const besideY = Math.min(Math.max(GAP, (top + bottom) / 2 - h / 2), innerHeight - h - GAP);
      if (innerHeight - bottom >= h + GAP * 2) y = bottom + GAP;
      else if (top >= h + GAP * 2) y = top - h - GAP;
      else if (left >= w + GAP * 2) { x = left - w - GAP; y = besideY; }
      else if (innerWidth - right >= w + GAP * 2) { x = right + GAP; y = besideY; }
      place = { x: Math.round(Math.max(GAP, x)), y: Math.round(Math.max(GAP, y)) };
    });
  }

  function finish(): void {
    release();
    onclose();
  }

  $effect(() => {
    const targets = step.targets;
    void tick().then(() => {
      light(targets);
      position();
      next?.focus({ preventScroll: true });
    });
  });

  onDestroy(() => { cancelAnimationFrame(frame); release(); });
</script>

<svelte:window onscroll={position} onresize={position}
  onkeydown={e => { if (e.key === 'Escape') { e.preventDefault(); finish(); } }} />

<div class="tour-shade" aria-hidden="true"></div>
<div class="tour-card" class:placed={place !== null} role="dialog" aria-labelledby="tour-title" bind:this={card}
  style:transform={place ? `translate(${place.x}px, ${place.y}px)` : undefined}>
  <span class="tour-count">{index + 1} / {steps.length}</span>
  <h2 id="tour-title">{step.title}</h2>
  {#each step.body as line}<p>{line}</p>{/each}
  <div class="tour-actions">
    {#if !last}<button class="tour-skip" type="button" onclick={finish}>{labels.skip}</button>{/if}
    {#if index > 0}<button type="button" onclick={() => index--}>{labels.back}</button>{/if}
    <button class="tour-next" type="button" bind:this={next} onclick={() => (last ? finish() : index++)}>{last ? labels.done : labels.next}</button>
  </div>
</div>

<style>
  .tour-shade{position:fixed;inset:0;z-index:70;background:#030303d9;animation:tour-in .25s ease-out}
  .tour-card{position:fixed;left:0;top:0;z-index:72;width:min(400px,calc(100vw - 32px));box-sizing:border-box;padding:20px 22px 18px;border:1px solid #6d5a72;border-radius:8px;background:#1d1a1f;color:var(--ink);opacity:0;transition:transform .3s ease-out}
  .tour-card.placed{opacity:1}
  .tour-count{font:9px var(--mono);letter-spacing:1.6px;color:#a99cae}
  h2{font:500 18px var(--body);margin:6px 0 10px}
  p{font:13px/1.55 var(--body);color:#d6ced9;margin:0 0 8px}
  .tour-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:14px}
  button{font:12px var(--body);color:#ddd;background:#303030;border:1px solid #4b4b4b;border-radius:4px;min-height:34px;padding:6px 14px;cursor:pointer}
  button:hover{background:#414141}
  .tour-skip{margin-right:auto;background:none;border-color:transparent;color:#a99cae;padding-left:0}
  .tour-skip:hover{background:none;color:#e6dcea}
  .tour-next{background:#dedbd5;color:#222;border-color:#dedbd5}
  .tour-next:hover{background:#fff}
  :global(.tour-lit){outline:1px solid #cdb6d466;outline-offset:6px}
  @keyframes tour-in{from{opacity:0}to{opacity:1}}
</style>
