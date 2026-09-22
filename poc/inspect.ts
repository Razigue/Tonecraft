import fs from 'node:fs';
import * as alpha from '@coderline/alphatab';
const bytes = new Uint8Array(fs.readFileSync(process.argv[2]!));
const score = alpha.importer.ScoreLoader.loadScoreFromBytes(bytes, new alpha.Settings());
console.log(score.title, score.artist, 'tempo', score.tempo, 'bars', score.masterBars.length);
for (const t of score.tracks) {
  const st = t.staves[0]!;
  console.log(t.index, t.name, 'prog', t.playbackInfo.program, 'tuning', st.tuning.join(','), 'capo', st.capo, 'strings', st.tuning.length, 'isPerc', st.isPercussion);
}
const effects = new Map<string, number>();
const bump = (k: string) => effects.set(k, (effects.get(k) ?? 0) + 1);
for (const bar of score.tracks[0]!.staves[0]!.bars) for (const v of bar.voices) for (const b of v.beats) {
  if (b.isRest) continue;
  if (b.notes.length > 1) bump('chord');
  if (b.tremoloSpeed) bump('tremolo');
  if (b.hasWhammyBar) bump('whammy');
  if (b.pickStroke) bump('pickstroke');
  for (const n of b.notes) {
    if (n.isPalmMute) bump('palm'); if (n.isDead) bump('dead'); if (n.harmonicType) bump('harm'+n.harmonicType);
    if (n.hasBend) bump('bend'); if (n.slideOutType) bump('slideout'+n.slideOutType); if (n.slideInType) bump('slidein');
    if (n.isHammerPullOrigin) bump('hammer'); if (n.isTieDestination) bump('tie'); if (n.vibrato) bump('vibrato');
    if (n.isLetRing) bump('letring'); if (n.isGhost) bump('ghost'); if (n.isStaccato) bump('stacc'); if (n.isLeftHandTapped || b.tap) bump('tap');
    bump('notes');
  }
}
console.log([...effects].join('  '));
const tempos = score.masterBars.flatMap(m => m.tempoAutomations.map(a => `${m.index}:${a.value}`));
console.log('tempo changes', tempos.slice(0, 20).join(' '), 'repeats', score.masterBars.filter(m=>m.isRepeatStart||m.repeatCount>0).length);
