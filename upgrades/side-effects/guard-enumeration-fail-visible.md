# Side-effects review — guard enumeration fail-distinguishable

**Slug:** `guard-enumeration-fail-visible`  
**Driving spec:** `docs/specs/guard-enumeration-fail-visible.md`  
**Review basis:** ten-round cross-model convergence history plus Justin's 2026-07-31
operator disposition; implementation independently reconciled against the final normative
contract before build.

## Summary and decision inventory

The reaper and stranded-work sentinel now use a typed success/failure enumeration result.
Failure produces an explicit unknown count on each live diagnostic route, a passive bounded
log trace, a named event, and a historical count/time. The background guard posture registers
both components and reports a fresh failed pass as `on-blind`; dry-run and stale retain their
existing higher precedence while the blindness detail remains visible. Only historical
count/time persist. The current blind verdict and last tick remain process-local, so restart
cannot manufacture a clean current verdict.

Persisting a two-record ledger was chosen over an append-only event stream because only the
count and latest time are required. The store uses atomic replace and has a fixed two-record
retention declaration. Corrupt history is named in the server log and never converted into a
false clean current state. A later successful pass clears the live blind state without erasing
history. No worktree eligibility, preservation, or removal decision changed.

## Over-block and under-block

There is no new action refusal. A failed enumeration already prevented cleanup; it now makes
that uncertainty inspectable. The typed result forces every caller to distinguish failure
from an empty list. The remaining under-blocks are explicit: no unprompted alert or exported
metric is added, and the synchronous live routes retain their known event-loop availability
cost. Those are tracked by `CMT-1103` and `CMT-1123` and are not claimed here.

## Signal versus authority

Enumeration success is an invariant fact. `on-blind` is a deterministic projection of the
last completed current-process pass, not an intelligence judgment. The change adds evidence
only. Cleanup authority remains behind the existing merged, clean, idle, race-rechecked,
dry-run, and per-pass-cap gates. No warning, event, counter, or posture row can authorize a
deletion.

## Interactions and external surfaces

Two existing authenticated routes gain additive fields and change a failed scan's count from
zero to null. The existing guard inventory gains one closed-vocabulary state and two optional
runtime fields. The compact peer heartbeat gains an optional `onBlind` count so older peers'
absence means “cannot report,” never zero. The new ledger is machine-local because worktrees
are physical directories on one machine; peer visibility is already proxied by the guard
posture surface.

## Rollback cost

Low. Reverting restores the old response and posture shapes. The bounded ledger can remain
unused without affecting boot or cleanup behavior. No migration or destructive cleanup is
required.

## Class-Closure Declaration

**Class:** `unbounded-self-action` · **Closure:** `n/a`.

This increment does not introduce or modify a self-triggered actuator, cadence, retry loop,
or escalation path. It adds passive evidence to two already-bounded scheduled guards. Their
existing action caps and cleanup gates are unchanged; the new log/event/history writes occur
once per already-scheduled failed pass and cannot schedule another pass.

## Verification

Focused tests passed across the typed Git adapters, both guards, persistence, posture,
authenticated routes, and both real AgentServer lifecycle suites. The named E2E suites each
inject a failed enumeration through production route plumbing and assert the response remains
HTTP 200 while carrying failure status, bounded reason, and a null count. TypeScript, the full
lint chain, and the production build are clean. CI must run both named E2E suites before merge.

CI's no-silent-fallback ratchet initially classified the low-level typed failure return as a
fallback because its lexical scanner matches any catch block returning an object. The catch now
carries the repository's explicit exemption with the architectural reason: the result is consumed
as persisted failure evidence and `on-blind` posture, not substituted success. The exact ratchet
test and 78 focused reaper/Git-adapter tests pass after that audit-only annotation; runtime behavior
is unchanged.
