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
   *
   * Two lights can share a position: a scale, marked as a ring, and the note
   * being played, a filled dot. They are drawn in three layers — the played
   * note's halo, the scale, the played note's core — so a note played inside
   * the scale reads as a dot inside its ring, one outside it as a dot alone,
   * and neither ever hides the other.
   *
   * Given `onpick`, every position is a target: the open string left of the
   * nut, then each fret's cell, a string's gap tall. They are drawn last and
   * transparent, so they catch the click without covering what is lit.
   */
  import type { NeckNote } from '../engine/scales.ts';

  let { strings, lit, capo = 0, scale = [], onpick }: {
    strings: readonly number[];
    /** Frets counted from the capo, as alphaTab reports a played note. */
    lit: readonly { string: number; fret: number }[];
    capo?: number;
    /** The same coordinates as `lit`, so the two land on the same spot. */
    scale?: readonly NeckNote[];
    /** A position clicked, in the same coordinates as `lit`. */
    onpick?: (note: { string: number; fret: number }) => void;
  } = $props();

  const FRETS = 24;
  const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  // Single dots, then the two that mark the octave and the end of the neck.
  const INLAYS = [3, 5, 7, 9, 15, 17, 19, 21];
  const DOUBLE = [12, 24];

  // The highest string on top, the way a tab staff is written: the dots then
  // land on the same rows as the numbers above them.
  const BOARD = 780;
  // Room left of the nut for two columns: the string's name, and a scale ring
  // on the open string, which would otherwise sit on top of the name.
  const NUT = 46;
  const END = BOARD - 14;
  const TOP = 26;
  const GAP = 20;
  const width = (END - NUT) / FRETS;
  const height = $derived(TOP * 2 + Math.max(1, strings.length - 1) * GAP);
  // alphaTab numbers strings from the lowest (1) while its tuning lists them
  // from the highest: a note's row is counted back from the bottom.
  const row = (index: number) => TOP + index * GAP;
  const y = (string: number) => row(strings.length - string);
  /* Where a fret counted from the capo sits on the neck. alphaTab sounds a note
     at tuning + capo + fret, so a tab's 0 under a capo on 2 is played at the
     second fret, not at the nut. */
  const x = (fret: number) => {
    const onNeck = capo + fret;
    return onNeck === 0 ? NUT - 12 : NUT + (onNeck - 0.5) * width;
  };
  const middle = $derived(TOP + ((strings.length - 1) * GAP) / 2);
  const onBoard = (note: { string: number; fret: number }) =>
    note.string >= 1 && note.string <= strings.length && note.fret >= 0 && capo + note.fret <= FRETS;
  const name = (note: { string: number; fret: number }) =>
    NAMES[(((strings[strings.length - note.string] ?? 0) + capo + note.fret) % 12 + 12) % 12];
  const played = $derived(lit.filter(onBoard));
</script>

<div class="neck" aria-hidden="true">
  <svg viewBox={`0 0 ${BOARD} ${height}`} preserveAspectRatio="xMidYMid meet">
    <!-- frets, then strings on top of them, then the scale and what is being played -->
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
      <text class="open" x={NUT - 36} y={row(i) + 4}>{NAMES[((note % 12) + 12) % 12]}</text>
    {/each}
    {#each [...INLAYS, ...DOUBLE] as fret}
      <text class="number" x={NUT + (fret - 0.5) * width} y={height - 6}>{fret}</text>
    {/each}

    <!-- 1. the played note's glow, under everything it could cover -->
    {#each played as note (`h${note.string}:${note.fret}`)}
      <circle class="halo" cx={x(note.fret)} cy={y(note.string)} r="13" />
    {/each}
    <!-- 2. the scale: rings, the root filled, each named -->
    {#each scale as note (`s${note.string}:${note.fret}`)}
      {#if onBoard(note)}
        <g class="scale" class:root={note.root}>
          <circle class="mark" cx={x(note.fret)} cy={y(note.string)} r="8.5" />
          <text class="degree" x={x(note.fret)} y={y(note.string) + 3}>{name(note)}</text>
        </g>
      {/if}
    {/each}
    <!-- 3. the played note itself, inside its ring when it has one -->
    {#each played as note (`c${note.string}:${note.fret}`)}
      <circle class="core" cx={x(note.fret)} cy={y(note.string)} r="6" />
    {/each}
    {#if onpick}
      {#each strings as _, i}
        {#each Array(FRETS + 1 - capo) as _, fret}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <rect class="pick" x={fret + capo === 0 ? 0 : NUT + (fret + capo - 1) * width} y={row(i) - GAP / 2}
            width={fret + capo === 0 ? NUT : width} height={GAP}
            onclick={() => onpick({ string: strings.length - i, fret })} />
        {/each}
      {/each}
    {/if}
  </svg>
</div>

<style>
  /* The neck sits on the lectern's paper, framed like it. */
  /* The neck is what gives way on a short screen: the tab above it never does. */
  /* The plate is the drawing's own size, not whatever height is left over: the
     svg keeps its viewBox's shape and the paper hugs it. Given the leftover
     instead, a neck on a tall page was a thin line adrift in a cream field. */
  .neck{flex:0 1 auto;min-height:0;display:flex;padding:14px 16px 10px;border-radius:var(--radius);background:radial-gradient(ellipse 80% 140% at 50% 0%,#fffdf8,#f3eee4 70%,#ebe4d6);box-shadow:var(--shadow),0 0 0 1px #000}
  svg{width:100%;height:auto;max-height:300px;margin:auto}
  .fret{stroke:#cec8bb;stroke-width:1}
  .nut{stroke:#6f6962;stroke-width:3}
  .capo{stroke:#a37320;stroke-width:3;opacity:.55}
  .string{stroke:#a9a296}
  .inlay{fill:#e3dccf}
  .open{font:11px var(--mono);fill:#8b8378;text-anchor:middle}
  .number{font:9px var(--mono);fill:#b1a99d;text-anchor:middle}
  /* The scale is violet and drawn, the playing note amber and filled: two hues
     and two shapes, so neither depends on telling colours apart (DESIGN.md §8).
     The violet is the studio's, deepened to be read on paper. */
  .mark{fill:#fbf8f2;stroke:#5e4a66;stroke-width:1.6}
  .degree{font:7.5px var(--mono);fill:#5e4a66;text-anchor:middle;pointer-events:none}
  .root .mark{fill:#5e4a66}
  .root .degree{fill:#fbf8f2;font-weight:600}
  .halo{fill:#a3732040}
  .core{fill:#a37320}
  .halo,.core{transform-box:fill-box;transform-origin:center;animation:strike .13s ease-out}
  /* The keyboard stays the way to write for anyone not pointing: the neck is a shortcut, not the only path. */
  .pick{fill:transparent;cursor:pointer}
  .pick:hover{fill:#a3732018}
  @keyframes strike{from{opacity:0;transform:scale(.55)}to{opacity:1;transform:scale(1)}}
  @media(prefers-reduced-motion:reduce){.halo,.core{animation:none}}
  @media(max-width:760px){.neck{padding:10px 8px 14px;min-height:110px}.number{display:none}.degree{display:none}}
</style>
