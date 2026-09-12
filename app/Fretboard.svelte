<script lang="ts">
  /**
   * The neck under the tab, lit where the notes are. The tab says which fret on
   * which string; the neck says where the hand goes, which is the translation a
   * beginner is doing in their head while the bar slides past.
   *
   * It is the track's own neck: the string count comes from the tuning of the
   * staff being read, so a seven-string transcription draws seven strings and a
   * bass four. Twenty-four frets whatever the instrument — a neck that changed
   * length between scores would move every position the eye has just learnt.
   *
   * The frets are evenly spaced rather than following the real 17.817 rule.
   * That is deliberate: on a real neck the 24th fret is three millimetres wide,
   * and the point here is reading a position, not looking at a photograph of a
   * guitar. Nothing here is skeuomorphic (DESIGN.md): flat lines on the same
   * paper as the score.
   */
  let { strings, lit, capo = 0 }: {
    strings: readonly number[];
    lit: readonly { string: number; fret: number }[];
    capo?: number;
  } = $props();

  const FRETS = 24;
  const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  // Single dots, then the two that mark the octave and the end of the neck.
  const INLAYS = [3, 5, 7, 9, 15, 17, 19, 21];
  const DOUBLE = [12, 24];

  // The highest string on top, the way a tab staff is written: the dots then
  // land on the same rows as the numbers above them.
  const BOARD = 780;
  const NUT = 34;
  const END = BOARD - 14;
  const TOP = 26;
  const GAP = 20;
  const width = (END - NUT) / FRETS;
  const height = $derived(TOP * 2 + Math.max(1, strings.length - 1) * GAP);
  // alphaTab numbers strings from the lowest (1) while its tuning lists them
  // from the highest: a note's row is counted back from the bottom.
  const row = (index: number) => TOP + index * GAP;
  const y = (string: number) => row(strings.length - string);
  const x = (fret: number) => (fret === 0 ? NUT - 12 : NUT + (fret - 0.5) * width);
  const middle = $derived(TOP + ((strings.length - 1) * GAP) / 2);
</script>

<div class="neck" aria-hidden="true">
  <svg viewBox={`0 0 ${BOARD} ${height}`} preserveAspectRatio="xMidYMid meet">
    <!-- frets, then strings on top of them, then what is being played -->
    {#each Array(FRETS) as _, i}
      <line class="fret" x1={NUT + (i + 1) * width} x2={NUT + (i + 1) * width} y1={TOP - 7} y2={height - TOP + 7} />
    {/each}
    {#each INLAYS as fret}<circle class="inlay" cx={NUT + (fret - 0.5) * width} cy={middle} r="5" />{/each}
    {#each DOUBLE as fret}
      <circle class="inlay" cx={NUT + (fret - 0.5) * width} cy={middle - GAP * 0.9} r="5" />
      <circle class="inlay" cx={NUT + (fret - 0.5) * width} cy={middle + GAP * 0.9} r="5" />
    {/each}
    <line class="nut" x1={NUT} x2={NUT} y1={TOP - 7} y2={height - TOP + 7} />
    {#if capo > 0 && capo <= FRETS}<line class="capo" x1={NUT + capo * width} x2={NUT + capo * width} y1={TOP - 7} y2={height - TOP + 7} />{/if}
    {#each strings as note, i}
      <line class="string" x1={NUT} x2={END} y1={row(i)} y2={row(i)} style:stroke-width={0.7 + i * 0.2} />
      <text class="open" x={NUT - 22} y={row(i) + 4}>{NAMES[((note % 12) + 12) % 12]}</text>
    {/each}
    {#each [...INLAYS, ...DOUBLE] as fret}
      <text class="number" x={NUT + (fret - 0.5) * width} y={height - 6}>{fret}</text>
    {/each}
    {#each lit as note (`${note.string}:${note.fret}`)}
      {#if note.string >= 1 && note.string <= strings.length && note.fret >= 0 && note.fret <= FRETS}
        <g class="lit">
          <circle class="halo" cx={x(note.fret)} cy={y(note.string)} r="13" />
          <circle class="core" cx={x(note.fret)} cy={y(note.string)} r="6.5" />
        </g>
      {/if}
    {/each}
  </svg>
</div>

<style>
  .neck{flex:1;min-height:120px;display:flex;padding:14px 16px 10px;background:#faf8f3}
  svg{width:100%;height:100%;max-height:300px;margin:auto}
  .fret{stroke:#cec8bb;stroke-width:1}
  .nut{stroke:#6f6962;stroke-width:3}
  .capo{stroke:#a37320;stroke-width:3;opacity:.55}
  .string{stroke:#a9a296}
  .inlay{fill:#e6e1d5}
  .open{font:11px var(--mono);fill:#8b8378;text-anchor:middle}
  .number{font:9px var(--mono);fill:#b1a99d;text-anchor:middle}
  .halo{fill:#a3732033}
  .core{fill:#a37320}
  .lit{transform-box:fill-box;transform-origin:center;animation:strike .13s ease-out}
  @keyframes strike{from{opacity:0;transform:scale(.55)}to{opacity:1;transform:scale(1)}}
  @media(prefers-reduced-motion:reduce){.lit{animation:none}}
  @media(max-width:760px){.neck{padding:10px 8px 14px;min-height:110px}.number{display:none}}
</style>
