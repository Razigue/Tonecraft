<script lang="ts">
  interface Props {
    value: string;
    active: boolean;
    volume: number;
    tapCount: number;
    onvalue: (value: string) => void;
    onvolume: (value: number) => void;
    ontap: () => void;
    onclose: () => void;
    element?: HTMLDialogElement | null;
  }

  let {
    value, active, volume, tapCount, onvalue, onvolume, ontap, onclose,
    element = $bindable(null),
  }: Props = $props();
</script>

<dialog
  class="metronome"
  data-playing={active}
  bind:this={element}
  aria-label="Metronome"
  oncancel={(event) => { event.preventDefault(); element?.close(); }}
  onclose={onclose}
>
  <button class="close" type="button" aria-label="Close metronome" onclick={() => element?.close()}>
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" /></svg>
  </button>

  <label class="tempo">
    <span>BPM</span>
    <input
      type="number"
      min="30"
      max="300"
      step="1"
      inputmode="numeric"
      placeholder="120"
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
  .metronome {
    width: min(440px, calc(100vw - 40px));
    margin: auto;
    padding: 62px 42px 34px;
    box-sizing: border-box;
    border: 1px solid #403a43;
    border-radius: 10px;
    color: var(--ink);
    background: #111013;
    box-shadow: 0 24px 70px #000c;
  }
  .metronome[open] {
    display: grid;
    gap: 30px;
    animation: metronome-in 200ms cubic-bezier(0.2, 0, 0, 1);
  }
  .metronome::backdrop { background: #000c; }
  .close {
    position: absolute;
    top: 14px;
    right: 14px;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: #c8c2ca;
    cursor: pointer;
  }
  .close svg { display: block; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
  .close:hover { background: #1d1a20; color: #fff; }
  .close:focus-visible, .tap:focus-visible, input:focus-visible { outline: 2px solid var(--iris); outline-offset: 3px; }
  .tempo { display: grid; justify-items: center; gap: 8px; }
  .tempo > span, .volume > span { font: 9px var(--mono); letter-spacing: 1.8px; color: #817985; }
  .tempo input {
    width: 4ch;
    padding: 0 0 7px;
    border: 0;
    border-bottom: 1px solid #625767;
    background: transparent;
    color: #dfcae3;
    font: 300 58px/1 var(--display);
    text-align: center;
    appearance: textfield;
  }
  .tempo input::-webkit-inner-spin-button, .tempo input::-webkit-outer-spin-button { appearance: none; }
  .tempo input::placeholder { color: #3d3740; }
  .tap-zone { display: grid; justify-items: center; gap: 12px; }
  .tap {
    width: 128px;
    min-height: 50px;
    border: 1px solid #6a5c6e;
    border-radius: 4px;
    background: #18151a;
    color: #d8c5dc;
    font: 12px var(--mono);
    letter-spacing: 3px;
    cursor: pointer;
  }
  .tap:hover { background: #201c23; border-color: #9a82a0; }
  .tap:active { background: #29222c; }
  .tap-count { display: grid; grid-template-columns: repeat(4, 6px); gap: 9px; }
  .tap-count span { width: 6px; height: 6px; border: 1px solid #554d58; border-radius: 50%; box-sizing: border-box; }
  .tap-count span.filled { background: #a58baa; border-color: #a58baa; }
  .tap-count span.fourth { border-color: #8f7894; }
  .tap-count span.fourth.filled { background: #d9bfdd; }
  .volume { display: grid; grid-template-columns: auto 1fr 4ch; align-items: center; gap: 14px; }
  .volume input {
    width: 100%;
    height: 20px;
    margin: 0;
    appearance: none;
    background: linear-gradient(to right, #a28aa8 var(--volume), #373139 var(--volume));
    background-size: 100% 1px;
    background-position: center;
    background-repeat: no-repeat;
    cursor: pointer;
  }
  .volume input::-webkit-slider-thumb { width: 12px; height: 12px; appearance: none; border: 1px solid #d7c2db; border-radius: 50%; background: #171419; }
  .volume input::-moz-range-thumb { width: 12px; height: 12px; border: 1px solid #d7c2db; border-radius: 50%; background: #171419; }
  .volume output { font: 11px var(--mono); color: #928797; text-align: right; }
  @keyframes metronome-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 520px) {
    .metronome { width: calc(100vw - 28px); padding: 58px 24px 30px; }
    .close { top: 10px; right: 10px; }
  }
  @media (prefers-reduced-motion: reduce) { .metronome[open] { animation: none; } }
</style>
