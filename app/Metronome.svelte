<script lang="ts">
  interface Props {
    value: string;
    active: boolean;
    volume: number;
    tapCount: number;
    /** Whether the tab reader starts its bars on the click and plays at this tempo. */
    sync: boolean;
    onvalue: (value: string) => void;
    onvolume: (value: number) => void;
    ontap: () => void;
    onsync: () => void;
    onclose: () => void;
    element?: HTMLDialogElement | null;
  }

  let {
    value, active, volume, tapCount, sync, onvalue, onvolume, ontap, onsync, onclose,
    element = $bindable(null),
  }: Props = $props();
</script>

<dialog
  class="tc-dialog metronome"
  data-playing={active}
  bind:this={element}
  aria-label="Metronome"
  oncancel={(event) => { event.preventDefault(); element?.close(); }}
  onclose={onclose}
>
  <button class="tc-close" type="button" aria-label="Close metronome" onclick={() => element?.close()}>
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" /></svg>
  </button>

  <label class="tempo">
    <span>BPM</span>
    <input
      type="number"
      min="30"
      max="450"
      step="1"
      inputmode="numeric"
      aria-label="Tempo in BPM"
      {value}
      oninput={(event) => onvalue(event.currentTarget.value)}
    />
  </label>

  <div class="tap-zone">
    <button class="tap" type="button" onclick={ontap}>TAP</button>
    <div class="tap-count" aria-label={`${tapCount} of 4 taps`}>
      {#each [0, 1, 2, 3] as beat}
        <span class:filled={beat < tapCount} class:fourth={beat === 3}></span>
      {/each}
    </div>
  </div>

  <button
    class="sync"
    type="button"
    aria-pressed={sync}
    title="Tab bars start on the first beat, at this tempo"
    onclick={onsync}
  ><span class="sync-dot" aria-hidden="true"></span>SYNC TAB</button>

  <label class="volume">
    <span>VOLUME</span>
    <input
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={volume}
      style={`--volume:${volume * 100}%`}
      aria-label="Metronome volume"
      oninput={(event) => onvolume(Number(event.currentTarget.value))}
    />
    <output>{Math.round(volume * 100)}%</output>
  </label>
</dialog>

<style>
  .metronome { width: min(440px, calc(100vw - 40px)); }
  .metronome[open] { display: grid; gap: 30px; }
  .tap:focus-visible, input:focus-visible, .sync:focus-visible { outline: 2px solid var(--iris); outline-offset: 3px; }
  .tempo { display: grid; justify-items: center; gap: 8px; }
  .tempo > span, .volume > span {
    font: 400 10px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.24em;
    color: var(--text-3);
  }
  /* The same face, weight and colour as the tuner's note: one large readout. */
  .tempo input {
    width: 4ch;
    padding: 0 0 7px;
    border: 0;
    border-bottom: 1px solid var(--violet-700);
    background: transparent;
    color: var(--accent);
    font: 300 64px/1 var(--display);
    font-variant-numeric: tabular-nums;
    text-align: center;
    appearance: textfield;
  }
  .tempo input::-webkit-inner-spin-button, .tempo input::-webkit-outer-spin-button { appearance: none; }
  .tap-zone { display: grid; justify-items: center; gap: 12px; }
  .tap {
    width: 128px;
    min-height: 50px;
    border: 1px solid var(--accent-line);
    border-radius: var(--radius);
    background: var(--violet-900);
    color: var(--violet-100);
    font: 400 12px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.3em;
    cursor: pointer;
  }
  .tap:hover { background: var(--violet-800); border-color: var(--violet-400); }
  .tap:active { background: var(--violet-700); }
  .tap-count { display: grid; grid-template-columns: repeat(4, 6px); gap: 9px; }
  .tap-count span { width: 6px; height: 6px; border: 1px solid var(--violet-700); border-radius: 50%; box-sizing: border-box; }
  .tap-count span.filled { background: var(--violet-400); border-color: var(--violet-400); }
  .tap-count span.fourth { border-color: var(--violet-500); }
  .tap-count span.fourth.filled { background: var(--accent); }
  .sync {
    justify-self: center;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 0 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: transparent;
    color: var(--text-2);
    font: 400 10px/1 var(--display);
    font-stretch: 125%;
    letter-spacing: 0.2em;
    cursor: pointer;
  }
  .sync:hover { border-color: var(--line-strong); color: var(--text); }
  .sync[aria-pressed='true'] { border-color: var(--accent-line); color: var(--violet-100); }
  .sync-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--violet-800); }
  .sync[aria-pressed='true'] .sync-dot { background: var(--accent); }
  .volume { display: grid; grid-template-columns: auto 1fr 4ch; align-items: center; gap: 14px; }
  .volume input {
    width: 100%;
    height: 20px;
    margin: 0;
    appearance: none;
    background: linear-gradient(to right, var(--violet-400) var(--volume), var(--violet-800) var(--volume));
    background-size: 100% 1px;
    background-position: center;
    background-repeat: no-repeat;
    cursor: pointer;
  }
  .volume input::-webkit-slider-thumb { width: 12px; height: 12px; appearance: none; border: 1px solid var(--violet-200); border-radius: 50%; background: var(--surface-1); }
  .volume input::-moz-range-thumb { width: 12px; height: 12px; border: 1px solid var(--violet-200); border-radius: 50%; background: var(--surface-1); }
  .volume output { font: 11px var(--mono); color: var(--text-2); text-align: right; }
</style>
