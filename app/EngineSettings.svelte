<script lang="ts">
  /**
   * Where the chain runs: this tab, or Tonecraft Engine.
   *
   * A browser cannot open an ASIO driver, so on Windows the smallest buffers an
   * interface offers are out of a tab's reach. Tonecraft Engine is the small
   * native program that reaches them: an icon by the clock and nothing else.
   * It runs the same chain this page runs, and everything is set from here —
   * the interface, the buffer, the headphone level. The engine keeps those
   * settings itself, on the player's machine, so they survive a new tab.
   *
   * If it is not running, the sheet says where to get it and notices by itself
   * the moment it starts. Nothing about the tone changes with the choice.
   */
  import Segmented from './Segmented.svelte';
  import {
    NativeLink, detectPlatform, browserBlocksLoopback, downloadUrl, releasesUrl,
    type NativeConfig, type NativeDevice, type NativeInfo, type NativeOpened,
  } from '../engine/native-host.ts';
  import type { Backend } from '../engine/engine.ts';

  interface Props {
    backend: Backend;
    opened: NativeOpened | null;
    onbackend: (backend: Backend) => void;
  }

  const { backend, opened, onbackend }: Props = $props();

  const platform = detectPlatform();
  const blocked = browserBlocksLoopback();
  const OPTIONS = [
    { value: 'browser', label: 'Browser' },
    { value: 'native', label: platform === 'windows' ? 'ASIO' : 'Native' },
  ] as const;
  const SYSTEM = { windows: 'Windows', macos: 'macOS', linux: 'Linux' } as const;
  const DRIVER = { windows: 'your interface’s ASIO driver', macos: 'CoreAudio', linux: 'ALSA' } as const;

  /** Buffer sizes worth offering, inside what the device accepts. */
  const SIZES = [16, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 2048];

  const link = NativeLink.shared;
  let info = $state<NativeInfo | null>(link.info);
  let config = $state<NativeConfig | null>(link.config);
  let status = $state<'checking' | 'connected' | 'missing'>(link.connected ? 'connected' : 'checking');
  let devices = $state<{ inputs: readonly NativeDevice[]; outputs: readonly NativeDevice[] } | null>(null);
  let devicesFor = '';

  const host = $derived(config?.host ?? info?.hosts[0]?.id ?? null);

  async function probe(): Promise<void> {
    const found = await link.connect();
    info = found;
    config = link.config;
    status = found === null ? 'missing' : 'connected';
    const h = config?.host ?? found?.hosts[0]?.id;
    if (found !== null && h !== undefined) await loadDevices(h);
  }

  async function loadDevices(h: string): Promise<void> {
    if (devicesFor === h && devices !== null) return;
    devicesFor = h;
    devices = null;
    try {
      const found = await link.devices(h);
      devices = { inputs: found.inputs, outputs: found.outputs };
    } catch {
      devices = { inputs: [], outputs: [] };
    }
  }

  /* While the native engine is the choice and has not been found, look again
     every two seconds: the player is off downloading it, and the sheet should
     notice without being asked. */
  $effect(() => {
    if (backend !== 'native' || blocked) return;
    void probe();
    const timer = self.setInterval(() => { if (status !== 'connected') void probe(); }, 2000);
    const offClose = link.onClose(() => {
      status = 'missing';
      info = null;
      devices = null;
      devicesFor = '';
    });
    const offConfig = link.onConfig((c) => { config = c; });
    return () => { self.clearInterval(timer); offClose(); offConfig(); };
  });

  const isAsio = $derived(host === 'asio');
  const input = $derived(devices?.inputs.find((d) => d.id === config?.input) ?? devices?.inputs[0] ?? null);
  const output = $derived(devices?.outputs.find((d) => d.id === config?.output) ?? devices?.outputs[0] ?? null);
  const rate = $derived(config?.sampleRate ?? input?.defaultRate ?? output?.defaultRate ?? 48_000);
  const range = $derived(input?.bufferSizes ?? output?.bufferSizes ?? null);
  const sizes = $derived(range === null ? [] : [...new Set([range.min, ...SIZES.filter((n) => n > range.min && n <= range.max)])]);
  const rates = $derived(input?.sampleRates ?? output?.sampleRates ?? []);
  const monitor = $derived(config?.monitor ?? 1);
  const ms = (frames: number): string => ((frames / rate) * 1000).toFixed(1);
  /** Channel pairs a device offers: 1–2, 3–4, … or the one channel a mono device has. */
  const pairs = (channels: number): number[] =>
    channels <= 1 ? [0] : Array.from({ length: Math.floor(channels / 2) }, (_, i) => i * 2);
  const pairLabel = (first: number, channels: number): string =>
    channels <= 1 ? '1' : `${first + 1} – ${first + 2}`;
  const pairOf = (first: number, channels: number): number[] =>
    [first, channels > first + 1 ? first + 1 : first];

  /* The engine saves it, reopens the interface if a device changed, and pushes
     the result back — to this sheet and to any other tab. */
  function set(patch: Partial<NativeConfig>): void {
    if (config !== null) config = { ...config, ...patch };
    link.configure(patch);
  }

  function chooseHost(h: string): void {
    set({ host: h, input: null, output: null, sampleRate: null, bufferSize: null, inputChannels: null, outputChannels: null });
    void loadDevices(h);
  }

  /* An ASIO driver is one device in both directions: one choice, not two. */
  function chooseInterface(id: string): void {
    set({ input: id, output: id, sampleRate: null, bufferSize: null, inputChannels: null, outputChannels: null });
  }
</script>

{#if platform !== 'mobile'}
  <div class="engine">
    <Segmented label="Audio engine" options={OPTIONS} value={backend} onchange={(v) => onbackend(v as Backend)} />

    {#if backend === 'browser'}
      {#if platform === 'windows'}
        <p class="t-small note">An interface with an ASIO driver plays with less delay through ASIO: choose it above.</p>
      {/if}
    {:else if blocked}
      <p class="failure"><span>Safari cannot reach Tonecraft Engine.</span><span class="fix">Use Chrome, Edge or Firefox for ASIO.</span></p>
    {:else if status === 'connected' && info !== null}
      <p class="t-small note">Tonecraft Engine {info.version} is running: the sound leaves through it.</p>

      {#if info.hosts.length > 1}
        <label class="field"><span class="t-small">Driver</span>
          <select value={host ?? ''} onchange={(e) => chooseHost(e.currentTarget.value)}>
            {#each info.hosts as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
          </select>
        </label>
      {/if}

      {#if devices === null}
        <p class="t-small note">Reading devices…</p>
      {:else if devices.inputs.length === 0 && devices.outputs.length === 0}
        <p class="failure"><span>No device answers on this driver.</span><span class="fix">Connect the interface, or choose another driver.</span></p>
      {:else}
        {#if isAsio}
          <label class="field"><span class="t-small">Interface</span>
            <select value={input?.id ?? ''} onchange={(e) => chooseInterface(e.currentTarget.value)}>
              {#each devices.inputs as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
            </select>
          </label>
        {:else}
          <label class="field"><span class="t-small">Input device</span>
            <select value={input?.id ?? ''} onchange={(e) => set({ input: e.currentTarget.value, inputChannels: null })}>
              {#each devices.inputs as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
            </select>
          </label>
          <label class="field"><span class="t-small">Output device</span>
            <select value={output?.id ?? ''} onchange={(e) => set({ output: e.currentTarget.value, outputChannels: null })}>
              {#each devices.outputs as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
            </select>
          </label>
        {/if}

        {#if sizes.length > 0}
          <!-- The smallest by default: the lowest delay the device offers. A
               larger one is the player's call, when the sound crackles. -->
          <label class="field"><span class="t-small">Buffer</span>
            <select value={config?.bufferSize == null ? '' : String(config.bufferSize)}
                    onchange={(e) => set({ bufferSize: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })}>
              <option value="">Smallest — {sizes[0]} frames, {ms(sizes[0]!)} ms</option>
              {#each sizes as n (n)}<option value={String(n)}>{n} frames — {ms(n)} ms</option>{/each}
            </select>
          </label>
        {/if}

        {#if rates.length > 1}
          <label class="field"><span class="t-small">Sample rate</span>
            <select value={config?.sampleRate == null ? '' : String(config.sampleRate)}
                    onchange={(e) => set({ sampleRate: e.currentTarget.value === '' ? null : Number(e.currentTarget.value), bufferSize: null })}>
              <option value="">Device default</option>
              {#each rates as r (r)}<option value={String(r)}>{(r / 1000).toFixed(1).replace(/\.0$/, '')} kHz</option>{/each}
            </select>
          </label>
        {/if}

        {#if input !== null && input.channels > 2}
          <label class="field"><span class="t-small">Inputs</span>
            <select value={String(config?.inputChannels?.[0] ?? 0)}
                    onchange={(e) => set({ inputChannels: pairOf(Number(e.currentTarget.value), input.channels) })}>
              {#each pairs(input.channels) as first (first)}<option value={String(first)}>{pairLabel(first, input.channels)}</option>{/each}
            </select>
          </label>
        {/if}
        {#if output !== null && output.channels > 2}
          <label class="field"><span class="t-small">Outputs</span>
            <select value={String(config?.outputChannels?.[0] ?? 0)}
                    onchange={(e) => set({ outputChannels: pairOf(Number(e.currentTarget.value), output.channels) })}>
              {#each pairs(output.channels) as first (first)}<option value={String(first)}>{pairLabel(first, output.channels)}</option>{/each}
            </select>
          </label>
        {/if}

        <!-- The headphone level: the interface's volume, not the tone. The
             Output fader on the rig is part of a shared tone; this is not. -->
        <label class="field"><span class="t-small">Headphones — {Math.round(monitor * 100)}%</span>
          <input type="range" min="0" max="1" step="0.01" value={monitor} aria-label="Headphone level"
                 oninput={(e) => set({ monitor: Number(e.currentTarget.value) })} />
        </label>

        {#if opened !== null}
          <p class="t-small note">
            Playing at {(opened.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz{opened.bufferSize === null ? '' : ` with ${opened.bufferSize}-frame buffers`}:
            {opened.inputLatencyMs.toFixed(1)} ms in, {opened.outputLatencyMs.toFixed(1)} ms out.
          </p>
        {/if}
      {/if}
    {:else if status === 'checking'}
      <p class="t-small note">Looking for Tonecraft Engine on this computer…</p>
    {:else}
      <div class="guide">
        <p class="t-small">
          {platform === 'windows' ? 'ASIO needs Tonecraft Engine' : 'This needs Tonecraft Engine'}: a small free program that
          plays through {platform === 'other' ? 'your system’s audio driver' : DRIVER[platform]} directly, with the smallest
          buffer it allows. It sits as an icon by the clock; everything is set from here, and the tone is the same.
        </p>
        <ol class="t-small">
          {#if platform === 'other'}
            <li><a class="download" href={releasesUrl} target="_blank" rel="noopener">Download Tonecraft Engine</a></li>
          {:else}
            <li><a class="download" href={downloadUrl(platform)} rel="noopener">Download Tonecraft Engine for {SYSTEM[platform]}</a></li>
          {/if}
          {#if platform === 'windows'}
            <li>Unzip it and open <code>tonecraft-engine.exe</code>. If Windows SmartScreen stops it, choose More info, then Run anyway.</li>
          {:else if platform === 'macos'}
            <li>Unzip it, then Control-click <code>tonecraft-engine</code> and choose Open: macOS asks once, because the program is not notarised. Allow the microphone when asked — that is how it hears the interface.</li>
          {:else}
            <li>Extract it and run <code>./tonecraft-engine</code>.</li>
          {/if}
          <li>Keep this sheet open: it connects by itself. If the browser asks to reach devices on your local network, allow it — that is this page talking to the program on this computer, nothing else.</li>
        </ol>
        <p class="t-small note">
          <a href={releasesUrl} target="_blank" rel="noopener">Other systems and versions</a>
          <span aria-hidden="true"> · </span>
          <button class="inline" type="button" onclick={() => onbackend('browser')}>Keep playing in the browser</button>
        </p>
      </div>
    {/if}
  </div>
{/if}

<style>
  .engine { display: flex; flex-direction: column; gap: calc(var(--u) * 2); }
  .note { margin: 0; color: var(--graphite); line-height: 1.6; }
  .field { display: flex; flex-direction: column; gap: 2px; }
  .field select { max-width: 100%; width: 100%; }
  .field input[type='range'] { width: 100%; min-height: 40px; accent-color: var(--celadon); }
  .guide { display: flex; flex-direction: column; gap: var(--u); }
  .guide p, .guide ol { margin: 0; line-height: 1.6; }
  .guide ol { padding-left: calc(var(--u) * 2.5); display: flex; flex-direction: column; gap: var(--u); }
  .download { color: var(--ink); font-weight: 500; }
  a { color: var(--ink); }
  a:focus-visible, .inline:focus-visible, input:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }
  code { font-family: var(--mono); font-size: 12px; }
  .inline {
    padding: 0; border: 0; background: none; color: var(--ink);
    font: inherit; text-decoration: underline; cursor: pointer;
  }
  .failure { display: flex; flex-direction: column; gap: 2px; margin: 0; font-size: 15px; color: var(--ember); }
  .fix { color: var(--graphite); }
</style>
