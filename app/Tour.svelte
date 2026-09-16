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
    /** Something to do on the page; Next waits until `done`. */
    readonly task?: string;
    readonly done?: boolean;
  }
</script>

<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';

  let { steps, terms, labels, onclose }: {
    steps: readonly TourStep[];
    /** Term → selector of what it names, on the page or in the card's drawing. */
    terms: Readonly<Record<string, string>>;
    labels: { readonly skip: string; readonly back: string; readonly next: string; readonly done: string; readonly collapse: string; readonly expand: string };
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
  /**
   * Where a card beside the window does not fit, the card is a sheet at the
   * foot of the screen and the window is read above it. On a phone the card
   * beside the window was the whole screen: it hid what it explained, and its
   * buttons scrolled out of reach.
   */
  const SHEET = '(max-width: 640px), (max-height: 520px)';
  /** Far enough, and more sideways than down, to be a swipe rather than a scroll. */
  const SWIPE_PX = 60;
  let sheet = $state(false);
  /** A sheet folded to its title and buttons, so the window above can be used. */
  let collapsed = $state(false);
  let index = $state(0);
  let card = $state<HTMLDivElement | null>(null);
  let next = $state<HTMLButtonElement | null>(null);
  let place = $state<{ x: number; y: number } | null>(null);
  let term = $state<string | null>(null);
  let rings = $state<{ x: number; y: number; w: number; h: number }[]>([]);
  let lit: { el: HTMLElement; position: string; zIndex: string; translate: string; fixed: boolean }[] = [];
  let frame = 0;
  const step = $derived(steps[index]!);
  const last = $derived(index === steps.length - 1);
  const blocked = $derived(step.task !== undefined && !step.done);

  function go(to: number): void {
    if (to < 0 || to >= steps.length || (to > index && blocked)) return;
    index = to;
  }

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
    for (const { el, position, zIndex, translate } of lit) {
      el.style.position = position;
      el.style.zIndex = zIndex;
      el.style.translate = translate;
      el.classList.remove('tour-lit');
    }
    lit = [];
  }

  /**
   * A window near the end of the page cannot scroll above a sheet: the page
   * is lengthened by the sheet's height while there is one.
   */
  const bodyPadding = document.body.style.paddingBottom;
  function pad(): void {
    const h = sheet && card ? card.offsetHeight : 0;
    document.body.style.paddingBottom = h > 0 ? `${h}px` : bodyPadding;
    // A window fixed to the foot of the screen cannot scroll out from under
    // the sheet: it is lifted above it while it is explained.
    for (const l of lit) if (l.fixed) l.el.style.translate = h > 0 ? `0 ${-h}px` : l.translate;
  }

  function light(targets: readonly string[]): void {
    pad();
    release();
    for (const selector of targets) {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) continue;
      const computed = getComputedStyle(el).position;
      lit.push({ el, position: el.style.position, zIndex: el.style.zIndex, translate: el.style.translate, fixed: computed === 'fixed' });
      if (computed === 'static') el.style.position = 'relative';
      el.style.zIndex = LIFT;
      el.classList.add('tour-lit');
    }
    pad();
    const first = lit[0]?.el;
    if (!first || getComputedStyle(first).position === 'fixed') return;
    if (sheet) {
      // Read from its top, above the sheet.
      scrollTo({ top: scrollY + first.getBoundingClientRect().top - GAP, behavior: 'smooth' });
      return;
    }
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
      // The sheet is laid out by CSS; it only has to be shown.
      pad();
      if (sheet) { place = { x: 0, y: 0 }; return; }
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

  /**
   * A tap is not a hover: the ring stays until another term is tapped or the
   * step changes. Above a sheet, what the term names is brought into the part
   * of the screen the sheet leaves free.
   */
  function tapTerm(key: string): void {
    show(key);
    if (!sheet || !card) return;
    const selector = terms[key];
    const el = selector ? document.querySelector<HTMLElement>(selector) : null;
    if (!el || el.closest('.tour-card')) return;
    const r = el.getBoundingClientRect(), free = card.getBoundingClientRect().top;
    if (r.top >= GAP && r.bottom <= free - GAP) return;
    scrollTo({ top: scrollY + r.top - Math.max(GAP, (free - r.height) / 2), behavior: 'smooth' });
  }

  let swipe: { id: number; x: number; y: number } | null = null;
  function swipeStart(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }
  function swipeEnd(e: PointerEvent): void {
    if (swipe?.id !== e.pointerId) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    go(dx < 0 ? index + 1 : index - 1);
  }

  /** Using the window above a sheet folds the sheet out of its way. */
  function pageDown(e: PointerEvent): void {
    if (!sheet || collapsed || !(e.target instanceof Element) || e.target.closest('.tour-card')) return;
    if (lit.some(l => l.el.contains(e.target as Node))) { collapsed = true; void tick().then(position); }
  }

  function toggleSheet(): void {
    collapsed = !collapsed;
    void tick().then(position);
  }

  function finish(): void {
    release();
    onclose();
  }

  $effect(() => {
    const query = matchMedia(SHEET);
    const update = () => { sheet = query.matches; position(); };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  });

  /**
   * Only a new step lights and scrolls. The steps are rebuilt when a task is
   * done, and that must not pull the page away from where it was just done.
   */
  const targetKey = $derived(`${index}\n${step.targets.join('\n')}`);
  $effect(() => {
    void targetKey;
    const targets = untrack(() => step.targets);
    term = null;
    rings = [];
    // A step with something to do starts folded, the page it is done on in view.
    collapsed = sheet && untrack(() => blocked);
    void tick().then(() => {
      light(targets);
      position();
      next?.focus({ preventScroll: true });
    });
  });

  onDestroy(() => { cancelAnimationFrame(frame); release(); document.body.style.paddingBottom = bodyPadding; });
</script>

<svelte:window onscroll={position} onresize={position} onpointerdown={pageDown}
  onkeydown={e => { if (e.key === 'Escape') { e.preventDefault(); finish(); } }} />

<div class="tour-shade" aria-hidden="true"></div>
{#each rings as r}
  <span class="tour-ring" aria-hidden="true" style:width={`${r.w}px`} style:height={`${r.h}px`} style:transform={`translate(${r.x}px, ${r.y}px)`}></span>
{/each}
<div class="tour-card" class:placed={place !== null} class:wide={step.figure !== undefined} class:sheet class:collapsed role="dialog" tabindex="-1" aria-labelledby="tour-title" bind:this={card}
  style:transform={place && !sheet ? `translate(${place.x}px, ${place.y}px)` : undefined}
  onpointerdown={swipeStart} onpointerup={swipeEnd} onpointercancel={() => (swipe = null)}>
  <div class="tour-head">
    {#if sheet}<button type="button" class="tour-grip" aria-expanded={!collapsed} aria-label={collapsed ? labels.expand : labels.collapse} onclick={toggleSheet}><span></span></button>{/if}
    <div class="tour-progress" aria-hidden="true">{#each steps as _, i}<i class:done={i <= index}></i>{/each}</div>
    <span class="tour-count">{index + 1} / {steps.length}</span>
    <h2 id="tour-title">{step.title}</h2>
  </div>

  {#if !collapsed}
  <div class="tour-body">
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
        onpointerenter={e => { if (e.pointerType === 'mouse') show(part.term!); }} onpointerleave={e => { if (e.pointerType === 'mouse') show(null); }}
        onfocus={() => show(part.term!)} onclick={() => tapTerm(part.term!)}>{part.text}</button>{:else if part.bold}<strong>{part.text}</strong>{:else}{part.text}{/if}{/each}</p>
  {/each}
  </div>
  {/if}
  {#if step.task}
    <p class="tour-task" class:done={step.done} role="status"><span aria-hidden="true">{step.done ? '✓' : '→'}</span> {#each segments(step.task) as part}{#if part.bold}<strong>{part.text}</strong>{:else}{part.text}{/if}{/each}</p>
  {/if}
  <div class="tour-actions">
    {#if !last}<button class="tour-skip" type="button" onclick={finish}>{labels.skip}</button>{/if}
    {#if index > 0}<button type="button" onclick={() => go(index - 1)}>{labels.back}</button>{/if}
    <button class="tour-next" type="button" bind:this={next} disabled={blocked} onclick={() => (last ? finish() : go(index + 1))}>{last ? labels.done : labels.next}</button>
  </div>
</div>

<style>
  .tour-shade{position:fixed;inset:0;z-index:70;background:#030303d9;animation:tour-in .25s ease-out}
  .tour-card{position:fixed;left:0;top:0;z-index:72;display:flex;flex-direction:column;width:min(430px,calc(100vw - 32px));max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow:hidden;box-sizing:border-box;padding:20px 24px 18px;touch-action:pan-y;border:1px solid #6d5a72;border-radius:10px;background:#1d1a1f;color:var(--ink);opacity:0;transition:transform .3s ease-out}
  .tour-card.wide{width:min(470px,calc(100vw - 32px))}
  .tour-card.placed{opacity:1}
  .tour-head,.tour-task,.tour-actions{flex:none}
  .tour-body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}
  /* The sheet: the full width of the foot of the screen, its buttons always in reach. */
  .tour-card.sheet{top:auto;bottom:0;width:100%;max-height:min(58vh,100vh - 96px);max-height:min(58dvh,100dvh - 96px);padding:0 16px calc(12px + env(safe-area-inset-bottom));border-width:1px 0 0;border-radius:14px 14px 0 0;transition:none}
  .sheet .tour-head{padding-top:4px}
  .sheet h2{font-size:17px;margin:4px 0 8px}
  .sheet.collapsed h2{margin-bottom:0}
  .sheet .tour-body p{font-size:14px}
  .sheet .tour-task{margin-top:8px}
  .sheet .tour-actions{margin-top:10px}
  .tour-grip{display:grid;place-items:center;width:100%;min-height:28px!important;padding:0!important;border:0!important;background:none!important}
  .tour-grip span{width:40px;height:4px;border-radius:2px;background:#6d5a72}
  .sheet .tour-progress{margin-bottom:8px}
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
  .tour-next:disabled{opacity:.4;cursor:default}
  @media (pointer: coarse){
    button:not(.tour-term):not(.tour-grip){min-height:44px;padding:8px 16px;font-size:14px}
    .tour-term.named{padding:2px 0}
    /* No keyboard to point at: the neck is how a note is written here. */
    .fig-keys{display:none}
  }
  .tour-task{margin:14px 0 0;padding:10px 12px;border:1px solid #6d5a72;border-radius:6px;background:#27212a;color:#f3e9f6}
  .tour-task.done{border-color:#5fa39c;background:#1c2626}

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
