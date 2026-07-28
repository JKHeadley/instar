---
title: Codey gap-run fixes, batch 1 — commitment auto-deliver (F007) + messaging-probe lifeline mode (F003)
date: 2026-05-31
author: echo
status: in-flight
review-convergence: codey-gap-run-2026-05-31
approved: true
approved-by: Justin
approved-via: Telegram topic 17481 ("Yes, please continue", 2026-05-31, approving the second-wave landing of Codey's verified gap-run fixes)
eli16-overview: codey-gap-run-fixes-batch-1.eli16.md
companion-spec: codex-stranded-draft-recovery.md
---

# Spec — Codey gap-run fixes, batch 1

**Date:** 2026-05-31 · **Author:** echo · **Status:** in-flight

## Context

During an 8-hour Codex-on-Instar autonomous gap run, Codey (a `codex-cli` agent)
identified 11 findings and staged fixes for several in a worktree, but could not
commit them (it lacks the provider-neutral dev-commit path — tracked separately as
a framework issue). Echo, the instar-developing agent, is landing the verified
subset through the dev-gate. This is the mentor loop working end-to-end: the
mentee finds and fixes, the mentor with commit access reviews and lands.

Codey's base was v1.3.78 (current main is v1.3.18x), so these were **ported and
re-verified against current main**, not cherry-picked. Two findings that were
already addressed differently on main (script-job quota bypass) or required deeper
adaptation/migration (F005/F006/F009) are explicitly out of this batch and handled
separately. <!-- tracked: codex-stranded-draft-marker-not-restart-durable -->

## F007 — Beacon-enabled future commitments auto-delivered before the beacon ever beat

### Symptom

A beacon-enabled one-time-action commitment with no machine-checkable verifier was
auto-marked `delivered` on the first verify sweep (resolution: "No automated
verification method — trusting agent acknowledgment"), seconds after creation, with
`heartbeatCount: 0`. The PromiseBeacon never fired, and a PATCH-reopen was rejected
as terminal. This silently defeats the "open a commitment for follow-through"
pattern that CLAUDE.md mandates — and that long autonomous runs depend on. (Codey
found this independently; it matches Echo's own prior finding.)

### Root cause

`CommitmentTracker.isUnverifiableOneTime()` returned true for ANY one-time action
whose `verificationMethod` is undefined/null/manual — including beacon-enabled ones.
Both the constructor backfill and the periodic `verifyOne()` sweep then transitioned
such commitments to `delivered`. But PromiseBeacon explicitly OWNS the follow-through
for beacon-enabled promises: they are supposed to stay pending until the agent calls
`deliver()`.

### Fix

- `isUnverifiableOneTime()` returns `false` when `beaconEnabled` — beacon commitments
  are never "trust-the-ack auto-deliverable" (fixes the constructor backfill path).
- The `verifyOne()` sweep returns `null` (a no-op, stays pending) for a beacon-enabled
  one-time action with no verifier — placed before the unverifiable→delivered branch.

A beacon commitment now stays pending across sweeps; only an explicit `deliver()`
resolves it. Non-beacon unverifiable one-time actions are unchanged (still
auto-delivered, preserving the 51k-violation-tick guard they were added for).

## F003 — Messaging probe reports FAILURE in lifeline-owned polling mode

### Symptom

`/health` system review reported the Telegram adapter/polling probes as failed while
the topic was actively sending and receiving messages — eroding trust by saying
"Telegram broken" when the user-visible relay was fully working.

### Root cause

`MessagingProbe` treated `status.started === false` as a failure. But in
lifeline-owned polling mode the in-server adapter is intentionally **send-only** — the
lifeline process owns polling and forwards messages into the server, so `started` is
false by design.

### Fix

- `MessagingProbeDeps` gains an optional `externalPollerActive?: () => boolean`.
- When `!status.started` AND `externalPollerActive()` is true, the connected and
  polling probes pass (description names the lifeline-owned poller). When the dep is
  absent or returns false, the original failure behavior is byte-identical.
- `server.ts` supplies `externalPollerActive` from the existing `lifelineOwnsPolling`
  flag plus the presence of the `lifeline.lock` file. Only the two started-dependent
  probes (connected, polling) change; the log/topics probes are untouched.

## Safeguards

**No new authority.** Both fixes only relax a too-aggressive failure/auto-resolve.
F007 keeps a commitment pending (it never force-delivers); F003 only converts a
false-negative health failure into a pass when the lifeline demonstrably owns polling.

**No regression.** F007: non-beacon unverifiable one-time actions still auto-deliver
(covered by a test). F003: with the dep absent/false, probe behavior is unchanged
(covered by a test). The Claude/default paths are byte-identical.

## Out of scope (handled separately)

F005 (script jobs run directly), F006 (`retryOnGateSkip` gate-noise flag + its
required migration), and F009 (disabled manifests shadow legacy) need real adaptation
on current main (drifted internal APIs) and, for F006, a `PostUpdateMigrator`
migration Codey's diff did not include. They are deliberately not rushed into this
batch.

## Testing

- `tests/unit/CommitmentTracker.test.ts` — beacon one-time stays pending through
  `verifyOne()`/`verify()`; non-beacon still auto-delivers (no regression).
- `tests/unit/MessagingProbe-external-poller.test.ts` (new) — connected+polling pass
  in lifeline mode, fail without a poller, unchanged when the dep is absent, pass when
  started.
- `tsc --noEmit` clean.
