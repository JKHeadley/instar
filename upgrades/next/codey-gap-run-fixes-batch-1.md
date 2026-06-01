# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Two fixes that a codex-based agent (Codey) found during an autonomous run, reviewed and
landed by Echo:

1. **Beacon-backed promises no longer auto-resolve before they're done.** A tracked
   commitment with a follow-through beacon but no automatic verifier was being marked
   "delivered" seconds after creation — before the beacon ever fired — silently defeating
   the whole follow-through mechanism. Such a commitment now stays pending until the agent
   explicitly delivers it.
2. **The Telegram health check no longer reports a false failure** when the agent is
   running in lifeline-owned polling mode (the in-server adapter is send-only and a
   separate process owns polling). The probe now recognizes that mode as healthy.

## What to Tell Your User

If you use the "remind me / report back" style of tracked promises, they now stay open
until they're actually finished instead of quietly closing themselves early. And your
health view will stop occasionally claiming Telegram is broken when it is in fact working.
Nothing for you to do.

## Summary of New Capabilities

- Beacon-enabled one-time commitments remain pending until an explicit deliver(),
  letting the follow-through beacon actually do its job.
- The messaging probe accepts an optional external-poller signal and reports healthy in
  lifeline-owned send-only polling mode (the connected and polling probes only).

## Evidence

- Spec: `docs/specs/codey-gap-run-fixes-batch-1.md` (+ `.eli16.md`), review-convergence +
  approved by Justin (Telegram topic 17481, 2026-05-31).
- Tests: `tests/unit/CommitmentTracker.test.ts` (beacon-stays-pending + non-beacon
  no-regression) and `tests/unit/MessagingProbe-external-poller.test.ts` (new); `tsc
  --noEmit` clean.
- Origin: findings F007 and F003 from Codey's Codex-on-Instar autonomous gap run,
  ported from a v1.3.78 base and re-verified on current main.
