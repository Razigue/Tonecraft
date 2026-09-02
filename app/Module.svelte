<script lang="ts">
  /**
   * One block of the signal chain (UX-DR5).
   *
   * `--bone` on `--chalk`, one elevation, 2px radius. The name in the display
   * face at the top left, the bypass at the top right. A bypassed module drops
   * to 40% opacity — the hierarchy comes from spacing and weight, never from a
   * border or a frame.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    name: string;
    bypassed?: boolean;
    onbypass?: (bypassed: boolean) => void;
    children: Snippet;
  }

  const { name, bypassed = false, onbypass, children }: Props = $props();
</script>

<section class="module" class:bypassed>
  <header>
    <h2 class="t-module">{name}</h2>
    {#if onbypass}
      <button
        type="button"
        class="bypass"
        aria-label="Bypass {name}"
        aria-pressed={bypassed}
        onclick={() => onbypass(!bypassed)}
      >
        <span class="dot"></span>
      </button>
    {/if}
  </header>

  <div class="controls">
    {@render children()}
  </div>
</section>

<style>
  .module {
    background: var(--bone);
    border-radius: var(--radius);
    box-shadow: var(--lift);
    padding: calc(var(--u) * 2);
    display: flex;
    flex-direction: column;
    gap: calc(var(--u) * 2);
    transition: opacity 200ms cubic-bezier(0.2, 0, 0, 1);
  }

  .bypassed { opacity: 0.4; }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: calc(var(--u) * 2);
  }

  h2 {
    margin: 0;
    color: var(--ink);
    font-weight: 400;
  }

  /* 40px of hit area around a 10px dot: the target is the rule, not the ink. */
  .bypass {
    width: 40px;
    height: 40px;
    margin: -14px;
    display: grid;
    place-items: center;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }

  .bypass:focus-visible {
    outline: 2px solid var(--iris);
    outline-offset: 2px;
    border-radius: var(--radius);
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1px solid var(--graphite);
    background: var(--celadon);
  }

  .bypass[aria-pressed='true'] .dot { background: transparent; }

  .controls {
    display: flex;
    gap: calc(var(--u) * 2);
    align-items: flex-start;
  }
</style>
