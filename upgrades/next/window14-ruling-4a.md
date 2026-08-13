# Ruling 4a — 25 constitutional articles retired archivally, 1 relabelled, 3 held live

## What Changed

The operator's seventh Window-12 ruling, after an escalation and an independent review.

- **25 articles retired archivally.** Each keeps its text and gains a retirement record naming the
  date, what superseded the original failure, the live article that now carries its obligations, and
  that it no longer governs.
- **1 relabelled rather than retired** — the registry's sole Root article, whose own provenance
  already said it is a founding lens rather than a single incident. `Earned from` → `Grounded in`,
  the rule text untouched.
- **3 held live**, each with why it is held, an explicit list of what a sufficient replacement must
  cover, a tracked owner, and a review deadline in the document.
- **39 citation sites forwarded.** Every mention of a retired article from a live one now carries
  `(retired <date> → *successor*)` — additive, so the citing article's own claim is unchanged.
- **A new lint** (`lint-retired-article-redirects`) keeps that true: a retired article must name a
  live successor that is not itself retired, every citation site must carry a marker, and the marker
  must agree with the retirement record.

## Evidence

Article count **87** unchanged, enforcement ratio **0.7356** unchanged, dangling **0**, parentage
**13/13 resolving and bidirectional**, **0** surviving articles declaring a retired parent, **39/39**
citations forwarded. Area audit `docs/audits/standards-area-audit-2026-08-13b.json` and its
convergence report, with every claim labelled behaviour-proven or inspection-verified.

The parentage lint is the positive control for the ruling itself: it passes only because *The Body
and the Mind* is held live — five articles declare it as their parent, so retiring it would have
broken the build.

## What to Tell Your User

Nothing changes in how the agent behaves. Twenty-five constitutional rules whose original incident
can no longer happen are now marked retired, with the live rule that carries their obligations named
in each one and at every place they are cited. Nothing was deleted: every existing reference still
resolves, which is exactly why the retired text stays in place rather than being stripped out.

## Summary of New Capabilities

None — this amends the constitution's text and adds one build-time check that keeps references to
retired rules from stranding a reader.
