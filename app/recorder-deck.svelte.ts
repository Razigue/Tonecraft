/**
 * The recorder, as the studio's transport shows it.
 *
 * Recording is one button at the foot of the screen; the timeline, the tracks
 * and the export are a drawer that only matters once there is something in
 * it. So the button cannot live in the drawer. The recorder writes what it is
 * doing here and installs what a press does, as the tab reader does with
 * `TabDeck`; nothing here records.
 */
export class RecorderDeck {
  recording = $state(false);
  /** Seconds in the take being recorded, or in the armed one. */
  seconds = $state(0);
  /** Starting, saving, or rendering the other tracks before an overdub. */
  busy = $state(false);
  /** A press would do something: an engine is running, or a take is. */
  available = $state(false);
  /** A take or a backing track exists: the drawer has something to show. */
  filled = $state(false);
  /** The last failure, in the player's language; '' when there is none. */
  error = $state('');

  record: () => void = () => {};
  stop: () => void = () => {};
}
