# Registry field classification — plain-English overview

## What this actually is

The constitution (`docs/STANDARDS-REGISTRY.md`) is a markdown document where each rule is a section,
and each section is made of labelled fields — `**Rule.**`, `**In practice.**`, `**Earned from.**`,
`**Applied through.**`, and so on. Two pieces of tooling read those labels: a parser that other code
uses, and a CI ratchet that grades how many rules actually name a real guard.

Both of those tools keep a **closed list** of which labels mean what. A label they don't recognize is
counted as "unrecognized," and CI fails if there is even one. That is deliberate — it forces anyone
adding a new label to say what kind of thing it is, instead of letting a new field quietly change how
the constitution is measured.

The operator ruled on seven questions about the constitution on 2026-08-12. Applying those rulings
introduces six new labels. This change tells both tools what those six labels mean.

## What already exists

- The parser: `src/core/StandardsRegistryParser.ts`. It sorts every field label into one of four
  buckets — core, enforcement, provenance, or narrative.
- The ratchet: `scripts/standards-coverage.mjs`. It grades the registry and fails CI on unrecognized
  labels, dangling references, or a coverage regression. It carries its **own copy** of those same
  lists, because it runs before the TypeScript is compiled and cannot import the parser.
- The important distinction: **enforcement** labels get their file references scanned as evidence
  that a real guard exists. Everything else does not.

## What is new

Six labels, in two groups.

**Four provenance labels**, from rulings 4b and 4c. Some rules in the constitution claimed to be
"earned from" an incident that never happened — the field said "recurring" while naming no actual
occurrence. That is a rule borrowing authority it did not earn. The rulings split the honest cases
out of `Earned from`:

- `Grounded in` — a stated value, never derived from a failure.
- `Articulated during` — a principle that emerged in a specific conversation.
- `Ratified from operator policy` — a rule the operator named directly.
- `Provenance status` — the origin is genuinely lost, and the field says so plus what would re-earn it.

**Two narrative labels.**

- `Fails`, from item 2 — states which way a rule fails when the machinery it depends on is missing:
  refuse, or proceed. 57 of the 82 machinery-dependent rules never said, and an unstated direction
  becomes whatever the code happened to do, discovered mid-incident.
- `Judgment-bound`, from ruling 3 — marks a rule that genuinely **cannot** be mechanically checked,
  names the judgment it turns on, and carries what replaces the check: the call must be made with
  enough context, and it gets logged and periodically rated. Ten rules were accepted this way. The
  point is that "a human decides this one" is stated honestly instead of someone building a check on
  the paperwork and calling the rule enforced.

## The safeguard, in plain terms

All six are classified as **not enforcement**, and that is the load-bearing decision.

`Fails` describes what should happen when a guard is **absent**. If it were classified as
enforcement, a rule's account of its own missing guard could be read as evidence that the guard
exists — a rule would grade itself "enforced" by describing its own hole. The same logic applies to
the provenance labels: an origin story is a claim about the past, not a live check.

`Judgment-bound` is the sharpest version of the same point. Its entire content is *"no mechanical
check exists here."* Classified as enforcement, a rule's own admission that it is unguarded would
count as evidence that it is guarded — the over-claim exactly inverted, and the precise defect the
ruling that introduced the label exists to fix.

This mirrors an earlier decision in the same file. `Documented-only until` was classified as
narrative for exactly this reason: a countdown says a guard is **owed**, not that one exists.

## What went wrong while building it, and why that is reassuring

The parser was updated first. The ratchet's hand-copied list was not — so CI reported 62
unrecognized sections against a ceiling of zero, and the commit was refused. The arithmetic matched
the change exactly: 54 `Fails` fields plus 8 provenance fields.

That is the gate working on its own author. It also exposes a real wart worth knowing about: the two
lists are hand-kept mirrors, so the constitution's own rule about canonical migrations — every
consumer must read the new authority — is violated by the tooling that measures the constitution.
That is recorded in a comment at the mirror site rather than silently left for the next person.

## What you actually need to decide

Nothing, if you agree with the classification. The question a reviewer should ask is the one in the
safeguard section: **should any of these six labels be treated as evidence that a guard exists?**
The answer taken here is no for all six, in the conservative direction — a wrong "no" understates
enforcement and shows up as a lower coverage score, while a wrong "yes" would let the constitution
credit itself with guards it does not have.

Verified either way: the coverage ratio is 0.7356 before and after. If a classification had leaked
into enforcement extraction, that number would have moved.
