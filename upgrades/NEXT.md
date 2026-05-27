# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fifth increment of the **Feedback Factory Migration** (Dawn → Echo; spec `docs/specs/feedback-factory-migration.md`, approved). Ports the **fix verifier** — `can_transition_to_verified` — from the reference Python (`the-portal/.claude/scripts/feedback-processor.py`) to TypeScript at `src/feedback-factory/processor/verify.ts`.

This is the logic that decides whether a bug marked "fixed" has actually stayed fixed before it's allowed to move to "verified": a high-confidence check (no recurrence on the fixed version) and a low-confidence fallback (quiet long enough relative to how often the bug used to be reported). The clock and the recent-reports lookup are passed in by the caller, so the decision itself is pure and deterministic. **Not wired into any route or job yet** — no behavioral change.

## What to Tell Your User

- The part of the feedback brain that guards against declaring a bug fixed too early is now ported — it won't mark something verified while reports are still coming in, or before enough quiet time has passed.
- Proven against Dawn's original by feeding both the same fixed clock and the same recent-report data: identical verdicts, 9 for 9 — including the exact wording of the "how many hours" explanations.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Fix verifier (TS port) | Internal module `src/feedback-factory/processor/verify.ts` — not yet wired |
| Verifier parity harness | `node scripts/feedback-factory/verify-parity.mjs` (local; set `PORTAL_PROCESSOR`) |

## Evidence

- **Parity vs the REAL `can_transition_to_verified`:** the harness monkeypatches the reference's clock (`datetime.now`) and database query to fixed per-case values and runs the actual function, then compares the full verdict (allowed, evidence text, recommendation, confidence, verified-by) to the TS port. Result: **9/9 identical** across no-fix-timestamp, silence too-soon vs quiet-enough, version-anchored (recent reports / clean / under-24h fallthrough), the dispatched-at fallback, and a fractional-hours case that exercises Python's round-half-to-even number formatting.
- **CI anchors:** unit tests assert each branch plus the half-to-even rounding, so a regression fails in CI even without the reference checkout.
