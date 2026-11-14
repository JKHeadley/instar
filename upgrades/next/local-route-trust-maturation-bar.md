<!-- bump: patch -->
## What Changed

Same-machine agent trust (`threadline.localRouteTrust`, still dry-run) now keeps evidence the maturation ladder can judge it by (CMT-1141).

- Every decision row in the evidence log names its sender in a top-level `subject` (the fingerprint, else the cleaned claimed name). Each would-refuse row also keeps the sender and the reason (`refuseReason`, for example `untrusted-may-not-message`), at most one row per sender and operation per minute, each saying how many it stood for.
- The ladder bar for the next rung (dev-agent-live, which turns refusals on) adds: at least 3 distinct senders, at least 1 would-refuse decision, and no would-refuse graded wrong (graded with `POST /maturation/evidence`, `kind: outcome`, `reason: would-refuse`, `gradesEventId`).
- Evidence rows gain an optional `subject` field any feature can use to count distinct things on its bar.
- A drill, `scripts/drills/local-route-trust-drill.mjs`, runs two throwaway agents (no channels, no relay network) and proves an unprofiled same-machine sender with its relay off gets a would-refuse row while its message is still delivered.

## What to Tell Your User

Nothing changes for you. Messages between agents on the same computer are delivered exactly as before. Behind the scenes, the safety check that may later refuse untrusted senders now has to show it has seen several senders and made correct refusal calls before it is allowed to start refusing.

## Summary of New Capabilities

- Would-refuse evidence rows naming the sender and the reason, for same-machine agent trust.
- A stricter, evidence-based bar before same-machine agent trust can enforce.
- An optional `subject` field on maturation evidence rows for distinct-count bars.

## Evidence

- Unit: `tests/unit/local-route-trust-maturation-bar.test.ts` (rows, the three bars read with the real ladder refs, the shipped ladder file parses), `tests/unit/a2a-local-route-trust.test.ts`, `tests/unit/FeatureEvidenceLog.test.ts`.
- Integration: `tests/integration/threadline/a2a-local-route-trust.test.ts` (a dry-run would-refuse on the real route writes the row and is delivered).
- Drill: `node scripts/drills/local-route-trust-drill.mjs` — 9/9 on the Studio, 2026-11-11.
