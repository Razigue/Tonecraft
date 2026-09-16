# `site/` — Astro pages

**Depends on `app/` and `render/` output. Never imports `engine/`.**

Astro's `srcDir`. Content pages ship no application JavaScript. A preset page
ships at most 2 kB of inline vanilla JS — a play control and the cord — and
imports nothing from `engine/` or `app/`; the ceiling is a build failure, not an
intention (AD-16).

Everything is a static file. No adapter, no SSR, no serverless function, no
custom HTTP header, ever (AD-17).

## Routes

- `/` and `/fr/` — the home pages, one component (`components/Landing.astro`)
  and one copy file (`i18n/landing.ts`). Indexable, `hreflang` paired, JSON-LD
  `SoftwareApplication` and `FAQPage`. No framework script: one inline script
  of a few hundred bytes keeps them in the language the studio last used
  (`tonecraft-locale`), and a `?lang=` link records a new choice. Crawlers keep
  no storage and are never redirected. Motion is CSS only (scroll-driven
  animations, `transform` and `opacity`); the language menu is a native
  popover.
- `/app/` — the studio, the single Svelte island. `noindex`, left out of the
  sitemap: it would compete with the home pages. The home pages link to it with
  `?lang=`, which the studio keeps as its language.

The images are screenshots of the studio, taken from the built site by
`npm run shots` into `assets/landing/`; `astro:assets` serves them as AVIF and
WebP. Re-run it when the studio changes.
