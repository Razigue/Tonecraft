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
  import { lang } from './locale.svelte.ts';
  import {
    NativeLink, detectPlatform, browserBlocksLoopback, downloadUrl, releasesUrl,
    type NativeConfig, type NativeDevice, type NativeInfo, type NativeOpened,
  } from '../engine/native-host.ts';
  import type { Backend } from '../engine/engine.ts';
  import { engineUpdate } from '../engine/engine-update.ts';

  interface Props {
    backend: Backend;
    opened: NativeOpened | null;
    onbackend: (backend: Backend) => void;
  }

  const { backend, opened, onbackend }: Props = $props();

  const platform = detectPlatform();
  const blocked = browserBlocksLoopback();
  const words = $derived(lang.ui.engine);
  const OPTIONS = $derived([
    { value: 'browser', label: words.browser },
    { value: 'native', label: platform === 'windows' ? 'ASIO' : words.native },
  ]);
  const SYSTEM = { windows: 'Windows', macos: 'macOS', linux: 'Linux' } as const;

  /** Buffer sizes worth offering, inside what the device accepts. */
  const SIZES = [16, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 2048];

  const link = NativeLink.shared;
  let info = $state<NativeInfo | null>(link.info);
  let config = $state<NativeConfig | null>(link.config);
  let status = $state<'checking' | 'connected' | 'missing'>(link.connected ? 'connected' : 'checking');
  let devices = $state<{ inputs: readonly NativeDevice[]; outputs: readonly NativeDevice[] } | null>(null);
  let devicesFor = '';

  const host = $derived(config?.host ?? info?.hosts[0]?.id ?? null);

  /* The running engine against the newest release: it does not update itself. */
  let latest = $state<string | null>(null);
  $effect(() => {
    const version = info?.version;
    latest = null;
    if (version !== undefined) void engineUpdate(version).then((l) => { if (info?.version === version) latest = l; });
  });
  const updateHref = platform === 'windows' || platform === 'macos' || platform === 'linux' ? downloadUrl(platform) : releasesUrl;

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
    <Segmented label={words.audioEngine} options={OPTIONS} value={backend} onchange={(v) => onbackend(v as Backend)} />

    {#if backend === 'browser'}
      {#if platform === 'windows'}
        <p class="t-small note">{words.asioHint}</p>
      {/if}
    {:else if blocked}
      <p class="failure"><span>{words.safariCause}</span><span class="fix">{words.safariFix}</span></p>
    {:else if status === 'connected' && info !== null}
      <p class="t-small note">{words.running(info.version)}</p>
      {#if latest !== null}
        <p class="update t-small"><span>{words.updateAvailable(latest)}</span>
          <a class="download update-link" href={updateHref} rel="noopener">{words.update}</a></p>
      {/if}

      {#if info.hosts.length > 1}
        <label class="field"><span class="t-small">{words.driver}</span>
          <select value={host ?? ''} onchange={(e) => chooseHost(e.currentTarget.value)}>
            {#each info.hosts as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
          </select>
        </label>
      {/if}

      {#if devices === null}
        <p class="t-small note">{words.readingDevices}</p>
      {:else if devices.inputs.length === 0 && devices.outputs.length === 0}
        <p class="failure"><span>{words.noDeviceCause}</span><span class="fix">{words.noDeviceFix}</span></p>
      {:else}
        {#if isAsio}
          <label class="field"><span class="t-small">{words.interface}</span>
            <select value={input?.id ?? ''} onchange={(e) => chooseInterface(e.currentTarget.value)}>
              {#each devices.inputs as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
            </select>
          </label>
        {:else}
          <label class="field"><span class="t-small">{words.inputDevice}</span>
            <select value={input?.id ?? ''} onchange={(e) => set({ input: e.currentTarget.value, inputChannels: null })}>
              {#each devices.inputs as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
            </select>
          </label>
          <label class="field"><span class="t-small">{words.outputDevice}</span>
            <select value={output?.id ?? ''} onchange={(e) => set({ output: e.currentTarget.value, outputChannels: null })}>
              {#each devices.outputs as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
            </select>
          </label>
        {/if}

        {#if sizes.length > 0}
          <!-- By default, ASIO keeps the buffer set in the interface's own
               control panel, which other programs share; elsewhere, the
               smallest the device offers. Any other size is the player's call. -->
          <label class="field"><span class="t-small">{words.buffer}</span>
            <select value={config?.bufferSize == null ? '' : String(config.bufferSize)}
                    onchange={(e) => set({ bufferSize: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })}>
              <option value="">{isAsio ? words.interfaceSetting : words.smallest(sizes[0]!, ms(sizes[0]!))}</option>
              {#each sizes as n (n)}<option value={String(n)}>{words.frames(n, ms(n))}</option>{/each}
            </select>
          </label>
        {/if}

        {#if rates.length > 1}
          <label class="field"><span class="t-small">{words.sampleRate}</span>
            <select value={config?.sampleRate == null ? '' : String(config.sampleRate)}
                    onchange={(e) => set({ sampleRate: e.currentTarget.value === '' ? null : Number(e.currentTarget.value), bufferSize: null })}>
              <option value="">{words.deviceDefault}</option>
              {#each rates as r (r)}<option value={String(r)}>{(r / 1000).toFixed(1).replace(/\.0$/, '')} kHz</option>{/each}
            </select>
          </label>
        {/if}

        {#if input !== null && input.channels > 2}
          <label class="field"><span class="t-small">{words.inputs}</span>
            <select value={String(config?.inputChannels?.[0] ?? 0)}
                    onchange={(e) => set({ inputChannels: pairOf(Number(e.currentTarget.value), input.channels) })}>
              {#each pairs(input.channels) as first (first)}<option value={String(first)}>{pairLabel(first, input.channels)}</option>{/each}
            </select>
          </label>
        {/if}
        {#if output !== null && output.channels > 2}
          <label class="field"><span class="t-small">{words.outputs}</span>
            <select value={String(config?.outputChannels?.[0] ?? 0)}
                    onchange={(e) => set({ outputChannels: pairOf(Number(e.currentTarget.value), output.channels) })}>
              {#each pairs(output.channels) as first (first)}<option value={String(first)}>{pairLabel(first, output.channels)}</option>{/each}
            </select>
          </label>
        {/if}

        <!-- The headphone level: the interface's volume, not the tone. The
             Output fader on the rig is part of a shared tone; this is not. -->
        <label class="field"><span class="t-small">{words.headphones(Math.round(monitor * 100))}</span>
          <input type="range" min="0" max="1" step="0.01" value={monitor} aria-label={words.headphoneLevel}
                 oninput={(e) => set({ monitor: Number(e.currentTarget.value) })} />
        </label>

        {#if opened !== null}
          <p class="t-small note">{words.playingAt((opened.sampleRate / 1000).toFixed(1).replace(/\.0$/, ''), opened.bufferSize, opened.inputLatencyMs.toFixed(1), opened.outputLatencyMs.toFixed(1))}</p>
        {/if}
      {/if}
    {:else if status === 'checking'}
      <p class="t-small note">{words.looking}</p>
    {:else}
      <div class="guide">
        <p class="t-small">{words.guide(platform === 'windows' ? words.needsWindows : words.needs, words.drivers[platform], platform === 'windows')}</p>
        <ol class="t-small">
          {#if platform === 'other'}
            <li><a class="download" href={releasesUrl} target="_blank" rel="noopener">{words.download}</a></li>
          {:else}
            <li><a class="download" href={downloadUrl(platform)} rel="noopener">{words.downloadFor(SYSTEM[platform])}</a></li>
          {/if}
          {#if platform === 'windows'}
            <li>{words.stepWindowsBefore} <code>tonecraft-engine.exe</code>{words.stepWindowsAfter}</li>
          {:else if platform === 'macos'}
            <li>{words.stepMacBefore} <code>tonecraft-engine</code>{words.stepMacAfter}</li>
          {:else}
            <li>{words.stepLinuxBefore} <code>./tonecraft-engine</code>{words.stepLinuxAfter}</li>
          {/if}
          <li>{words.stepConnect}</li>
        </ol>
        <p class="t-small note">
          <a href={releasesUrl} target="_blank" rel="noopener">{words.otherVersions}</a>
          <span aria-hidden="true"> · </span>
          <button class="inline" type="button" onclick={() => onbackend('browser')}>{words.stayInBrowser}</button>
        </p>
      </div>
    {/if}
  </div>
{/if}

<style>
  .engine { display: flex; flex-direction: column; gap: calc(var(--u) * 2); }
  .note { margin: 0; color: var(--graphite); line-height: 1.6; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field select {
    width: 100%;
    min-height: 34px;
    padding: 0 30px 0 10px;
    appearance: none;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface-2) var(--chevron) no-repeat right 11px center;
    color: var(--text);
    font: 13px var(--body);
  }
  .field select:hover { border-color: var(--line-strong); }
  .field select:focus-visible { outline: 2px solid var(--iris); outline-offset: 2px; }
  .field input[type='range'] { width: 100%; min-height: 40px; }
  .guide { display: flex; flex-direction: column; gap: var(--u); }
  .guide p, .guide ol { margin: 0; line-height: 1.6; }
  .guide ol { padding-left: calc(var(--u) * 2.5); display: flex; flex-direction: column; gap: var(--u); }
  .download { color: var(--ink); font-weight: 500; }
  .update { display: flex; flex-direction: column; align-items: flex-start; gap: var(--u); margin: 0; line-height: 1.6; }
  .update-link { padding: 8px 14px; border: 1px solid var(--violet-500); border-radius: var(--radius); background: var(--action); color: var(--action-text); text-decoration: none; }
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
