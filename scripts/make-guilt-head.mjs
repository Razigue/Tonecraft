/**
 * Bakes the GUILT head's raster out of its source render.
 *
 * The render (`assets/guilt/head.webp`) was made with the signature where the
 * old CSS power rocker was not: the two sat on top of each other at the right
 * end of the plate, the rocker squeezed between the last letter and the
 * cabinet's corner. Now that the rocker is a photographed object with a bezel
 * of its own, it needs that end of the plate, and the signature belongs in the
 * gap between LEVEL and it — centred in it, which is where a signature goes on
 * an amplifier.
 *
 * Re-rendering the head to move it was not an option, so it is moved here, and
 * moved as ink rather than as a rectangle: the script models the plate behind
 * the signature, takes the **signed residual** of the render against that model
 * — which is the ink, its anti-aliasing and the engraved lip that catches the
 * light, all of it, positive and negative — lays the plate back down flat, and
 * adds the same residual back SHIFT px to the left. Nothing is redrawn and
 * nothing is masked, so the signature that comes out is the one that went in,
 * to the level. That is only possible because the plate is almost flat here:
 * measured over the rows the signature occupies, it runs 201 to 212 with a
 * standard deviation along x of about 4, so a per-row ramp between the clean
 * plate either side of it is the plate, to within a level or two.
 *
 * The residual is feathered to zero across the margin between the ink and the
 * region's edge, so the plate's own grain is not laid down twice where the
 * shifted region falls outside the erased one.
 *
 *   node scripts/make-guilt-head.mjs
 */
import sharp from 'sharp';

const SOURCE = 'assets/guilt/head.webp';
const OUT = 'public/images/guilt.webp';

/** How far left the signature moves, in the raster's own pixels. See below. */
const SHIFT = 38;

/**
 * The patch of plate the signature lives on, and the ink's own box inside it.
 * Both measured off the render: ink is anything under 140 of luminance on a
 * plate that sits at about 207.
 */
const REGION = { x0: 1325, x1: 1491, y0: 683, y1: 781 };
const INK = { x0: 1339, x1: 1470, y0: 699, y1: 764 };
/** Clean plate either side of the ink, on the same rows: the ramp's two ends. */
const LEFT = { x0: 1300, x1: 1336 };
const RIGHT = { x0: 1472, x1: 1508 };

/**
 * 92 is the quality the plate survives at. The source is already a lossy WebP,
 * so this is a second generation; measured against the untouched part of the
 * render it lands above 45 dB, which is far under a level of the plate's own
 * variation. Lower, and the flat ivory blocks.
 */
const QUALITY = 92;

const { data, info } = await sharp(SOURCE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;
const at = (x, y, c) => (y * width + x) * channels + c;

/** The mean of one channel over a span of a row: one end of the plate's ramp. */
function span(y, c, { x0, x1 }) {
  let sum = 0;
  for (let x = x0; x < x1; x++) sum += data[at(x, y, c)];
  return sum / (x1 - x0);
}

/** 1 in the ink, falling smoothly to 0 at the region's edge. */
function feather(v, lo, hi, inLo, inHi) {
  if (v <= lo || v >= hi) return 0;
  if (v >= inLo && v <= inHi) return 1;
  const t = v < inLo ? (v - lo) / (inLo - lo) : (hi - v) / (hi - inHi);
  return (1 - Math.cos(Math.PI * t)) / 2;
}

const xL = (LEFT.x0 + LEFT.x1) / 2;
const xR = (RIGHT.x0 + RIGHT.x1) / 2;

// 1. The ink, as what the render has that the flat plate does not.
const residual = new Float32Array((REGION.x1 - REGION.x0) * (REGION.y1 - REGION.y0) * 3);
const plate = new Float32Array(residual.length);
for (let y = REGION.y0; y < REGION.y1; y++) {
  const wy = feather(y, REGION.y0 - 1, REGION.y1, INK.y0, INK.y1);
  for (let c = 0; c < 3; c++) {
    const l = span(y, c, LEFT), r = span(y, c, RIGHT);
    for (let x = REGION.x0; x < REGION.x1; x++) {
      const bg = l + ((r - l) * (x - xL)) / (xR - xL);
      const i = ((y - REGION.y0) * (REGION.x1 - REGION.x0) + (x - REGION.x0)) * 3 + c;
      plate[i] = bg;
      residual[i] = (data[at(x, y, c)] - bg) * wy * feather(x, REGION.x0 - 1, REGION.x1, INK.x0, INK.x1);
    }
  }
}

// 2. The plate, laid back down flat where the signature was.
for (let y = REGION.y0; y < REGION.y1; y++) {
  for (let x = REGION.x0; x < REGION.x1; x++) {
    for (let c = 0; c < 3; c++) {
      const i = ((y - REGION.y0) * (REGION.x1 - REGION.x0) + (x - REGION.x0)) * 3 + c;
      data[at(x, y, c)] = Math.max(0, Math.min(255, Math.round(plate[i])));
    }
  }
}

// 3. The same ink again, SHIFT to the left.
for (let y = REGION.y0; y < REGION.y1; y++) {
  for (let x = REGION.x0; x < REGION.x1; x++) {
    const dx = x - SHIFT;
    if (dx < 0) continue;
    for (let c = 0; c < 3; c++) {
      const i = ((y - REGION.y0) * (REGION.x1 - REGION.x0) + (x - REGION.x0)) * 3 + c;
      const v = data[at(dx, y, c)] + residual[i];
      data[at(dx, y, c)] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
}

await sharp(data, { raw: { width, height, channels } })
  .webp({ quality: QUALITY, alphaQuality: 100, effort: 6 })
  .toFile(OUT);
console.log(`${OUT} — signature moved ${SHIFT}px left, centred between LEVEL and the rocker`);
