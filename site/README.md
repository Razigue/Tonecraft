# `site/` — Astro pages

**Depends on `app/` and `render/` output. Never imports `engine/`.**

Astro's `srcDir`. Content pages ship no application JavaScript. A preset page
ships at most 2 kB of inline vanilla JS — a play control and the cord — and
imports nothing from `engine/` or `app/`; the ceiling is a build failure, not an
intention (AD-16).

Everything is a static file. No adapter, no SSR, no serverless function, no
custom HTTP header, ever (AD-17).
