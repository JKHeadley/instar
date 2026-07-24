# Side-Effects Review — Subscription-pool identity repair

**Version / slug:** `subscription-pool-identity-repair`  
**Date:** 2026-07-15  
**Author:** Instar-codey  
**Second-pass reviewer:** Codex independent reviewer `/root/identity_repair_side_effects_review`

## Summary of the change

This extends the approved live credential re-pointing design in `docs/specs/live-credential-repointing-rebalancer.md`: a live profile probe becomes the identity truth for quota attribution; mismatched slots are marked `identityDrifted`, excluded from capacity and swaps, and surfaced once per episode; a pure census planner proposes exchanges, duplicate vacates, or missing-login residuals; and execution reuses `CredentialSwapExecutor`, its locks, staging journal, oracle verification, quarantine, and audit funnel. The server exposes scrubbed plan/read and execute routes, the host creates and closes deduplicated owner commitments, and scaffold/migration parity teaches existing and new agents the behavior.

## Decision-point inventory

- `QuotaPoller.pollAccount()` — modify — live identity wins over configured identity and opens/closes one drift episode.
- `SubscriptionPool.isLocallyExecutable()` — modify — drifted identities cannot contribute capacity or receive work.
- `CredentialIdentityRepairPlan.buildCredentialIdentityRepairPlan()` — add — deterministic census-to-plan transformation; advisory only.
- `CredentialSwapExecutor.swap()` — modify — mandatory live target-identity preflight under the existing lock before every write.
- `CredentialSwapExecutor.vacateDuplicate()` — add — staged, locked, identity-verified deletion of a duplicate impostor.
- `/credentials/repair-plan/execute` — add — operator/API execution arm, still subject to the existing feature flags and executor safeguards.
- Host repair callback — add — a detected mismatch attempts one bounded repair-plan execution and creates a deduplicated owner commitment for unresolved missing logins.

---

## 1. Over-block

A transient profile-oracle error does not mark drift. A confirmed mismatch does exclude that slot from capacity and swapping until a later matching probe; this can temporarily reduce available capacity if the profile service returns a confidently wrong identity, but it avoids charging or moving an unknown credential. The execute route may refuse a legitimate swap when the mandatory preflight is unavailable or no longer matches the plan; the caller can retry after a fresh census.

---

## 2. Under-block

Drift remains undetected until the next quota/profile probe. A token can also change after the under-lock preflight and before the write because Claude itself is outside Instar's lock; the existing source-slot CAS, post-write identity verification, quarantine, staging recovery, and delayed re-verification bound that residual. A missing credential cannot be fabricated or copied across machines, so it remains an explicit owner-login residual.

---

## 3. Level-of-abstraction fit

The planner is a pure detector over a fresh census and has no write authority. The executor is the existing constrained authority for credential movement: it owns the single-mover lock, per-slot locks, staging, journal, oracle checks, quarantine, and audit. Host wiring may request execution, but cannot bypass the executor. Quota attribution uses the profile endpoint as a hard identity oracle, not a probabilistic heuristic.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design.

The census planner produces evidence and proposed operations. The deterministic preflight directly blocks a mutation under the explicit irreversible-action exception: a slot's live account must equal the expected tenant immediately before a credential write. It is not represented as a smart gate; it is an enumerable safety invariant, and refusals are audited with concrete identity evidence.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic resolves competing live signals. Identity equality, unique slot occupancy, membership, and the one-credential-per-home rule are enumerable invariants. The only autonomous action consumes a fresh plan and is rechecked by the executor; it does not rank urgency, work evidence, or ownership by heuristic.

---

## 5. Interactions

- **Shadowing:** drift exclusion runs alongside quarantine and disabled/maintenance checks; it does not clear or override them. Executor preflight occurs after locks and before existing CAS/staging writes.
- **Double-fire:** attention and owner commitments use stable episode/account deduplication keys. Matching identity closes the drift attention and the corresponding open commitment.
- **Races:** census plans are advisory. Every swap or vacate repeats live identity checks inside the single-mover and slot locks. Ledger reconciliation is explicitly journaled.
- **Feedback loops:** a mismatch can trigger one bounded repair pass; repaired identities settle on the next probe. Drifted slots are excluded, so they cannot repeatedly feed placement or swap selection. Missing-login commitments deduplicate instead of spawning per poll.

---

## 6. External surfaces

- `/subscription-pool` gains scrubbed drift evidence and stops counting drifted slots as available capacity.
- `/credentials/repair-plan` and `/credentials/repair-plan/execute` expose a dry plan and a guarded execution arm; no token bytes are returned.
- Persistent state gains drift episode evidence, explicit ledger reconciliation entries, and duplicate-slot vacate markers.
- Operator action is phone-completable: unresolved accounts create commitments containing existing enrollment links that can be opened from Telegram/dashboard. No shell or file-edit step is required.
- There is no cross-machine credential transfer. Each machine repairs only credentials physically present in its local homes.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer, approval page, or form is changed. The touched operator action uses the existing enrollment-link and commitment surfaces, which are phone-completable and present human account labels; raw token material is never displayed.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN:** credential presence and slot identity are machine-specific security truths, and OAuth credentials must never cross the machine boundary. Pool-scoped reads can report each machine's drift state through the existing `/subscription-pool?scope=pool` fan-out, while repair executes only on the reporting machine. User-facing notices and commitments are deduplicated per local drift episode/account and carry no machine-bound secret URL; enrollment URLs use the existing reachable surface. Durable ledger/drift state intentionally stays with the machine whose keychain it describes.

---

## 8. Rollback cost

- **Hot-fix release:** revert the code and ship a patch; the existing credential executor and ledger remain compatible.
- **Data migration:** no schema migration. Older code ignores the added JSON drift fields; duplicate vacates use the executor's existing `swap` journal operation.
- **Agent state repair:** drift markers or vacated duplicate markers can remain as conservative audit history; no token recovery depends on the new code.
- **User visibility:** rollback removes automated diagnosis/repair and returns to the prior capacity behavior; it does not move credentials during rollback.

---

## Conclusion

The change is clear to ship behind the existing `credentialRepointing.enabled` and `dryRun` controls. The review kept the planner advisory, placed all mutation behind the established staged executor, added mandatory under-lock preflight, made notices and commitments episode-deduplicated, and preserved the no-cross-machine-token boundary. The honest residual is the external Claude writer race already bounded by CAS, verification, quarantine, recovery, and delayed re-verification.

---

## Second-pass review (if required)

**Reviewer:** Codex independent reviewer `/root/identity_repair_side_effects_review`  
**Independent read of the artifact:** concur — no remaining blockers after cache invalidation, attention closure, duplicate-vacate recovery ratchets, honest authority classification, and unknown-identity handling were verified; 50 cited unit tests passed independently.

---

## Evidence pointers

- `tests/unit/credential-identity-repair-plan.test.ts`
- `tests/unit/credential-swap-executor.test.ts`
- `tests/unit/quota-poller.test.ts`
- `tests/integration/credential-routes.test.ts`
- `tests/e2e/subscription-quota-lifecycle.test.ts`
- Four local `test:push` shards, lint, build, and focused 106-test run completed green.
- Follow-up shared-substrate regression: quota polling now carries the ledger-routed account object into identity reconciliation, so an absent or matching oracle cannot silently restore the enrollment home. All 14 direct `CredentialLocationLedger` consumer suites pass (156 tests), including the pre-existing gate contract.
- CI contract follow-up: the repair execution route is explicitly machine-local in the write-domain registry because credentials and their ledger never cross machines. The pre-existing enrollment cancel/complete refusal was a timing-flaky test, not a relaxed route: a deterministic in-flight hook now proves the 409 while completion owns the ID (five repeated integration runs green).

---

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/quota-poller.test.ts ("invalidates cached pre-repair identity...") + tests/unit/credential-identity-repair-plan.test.ts, howCaught: the pure planner emits a finite set bounded by the slot census, the executor invalidates every changed slot, and the immediate post-repair poll is ratcheted to close drift rather than re-drive stale identity; episode/commitment dedup are the notification settling brakes }`.
