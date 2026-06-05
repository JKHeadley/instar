---
bump: patch
---

## What Changed

The instar-dev pre-commit gate's decision-audit entries gain a verdict field ('pass' | 'blocked', written as 'pending' and finalized by a process exit hook that also re-stages the corrected file). The riding-the-retry design is unchanged — blocked-run entries still ride the next successful commit — but each entry is now self-describing.

## What to Tell Your User

Nothing user-visible — contributor audit hygiene. Gate audit records that ride into a PR from earlier blocked attempts (often under an unresolved or stale slug) are now labeled as blocked evaluations instead of reading like real shipped decisions.

## Summary of New Capabilities

- Decision-audit entries carry verdict: pass | blocked (pending only if finalization itself failed). Reviewers can distinguish shipped decisions from rode-along blocked evaluations at a glance.

## Evidence

Live recurrence (2026-06-05, twice in one day): echo's PR #836 swept in a blocked-attempt entry labeled with a DIFFERENT PR's slug (the then-freshest stale trace), and codey's PR #842 shipped an "unknown"-slug entry from a pre-trace gate run — both read as real decisions and needed review-time explanation. Pinned by 2 new sandbox tests in tests/unit/instar-dev-precommit-audit-staging.test.ts (blocked run finalizes 'blocked' incl. the STAGED copy; passing Tier-1 run finalizes 'pass') alongside the existing 4; the development itself caught the source-order trap twice (TDZ on the shared variable, exit-before-registration on the hook) — both now documented in code comments and covered by the blocked-path test.
