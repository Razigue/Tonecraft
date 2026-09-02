// @ts-check
import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import sitemap from '@astrojs/sitemap';
import tailwind from '@tailwindcss/vite';

// Provisional. PRODUCT.md section 7 targets tonecraft.app; the domain is not
// bought yet and trademark clearance (OI-6) has not run. Sitemap and canonical
// URLs derive from this, so it has to be settled before launch.
const SITE = 'https://tonecraft.app';

export default defineConfig({
  site: SITE,

  // The architecture spine names the top-level directories. `site/` holds the
  // Astro pages; `app/`, `engine/`, `schema/` sit outside it and are imported.
  srcDir: './site',

  // AD-17: everything is a static file. No adapter, no SSR, no serverless
  // function, ever — GitHub Pages cannot serve one and the product does not
  // need one.
  output: 'static',

  integrations: [svelte(), sitemap()],

  vite: {
    plugins: [tailwind()],
  },
});
