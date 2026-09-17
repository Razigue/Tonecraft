/**
 * The tab reader's playback, as the studio's transport shows it.
 *
 * The transport sits at the foot of the studio in both views, and the reader
 * may be out of sight while it plays — dialling a tone over a song is the
 * point of Play running in the Tone view. So the controls cannot live in the
 * reader. The reader writes what it is doing here and installs what a press
 * does; the transport reads one and calls the other. Nothing here plays.
 */
export class TabDeck {
  /** A score is open. */
  loaded = $state(false);
  /** What is on the lectern: the score's title, else its file name. */
  title = $state('');
  ready = $state(false);
  busy = $state(false);
  playing = $state(false);
  /** Waiting for the metronome's next first beat. */
  cueing = $state(false);
  position = $state(0);
  duration = $state(0);
  /** The bar being played, from 1, and how many there are. */
  bar = $state(0);
  bars = $state(0);
  /** The tempo heard: the score's, at the current speed or the click's. */
  bpm = $state(0);
  looping = $state(false);
  /** A passage is selected, so the loop is that passage. */
  selection = $state(false);
  /** Percent. Owned here: the transport sets it and the reader follows. */
  speed = $state(100);
  /** The score player's level, percent. Owned here, like the speed. */
  volume = $state(60);

  toggle: () => void = () => {};
  stop: () => void = () => {};
  seek: (ms: number) => void = () => {};
  loop: () => void = () => {};
  clearSelection: () => void = () => {};
  /** Reads a file the transport's picker was given. */
  open: (file: File) => void = () => {};
  /** Opens the editor on the draft. */
  write: () => void = () => {};
}
