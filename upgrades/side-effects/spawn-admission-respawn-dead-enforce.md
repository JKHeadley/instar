# Side-Effects Review — Respawn-dead admission graduation

**Version / slug:** `spawn-admission-respawn-dead-enforce`
**Date:** `2026-07-16`
**Author:** `Instar-codey`
**Second-pass reviewer:** independent lifecycle reviewer — concurred

## Summary of the change

`SpawnAdmission` now promotes one dry-run row to enforcement: a consumed queued/placement-blocked router verdict at `telegram-respawn-dead` when the effective hard pin names a different, currently-live machine and the same pool/custody gates used by Increment 1.4 are green. `server.ts` supplies the merged effective hard-pin read. Tests cover unit, integration, and E2E composition.

## Decision-point inventory

- Respawn-dead local session creation — modified — refuses the local spawn on exact, corroborated live remote ownership.
- Owner-dark ladder — pass-through — remains dry-run/unchanged when the pinned owner is not live.

## 1. Over-block

The only newly rejected input is a respawn-dead attempt after the router has already queued the same message for a live, differently pinned machine. A stale pin could over-block only if both the merged pin read and the pool liveness view incorrectly agree; durable custody still prevents loss. Other callsites, absent/error pins, local pins, and dark owners remain unchanged.

## 2. Under-block

Unpinned topics and owners not currently reported alive remain in the existing posture, so duplicates from those distinct evidence rows are not prevented by this graduation. That is intentional: the incident's hard-pin evidence rung is affirmative and enumerable; guessing ownership from weaker state would risk silence.

## 3. Level-of-abstraction fit

The existing `SpawnAdmission` authority owns session-creation permission and already consumes the router verdict. Adding the hard-pin corroboration there avoids a parallel server-side blocker. The server supplies only the effective merged pin observation.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

This is deterministic authority over an enumerable ownership invariant, explicitly within the principle's hard-invariant exemption. No keyword/heuristic detector gains authority: router outcome, callsite identity, hard-pin owner, machine liveness, pool posture, and durable custody are structured facts consumed by the existing authority.

## 4b. Judgment-point check

No new competing-signals heuristic is introduced. The action space is fixed by the ratified Ownership-Gated Side Effects floor: a live remote hard-pin owner plus custody means forward, never spawn locally. Ambiguous or unavailable evidence preserves the existing path.

## 5. Interactions

- The router queues before SpawnAdmission runs; the admission seam consumes that exact verdict, avoiding TOCTOU re-derivation.
- Refusal action is `forward`; acknowledged custody prevents loss and avoids owner-dark notices.
- `spawningTopics` and respawn execution remain downstream and are skipped only on the exact refusal.
- The genuinely-dark owner path does not graduate and continues through the existing ladder behavior.
- DuplicateSessionReconciler is not graduated: its owner-copy-survives action is a separate, destructive authority. Closing the spawn door fixes this incident without broadening termination scope.

## 6. External surfaces

Users stop seeing a second local session and duplicate reply during the narrow restart race. No new operator action, URL, API, durable schema, or notice is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local decision over replicated/proxied facts: the effective hard pin comes from the local-plus-replicated HLC fold, and liveness comes from the pool capacity view with the suspect breaker. The decision appropriately differs by front-door machine but converges on the same pinned owner. It emits no notice, creates no durable state, and generates no URL; the existing inbound queue owns custody across machines.

## 8. Rollback cost

Pure code rollback: revert and ship a patch. No migration or state repair is required. During rollback the prior duplicate-session race reopens, but messages remain reachable.

## Conclusion

The change is narrowly fitted to the recurring live incident and closes it at the existing session-creation authority. Dark/error/unowned behavior and destructive reconciliation remain unchanged. Clear to ship after independent lifecycle review.

## Second-pass review

**Reviewer:** independent lifecycle reviewer
**Independent read of the artifact: concur.** The change narrowly binds only respawn-dead with a queued verdict, live remote hard pin, and durable custody, while owner-dark, ambiguous evidence, other callsites, and custody failure retain their existing safe paths.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable. The respawn is triggered by an inbound user message; its recurrence guard is nevertheless covered by the callsite pin plus unit/integration/E2E admission matrix.
