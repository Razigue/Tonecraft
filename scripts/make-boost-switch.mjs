/**
 * Cuts the GUILT head's boost switch out of its two source renders.
 *
 * The switch is the one control the head's own photograph does not contain, so
 * it is photographed separately, up and down (`assets/guilt/boost-*.webp`).
 * Both renders are 1254 px square and share one fixed part — the round
 * escutcheon the lever turns on — so this aligns them on that circle and crops
 * both to one frame. Aligned, the two can be laid over each other and
 * cross-faded: the lever moves and nothing else does, which is what a switch
 * does. Cropped to a common frame, one position of the plate places both.
 *
 * They are also cut down to the size they are actually seen at: 1254 px for a
 * control drawn 28 px wide is 580 kB of detail nobody will ever see.
 *
 *   node scripts/make-boost-switch.mjs
 */
import sharp from 'sharp';

/** The frame, around the escutcheon's centre: room for the lever either way. */
const FRAME = { left: 245, right: 245, up: 432, down: 352 };
/** Four times the width the switch is drawn at on the head, for dense screens. */
const OUT_WIDTH = 196;

/**
 * The escutcheon's centre. It is the widest thing in the picture and it is a
 * circle, so its widest row is its horizontal diameter, and that row's middle
 * and its own index are the centre. The lever never reaches that width.
 */
async function escutcheon(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let best = { width: 0, x: 0, y: 0 };
  for (let y = 0; y < info.height; y++) {
    let left = -1, right = -1;
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] > 60) { if (left < 0) left = x; right = x; }
    }
    if (left >= 0 && right - left > best.width) best = { width: right - left, x: (left + right) / 2, y };
  }
  return best;
}

for (const state of ['on', 'off']) {
  const source = `assets/guilt/boost-${state}.webp`;
  const centre = await escutcheon(source);
  const width = FRAME.left + FRAME.right, height = FRAME.up + FRAME.down;
  await sharp(source)
    .extract({ left: Math.round(centre.x) - FRAME.left, top: centre.y - FRAME.up, width, height })
    .resize({ width: OUT_WIDTH, height: Math.round((height / width) * OUT_WIDTH), fit: 'fill' })
    .webp({ quality: 90, alphaQuality: 90, effort: 6 })
    .toFile(`public/images/guilt-boost-${state}.webp`);
  console.log(`guilt-boost-${state}.webp — escutcheon Ø${centre.width} at ${centre.x},${centre.y}`);
}
