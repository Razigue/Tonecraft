/**
 * Cuts one knob cap out of the GUILT head's own photograph.
 *
 * The shell's bands carry knobs too — the chain band's dials — and they were
 * machined violet metal while the amplifier two hundred pixels below wears
 * turned ivory. Drawing a second ivory cap in CSS would be a second cap: the
 * highlight would sit somewhere else and the two would never agree. So the
 * band borrows the amplifier's, cut from the same raster the head is built
 * from, at the same light. Cropped to the cap's own circle — the plate around
 * it is ivory too, and any of it left in the file reads as a halo on a dark
 * panel — and left small: it is shown at ~26 px, and 96 source pixels is
 * already three times that.
 *
 * Measured off `public/images/guilt.webp`, not derived from the knob slots in
 * `app/AmpHead.svelte`: those describe the hit box, which is smaller than the
 * cap the photograph draws.
 *
 *   node scripts/make-guilt-cap.mjs
 */
import sharp from 'sharp';

const SOURCE = 'public/images/guilt.webp';
/** The first cap (GAIN), and its outer edge, in the raster's own pixels. */
const CAP = { x: 323, y: 733, r: 43 };
/** Half a pixel of feather: a hard cut alias-crawls when the panel scales it. */
const EDGE = 0.5;

const S = CAP.r * 2;
const mask = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">` +
  `<circle cx="${CAP.r}" cy="${CAP.r}" r="${CAP.r - EDGE}" fill="#fff"/></svg>`,
);

await sharp(SOURCE)
  .extract({ left: CAP.x - CAP.r, top: CAP.y - CAP.r, width: S, height: S })
  .ensureAlpha()
  .composite([{ input: mask, blend: 'dest-in' }])
  .webp({ quality: 88, alphaQuality: 90, effort: 6 })
  .toFile('public/images/guilt-cap.webp');
console.log(`guilt-cap.webp — ${S}x${S}`);
