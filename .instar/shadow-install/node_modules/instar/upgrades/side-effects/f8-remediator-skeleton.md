# Side-Effects Review — F-8: Remediator orchestrator skeleton (Tier-1 subset)

**Version / slug:** `f8-remediator-skeleton`
**Date:** `2026-05-13`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Ships the Tier-1 subset of F-8 from the Self-Healing Remediator v2 spec (`docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` §A1 manifest, §A2 lock-bound co-existence, §A3 capability-token context, §A4 deadline enforcement, §A6 errorCode-provenance gate, §A21 verify-failed strict typing, §A36 essential-runbook validator, §A57 phase tiering).

New module: `src/remediation/Remediator.ts`. A single orchestrator class plus the surface types `ApprovedRunbook`, `RemediationContext`, `ExecutionResult`, `VerifyOutcome`, `BlastRadius`, `Reversibility`, `DispatchOutcome`.

What this PR DOES include (per A57's Tier-1 carve-out):
- Runbook registration with §A6 + §A36 registry-load-time refusal.
- Dispatch loop: match by `eventPrefilter` (errorCode + provenance) + `match()`; refuse `provenance: 'free-text'` events at the matcher; pick highest-priority candidate.
- Lock acquisition via the F-4 `MachineLock` using `tupleHash = sha256(runbookId + signatureHash)`. Existing in-flight lock with same tuple → `covered-by-inline`.
- Intent journal declaration via the F-4 `IntentJournal` (durable witness before any mutation).
- `RemediationContext` carrying `attemptId, runbookId, lockHandle, auditToken (leaf from F-1 keyVault), abortSignal, expiresAt, monotonicDeadline`.
- Deadline enforcement (§A4): an `AbortController` fires at `expectedRuntimeMs`; the dispatcher races the surface against the timer; on deadline, the result is `aborted-deadline` and the lock is released in the `finally` block.
- Verify-outcome wiring (§A21): verify is only called when surfaceCallable returned `outcome: 'success'`; verify-THROW is mapped to `verify-inconclusive` (probe error), never `verify-failed`.
- Audit-append via the F-4 `AuditWriter` at every state transition (`started`, `verified-healthy | verify-failed | verify-inconclusive`, `aborted-deadline`, `no-matching-runbook`, `covered-by-inline`).

What this PR explicitly does NOT include (per A57 Tier-2 carve-out, deferred):
- Trust elevation source.
- Probe authentication (A40, A52).
- Capability-token HMAC enforcement on the surface side (A3, A23, A42).
- Supervisor handshake (A15).
- Runbook registry validation against a signed manifest (A56, A66).
- Child-process SIGTERM/SIGKILL escalation — surfaces (W-1..W-4) implement that; the skeleton's AbortSignal is the in-process enforcement handle only.

Files touched:
- `src/remediation/Remediator.ts` (add)
- `tests/unit/Remediator.test.ts` (add — 12 cases)
- `upgrades/NEXT.md` (modify — preserves F-1..F-4 + Phase 4/5 + ELI16 + API-safety entries)

## Decision-point inventory

- `Remediator.registerRunbook()` — **add** — registry-load-time gate; rejects free-text-provenance prefilters (§A6) and essential-on-non-machine (§A36). Hard error: throws on misconfig so boot fails fast.
- `Remediator.dispatch()` — **add** — orchestration entry; produces a `DispatchOutcome` discriminated union. Five terminal states. Does not throw on policy rejections; throws only on infrastructure failures (lock acquire error not covered by `covered-by-inline`).
- Internal: `matchRunbook()` — defends-in-depth against `provenance: 'free-text'` events even if a runbook somehow registered such a prefilter.
- Internal: deadline race via `Promise.race(racePromise, deadlinePromise)` — the AbortController is the surface-facing signal; the race is the dispatcher-side authority.

No new HTTP routes. No new persistent files beyond what F-4 already creates (audit-projection-*, intent-journal-*, machine-locks/*). The skeleton consumes those primitives; it does not create new file types.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **`provenance: 'free-text'` events never match.** This is by design (§A6). Legacy `.report(...)` callers normalize through DegradationReporter's F-3 shim to `free-text` provenance and route to `no-matching-runbook` (which is fine — they still produce an audit entry; SystemReviewer clusters them for novel-failure proposals). The "rejection" is exactly what §A6 mandates as the structural defense against attacker-shaped error text.
- **Concurrent dispatch against the same tuple while in-flight → `covered-by-inline`.** Intended (§A2). The second caller is not silently dropped — it receives a structured outcome naming the existing attempt. The caller can subscribe to the audit log for the in-flight attempt's terminal outcome.
- **Essential on non-machine blast radius rejected at register-time.** Intended (§A36). A boot-time misconfig fails fast rather than allowing a non-machine runbook to skip auto-quarantine (which would be a DoS vector).
- **Verify probe error → `verify-inconclusive`.** Intended (§A21). The spec explicitly carves out probe error / timeout / unsigned payload as `verify-inconclusive` so attackers cannot DoS a working heal by making the verify probe fail.

There is no legitimate path this PR over-blocks. The four rejections above are all structural defenses with no false-positive surface.

---

## 2. Under-block

**What failure modes does this still miss?**

- **No capability-token HMAC enforcement on the surface side.** A surface that receives `RemediationContext` could theoretically be invoked by a forged context (no token verification on the surface). Tier-2 fixes this with A3 + A23 + A42. The Tier-1 skeleton's mitigation: only the dispatcher creates contexts, and the surface package is co-installed with the dispatcher; in this PR there are no real surface consumers yet (W-1 ships the first one). Forging requires in-process code-exec, at which point all bets are off anyway.
- **No probe authentication.** Verify outcomes from the runbook's `verify()` callback are trusted by-signature only insofar as the runbook author wrote them correctly. A40 will harden this with per-probe leaf-key signatures over the verify envelope. Tier-1 trusts the runbook code itself.
- **No cross-machine coordination.** The lock is per-machine. Two machines healing the same tuple are not coordinated by F-8. Cross-process attempt ledger (A7) and primary-aggregator lease (A47) handle that at Tier-2/Tier-3.
- **No child-process abort escalation.** A surface that spawns a child process and ignores `abortSignal` won't be force-killed by F-8; the dispatcher only signals. Child-process SIGTERM/SIGKILL ladder is W-1's concern. Mitigation: the lock IS released by the dispatcher's `finally` block, so the orphaned child does not block a re-dispatch.
- **No deadline enforcement on `verify()` itself.** If a surface succeeds but verify hangs, the same AbortController fires and the dispatcher returns `aborted-deadline` (the deadline race is around the entire `surfaceCallable + verify` chain). However, verify is not given a separate deadline budget. Tier-2 may refine this.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The Remediator is the orchestrator — its job is *to compose* the F-1..F-4 primitives. It owns:
- Match policy (which runbook fires for which event).
- Coordination policy (lock acquire, tuple compute, covered-by-inline detection).
- Deadline policy (AbortController + timer race).
- Verify-outcome interpretation (success/failure/inconclusive mapping).

It does NOT own:
- Key material (F-1).
- Lock-file format (F-4 MachineLock).
- Intent durability semantics (F-4 IntentJournal).
- Audit-token verification (F-4 AuditWriter's injected verifier).
- Surface implementations (W-*).

Each of those concerns lives in its rightful module. The dispatcher is the thin glue layer that the spec mandates.

No higher-level smart gate is shadowed. The dispatch decision is structural (does the event match this runbook's prefilter?), not heuristic. The signal-vs-authority principle is honoured because matching is deterministic and the authority is bounded to "which surfaceCallable to invoke" — a runbook-author-controlled invariant, not a content-classifier's call.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface beyond structural primitives (errorCode equality, provenance enum membership, runbook id presence).
- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The match function `eventPrefilter.errorCode.includes(event.errorCode) && eventPrefilter.provenance.includes(event.provenance) && runbook.match(event)` is precise, not heuristic. There is no regex, no string-pattern matching, no LLM call. The only "intelligence" is the runbook author's `match()` callback, which is structural code shipped in `src/remediation/runbooks/*` (none exist yet — W-* PRs add them).

The blocking decisions held by the dispatcher (free-text rejection, essential validator, deadline enforcement) are all over precise structural inputs:
- §A6 free-text rejection: enum equality.
- §A36 essential validator: enum equality + boolean.
- §A4 deadline: monotonic clock comparison.

These are exactly the kind of authority that *should* be hard-coded structurally. The smart gate (the runbook author + the user who approves runbook PRs through `/instar-dev`) holds policy authority over which runbooks exist; the dispatcher's job is to enforce structural invariants on registration and dispatch.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** None. There is no existing dispatcher in `src/remediation/`. The closest prior art is the in-line `NativeModuleHealer` path inside the existing native-binding error handling — that path remains untouched in this PR. W-1 ships the wrapper that makes the inline healer addressable from F-8 *as a runbook*, at which point §A2's lock-bound co-existence rule kicks in (both the inline and the F-8 path acquire the same MachineLock tuple; only one runs).
- **Race with adjacent cleanup:** The dispatcher's `finally` block always releases the lock. If `acquireInFlight` succeeded but the surface throws before `surfaceCallable` is invoked (currently impossible — the dispatcher calls it directly), the lock would still be released. The release is idempotent (F-4 contract).
- **Double-fire:** `dispatch()` for the same event called twice concurrently → second call observes the first's lock and returns `covered-by-inline`. `dispatch()` called sequentially → second call proceeds (the first released its lock).
- **DegradationReporter wiring:** F-3 ships `setRemediator(remediatorLike)`. THIS PR does not call `setRemediator()` from anywhere — the dispatcher is constructible but not yet wired into the DegradationReporter pipeline. A subsequent PR (or W-1) wires the dispatcher into the reporter, at which point legacy events route through `dispatch()`. Until then, the dispatcher only fires when called explicitly (e.g., from tests).
- **Audit-projection consumer:** F-4's `AuditProjection` reads from the same file the dispatcher writes to. Live: as soon as the dispatcher is invoked, `AuditProjection.recentByRunbook()` reflects the new entries. No coupling beyond the file path contract.

---

## 6. External surfaces

**Does this change anything visible to other agents, other users, other systems?**

- No HTTP routes, no Telegram surfaces, no dashboard tabs, no config-flip entries, no CLI commands.
- No new file types on disk. The dispatcher consumes the F-4 primitives' files (`<stateDir>/machine-locks/in-flight/*.lock`, `<stateDir>/remediation/intent-journal-*.jsonl`, `<stateDir>/remediation/audit-projection-*.jsonl`, `<stateDir>/remediation/audit-rejected.jsonl`). Files only materialize when the dispatcher is actually invoked.
- The default exported class is a new symbol. No existing imports break.
- The DegradationReporter `RemediatorLike` interface declared in F-3 is structurally compatible with the new `Remediator.dispatch()` signature: both accept `NormalizedDegradationEvent` and return `Promise`. The dispatcher's return type is richer (`DispatchOutcome`), which is a widening from F-3's `Promise<void>` — backwards-compatible.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Trivially low. The dispatcher is a new symbol that is not yet imported by any production code path. `git revert` of this PR removes the class and the test file with zero state migration cost. The on-disk artifacts (audit-projection, intent-journal, machine-locks) are F-4's responsibility; the revert doesn't touch them, and they remain consumable by whichever future PR re-introduces the dispatcher.

If a future consumer-PR (W-1) wires the dispatcher into `setRemediator()` and a bug surfaces, the back-out path is "revert the consumer PR" — the dispatcher itself never runs without a caller. The fail-safe shape of the design means a dispatcher bug cannot break legacy `.report(...)` flow (which never reaches the dispatcher absent a `setRemediator()` call).

---

## Reviewer concurrence (Phase 5)

Not required. This change introduces no live consumers, no block/allow surface for messaging, no session lifecycle, no coherence/sentinel/gate authority. It is foundation infrastructure that becomes load-bearing only once W-1 wires a real runbook. At that point W-1 carries its own side-effects review covering the dispatcher's first production caller.
