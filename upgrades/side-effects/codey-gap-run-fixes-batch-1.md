# Side-Effects Review — Codey gap-run fixes, batch 1

**Version / slug:** `codey-gap-run-fixes-batch-1`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Land two verified fixes Codey found during its autonomous gap run, ported to current
main. F007: `CommitmentTracker` no longer auto-delivers beacon-enabled future
commitments (they stay pending until explicit `deliver()`). F003: the Telegram
messaging probe accepts an optional `externalPollerActive` signal so it reports healthy
in lifeline-owned send-only polling mode instead of a false failure.

## Decision-point inventory

- **F007 — `isUnverifiableOneTime` beacon exclusion + verify-sweep beacon skip.** Both
  sides tested: beacon one-time stays pending; non-beacon one-time still auto-delivers.
- **F003 — probe pass-vs-fail on `!status.started`.** Both sides tested: poller-active →
  pass; poller-absent/false → original failure; started → pass.

## 1. Over-block

**What legitimate inputs does this change reject?** None. Both changes only *relax* an
over-aggressive terminal transition. F007 stops force-delivering a class of commitments;
F003 stops a false health failure. No new rejection path is introduced.

## 2. Under-block

**What does this still miss?** F007: a beacon commitment with a real machine-checkable
verifier is still verified/resolved normally (only the verifier-less case is held
pending) — intended. F003: only the two started-dependent probes (connected, polling)
are adjusted; the log/topics probes are unchanged. The other three gap-run findings
(F005/F006/F009) are explicitly out of this batch.

## 3. Level-of-abstraction fit

**Right layer?** Yes. F007 lives in `CommitmentTracker.isUnverifiableOneTime` (the one
predicate both the backfill and the sweep consult) plus the `verifyOne` sweep — the
single decision points. F003 lives in `MessagingProbe` (the probe factory) with the
signal injected once at the `server.ts` wiring site, sourced from the existing
`lifelineOwnsPolling` flag.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority added. F007 makes a commitment *more* durable (keeps it pending,
the safe direction). F003 is a read-only health signal that now reads the system more
accurately; it gates nothing. The `externalPollerActive` dep is optional and defaults
to the prior behavior.

## 5. Interactions

- **F007 ↔ PromiseBeacon:** beacon-enabled commitments now remain in the active set, so
  the beacon continues its cadenced heartbeats as designed (previously they were
  resolved out from under it). `deliver()` remains the explicit terminal path.
- **F007 ↔ constructor backfill:** the same predicate gates the boot-time backfill, so a
  beacon commitment loaded from disk is no longer backfilled-as-delivered either.
- **F003 ↔ lifeline:** the `externalPollerActive` source mirrors the existing
  `lifelineOwnsPolling` send-only decision and the `lifeline.lock` presence check
  already used by the lifeline probes. No new files, no new state.
- No interaction with the SessionReaper, sentinels, or any gate.

## 6. External surfaces

No new HTTP routes, no config keys, no Telegram, no new on-disk files. F007 changes the
lifecycle of existing `/commitments` records (a beacon commitment reports `pending`
longer); F003 changes a `/health` probe verdict (fewer false Telegram failures). No
agent-installed file (`.claude/settings.json`, `.instar/config.json`, CLAUDE.md
template, hook, skill, job template) is touched, so the Migration Parity Standard does
not apply to this batch.
