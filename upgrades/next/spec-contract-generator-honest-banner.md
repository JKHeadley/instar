<!-- internal-only -->

## What Changed

Two fixes to `scripts/generate-spec-contract.mjs`, both found by reviewing the
tool's own output as a build artifact for the first time:

1. **Meta-blockquotes are stripped.** Blocks that talk *about* the document —
   normative-boundary markers, "this file is rationale", scope-change notices —
   are now removed alongside history sections, and counted separately.

2. **The banner stopped overclaiming.** It previously said review history "is
   deliberately absent." That was false: narrative prose that states a rule and
   narrates its own history in the same sentence cannot be separated by a
   transform, and such sentences remained. The banner now states what is removed,
   what is not, and prints the **count of `round-N` references still present**.

**Why it matters.** The first version produced a file claiming to be
normative-only that contained a `NON-NORMATIVE FROM HERE` marker — a boundary
marker inside a document denying it had boundaries. An implementer trusting the
banner would have been trusting a false statement. A tool that lies in its own
header is worse than one with a stated limit, and this tool exists specifically
to stop retired designs from being implemented.

## Evidence

- Before: `inbound-message-recording-gap` generated with **3 meta-blocks
  surviving**, banner claiming history absent, `NON-NORMATIVE` marker present in
  the output.
- After: 1 history section + **3 meta-blocks** excluded, 13% smaller, zero
  `NON-NORMATIVE` occurrences, banner reporting **14 narrative round-references
  remain**.
- Regression check on the large spec: unchanged behaviour — still **37 history
  sections, 0 meta-blocks, 37% smaller** — confirming the new pattern does not
  over-match on a document that has none.
- `--check` passes for both specs after regeneration and reports the new counts.
