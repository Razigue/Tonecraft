/**
 * Bakes the two light layers of the GUILT head out of its own photograph.
 *
 * The head is one raster (`public/images/guilt.webp`). Its glass is lit in the
 * image, so switching the amplifier off means laying something over it — and
 * only over the glass, because the cast silver keeps its studio lighting at all
 * times. A chroma key does exactly that, and it used to run in the browser as
 * two SVG filters. Measured, that cost ~600 ms per frame: every change of the
 * layer's opacity re-rasterised a 1180x664 filter, and the meters move it 30
 * times a second. A filter that never changes has no business running at
 * runtime, so it runs here instead, once, and ships as two small images.
 *
 *   shade — black wherever the image is violet, transparent elsewhere. Laid
 *           over the glass at plain opacity, it is the amplifier being off.
 *   bloom — the violet alone, premultiplied and blurred, on black. Screened
 *           over the glass, black contributes nothing, so no mask is needed.
 *
 * Both are cropped to the window plus a margin for the blur's halo, and are
 * placed back in the head's own coordinates by `app/AmpHead.svelte`.
 *
 *   node scripts/make-guilt-layers.mjs
 */
import sharp from 'sharp';

const SOURCE = 'public/images/guilt.webp';
/** The tracery window, measured on the raster, plus room for the halo. */
const GLASS = { left: 95, top: 174, width: 1486, height: 477 };
/** Same spread as the SVG filter it replaces, in the raster's own pixels. */
const BLUR = 5;

/**
 * How violet a pixel is, 0 to 1. The silver is neutral, so red and blue above
 * green is the glass and nothing else. These are the coefficients the two SVG
 * filters carried, kept identical so the light does not change.
 */
const chroma = (r, g, b) => Math.max(0, Math.min(255, 1.5 * r - 3 * g + 1.5 * b));

const { data, info } = await sharp(SOURCE)
  .extract(GLASS)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const n = info.width * info.height;
const shade = Buffer.alloc(n * 4);
const bloom = Buffer.alloc(n * 3);
for (let i = 0; i < n; i++) {
  const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
  const a = (chroma(r, g, b) * data[i * 4 + 3]) / 255;
  shade[i * 4 + 3] = Math.round(a);
  // Premultiplied on black: screen blending ignores black, so the layer needs
  // no alpha of its own and the blur cannot drag the silver into the halo.
  bloom[i * 3] = Math.round((r * a) / 255);
  bloom[i * 3 + 1] = Math.round((g * a) / 255);
  bloom[i * 3 + 2] = Math.round((b * a) / 255);
}

const raw = (buffer, channels) => ({ raw: { width: info.width, height: info.height, channels } });
// The shade is pure black everywhere: only its alpha carries a shape, so the
// colour channels are worth nothing and the alpha is worth most of the file.
await sharp(shade, raw(shade, 4)).webp({ quality: 40, alphaQuality: 70, effort: 6 }).toFile('public/images/guilt-glass-shade.webp');
await sharp(bloom, raw(bloom, 3)).blur(BLUR).webp({ quality: 82, effort: 6 }).toFile('public/images/guilt-glass-bloom.webp');
console.log(`guilt-glass-shade.webp, guilt-glass-bloom.webp — ${info.width}x${info.height}`);
