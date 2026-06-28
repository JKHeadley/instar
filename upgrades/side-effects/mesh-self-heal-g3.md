# Side-Effects Review — Mesh Self-Heal G3 (lease-gated spawn + single-writer binding lifecycle)

**Change:** G3 of MESH-SELF-HEAL-SPEC. A machine spawns a session for an inbound topic ONLY if it genuinely holds the fenced awake-lease, else it forwards to the holder ("spawn iff holder, else forward"); and a topic→session binding is cleared the instant its session is killed ("a binding exists IFF a live session exists"). Both fed by a shared soak-evidence ledger surfaced read-only at `GET /mesh-selfheal/g3`. Ships **dark + dryRun** behind `multiMachine.sessionPool.ownershipCheckedSpawn`.

**Decision point?** YES — this gates session SPAWN (a decision that constrains agent behavior). Signal-vs-authority applies (Q4 below).

## 1. Over-block (legitimate inputs wrongly rejected?)
The spawn gate's only non-spawn outcome is `forward` (a non-holder forwards to the holder) — that is the CORRECT behavior, not a block, and it only fires when a real forward seam exists. When the forward seam is unavailable the gate SPAWNS anyway (`spawn-forward-unavailable`) — it never strands a message to avoid a duplicate. Single-machine and flag-off resolve to `spawn` (byte-for-byte legacy). The binding-cleanup only clears a binding whose session is being killed (a dead pointer) — it cannot remove a binding for a live session. **No legitimate spawn is rejected.**

## 2. Under-block (failure modes still missed?)
With the flag OFF (default), nothing is enforced — both bugs (duplicate spawn, stale-binding resurrection) can still occur; this is intentional (dark rollout). In dryRun, the gate records the counterfactual but still spawns, so it OBSERVES rather than prevents. The HTTP-path (`/internal/telegram-forward`) gate is record-only (no forward seam there) so even when enabled it does not forward — it relies on the cold-spawn gate for the primary prevention. G2 (nobody-polling) is the bounded backstop for the fail-closed forward path; G2 is a separate increment (tracked, not deferred-orphan).

## 3. Level-of-abstraction fit
The gate keys on the ONE trustworthy authority — `MultiMachineCoordinator.holdsLease()` (the fenced lease) — not a placement view (which the spec foundation note B shows is unreliable from a non-router machine). Binding cleanup hooks the ONE convergence point all kill paths fire (`beforeSessionKill`), so it covers kill/reaper/recovery/transfer-closeout uniformly rather than being bolted onto one spawn path. Correct layer.

## 4. Signal vs authority compliance
`leaseGatedSpawn.ts` is a PURE decision function (no I/O) — a signal producer. Its only authority is "spawn locally vs forward," and it FAILS CLOSED to forward only when a real seam exists, else spawns (never strands). The binding-cleanup is gated dark+dryRun and clears only dead pointers. The `/mesh-selfheal/g3` route is READ-ONLY observability. No brittle check holds destructive blocking authority. **Compliant.**

## 5. Interactions
- `beforeSessionKill` binding-cleanup is registered AFTER the resume-UUID-save listener, so the UUID (kept in TopicResumeMap, keyed by topicId — independent store) is saved before the binding is cleared; clearing never loses resume. Verified by test.
- **Recovery-respawn paths (FIXED — see Second-Pass §RESOLVED).** A context-exhaustion / recovery kill is immediately followed by a SAME-TOPIC respawn (`respawnSession` / `respawnSessionFresh`) that resolves its target via `getSessionForTopic`; clearing the binding first would null that lookup and silently abort recovery. The binding-cleanup now skips such kills (`respawnImminent`, fed by `contextExhaustionKills`) — identical skip-on-respawn semantics to the resume-UUID-save sibling. So "kill → fire the same listener → binding cleared" applies to TERMINAL kills (reaper / operator / transfer-closeout), NOT the kill-then-respawn-same-topic recovery paths.
- The cold-spawn gate and the HTTP-path record share ONE `sharedG3SoakLedger` singleton (server.ts records, routes.ts reads) — no double-counting (distinct callsites).
- Transfer-closeout already closes the old session by KILLING it → fires the same `beforeSessionKill` cleanup. No race with post-transfer closeout; it IS the closeout's binding-clear.
- No shadowing of existing reaper/recovery (they kill → fire the same listener → binding cleared, which is correct).

## 6. External surfaces
New route `GET /mesh-selfheal/g3` (classified INTERNAL_PREFIXES — agent-reads, not a user capability). New audit file `logs/mesh-selfheal.jsonl` (one line per binding transition). No user-visible behavior change while dark. Depends on the lease coordinator being present for non-single-machine gating (null → single-machine no-op).

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local BY DESIGN.** The topic→session binding names a LOCAL tmux session — it cannot be meaningfully replicated (spec §3.3). Its lifecycle binds to the local session. The gate's whole PURPOSE is cross-machine coherence (prevent two machines serving one topic) and it keys on the cross-machine fenced lease. The soak ledger + audit are per-machine observability. One-voice/transfer/URL concerns: the forward path reuses the existing SessionRouter (one owner serves); transfer-closeout clears the binding via the same hook (no strand — durable inbound queue carries in-flight to the new owner).

## 8. Rollback cost
Trivial. Ships dark (`ownershipCheckedSpawn.enabled:false, dryRun:true`) — a strict no-op until deliberately enabled. To back out: leave the flag off (no behavior), or revert the commit. No data migration, no agent-state repair. The audit file is append-only observability (safe to ignore/delete).

## Second-Pass Review

**Concern raised: when the binding-cleanup is ENABLED + live (not dryRun), it breaks context-exhaustion recovery — the artifact's §5 "recovery is unaffected" claim is wrong for that path.**

What I independently verified against the code:
- **Q4 (signal-vs-authority) and the dark+dryRun no-op are sound.** `decideLeaseGatedSpawn` returns `spawn` for `!flagEnabled` (line 77-79) and for `singleMachine` (line 80-82) before ever consulting the lease — a strict byte-for-byte no-op, confirmed. The spawn gate fails toward spawn (`spawn-forward-unavailable` when no seam) and never strands; the HTTP path (`forwardAvailable:false`, routes.ts:16230) is genuinely record-only and unconditionally spawns. No brittle check holds destructive authority.
- **Q5 (resume never lost) is true for the happy path.** The two `beforeSessionKill` listeners are registered UUID-save-first (server.ts:8738) then binding-cleanup (server.ts:8840); EventEmitter fires in registration order, and `TopicResumeMap` persists keyed by `topicId` in a separate file-backed store, so `unregisterTopic` (a topic→tmux map delete) cannot touch the resume UUID. Confirmed.
- **The defect (Q1/Q2 omission).** The UUID-save listener deliberately SKIPS context-exhaustion kills (`!contextExhaustionKills.has(...)`, server.ts:8742) to avoid a death loop, but the binding-cleanup listener had NO such guard. SessionRecovery kills via `killForRecovery` → `terminateSession` → synchronous `emit('beforeSessionKill')` → `unregisterTopic(topicId)` BEFORE it calls the respawn callback. Both Telegram recovery respawns then resolve their target via `telegram.getSessionForTopic(topicId)` and bail on null (`respawnSession` server.ts:9309-9310; `respawnSessionFresh` server.ts:9437-9441). With the binding cleared, that lookup returns null → recovery silently aborts and the context-exhausted session is killed but never respawned. Invisible today (dark+dryRun) but a real regression the moment the flag is promoted — exactly the state the soak is evidence FOR.

### RESOLVED (in this commit)
Took the structural fix, not a "fix-before-promotion" prose note (a deferral the standards forbid): the pure `decideBindingCleanupOnKill` now takes a `respawnImminent` input and returns a distinct `skip-respawn-kill` action (`clearNow:false`) that takes precedence over both `clear` and `dry-run-would-clear` — so a recovery kill neither clears the binding nor records a misleading would-clear counterfactual. The `beforeSessionKill` wiring feeds `respawnImminent: contextExhaustionKills.has(session.tmuxSession)`, giving the binding-cleanup listener IDENTICAL skip-on-respawn semantics to its resume-UUID-save sibling above it. Any gap in `contextExhaustionKills` coverage for fresh-respawn (wedge/AUP) is a PRE-EXISTING property of the UUID-save guard, not introduced by G3 — the two siblings are now consistent. Both sides of the new boundary are unit-tested (`decide` level + `applyBindingCleanupOnKill` wiring: binding SURVIVES, recovery's `getSessionForTopic` still resolves, no audit, no counterfactual). 33 G3 tests green, typecheck clean. The reviewer's §5 narrowing is applied above.
