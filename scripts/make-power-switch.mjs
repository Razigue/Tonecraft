/**
 * Cuts the GUILT head's power rocker out of its two source renders.
 *
 * Like the boost lever, the rocker is a control the head's own photograph has
 * no place drawn for, so it is photographed separately, on and off
 * (`assets/guilt/power-*.webp`). Both renders are 1254 px square and share one
 * fixed part — the bezel the rocker is bolted into — which in these two is
 * already at the same pixels: their alpha bounding boxes are identical. So
 * there is no circle to hunt for here, as there is for the lever; the bezel's
 * own box is the frame, and cropping both to it leaves two images that can be
 * laid over each other and cross-faded. The rocker tips and the lamp lights;
 * the metal they are bolted to does not move, which is what a switch does.
 *
 * The rocker replaces a bezel that used to be built in CSS, about fifteen
 * declarations of gradients, insets and a `perspective` to tip a face on. It
 * never read as the same object as the plate it was cut into, for the reason
 * the whole head stopped being drawn: a photograph of cast metal and a
 * gradient do not sit on the same surface.
 *
 *   node scripts/make-power-switch.mjs
 */
import sharp from 'sharp';

/** Four times the width the switch is drawn at on the head, for dense screens. */
const OUT_WIDTH = 240;

/** The opaque part of a render: the bezel, which is the outermost thing in it. */
async function bezel(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, right = -1, top = info.height, bottom = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] <= 60) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

const boxes = await Promise.all(['on', 'off'].map((s) => bezel(`assets/guilt/power-${s}.webp`)));
const same = JSON.stringify(boxes[0]) === JSON.stringify(boxes[1]);
// A pair that no longer shares its bezel cannot be cross-faded: the metal would
// jump between the two states. Better to stop than to ship a switch that moves.
if (!same) throw new Error(`power renders no longer share a bezel: ${JSON.stringify(boxes)}`);

const box = boxes[0];
for (const state of ['on', 'off']) {
  await sharp(`assets/guilt/power-${state}.webp`)
    .extract(box)
    .resize({ width: OUT_WIDTH, height: Math.round((box.height / box.width) * OUT_WIDTH), fit: 'fill' })
    .webp({ quality: 90, alphaQuality: 90, effort: 6 })
    .toFile(`public/images/guilt-power-${state}.webp`);
  console.log(`guilt-power-${state}.webp — bezel ${box.width}x${box.height} at ${box.left},${box.top}`);
}
