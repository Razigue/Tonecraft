// @ts-check
import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import sitemap from '@astrojs/sitemap';
import tailwind from '@tailwindcss/vite';
import { alphaTab } from '@coderline/alphatab-vite';

// Canonical URLs, the sitemap and robots.txt derive from this. CI passes the
// origin GitHub Pages actually serves — the github.io host today, the custom
// domain once one is set — so a canonical never points at a host that does not
// answer. PRODUCT.md section 7 targets tonecraft.app, not bought yet.
const SITE = process.env.SITE_ORIGIN ?? 'https://tonecraft.app';

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

/**
 * alphaTab 1.8.4's AudioWorklet output starts its buffer source only once the
 * worklet module has loaded, a promise later. A note played from the tab
 * editor that ends before then is paused first: stop() on a source never
 * started throws, and the late callback then starts and connects a source the
 * pause had already dropped. Typing notes quickly did exactly that. The pause
 * tolerates an unstarted source, and the callback gives up if a pause came
 * first. Same rule as above: the build fails if an upgrade changed the code.
 */
function alphaTabWorkletPause() {
  const STOP = 'this.source.stop(0);';
  const LOADED = 'BrowserUiFacade.createAlphaSynthAudioWorklet(ctx, this._settings).then(() => {';
  return {
    name: 'tonecraft:alphatab-worklet-pause',
    enforce: /** @type {const} */ ('pre'),
    /** @param {string} code @param {string} id */
    transform(code, id) {
      if (!id.includes('@coderline/alphatab') || !code.includes('class AlphaSynthAudioWorkletOutput')) return null;
      if (code.split(STOP).length !== 2 || code.split(LOADED).length !== 2) throw new Error('alphaTab changed its Web Audio output: re-check the worklet pause fix in astro.config.mjs.');
      return {
        code: code
          .replace(STOP, 'try { this.source.stop(0); } catch { /* never started: the worklet was still loading */ }')
          .replace(LOADED, 'const started = this.source;\n\t\t' + LOADED + '\n\t\t\tif (this.source !== started) return;'),
        map: null,
      };
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

  integrations: [
    svelte(),
    // The studio is an application, not content: it would rank for nothing and
    // compete with the home page it links from. Each home page lists its
    // translation so the sitemap carries the same hreflang pairs as the pages.
    sitemap({
      filter: (page) => !new URL(page).pathname.endsWith('/app/'),
      i18n: { defaultLocale: 'en', locales: { en: 'en', fr: 'fr' } },
    }),
  ],

  vite: {
    plugins: [alphaTabEffectRows(), alphaTabWorkletPause(), tailwind(), alphaTab()],
    worker: { format: 'es', plugins: () => [alphaTabEffectRows(), alphaTabWorkletPause()] },
  },
});
