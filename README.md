# Tonecraft

Guitar amp and effects in a browser tab. No install, no plugin, no driver, no
account, no server.

**Nothing here makes sound yet.** Story 1.1 of epic 1 is complete: the project
scaffolds, builds and deploys. The engine arrives in story 1.3.

---

## Requirements

- **Node 24 LTS** (Krypton). Checked by `engines` in `package.json`.
- **Emscripten 6.0.4**, pinned exactly — not needed until story 1.3.

## Commands

```sh
npm ci        # install exactly what the lockfile pins
npm run dev   # dev server
npm run build # static build into dist/
npm run preview
```

A fresh clone needs no manual step beyond `npm ci`. Everything else is derived.

## Layout

The architecture spine names these directories and fixes the dependency
direction between them. Each carries a `README.md` stating what it owns and
which decisions govern it.

```
schema/   parameter definitions — depends on nothing
dsp/      C++ stages, flat C interface — never imports TypeScript
engine/   chain composition, WASM lifetime, parameter bridge, meter reader
app/      the Svelte island — never imports dsp/
site/     Astro pages (this is Astro's srcDir) — never imports engine/
render/   Node harness driving the same .wasm offline
assets/   source audio and model assets — build output derived from them is not committed
```

Dependencies point one way only:

```
schema ──> dsp ──> engine ──> app ──> site
   │                 │                 ▲
   └─────────────────┴──> render ──────┘
```

## What is not in this repository

No build output, ever — no `.wasm`, no rendered audio, no RMS envelope JSON, no
generated C++ header. CI compiles and renders them, so a `.wasm` and the audio
produced from it cannot drift apart, and no binary enters git history.

The deployed site is therefore a pure function of the commit, and a rollback is
a revert.

## Documents

| Document | What it governs |
| --- | --- |
| `CLAUDE.md` | Working rules, non-negotiable audio and frontend constraints |
| `PRODUCT.md` | Positioning, audience, scope, metrics, legal position |
| `DESIGN.md` | The design system — the source of truth for anything visual |
| `_bmad-output/planning-artifacts/PRD.md` | 50 functional and 18 non-functional requirements |
| `_bmad-output/planning-artifacts/Architecture.md` | The spine: 21 invariants, conventions, stack |
| `_bmad-output/planning-artifacts/epics.md` | 5 epics, 41 stories |
