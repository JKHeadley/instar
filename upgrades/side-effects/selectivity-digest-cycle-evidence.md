# Side effects: one durable row per daily digest cycle

**Version / slug:** `selectivity-digest-cycle-evidence`
**Date:** `2026-11-28`
**Author:** `Echo (Telegram Parity, CMT-2221)`

## Decision and authority

No authority changes. `NotificationSelectivityGate.tickDigest` (src/messaging/NotificationSelectivityGate.ts) writes one ledger row per daily digest cycle while `notifications.selectivity.digest.enabled` is true: `{ category: 'selectivity-digest', sourceContext: 'selectivity-digest', decision: 'digest-cycle', reason, total, categories }` with reason `digest-empty` (nothing to count), `digest-sent` (`onSummary` resolved) or `digest-send-failed` (`onSummary` rejected; `error` holds only the error name when it matches `^[A-Za-z][A-Za-z0-9_]{0,39}$`, else `Error`). The rejection is re-thrown, so the existing warning and next-day cadence are unchanged. No row is written while the digest is off, including the disk-only daily summary that runs with the digest off (that path is not the opt-in digest). The once-a-day guard is unchanged, so at most one cycle row per day per machine.

The digest ladder entry (src/data/feature-ladders.json, `notifications.selectivity.digest`, rung dev-agent-live): `daily-digests` now counts `{category: selectivity-digest, decision: digest-cycle}` instead of `reason: single-use-local-permit`, and a new harm metric `send-failures` is the ratio of `digest-send-failed` over cycle rows, at most 0. `gate-errors` is unchanged. The tracking plan text says what the rows mean. The entry stays `final: default-off-by-preference` with an owner-driver advance: nothing here turns the digest on.

## Data and resource effects

At most one extra JSON line a day in .instar/logs/notification-selectivity.jsonl, counts only (no digest text, no category names, no topic). The existing `single-use-local-permit` row for a sent digest is still written. `digest-sent` means handed to the sender without error, not a delivery receipt; the ladder's plan text says so.

## Rollback and verification

Revert the commit: the cycle rows stop and the ladder counts permit rows again. Files: src/messaging/NotificationSelectivityGate.ts, src/data/feature-ladders.json, tests/unit/notification-digest-cycle-evidence.test.ts. Verification on the M5, 2026-11-28 08:45 PT, all exit 0: the new test file (7 tests) and the 13 other unit files that read the ladder file or the gate (notification-selectivity, notification-disk-push-default, feature-ladders-coverage, MaturationLadder, MaturationLadderService, correction-class-review-graded-evidence, feature-maturation-plan-gate, feedback-drain-fleet-bars, lint-dev-agent-dark-gate, local-route-trust-maturation-bar, localVerify/firstPartReport, notification-selectivity-routes, recovery-maturation-ladder): 245 tests. npx tsc --noEmit -p . clean.

## Second-pass review

**Reviewer:** independent sub-agent (general-purpose), 2026-11-28 08:33 PT, read only. Verdict: CONCUR.

It traced every early return in tickDigest (no row), the digest-off and disk-only paths (no row), the empty path, the send outcome and re-throw, that the digest text, permit and existing `single-use-local-permit` row are unchanged, and that the gate writes the same file the ladder reads (gate root = stateDir; the ladder resolves `.instar/logs/...` against the project). It confirmed the evaluator matches two-key `where` and `of` by strict equality, that no cycle rows means insufficient evidence, that no test pins the old metric, and that the row holds no text, topic or category names. Applied: a test for the disk-only summary writing no cycle row, and the release note's "Before" now says the old count also took in disk-only summaries. Noted, not changed here: the rung's soak restarts because its metrics changed (expected), and the existing `gate-errors` metric probably never matches, since a gate-error verdict is stamped `category: 'uncategorized'`; that is a follow-up for the notification-selectivity owner (Telegram Parity, CMT-2221, by 2026-12-03).

## Class-Closure Declaration

unbounded-self-action: n/a. No new action: the row is written by the existing once-a-day digest cycle, which already exists and is not changed.

## 6b. Operator-surface quality

No visible surface changes. The digest text is unchanged.

## Framework generality

Notification gate internals and the maturity ladder data. Nothing depends on an agent framework or model provider.
