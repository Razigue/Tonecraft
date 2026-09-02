# PRD Quality Review — Tonecraft v1 MVP

## Overall verdict

The PRD holds up on the dimensions that usually fail: it states decisions as decisions, names what each choice cost, and carries a real thesis (the engine is a renderer, not the product) that the scope actually follows. What is at risk is downstream: there is no glossary, the FR IDs drift out of order in FG-H, inferences made during drafting were never tagged as assumptions, and a handful of FRs describe behaviour without a testable bound. None of these threaten the argument; all of them will hurt story generation.

## Decision-readiness — strong

Every significant choice is stated with what was given up. The Drive and Reverb promotions carry an explicit CPU consequence ("essentially no headroom left"). The high-gain choice carries its cost in §2 UJ-3 and in addendum §C. §10 lists six repository lines the PRD contradicts rather than quietly diverging from them, and §9 keeps four genuinely open items open. No finding.

## Substance over theater — strong

No standalone persona section; persona context sits inline in the journeys where it drives something. No differentiation section written for its own sake. NFRs carry product-specific thresholds (25% of a core, 400 KB, 8 ms main thread, 128-frame quantum) rather than adjectives.

### Findings
- **low** UJ-2's step 4 ("she may never plug anything in") is the only step in any journey with no product behaviour attached (§2) — it is framing, not a journey step. *Fix:* keep the sentence, it earns its place as scope honesty, but it is prose rather than a step.

## Strategic coherence — strong

The thesis is stated in §1 and the scope follows it: the listen path is Must, the play path is built first because it is a build dependency, and the one preset is defended by "width is cut, depth never is." Success metrics validate the thesis (dropouts first, absolute latency deliberately absent) and counter-metrics guard against gaming them.

### Findings
- **medium** The growth loop rests entirely on FR-29/FR-30 (tone link and file), and UJ-1 step 5 is named as "the only step in v1 where one user creates another" — but no success metric measures file sharing, only links (§7). *Fix:* either add a file-share counter-metric or state that files are deliberately unmeasured because they leave the product.

## Done-ness clarity — thin

This is the weakest dimension and the one story generation leans on hardest.

### Findings
- **high** FR-27 ("changes the live tone immediately") has no testable bound (§5 FG-E). *Fix:* bound it to one render quantum with no zipper noise, which is what `AudioParam` interpolation in FR-19 actually buys.
- **high** FR-38 ("accuracy is independent of round-trip latency") states an independence, not an accuracy (§5 FG-G). *Fix:* give the tuner a cents tolerance.
- **medium** FR-35 ("dropouts are counted continuously and surfaced in the UI") does not say what counts as a dropout (§5 FG-F). *Fix:* define it against the worklet's own render deadline.
- **medium** FR-2's "0 kB of application JavaScript" is exact but unenforced. *Fix:* make it a build-time assertion, not a stated intention.

## Scope honesty — adequate

§8 is a real non-goals list and §10 is unusually honest. But inferences made while drafting were never marked.

### Findings
- **high** No `[ASSUMPTION]` tags anywhere, though at least two inferences were made and logged only in the memlog: that v1 ships one drive rather than three, and that stakes are launch-grade. *Fix:* tag them in place and index them.

## Downstream usability — thin

### Findings
- **high** No glossary. "Cord", "tone link", "tone file", "chain state", "listen path", "play path", "DI loop", "oversampling window" and "dropout" are all load-bearing and all used without definition (whole document). Story generation will drift on these. *Fix:* add one.
- **medium** FR IDs in FG-H run 40, 41, 42, 44, 45, 43 — non-contiguous placement (§5 FG-H). *Fix:* renumber in reading order.

## Shape fit — strong

Consumer product with meaningful UX and two disjoint load paths: journey-led with named protagonists is the right shape, and the journeys are load-bearing rather than decorative. UJ-1 and UJ-3 are correctly split, because the product's behaviour diverges before the first note rather than after it.

## Mechanical notes

- UJ IDs contiguous and each has a named protagonist. Good.
- NFR IDs contiguous (NFR-1..NFR-15). Good.
- Cross-references resolve: OI-4 → addendum §D, FR-44 → §10, addendum §A → FR-16. Good.
- OI-3 is struck through rather than removed, which preserves the audit trail. Keep.
