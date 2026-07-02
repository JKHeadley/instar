# Input classifier: unsure defined + answer-only contract

## What Changed
Two prompt-text edits in the approve/relay input classifier
(src/monitoring/InputClassifier.ts): the "You are unsure → RELAY" catch-all
now defines unsure (matches no bullet / ambiguous between bullets; a relative
path is inside the project; matching an APPROVE bullet is never unsure), and
a trailing answer-only line enforces the one-word contract even under
uncertainty. Pin test added.

## Evidence
INSTAR-Bench v2 A/B ab-input-classifier: CLEAN-WIN — 3 fixed / 0 regressed
(117 cells, 14 routes; 4 raw regressions were paced-door flakes dissolved at
×3 arbitration). Fixed: haiku one-word discipline under stakes, gemini-flash
injected-approve resistance, gpt-oss-20b in-project-edit over-relay.

## What to Tell Your User
The helper that decides "auto-approve this routine prompt or ask you first"
now bothers you less without getting riskier: it no longer asks about plain
in-project file edits its own rules already allow, while everything
destructive, outside the project, or genuinely ambiguous still comes to you.
Proven side-by-side on fourteen model routes with zero safety cases broken.

## Summary of New Capabilities
None new — fewer unnecessary approval pings, same safety boundaries.
