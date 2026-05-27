# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Eighth increment of the **Feedback Factory Migration** (Dawn → Echo; spec `docs/specs/feedback-factory-migration.md`, approved). Ports the **auto-reopen-on-regression decision** from the reference Python (`cmd_apply_clusters` in `the-portal/.claude/scripts/feedback-processor.py`) into a pure function at `src/feedback-factory/processor/reopen.ts`.

When a new report gets grouped onto a bug that was already marked fixed, resolved, or deferred, the bug is automatically reopened for review. This computes how: a long-deferred bug becomes "new" again (an aged-reopen, logged on its action trail); a fixed/resolved bug becomes "investigating" again and bumps its recurrence counter (a regression, logged on its research notes). It also writes the exact audit note. Pure function; **not wired into any route or job yet** — no behavioral change.

## What to Tell Your User

- The safety behavior that catches a bug "coming back from the dead" — a report landing on an already-fixed bug auto-reopens it instead of silently swallowing it — is now ported, including the audit note that records why it reopened.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Auto-reopen decision (TS port) | Internal module `src/feedback-factory/processor/reopen.ts` — not yet wired |

## Evidence

- The decision is interleaved with database writes in the reference, so equivalence is by faithful transcription plus both-sides-of-boundary unit tests (5): the deferred (aged-reopen) branch vs the fixed/resolved (regression) branch — each asserting the right new status, which field gets annotated, and whether the recurrence counter bumps — plus the audit-note string asserted verbatim and the `fixedInVersion=n/a` fallback.
