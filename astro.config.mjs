// @ts-check
import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import sitemap from '@astrojs/sitemap';
import tailwind from '@tailwindcss/vite';
import { alphaTab } from '@coderline/alphatab-vite';

// Provisional. PRODUCT.md section 7 targets tonecraft.app; the domain is not
// bought yet and trademark clearance (OI-6) has not run. Sitemap and canonical
// URLs derive from this, so it has to be settled before launch.
const SITE = 'https://tonecraft.app';

// GitHub Pages serves a project repository under /<repo>/, so every absolute
// path in the app would 404 there. CI passes the repository name; locally and
// on a custom domain this stays '/'.
const BASE = process.env.BASE_PATH ?? '/';

/**
 * alphaTab 1.8.4 lets a row of effects above the tab share its line with
 * another when one ends on the very beat the other starts on. Both are then
 * drawn on that beat, one over the other: a section name printed across a
 * "P.M.", a tempo across a section name. Without the rule such rows take a line
 * each. The alphaTab code is edited as it is bundled — the page and the layout
 * worker alike — and the build fails if an upgrade has changed it, so the
 * edit cannot silently stop applying.
 */
function alphaTabEffectRows() {
  const RULE = 'if (this.shared.lastBeat === band.firstBeat) return true;';
  return {
    name: 'tonecraft:alphatab-effect-rows',
    enforce: /** @type {const} */ ('pre'),
    /** @param {string} code @param {string} id */
    transform(code, id) {
      if (!id.includes('@coderline/alphatab') || !code.includes('class EffectBandSlot')) return null;
      if (!code.includes(RULE)) throw new Error('alphaTab changed EffectBandSlot.canBeUsed: re-check the effect row fix in astro.config.mjs.');
      return { code: code.replace(RULE, ''), map: null };
    },
  };
}

export default defineConfig({
  site: SITE,
  base: BASE,

  // The architecture spine names the top-level directories. `site/` holds the
  // Astro pages; `app/`, `engine/`, `schema/` sit outside it and are imported.
  srcDir: './site',

  // AD-17: everything is a static file. No adapter, no SSR, no serverless
  // function, ever — GitHub Pages cannot serve one and the product does not
  // need one.
  output: 'static',

  integrations: [svelte(), sitemap()],

  vite: {
    plugins: [alphaTabEffectRows(), tailwind(), alphaTab()],
    worker: { format: 'es', plugins: () => [alphaTabEffectRows()] },
  },
});
