<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import type { AlphaTabApi, model } from '@coderline/alphatab';
  import { loadMedia, saveMedia } from '../store/media.ts';

  // Every format alphaTab's own ScoreLoader tries, in its order: Guitar Pro
  // 3-5, 6 (gpx), 7-8 (gp), MusicXML plain and zipped, Capella, alphaTex.
  // Naming one it cannot read would be a promise the importer breaks.
  const ACCEPT = '.gpx,.gp,.gp3,.gp4,.gp5,.musicxml,.xml,.mxl,.cap,.capx,.alphatex,.atex';
  const BASE = import.meta.env.BASE_URL;
  let surface: HTMLDivElement;
  let viewport: HTMLDivElement;
  let picker: HTMLInputElement;
  let api: AlphaTabApi | null = null;
  let loading: Promise<typeof import('@coderline/alphatab')> | null = null;
  let disposed = false;
  let score = $state.raw<model.Score | null>(null);
  let filename = $state('');
  let busy = $state(false);
  let error = $state('');
  let storageNote = $state('');
  let dragging = $state(false);
  let focused = $state(false);
  let track = $state(0);
  let ready = $state(false);
  let playing = $state(false);
  let speed = $state(100);
  let zoom = $state(100);
  let notation = $state('tab');
  let looping = $state(false);
  let selection = $state(false);
  let solo = $state(false);
  let muted = $state(false);
  let position = $state(0);
  let duration = $state(0);
  let volume = $state(60);
  const time = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

  /** The engine, the notation fonts and the soundfont: fetched at the first file opened, never before. */
  function library() {
    loading ??= import('@coderline/alphatab').catch(e => { loading = null; throw e; });
    return loading;
  }

  /**
   * One reader per score, rather than a new score into the reader on screen.
   * A layout runs in alphaTab's own worker and what comes back is resolved
   * against whatever score the api holds by then, so replacing the score under
   * a render still in flight — a second import after a resize or after leaving
   * focus view — throws on bars that no longer exist. `destroy()` terminates
   * that worker and closes its audio context, so nothing from the previous
   * score can arrive at all. It costs one soundfont decode per import, on a
   * deliberate action that already shows Opening…, and it is why every display
   * setting below is passed from the current state instead of a default.
   */
  async function reader(alpha: typeof import('@coderline/alphatab')) {
    api?.destroy();
    api = null;
    ready = false;
    await tick();
    if (disposed) throw new Error('Reader closed.');
    api = new alpha.AlphaTabApi(surface, {
      // SVG, spelled out rather than relied on: canvas is forbidden here
      // (CLAUDE.md section 4) and alphaTab renders either way.
      core: { fontDirectory: `${BASE}font/`, engine: 'svg' },
      display: { scale: zoom / 100, padding: [24, 28, 24, 28],
        staveProfile: notation === 'tab' ? alpha.StaveProfile.Tab : alpha.StaveProfile.ScoreTab },
      player: {
        playerMode: alpha.PlayerMode.EnabledSynthesizer,
        soundFont: `${BASE}soundfont/sonivox.sf2`,
        scrollElement: viewport, enableCursor: true, enableUserInteraction: true,
      },
    });
    api.masterVolume = volume / 100;
    api.playerReady.on(() => { ready = true; });
    api.playerStateChanged.on(e => { playing = e.state === 1; });
    api.playerPositionChanged.on(e => { position = e.currentTime; duration = e.endTime; });
    api.playbackRangeChanged.on(e => { selection = e.playbackRange !== null; });
    api.error.on(e => { error = e.message || 'Unable to display this score.'; busy = false; });
    return api;
  }

  async function open(file: File, remember = true) {
    if (busy) return;
    if (!/\.(gp[345x]?|musicxml|xml|mxl|capx?|alphatex|atex)$/i.test(file.name)) {
      error = 'Choose a Guitar Pro, MusicXML, Capella or alphaTex file.'; return;
    }
    if (file.size > 20 * 1024 * 1024) { error = 'This score exceeds the 20 MB import limit.'; return; }
    busy = true; error = ''; storageNote = '';
    try {
      const alpha = await library();
      // Parsed before anything on screen is touched: a file that turns out not
      // to be a score leaves the one being read exactly as it was.
      const parsed = alpha.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(await file.arrayBuffer()), new alpha.Settings());
      if (disposed) return;
      score = parsed; filename = file.name;
      track = Math.max(0, parsed.tracks.findIndex(t => t.staves.some(s => s.tuning.length > 0)));
      muted = false; solo = false; looping = false; selection = false; position = 0; duration = 0;
      const fresh = await reader(alpha);
      fresh.renderScore(parsed, [track]);
      fresh.playbackSpeed = speed / 100;
      ready = fresh.isReadyForPlayback;
      if (remember) {
        const saved = await saveMedia(file, 'score', 'last-score');
        if (saved === null) storageNote = 'Opened for this session. Browser storage is unavailable.';
      }
    } catch (e) {
      error = `Could not open ${file.name}. ${e instanceof Error ? e.message : 'The file may be damaged or unsupported.'}`;
    } finally { busy = false; }
  }

  function chooseTrack(index: number) {
    if (!score || !api) return;
    api.changeTrackSolo(score.tracks, false);
    api.changeTrackMute(score.tracks, false);
    track = index; solo = false; muted = false;
    api.renderTracks([score.tracks[index]!]);
  }
  function updateDisplay() {
    if (!api) return;
    // Numeric enum values come from the installed library, loaded on demand.
    void library().then(alpha => {
      if (!api || disposed) return;
      api.settings.display.scale = zoom / 100;
      api.settings.display.staveProfile = notation === 'tab' ? alpha.StaveProfile.Tab : alpha.StaveProfile.ScoreTab;
      api.updateSettings(); api.render();
    });
  }
  function togglePlay() { if (ready && !busy) api?.playPause(); }
  function keydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && focused) { focused = false; e.stopPropagation(); }
    if (e.code === 'Space' && e.target instanceof HTMLElement && !e.target.closest('input,select,button')) {
      e.preventDefault(); e.stopPropagation(); togglePlay();
    }
  }
  onMount(() => { void loadMedia('last-score').then(file => { if (file && !disposed && !busy && !score) void open(file, false); }); });
  onDestroy(() => { disposed = true; api?.destroy(); });
</script>

<section class="reader" class:focused role="application" aria-label="Tab reader" onkeydown={keydown}>
  <div class="reader-heading">
    <div><span class="eyebrow">PRACTICE</span><h2>Tab reader</h2></div>
    <div class="heading-actions">
      {#if score}<button aria-pressed={focused} onclick={() => { focused = !focused; }}> {focused ? 'Exit focus' : 'Focus view'} </button>{/if}
      <button class="primary" disabled={busy} onclick={() => picker.click()}>{busy ? 'Opening…' : score ? 'Open another tab' : 'Import tab'}</button>
    </div>
    <input bind:this={picker} type="file" accept={ACCEPT} aria-label="Import tablature" onchange={e => { const f = e.currentTarget.files?.[0]; if (f) void open(f); e.currentTarget.value = ''; }} />
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if storageNote}<p class="storage-note" role="status">{storageNote}</p>{/if}
  <div class="drop-surface" class:dragging role="region" aria-label="Drop a tablature file"
    ondragover={e => { e.preventDefault(); dragging = true; }}
    ondragleave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) dragging = false; }}
    ondrop={e => { e.preventDefault(); dragging = false; const f = e.dataTransfer?.files[0]; if (f) void open(f); }}>
    {#if score}
      <div class="transport">
        <div class="playback">
          <button class="play" aria-label={playing ? 'Pause tablature' : 'Play tablature'} disabled={!ready || busy} onclick={togglePlay}>{playing ? 'Ⅱ' : '▶'}</button>
          <button aria-label="Stop tablature" onclick={() => api?.stop()}>■</button>
          <span class="clock">{time(position)} <span>/ {time(duration)}</span></span>
        </div>
        <label>Speed<select aria-label="Playback speed" bind:value={speed} onchange={() => { if (api) api.playbackSpeed = speed / 100; }}>{#each [25, 50, 60, 70, 80, 90, 100, 110, 125, 150] as n}<option value={n}>{n}%</option>{/each}</select></label>
        <button class:active={looping} aria-pressed={looping} onclick={() => { looping = !looping; if (api) api.isLooping = looping; }}>↻ {selection ? 'Loop selection' : 'Loop song'}</button>
        {#if selection}<button onclick={() => { if (api) api.playbackRange = null; }}>Clear selection</button>{/if}
        <label class="volume">Volume<input type="range" aria-label="Tab playback volume" min="0" max="100" bind:value={volume} oninput={() => { if (api) api.masterVolume = volume / 100; }} /></label>
        <label class="view-select">View<select aria-label="Notation view" bind:value={notation} onchange={updateDisplay}><option value="tab">Tab</option><option value="both">Score + tab</option></select></label>
        <label>Zoom<select aria-label="Tab zoom" bind:value={zoom} onchange={updateDisplay}>{#each [75, 90, 100, 110, 125, 150] as n}<option value={n}>{n}%</option>{/each}</select></label>
      </div>
    {/if}
    <div class="reader-body" class:empty={!score}>
      {#if score}
        <aside aria-label="Score tracks">
          <span class="eyebrow">{score.tracks.length} TRACKS</span>
          <div class="tracks">{#each score.tracks as t, i}
            <button class:selected={track === i} aria-pressed={track === i} onclick={() => chooseTrack(i)}><span class="track-number">{String(i + 1).padStart(2, '0')}</span><span>{t.name || `Track ${i + 1}`}</span></button>
          {/each}</div>
          <div class="track-tools">
            <button aria-pressed={solo} class:active={solo} onclick={() => { solo = !solo; api?.changeTrackSolo([score!.tracks[track]!], solo); }}>Solo</button>
            <button aria-pressed={muted} class:active={muted} onclick={() => { muted = !muted; api?.changeTrackMute([score!.tracks[track]!], muted); }}>Mute</button>
          </div>
          <p>{Math.round(score.tempo * speed / 100)} BPM <span>· {score.masterBars.length} bars</span></p>
          <p class="hint">Click a note to seek. Drag across notes to select a passage, then enable the loop.</p>
        </aside>
      {/if}
      <div class="score-viewport" class:has-score={!!score} bind:this={viewport}>
        {#if !score}
          <div class="empty-state">
            <div class="tab-mark" aria-hidden="true"><span>TAB</span><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <h3>Your next riff starts here.</h3>
            <p>Drop a Guitar Pro file here, or import one from your device.</p>
            <span class="formats">GP · GPX · GP3 / GP4 / GP5 · MUSICXML · CAPELLA · ALPHATEX</span>
            <small>Your files stay on this device.</small>
          </div>
        {/if}
        <div class="score-paper" class:hidden={!score} bind:this={surface}></div>
      </div>
    </div>
    {#if score}<div class="reader-footer"><span>{score.title || filename}{score.artist ? ` · ${score.artist}` : ''}</span><span>{ready ? 'Click the score · Space to play' : 'Preparing playback…'}</span></div>{/if}
  </div>
</section>

<style>
  .reader{margin:32px 0 24px;border:1px solid #3c3c3c;border-radius:8px;background:#1b1b1b;overflow:hidden;min-width:0}
  .reader-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 24px}.eyebrow{font:9px var(--mono);letter-spacing:1.6px;color:#a4a4a4}h2{font:500 20px var(--body);margin:5px 0 0}.heading-actions{display:flex;gap:10px}
  button,select{font:12px var(--body);color:#ddd;background:#303030;border:1px solid #4b4b4b;border-radius:4px;min-height:34px;padding:6px 12px;cursor:pointer}button:hover{background:#414141}button:disabled{opacity:.45;cursor:wait}.primary{background:#dedbd5;color:#222;border-color:#dedbd5}.primary:hover{background:#fff}.reader-heading>input{display:none}.error,.storage-note{padding:0 24px 15px;margin:0;font-size:13px}.error{color:var(--ember)}.storage-note{color:#bbb}
  .drop-surface{border-top:1px solid #393939}.dragging{outline:2px dashed #dedbd5;outline-offset:-5px}.transport{display:flex;align-items:center;gap:12px;padding:12px 18px;flex-wrap:wrap;background:#242424;border-bottom:1px solid #404040}.playback{display:flex;align-items:center;gap:6px}.play{width:38px}.clock{font:11px var(--mono);margin:0 8px;white-space:nowrap}.clock span{color:#999}.transport label{display:flex;align-items:center;gap:6px;font-size:10px;color:#aaa}.transport select{padding:5px}.volume input{width:65px;accent-color:#ddd}.view-select{margin-left:auto}.active{background:#dedbd5;color:#222}
  .reader-body{display:grid;grid-template-columns:185px minmax(0,1fr)}.reader-body.empty{display:block}aside{padding:22px 12px;background:#202020;min-width:0;border-right:1px solid #414141}.tracks{display:grid;gap:5px;margin-top:15px;max-height:300px;overflow:auto}.tracks button{display:flex;align-items:baseline;gap:10px;text-align:left;border-color:transparent;background:none;padding:10px 8px;overflow-wrap:anywhere;line-height:1.5}.tracks .selected{background:#363636;border-color:#555}.track-number{font:10px var(--mono);color:#9e9e9e}.track-tools{display:flex;gap:6px;margin:16px 8px}.track-tools button{flex:1}aside p{font:11px var(--mono);line-height:1.7;padding:0 8px;color:#ccc}aside p span{color:#999}aside .hint{font:11px/1.7 var(--body);color:#aaa;margin-top:22px}
  .score-viewport{overflow:auto;min-width:0;max-height:640px;position:relative;scrollbar-color:#777 #dedbd5}.has-score{background:#faf8f3;color:#222}.score-paper{min-height:320px;background:#faf8f3;color:#171717}.hidden{display:none}.empty-state{padding:48px 24px;text-align:center;background:radial-gradient(ellipse at top,#303030,#1c1c1c 75%)}h3{font:500 21px var(--body);margin:22px 0 10px}.empty-state p{font-size:13px;color:#b2b2b2;margin-bottom:20px}.formats{font:10px var(--mono);letter-spacing:1px;color:#c5c1ba}.empty-state small{display:block;margin-top:16px;font-size:11px;color:#999}.tab-mark{width:124px;position:relative;margin:auto;padding:4px 0}.tab-mark i{display:block;height:1px;background:#696762;margin:7px 0}.tab-mark span{position:absolute;inset:0;display:grid;place-items:center;font:600 17px var(--mono);letter-spacing:3px;color:#dedbd5;text-shadow:0 0 6px #222;background:linear-gradient(90deg,transparent,#282828 32%,#282828 68%,transparent)}
  .reader-footer{display:flex;justify-content:space-between;gap:16px;padding:12px 18px;border-top:1px solid #404040;font:10px var(--mono);color:#aaa}.reader-footer>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.focused{position:fixed;inset:16px;z-index:50;margin:0;display:flex;flex-direction:column;box-shadow:0 0 0 30px #080808e8}.focused .drop-surface{flex:1;min-height:0;display:flex;flex-direction:column}.focused .reader-body{flex:1;min-height:0}.focused .score-viewport{max-height:none}.focused aside{overflow:auto}
  :global(.at-cursor-bar){background:#bda77230}:global(.at-cursor-beat){background:#866329;width:3px}:global(.at-selection div){background:#bda77244}:global(.at-highlight *){fill:#a37320!important;stroke:#a37320!important}
  @media(max-width:760px){.reader-heading{padding:18px 14px}.heading-actions{gap:6px}.heading-actions button{padding:5px 8px}.reader-body{grid-template-columns:minmax(0,1fr)}aside{padding:12px;border-right:0;border-bottom:1px solid #444}aside>.eyebrow,aside p{display:none}.tracks{display:flex;margin:0;overflow:auto;max-height:90px}.tracks button{flex-shrink:0;max-width:180px}.track-tools{margin:10px 0 0;max-width:160px}.transport{padding:12px;gap:8px}.volume{display:none!important}.view-select{margin-left:0}.score-viewport{max-height:520px}.focused{inset:6px}.focused .reader-body{display:flex;flex-direction:column}.focused .score-viewport{flex:1}.reader-footer>span:last-child{display:none}.empty-state{padding:32px 18px}}
</style>
