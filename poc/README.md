# `poc/` — where a tab first sounded like a guitar

**Not part of the site.** Nothing here is imported by `app/` or `engine/`: it is
the bench the tab-through-the-amplifier work was decided on, kept because the
decisions were made by ear against these files and the next change will be too.

The shipped path lives in `engine/di-*.ts` and `engine/tab-*.ts`; this directory
holds the two candidates that were compared, the measurements that chose
between them, and the tools that render a passage to listen to.

## What was compared

| Candidate | What it is | Where it ended up |
| --- | --- | --- |
| **A · Sampler** (`sampler.ts`, `bank.ts`, `palm-mute.ts`) | Real DI notes of one electric guitar, one voice per string | Shipped, ported to `engine/di-sampler.ts` |
| **B · Physical model** (`string-model.ts`) | A digital waveguide per string: delay loop, loss filter, pickup combs | Kept here, not shipped |

The sampler won by ear and on the measurements. Its long-term spectrum lands
within about a dB of the repository's real DI loop above 1 kHz; the model, even
after fitting its voicing to the sampler's (`fit-model.ts`), kept about 5.6 dB
of error and a mid-range the leads did not want. The model is still the answer
if the bank ever becomes impossible to license: it is a few kB of code and no
samples at all.

## The measurements that settled things

- **Palm mutes** (`palm-mute-test.ts`). The bank has muted notes at the 5th fret
  only. Leave-one-string-out, a picked note with the learned palm applied lands
  12.6 dB from a real mute — where two real takes of that same mute are 12.2 dB
  apart, and resampling one down ten semitones is 14.9. That is why
  `engine/di-palm.ts` exists.
- **Holes.** `qa.ts` counts clicks and NaNs; the gate and hole measurements that
  found notes starting 80 ms late, silent hammer-ons and mutes gone in 50 ms are
  now kept honest by `scripts/test-tab-audio.ts`.
- **Cost.** `cost.ts` times the whole thing per second of music.

## Running it

```sh
# The bank the sampler plays, from recordings that are not in this repository.
npx tsx scripts/build-di-bank.ts <dataset dir>

# A passage through each candidate, level-matched, with a page to switch between them.
npx tsx poc/compare.ts "<file.gp>" --auto --out poc/out/<name>

# The shipped path, rendered to a file exactly as the reader plays it.
npx tsx scripts/render-tab.ts "<file.gp>" --bars 30-45 --out poc/out/<name>.wav
```

`poc/out/` is not committed.

## The samples

Developed against **IDMT-SMT-Guitar** (Fraunhofer IDMT), which is CC BY-NC-ND:
usable to build and judge this, never publishable with the site. Shipping the
feature means recording a bank of our own — the format is
`engine/di-bank.ts` and the builder takes any directory laid out like that
dataset's second subset.
