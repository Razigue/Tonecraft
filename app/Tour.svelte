<script lang="ts" module>
  export type TourFigure = 'tracks' | 'compose';
  export interface TourStep {
    /** The windows lit for this step; none puts the card in the middle of the screen. */
    readonly targets: readonly string[];
    readonly title: string;
    /**
     * Paragraphs. `[words](term)` is a defined term, in bold, that rings the
     * control it names on the page while it is hovered, focused or tapped;
     * `**words**` is bold alone.
     */
    readonly body: readonly string[];
    /** A drawing in the card, for what the page cannot show yet. */
    readonly figure?: TourFigure;
  }
</script>

<script lang="ts">
  import { onDestroy, tick } from 'svelte';

  let { steps, terms, labels, onclose }: {
    steps: readonly TourStep[];
    /** Term → selector of what it names, on the page or in the card's drawing. */
    terms: Readonly<Record<string, string>>;
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
  const RING_PAD = 6;
  let index = $state(0);
  let card = $state<HTMLDivElement | null>(null);
  let next = $state<HTMLButtonElement | null>(null);
  let place = $state<{ x: number; y: number } | null>(null);
  let term = $state<string | null>(null);
  let rings = $state<{ x: number; y: number; w: number; h: number }[]>([]);
  let lit: { el: HTMLElement; position: string; zIndex: string }[] = [];
  let frame = 0;
  const step = $derived(steps[index]!);
  const last = $derived(index === steps.length - 1);

  type Segment = { text: string; term?: string; bold?: boolean };
  function segments(line: string): Segment[] {
    const out: Segment[] = [];
    let at = 0;
    for (const m of line.matchAll(/\[([^\]]+)\]\((\w+)\)|\*\*([^*]+)\*\*/g)) {
      if (m.index > at) out.push({ text: line.slice(at, m.index) });
      out.push(m[1] !== undefined ? { text: m[1], term: m[2] } : { text: m[3]!, bold: true });
      at = m.index + m[0].length;
    }
    if (at < line.length) out.push({ text: line.slice(at) });
    return out;
  }

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

  /** A ring around everything the hovered term names that is on screen. */
  function measureRings(): void {
    const selector = term === null ? undefined : terms[term];
    if (!selector) { rings = []; return; }
    rings = [...document.querySelectorAll<HTMLElement>(selector)]
      .map(el => el.getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0)
      .map(r => ({ x: Math.round(r.left - RING_PAD), y: Math.round(r.top - RING_PAD), w: Math.round(r.width + RING_PAD * 2), h: Math.round(r.height + RING_PAD * 2) }));
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
      measureRings();
      if (!card) return;
      const w = card.offsetWidth, h = card.offsetHeight;
      const rects = lit.map(l => l.el.getBoundingClientRect());
      if (rects.length === 0) { place = { x: Math.round((innerWidth - w) / 2), y: Math.round(Math.max(GAP, (innerHeight - h) / 2)) }; return; }
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

  function show(key: string | null): void {
    term = key;
    measureRings();
  }

  function finish(): void {
    release();
    onclose();
  }

  $effect(() => {
    const targets = step.targets;
    term = null;
    rings = [];
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
{#each rings as r}
  <span class="tour-ring" aria-hidden="true" style:width={`${r.w}px`} style:height={`${r.h}px`} style:transform={`translate(${r.x}px, ${r.y}px)`}></span>
{/each}
<div class="tour-card" class:placed={place !== null} class:wide={step.figure !== undefined} role="dialog" aria-labelledby="tour-title" bind:this={card}
  style:transform={place ? `translate(${place.x}px, ${place.y}px)` : undefined}>
  <div class="tour-progress" aria-hidden="true">{#each steps as _, i}<i class:done={i <= index}></i>{/each}</div>
  <span class="tour-count">{index + 1} / {steps.length}</span>
  <h2 id="tour-title">{step.title}</h2>

  {#if step.figure === 'tracks'}
    <div class="tour-figure fig-tracks" aria-hidden="true">
      <div class="fig-track"><span class="fig-name"><b>01</b> Lead</span><span class="fig-btn on" data-term="solo">Solo</span><span class="fig-btn">Mute</span><span class="fig-level" data-term="volume"><i style="transform:scaleX(.85)"></i></span></div>
      <div class="fig-track muted"><span class="fig-name"><b>02</b> Rhythm</span><span class="fig-btn">Solo</span><span class="fig-btn on" data-term="mute">Mute</span><span class="fig-level"><i style="transform:scaleX(.6)"></i></span></div>
      <div class="fig-track"><span class="fig-name"><b>03</b> Bass</span><span class="fig-btn">Solo</span><span class="fig-btn">Mute</span><span class="fig-level"><i style="transform:scaleX(.7)"></i></span></div>
    </div>
  {:else if step.figure === 'compose'}
    <div class="tour-figure fig-compose" aria-hidden="true">
      <div class="fig-chips"><span data-term="tempo">120 BPM</span><span data-term="signature">4/4</span><span data-term="tuning">E standard</span></div>
      <svg class="fig-tab" viewBox="0 0 290 84">
        {#each [0, 1, 2, 3, 4, 5] as s}<line x1="4" x2="286" y1={12 + s * 12} y2={12 + s * 12} />{/each}
        <line class="bar" x1="4" x2="4" y1="12" y2="72" /><line class="bar" x1="286" x2="286" y1="12" y2="72" />
        <rect class="fig-cursor" x="30" y="3" width="26" height="78" rx="4" />
        <text x="43" y="16">3</text>
        <text x="113" y="16">12</text><text x="113" y="28">5</text>
        <text x="183" y="40">7</text>
        <text x="253" y="76">0</text>
      </svg>
      <div class="fig-keys">
        <span class="fig-keyset" data-term="digits">{#each ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as k}<kbd>{k}</kbd>{/each}</span>
        <span class="fig-keyset" data-term="arrows"><kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd></span>
      </div>
    </div>
  {/if}

  {#each step.body as line}
    <p>{#each segments(line) as part}{#if part.term}<button type="button" class="tour-term" class:named={terms[part.term] !== undefined}
        onpointerenter={() => show(part.term!)} onpointerleave={() => show(null)}
        onfocus={() => show(part.term!)} onblur={() => show(null)} onclick={() => show(part.term!)}>{part.text}</button>{:else if part.bold}<strong>{part.text}</strong>{:else}{part.text}{/if}{/each}</p>
  {/each}
  <div class="tour-actions">
    {#if !last}<button class="tour-skip" type="button" onclick={finish}>{labels.skip}</button>{/if}
    {#if index > 0}<button type="button" onclick={() => index--}>{labels.back}</button>{/if}
    <button class="tour-next" type="button" bind:this={next} onclick={() => (last ? finish() : index++)}>{last ? labels.done : labels.next}</button>
  </div>
</div>

<style>
  .tour-shade{position:fixed;inset:0;z-index:70;background:#030303d9;animation:tour-in .25s ease-out}
  .tour-card{position:fixed;left:0;top:0;z-index:72;width:min(430px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;padding:20px 24px 18px;border:1px solid #6d5a72;border-radius:10px;background:#1d1a1f;color:var(--ink);opacity:0;transition:transform .3s ease-out}
  .tour-card.wide{width:min(470px,calc(100vw - 32px))}
  .tour-card.placed{opacity:1}
  .tour-progress{display:flex;gap:4px;margin-bottom:14px}
  .tour-progress i{flex:1;height:2px;border-radius:1px;background:#3d3540}
  .tour-progress i.done{background:#cdb6d4}
  .tour-count{font:9px var(--mono);letter-spacing:1.6px;color:#a99cae}
  h2{font:500 19px var(--body);margin:6px 0 12px}
  p{font:13.5px/1.6 var(--body);color:#d6ced9;margin:0 0 10px}
  strong{font-weight:600;color:#f3e9f6}
  .tour-term{all:unset;font-weight:600;color:#f3e9f6;cursor:default}
  .tour-term.named{cursor:help;border-bottom:1px dashed #b89cc2}
  .tour-term.named:hover,.tour-term.named:focus-visible{color:#fff;border-bottom-style:solid;border-bottom-color:#e6c7f0}
  .tour-term:focus-visible{outline:1px solid #e6c7f0;outline-offset:2px;border-radius:2px}
  .tour-ring{position:fixed;left:0;top:0;z-index:74;box-sizing:border-box;border:2px solid #e6c7f0;border-radius:8px;pointer-events:none}
  .tour-ring::after{content:'';position:absolute;inset:-2px;border:2px solid #e6c7f0;border-radius:inherit;animation:tour-pulse 1.2s ease-out infinite}
  .tour-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:16px}
  button:not(.tour-term){font:12px var(--body);color:#ddd;background:#303030;border:1px solid #4b4b4b;border-radius:4px;min-height:34px;padding:6px 14px;cursor:pointer}
  button:not(.tour-term):hover{background:#414141}
  .tour-skip{margin-right:auto;background:none!important;border-color:transparent!important;color:#a99cae!important;padding-left:0!important}
  .tour-skip:hover{color:#e6dcea!important}
  .tour-next{background:#dedbd5!important;color:#222!important;border-color:#dedbd5!important}
  .tour-next:hover{background:#fff!important}

  .tour-figure{margin:0 0 14px;padding:12px;border:1px solid #3a3340;border-radius:8px;background:#141216}
  .fig-track{display:grid;grid-template-columns:1fr auto auto 70px;align-items:center;gap:6px;padding:6px 4px;font:12px var(--body);color:#ddd}
  .fig-track+.fig-track{border-top:1px solid #29242c}
  .fig-track.muted .fig-name{opacity:.45;text-decoration:line-through}
  .fig-name b{font:10px var(--mono);color:#9e9e9e;margin-right:6px;font-weight:400}
  .fig-btn{padding:3px 8px;border:1px solid #4b4b4b;border-radius:4px;font-size:11px;color:#bbb}
  .fig-btn.on{background:#dedbd5;border-color:#dedbd5;color:#222}
  .fig-level{height:4px;border-radius:2px;background:#3a3a3a;overflow:hidden}
  .fig-level i{display:block;height:100%;background:#bdb7ae;transform-origin:left}
  .fig-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
  .fig-chips span{padding:4px 9px;border:1px solid #4b4b4b;border-radius:4px;font:11px var(--mono);color:#ddd;background:#242026}
  .fig-tab{display:block;width:100%;height:auto;background:#faf8f3;border-radius:4px}
  .fig-tab line{stroke:#9a958c;stroke-width:1}
  .fig-tab line.bar{stroke:#333;stroke-width:1.5}
  .fig-tab text{font:600 11px var(--mono);fill:#171717;text-anchor:middle;stroke:#faf8f3;stroke-width:4px;paint-order:stroke}
  .fig-cursor{fill:#a373201f;stroke:#a37320;stroke-width:1.5;transform-box:view-box;animation:fig-cursor 4.8s steps(1) infinite}
  .fig-keys{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
  .fig-keyset{display:flex;gap:3px;flex-wrap:wrap}
  kbd{display:inline-grid;place-items:center;min-width:20px;height:22px;padding:0 3px;box-sizing:border-box;border:1px solid #5a525e;border-bottom-width:2px;border-radius:4px;background:#2a252d;font:11px var(--mono);color:#eee}
  :global(.tour-lit){outline:1px solid #cdb6d466;outline-offset:6px}
  @keyframes tour-in{from{opacity:0}to{opacity:1}}
  @keyframes tour-pulse{from{opacity:.8;transform:scale(1)}to{opacity:0;transform:scale(1.12)}}
  @keyframes fig-cursor{0%{transform:translateX(0)}25%{transform:translateX(70px)}50%{transform:translateX(140px)}75%{transform:translateX(210px)}}
</style>
