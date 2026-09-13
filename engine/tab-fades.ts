/**
 * Puts a track's volume back after a fade, where alphaTab leaves it at zero.
 *
 * alphaTab plays a fade out — and the second half of a volume swell — by
 * ramping the track's MIDI channel volume down to 0, and nothing raises it
 * again: every note after the first fade on a track plays silent. In Guitar
 * Pro the fade belongs to the note that carries it. On "First Fragment", the
 * second solo guitar fades at bar 190, and its solo from bar 198 was never
 * heard; the first solo guitar went silent from bar 174.
 *
 * The first beat with notes after each such fade gets a volume automation at
 * the level the track was playing at — its last volume automation, or the
 * track's own volume — which alphaTab plays as a channel volume change at
 * that beat. Hidden, so the notation does not change. Pure, and checked
 * against alphaTab's own MIDI (`tab-fades.test.ts`).
 */
import type * as AlphaTab from '@coderline/alphatab';

/** Returns how many beats had their track's volume restored. */
export function restoreFadedVolume(score: AlphaTab.model.Score, alpha: { readonly model: typeof AlphaTab.model }): number {
  const { Automation, AutomationType, FadeType } = alpha.model;
  let restored = 0;
  for (const track of score.tracks) {
    const beats: AlphaTab.model.Beat[] = [];
    for (const staff of track.staves) for (const bar of staff.bars) for (const voice of bar.voices) beats.push(...voice.beats);
    beats.sort((a, b) => a.absolutePlaybackStart - b.absolutePlaybackStart);
    let volume = track.playbackInfo.volume;
    let fadedAt = -1;
    for (const beat of beats) {
      const own = beat.automations.find((a) => a.type === AutomationType.Volume);
      if (fadedAt >= 0 && beat.absolutePlaybackStart > fadedAt && beat.notes.length > 0) {
        if (own === undefined) {
          const automation = new Automation();
          automation.type = AutomationType.Volume;
          automation.value = volume;
          automation.isVisible = false;
          beat.automations.push(automation);
          restored++;
        }
        fadedAt = -1;
      }
      if (own !== undefined) volume = own.value;
      if (beat.fade === FadeType.FadeOut || beat.fade === FadeType.VolumeSwell) fadedAt = beat.absolutePlaybackStart;
    }
  }
  return restored;
}
