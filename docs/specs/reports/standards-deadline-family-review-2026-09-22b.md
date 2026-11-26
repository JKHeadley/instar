# Standards family delta review — the three remaining September 22 countdowns

## Scope and operator authority

This is the follow-on to `standards-deadline-family-review-2026-09-22.md`, which moved
the September 21 countdowns to December 21 and closed by naming what it did NOT cover:
"Four further countdowns are dated 2026-09-22 and were not touched; they expire next and
are outside this review." They have since expired, and the expiry fails
`scripts/lint-documented-only-countdown.mjs` on every commit and CI run repo-wide.

**This review does not inherit the prior review's authority.** The earlier postponement
rested on an explicit operator directive for the September 21 set. No directive covers
this set. The authority for this delta is the operator's approving GitHub review on this
exact commit, which `scripts/standards-direction-guard.mjs` requires and which is not yet
granted — the DIRECTION UNDECLARED refusal stands until it is. Nothing here asserts an
authority that has already been given.

## The delta, measured rather than described

The candidate registry equals its parent after exactly **three** date-token replacements
from `2026-09-22` to `2026-12-21`, occupying two lines because one line carries two
separately tracked countdowns. Zero `2026-09-22` tokens remain in the registry.

The prior report's "four" was an overcount: the parent commit carries three such tokens,
not four. This report is the correct count, and correcting it here rather than repeating
it is the point of writing a second report instead of amending the first.

The three trackers:

| Tracker | Article | Family |
|---|---|---|
| `STD-COUNTDOWN-archiving-never-deletes` | Archiving May Never Mean Deleting | The Substrate |
| `STD-SUBCOUNTDOWN-archiving-never-deletes` | Archiving May Never Mean Deleting | The Substrate |
| `STD-SUBCOUNTDOWN-multi-machine-survivability` | An Instar Agent Is Always a Multi-Machine Entity | Building |

No article text, tracker id, enforcement claim, reference, family membership, countdown
implementation, or family composition changed. **One** is an article-level documented-only
countdown (`STD-COUNTDOWN-archiving-never-deletes`) and **two** are sub-obligation
countdowns; all three had expired, so all three are within the scope this report claims.
The prior report named three article-level countdowns — *The Body and the Mind*, *Close the
Loop*, *Session Input Is a Principal* — and *Archiving May Never Mean Deleting* is the
fourth, which is why exactly one of this commit's three is article-level.

## Families and retained audit lineage

- **Building**: 1 date. Current area digest
  `56e9e4709cb807c51fb6c7d23c8b9bfffe7dac15e56e6fbb1f11166b6434107e`.
- **The Substrate**: 2 dates. Current area digest
  `9b36c471fe967bcd2b07c03c875343b91cfeaba836abcaffb63b5f0a9e7a7e9b`.
- **Shipping, Interaction, The Root, The Fractal**: unchanged, and they retain their
  existing audit records. The six-family area model is unchanged, so no area-model audit
  refresh is required.

This is a review of the date-only delta on top of already-accepted texts, not a new
whole-system audit. The immutable prior evidence and report hashes remain intact.
Reference-resolution floors are preserved exactly as they stand — Building 34/40, The
Substrate 16/26, Shipping 5/7, Interaction 8/13, The Root 1/1, The Fractal 1/1. No
rebaseline permit is used or needed.

## Finding and resolution

The date change invalidated two content-bound family audit records, and the live registry
check correctly refused to call them current — the failure this report resolves surfaced
as a red `Unit Tests` shard, not as a reviewer's judgment. Resolve it by recording the
accepted new family hashes through the existing audit command, leaving floors, family
composition, and unaffected records untouched. Do not edit test expectations.

## What this costs, stated rather than softened

Each countdown becomes a release blocker again on December 21, 2026. That is the price of
the extension, not a claim that anything got safer. Nothing was built for either article:
no guard decides whether a store deletes agent memory, and none decides whether a design
survives the loss of every peer.

**This is the second re-date in two days.** The first moved 38 dates; this moves the three
it left behind. Both are honest responses to a blocked repo, and both are the failure mode
the countdown mechanism exists to make visible — the standard's own resolution is "build
the guard, or have the operator deliberately re-date it — but it may not simply sit," and
re-dating twice running is the cheaper half of that choice taken twice. A third re-date in
December should be read as a pattern rather than an incident, and answered by building one
of the two guards instead.

**The consolidation is itself worth naming.** After this change, 41 of the 43 remaining
countdowns fall on 2026-12-21; the other two are 2026-11-13 and 2026-11-22. That 43 counts
raw countdown date tokens in the registry (4 article-level + 39 sub-obligation);
`lint-documented-only-countdown.mjs` parses 42, because one sub-obligation token sits
outside a parsed article section. Both counts are defensible and the difference does not
move the point. Re-dating has
converted a stream of individually-answerable deadlines into a single cliff that blocks
every commit at once. That is a worse shape than what it replaced, and it is a direct
consequence of answering expiry with postponement twice.

## Independent acceptance

An independent verifier re-derived every factual claim above from the repository rather
than from this report, and **concurred on all eight** — the two-line scope, the three-token
count, the single touched file, the three tracker ids, both family memberships, both area
digests, the predecessor's scope and its "four", and that the change is genuinely date-only.

It also raised two findings, both resolved in the text above before acceptance:

1. **The article-level / sub-obligation split was stated backwards** (the draft claimed two
   article-level and one sub-obligation; the truth is one and two). Corrected. This is the
   same class of prose-ledger miscount this report exists to correct in its predecessor,
   which is precisely why it was worth an independent pass to catch.
2. **The 43-vs-42 counting ambiguity was unnamed.** Now stated explicitly.

One methodological note recorded because it would mislead a future reader attempting the
same proof: a *global* inverse substitution of `2026-12-21` back to `2026-09-22` does NOT
demonstrate byte-identity with the parent, because the parent already carries 38 such
tokens from the preceding change. Only a line-scoped inverse on lines 233 and 477 is sound,
and under that method the result is byte-identical to `HEAD~1`.

Reviewers: `echo:claude-code`, `independent-verifier:claude-code`.
