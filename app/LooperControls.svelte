<script lang="ts">
  // The looper. It records what leaves the rig, so a part stays as it was
  // played while the capture, the preset and the boost move on under it. One
  // button does rec, stop and overdub, as a pedal does, because both hands are
  // on the guitar; the other one is power. Its level is in the transport's
  // Levels popover.
  import type { LoopMeters } from '../engine/engine.ts';
  import { lang } from './locale.svelte.ts';

  let { loop, running, onpress, onpower }: {
    /** What the chain says the looper is doing (dsp/looper.h). */
    loop: LoopMeters;
    running: boolean;
    onpress: () => void;
    onpower: () => void;
  } = $props();

  const t = $derived(lang.ui);
  const action = $derived(t.rig.loopAction[loop.state]);
  const on = $derived(loop.state !== 'empty');
</script>

<div class="tc-group looper" role="group" aria-label={t.rig.looper}>
  <span class="tc-group-label">{t.rig.looper}<span class="loop-status" data-state={loop.state}><span class="loop-dot"></span>{t.rig.loopStatus[loop.state]}</span></span>
  <div class="tc-row">
    <button class="tc-button loop-main" type="button" data-state={loop.state} disabled={!running}
      title={running ? `${action} (L)` : t.rig.loopNeedsEngine} onclick={onpress}>{action}</button>
    <button class="tc-button icon loop-power" type="button" aria-label={t.rig.looperOff} title={t.rig.looperOffTitle}
      aria-pressed={on} disabled={!running || !on} onclick={onpower}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 1.8v5.6M4.4 4a5 5 0 1 0 7.2 0" /></svg>
    </button>
  </div>
</div>

<style>
  .loop-status { display: flex; align-items: center; gap: 6px; font: 500 11px/1 var(--body); letter-spacing: 0; text-transform: none; color: var(--text-2); }
  .loop-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--violet-800); }
  .loop-status[data-state=recording] .loop-dot, .loop-status[data-state=overdubbing] .loop-dot { background: var(--ember); }
  .loop-status[data-state=playing] .loop-dot { background: var(--accent); }
  .loop-main { min-width: 84px; }
  .loop-main[data-state=recording], .loop-main[data-state=overdubbing] { border-color: var(--ember-line); color: #f0d5cf; }
</style>
