# Side-Effects Review — F-4: MachineLock + IntentJournal + audit infrastructure

**Version / slug:** `f4-machine-locks-intent-journal-audit`
**Date:** `2026-05-13`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Foundation Tier-1 primitives for the Self-Healing Remediator v2 spec. Four new modules under `src/remediation/`:

- `src/remediation/MachineLock.ts` — In-flight HMAC-locked tuple coordination + heartbeat + SIGKILL-grace stale-reclamation.
- `src/remediation/IntentJournal.ts` — Append-only intent declaration log.
- `src/remediation/audit/AuditWriter.ts` — Verified audit-projection append path with token + watermark gating.
- `src/remediation/audit/AuditProjection.ts` — Read view exposing `Map<runbookId, AuditEntry[]>`.

This PR ships the primitives ONLY. No surface (memory-healer, supervisor preflight, delivery-retry, db-corruption) wires into them in this PR. The dispatcher (F-8), runbooks (W-*), and the primary-aggregator lease (A47, Tier-3 scope) consume these in subsequent PRs.

The change is foundational infrastructure: it adds capability surface, it does not remove or replace any existing decision point.

## Decision-point inventory

- `MachineLock.acquireInFlight()` — **add** — gates whether a tuple is currently being healed; rejects concurrent acquisition until stale (A63) or released.
- `MachineLock.listInFlight()` — **add** — read primitive; filters out forged lockfiles via HMAC.
- `AuditWriter.append()` — **add** — gates whether an audit entry is persisted to the projection vs. quarantined to `audit-rejected.jsonl` (token-verify + A42 watermark).

All three decision points operate on cryptographic primitives (HMAC verify, monotonic watermark) provided by the caller. They do not contain content classification, heuristics, or "guess intent from text" logic.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- `MachineLock.acquireInFlight()` rejects a second attempt against the same `tupleHash` while the first lock is active. This is the intended contract (A2 lock-bound co-existence) — a second concurrent attempt should be observed as `covered-by-inline` by the caller, not coalesce. Legitimate use is one-attempt-at-a-time per tuple; concurrent attempts are *exactly* what the lock exists to prevent.
- `AuditWriter` rejects entries whose `auditToken` doesn't verify. By design — forging the token forges authority. Production callers obtain the token from `RemediationContext`, which is issued by the dispatcher at attempt-start.
- `AuditWriter` rejects entries whose `timestamp < highWatermark` for the same `(subsystem, attemptId)` pair. A legitimate use case for backdated entries doesn't exist in this design — per-attempt audit is forward-monotonic. If a real backdated write becomes a requirement, the design pivots from "drop" to "queue-for-reconciliation"; that's a future amendment, not a bug in this PR.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Cross-machine collision on `tupleHash`.** The lock is per-machine. Two machines healing the same tuple are not coordinated by F-4. The cross-process attempt ledger (A7, F-2) and the primary-aggregator lease (A47, Tier-3) are the cross-machine coordinations; F-4 is intentionally scoped to single-machine in-flight.
- **Forged-lock-with-correct-HMAC.** An attacker with the leaf key can forge a lockfile that passes verification. The mitigation lives in `RemediationKeyVault` (F-1): per-context, per-scope leaf-key derivation from OS-keychain-sealed master + install nonce (A20/A39/A51). F-4 trusts the caller-supplied verifier; key-management is F-1's job.
- **Slow-but-alive surface vs. crashed surface.** A surface whose heartbeats are landing but whose work is genuinely stuck would NOT be reclaimed — the stale-reclamation logic deliberately requires BOTH grace clauses (A63). The Remediator-side deadline (A4, F-8) is the second line of defense; it's not F-4's concern.
- **Audit-rejected flood from a compromised peer.** If a forger spams `append()` with bad tokens, `audit-rejected.jsonl` grows unbounded. A27/A49's rate-cap + first-5/last-5 forensic flood-summary handles this; that wraps the write path in F-2's `RemediationGc` rather than living inside `AuditWriter`. F-4 produces the durable forensic record; F-2 trims it.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. These are *primitives*. They expose:
- A coordination primitive (`MachineLock`) — synchronous semantics, no policy.
- A durable-witness primitive (`IntentJournal`) — append + read.
- An authorisation primitive (`AuditWriter` + `AuditProjection`) — verify-and-persist, no semantic interpretation.

Policy (when to acquire, when to declare, when to write) lives in the dispatcher (F-8). Key management lives in `RemediationKeyVault` (F-1). The split is the spec-mandated layering.

No higher-level gate is being shadowed. The closest prior art (`CoordinationProtocol.ts`) operates over `AgentBus` for cross-machine work coordination — a different concern. F-4's spec-level decision (A56) defers reuse of `CoordinationProtocol`'s lease channel to the Tier-3 primary-aggregator PR; this PR introduces no parallel lease file.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface beyond crypto-verified primitives.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The "blocks" in this change are HMAC verification and monotonic counter checks. Both are precise, deterministic primitives — not heuristic detectors. The signal-vs-authority principle is about brittle string-matching / pattern detectors holding blocking power; cryptographic verification is the canonical *correct* place to block. The blocking decisions here (forged token → rejected, stale lock → reclaim) are exactly the kind of authority that *should* be hard-coded.

The smart gate (Remediator dispatcher in F-8) is the consumer that decides *whether to attempt* a heal given the lock state; F-4 only exposes the state.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** None. No existing audit path or lockfile primitive in `src/remediation/` (this is the first module in that directory). Prior art `src/core/CoordinationProtocol.ts` is for cross-machine work avoidance, not in-flight remediation tuples. Prior art `src/core/WorktreeKeyVault.ts` is a sibling of F-1's `RemediationKeyVault`; both share the keychain-fallback pattern but no decision-point overlap.
- **Race with adjacent cleanup:** `MachineLock.reclaimStale` renames the lockfile into `orphaned/`. A racing `acquireInFlight` for the same tuple would see the rename happen first (the cache-divergence check stat()s before deciding); the post-reclaim acquire writes a fresh file. If the rename and the next acquire interleave on different machines, the per-machine state-dir scoping prevents cross-host interference. If they interleave on the SAME process via concurrent in-process callers, the second caller's `readVerifiedLock` returns `undefined` (cache invalidated, file just renamed) and falls through to the new-acquire path — both end up writing, the second `fs.renameSync` (atomicWriteLock's rename) is the final state. The atomic-rename guarantees one envelope ends up authoritative; the second caller's `attemptId` may "win" silently. Single-process concurrent acquisition of the same tuple is a contract violation, not a supported use case — the dispatcher serialises by tuple.
- **Double-fire:** `release()` is idempotent (uses a local `released` flag + ENOENT-tolerant unlink). `heartbeat()` throws after release. `append()` is idempotent only in the sense that duplicate entries land twice; the in-memory tail cap absorbs the bloat. The dispatcher is responsible for at-most-once `append` per state-transition.

---

## 6. External surfaces

**Does this change anything visible to other agents, other users, other systems?**

- New directories on disk: `~/.instar/machine-locks/in-flight/`, `~/.instar/machine-locks/orphaned/`, `<stateDir>/remediation/`. All created lazily by the modules at first use.
- New file types: `<tupleHash>.lock`, `intent-journal-<machineId>.jsonl`, `audit-projection-<machineId>.jsonl`, `audit-rejected.jsonl`.
- Per A14, the `audit-projection-*.jsonl` and `intent-journal-*.jsonl` paths are per-machine, not git-synced, not backed up. F-7 (PostUpdateMigrator) adds the gitignore entries and the backup-exclusion config; this PR doesn't ship that wiring — the files simply won't exist yet on any installation that doesn't enable the Remediator surface.
- No HTTP routes, no Telegram surfaces, no dashboard tabs, no config-flip entries.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Trivially low. No consumers of these modules ship in this PR — `MachineLock`, `IntentJournal`, `AuditWriter`, `AuditProjection` are new symbols not yet imported anywhere in `src/`. A `git revert` removes them with zero state-migration cost. The on-disk files (lock, journal, audit-projection) are not created until first call from a consumer; no installation that doesn't add F-1/F-8 will ever materialise them.

If a future consumer-PR exposes a bug in one of these primitives, the back-out path is "revert the consumer PR" — these primitives don't run on their own.

---

## Reviewer concurrence (Phase 5)

Not required. This change touches no block/allow surface for messaging, no session lifecycle, no coherence/sentinel/gate authority. It is foundational infrastructure with no live consumers in this PR.
