# `store/` — what the player's browser remembers

One IndexedDB database, `tonecraft`, opened only by `db.ts`. Local to the
player's machine: no server, no account, no identifier (PRODUCT.md §5). Never a
reason to fail — a browser that refuses storage gets "nothing remembered" and
still plays.

| Store   | Key                    | Holds |
|---------|------------------------|-------|
| `state` | out-of-line (`'session'`, …) | Small records. `session` is the rig as it was left (`session.ts`). |
| `media` | `id`, index on `kind`  | Blobs the player gave us (`media.ts`). Today the last DI take (`kind: 'take'`). |

## Rules

- **Migrations are append-only.** `MIGRATIONS[i]` upgrades version `i` to
  `i + 1`; an entry that has shipped is never edited. Adding a store is adding
  an entry.
- **Stored data is untrusted input.** Everything read goes through a
  sanitiser (`sanitizeSession`), clamps to the schema range and drops unknown or
  deprecated parameters before it can reach the chain.
- **A projection, not a source of truth.** Main-thread state is written after
  the fact and read once at load. Nothing reads from here on the audio path.
- **Writes are debounced** (250 ms) and flushed on `pagehide` / hidden tab: a
  fader drag must not become sixty transactions a second.
- **Hardware is not tone.** Device ids and input channel live in the session,
  never in a tone link.
- **Nothing starts by itself.** A restored session never opens an
  `AudioContext` or plays a sound; it only pre-fills what the next gesture uses.

The reader saves its last valid import as `last-score` (`kind: 'score'`). The
recorder saves a completed float32 DI WAV as `last-recording` (`kind: 'take'`),
separately from the imported DI player file. Restoring either never starts sound.

## Planned (cover timeline, backing tracks)

Each is one migration entry and one module, no change to what is here:

- `media` already takes `kind: 'score'` (`.gp`, `.gpx`, `.gp5`) and
  `kind: 'backing'` (audio). Library views list by the `kind` index without
  reading blobs.
- `songs` store (`keyPath: 'id'`): a score's `mediaId`, an optional backing
  `mediaId`, tempo map, tuning, and the tone chosen for it (engineering units,
  same wire format as a tone link).
- `timeline` store (`keyPath: 'id'`, index on `songId`): markers, loop ranges,
  count-in, playback-speed choices — the cover tools. Per-song, so one index.
- `state` gains `openSong` and the transport position, so reopening the app
  lands on the same bar.

When scores arrive, call `navigator.storage.persist()` on the first import —
only then, from the gesture that imports: Firefox asks the player, and that
question belongs to the moment they hand us a file worth keeping.
