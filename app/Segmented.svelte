<script lang="ts">
  /**
   * A segmented selector (UX-DR6).
   *
   * No rounded pills and no filled background — the selected segment gets a 2px
   * underline in `--ink`. DESIGN.md is blunt about why: filled backgrounds
   * fight the calm, and the calm is what the whole design is for.
   */
  interface Option {
    value: string;
    label: string;
  }

  interface Props {
    label: string;
    options: readonly Option[];
    value: string;
    onchange: (value: string) => void;
  }

  const { label, options, value, onchange }: Props = $props();
</script>

<div class="segmented" role="radiogroup" aria-label={label}>
  {#each options as option (option.value)}
    <button
      type="button"
      role="radio"
      aria-checked={value === option.value}
      class:selected={value === option.value}
      onclick={() => onchange(option.value)}
    >
      {option.label}
    </button>
  {/each}
</div>

<style>
  .segmented {
    display: flex;
    gap: var(--u);
  }

  button {
    font-family: var(--body);
    font-size: 13px;
    /* 40px of target around 13px of text (UX-DR14). */
    min-height: 40px;
    padding: 0 calc(var(--u) * 0.5);
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--graphite);
    cursor: pointer;
  }

  button:hover { color: var(--ink); }
  button.selected { color: var(--ink); border-bottom-color: var(--ink); }
  button:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }
</style>
