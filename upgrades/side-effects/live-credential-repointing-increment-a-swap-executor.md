# Side-Effects Review — Live credential re-pointing (Increment A, Step 5b: CredentialSwapExecutor)

**Version / slug:** `live-credential-repointing-increment-a-swap-executor`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `required` (this is the piece that actually MOVES a credential — the highest-blast-radius code in the increment; result appended below)

## Summary of the change

`src/core/CredentialSwapExecutor.swap(slotA, slotB)` — the staged, identity-verified, repair-safe credential exchange (spec §2.3), built on the Step-5a primitives (async keychain I/O + the durable swap journal) + the Step-4b funnel. Plus `credential-swap-executor.test.ts` (8 tests). Ships **DARK**: nothing calls `swap()` until the feature gate is enabled; boot-recovery of an in-flight journal row is Step 5c.

Flow (each safety property earned in spec review):
1. **Preconditions** — both slots must be EXACT ledger members (rejected `unknown-slot` otherwise, before any path expansion), neither tenant quarantined, same-slot rejected. The whole body runs under `withSingleMover` (one swap at a time) + `withSlotLocks([keyA,keyB])` (canonical order, deadlock-free) so it can't interleave with a refresh (Step 4b) or another swap.
2. **Source-slot CAS re-read (§2.3.1a)** — re-read each slot immediately before the destructive write; a changed-and-parseable blob is ADOPTED (the client's freshest rotated copy) so a stale blob never overwrites a newer one. A changed-but-unparseable blob aborts (no garbage staged).
3. **Staging escrow (§2.3.2)** — COPY blob A to the disjoint `instar-credential-swap-staging-<swapId>` namespace, then journal `begin`. A COPY (not a move): slot A is untouched until the first exchange write, so a crash before it unwinds to a no-op (unit-tested).
4. **Exchange** — write B→slotA, A→slotB (keychain first); metadata (`oauthAccount`) follows best-effort (a metadata failure is repairable → attention, NEVER quarantine). A keychain write failure mid-exchange returns `exchange-write-failed` and leaves the journal+staging for recovery.
5. **Verify on ACCOUNT IDENTITY (§2.3.4)** — the oracle, never token bytes. **Oracle-UNAVAILABLE is treated as 'unavailable', NEVER 'mismatch'**: an unreachable/ambiguous oracle quarantines the slot and STOPS (no repair write). A CONFIRMED mismatch (a reachable oracle returning a different KNOWN account) repairs ONCE from the known-good blob, re-verifies, and quarantines if still wrong.
6. **Commit + delayed re-verify (§2.3.5/6)** — ledger `recordAssignment` for both slots, journal `committed`, **staging RETAINED**. A scheduled (~90s) re-verify frees staging + journals `done` ONLY on a clean both-slots-ok result; any drift quarantines the unconfirmed slot and KEEPS staging (the heal source) — never a blind overwrite.

## Decision-point inventory

- `swap()` preconditions — **add** — reject a non-ledger-member slot / quarantined tenant. A structural guard against turning the (later) route into an arbitrary keychain-write primitive.
- Verify quarantine vs repair — **add** — the §2.3.4 unavailable-vs-mismatch decision: the single most dangerous ambiguity; the executor fails CLOSED (quarantine) on any non-confirming oracle outcome.
- These are mechanism with a deny-by-default bias; none gates messaging/dispatch. The swap NEVER runs while dark.

---

## 1. Over-block
The swap refuses (non-destructively) on: same-slot, unknown-slot, quarantined tenant, swap-in-flight (single-mover busy), slot-busy (lock timeout), an unparseable/refresh-tokenless blob, a staging-write failure. Each is a precondition that must hold for a SAFE exchange; refusing is the correct conservative action (the alternative is a corrupting half-swap). None rejects a legitimate ready-to-swap pair. While dark, `swap()` is never called, so no real input is ever refused.

## 2. Under-block
The executor cannot move a credential it was not asked to, and cannot move one whose identity it cannot confirm post-swap (an unconfirmable slot is quarantined, not left silently wrong). The residual the spec states honestly: identity-verify proves OWNERSHIP, not refreshability — a blob with the right tenant but a stale (server-rotated) refresh token passes identity yet is doomed at next expiry; the always-on identity audit (§2.4, a later step) + the §2.3.6 delayed re-verify are what catch that strand, not this verify alone. Documented, not hidden.

## 3. Level-of-abstraction fit
Correct layer. A `src/core` orchestrator composing the existing primitives (ledger, oracle, funnel, keychain I/O, swap journal) — it invents no new low-level mechanism. It is deliberately the ONLY place the exchange sequence lives, so the crash-decidability reasoning has one home. Verification is delegated to the oracle (Step 3); locking to the funnel (Step 4); bookkeeping to the ledger (Step 2) + the swap journal (Step 5a).

## 4. Signal vs authority compliance
Compliant. The executor holds authority over credential MOVEMENT, but its decision logic is not brittle: every branch is a deterministic, fail-closed response to a concrete observed state (a parse result, a lock outcome, an oracle verdict). The dangerous direction (repair on an oracle outage) is structurally excluded — `verifySlotIdentity` collapses every non-confirming outcome to 'unavailable', and 'unavailable' never repairs. No content heuristic gates anything.

## 5. Interactions
- **Funnel (Step 4b):** the swap takes the SAME per-slot lock (via `credentialSlotKey`) the refresh write takes, so a refresh and a swap on a slot genuinely serialize — the reason Step 4b shipped first. Verified by the single-mover serialization test.
- **Ledger (Step 2):** commit calls `recordAssignment` (which enforces one-home-per-credential); quarantine calls `quarantineSlot`. The swap journal is SEPARATE from the ledger journal (it carries `stagingRef` + pre-swap accounts for recovery).
- **External claude client:** the unlockable interleaving is a client refresh-write between the CAS re-read and the exchange write — narrowed (not closed) by §2.3.1a, with the delayed re-verify + identity audit as the honest backstop.
- No double-fire: the single-mover mutex guarantees one swap at a time machine-wide.

## 6. External surfaces
While dark: none (no caller). Once enabled: the macOS keychain on THIS machine (slot + staging services), two local files (the swap journal state + jsonl history), and a HIGH attention item on a quarantine/verify-failure (operator-visible, deduped per swapId). No network beyond the oracle's existing read-only profile call. No new routes in this step (routes are Step 7).

## 7. Multi-machine posture (Cross-Machine Coherence)
**Machine-local BY DESIGN.** A swap moves credentials within ONE machine's keychain; the single-mover mutex, the per-slot locks, the swap journal, and the staging escrow are all per-machine and must be — they protect a per-machine keychain. Cross-machine coordination of a topic transfer mid-swap is the existing handoff guard's job (the journal-in-flight slots are excluded from placement/polling/balancing until resolved — wired with the balancer in Increment B); this executor does not replicate state, and a swap on machine A is independent of machine B's keychain (separate login lineages).

## 8. Rollback cost
Low while dark. Plain `git revert` of this commit removes the executor; no consumer, no migration, no persisted state created at runtime (the journal/staging are written only once `swap()` runs, which requires the gate ON). If the feature were enabled and a swap misbehaved, the back-out is: disable the gate (`enabled:false`), and any in-flight journal row + retained staging is reconciled by the Step-5c boot recovery (adopt-on-newer, never a blind overwrite). The blast radius of a worst-case unrecoverable clobber is ONE account re-auth (§6), with the correct account flagged — never silent.

---

## Second-pass review

_Appended by the dedicated independent reviewer subagent (Phase 5), 2026-06-13._

**VERDICT: CONCERN → both findings FIXED in this commit (not deferred).** The reviewer ran 5 adversarial probes against a hermetic harness and **confirmed the dangerous invariants hold**: the §2.3.4 unavailable-vs-mismatch invariant is airtight (no path turns a non-confirming oracle into a destructive write, including at the delayed re-verify); the §2.3.1a CAS adopt is safe within the threat model and defended by step-4 verify even outside it; the slotA repair-from-in-memory cannot clobber a newer same-account rotation (that rotation verifies `ok` and skips repair). It raised two real, bounded defects (max severity = spurious quarantine / contract violation, never credential loss):

1. **`delayedReVerify` ran OUTSIDE the single-mover + per-slot locks** — its mutating tail (`keychain.delete(stagingRef)`, `ledger.quarantineSlot`) raced a concurrent swap/refresh on the same slots, contradicting spec §2.3 line 471 ("recovery WRITES acquire the single-mover mutex AND the per-slot locks like any swap"). **FIXED:** `delayedReVerify` now runs its whole verify+write body inside `withSingleMover` → `withSlotLocks([keyA,keyB])`; on a lock-skip (a move in flight) it RE-SCHEDULES (bounded by `MAX_REVERIFY_RESCHEDULES`) and leaves staging in place rather than acting on a stale view. New test: a held single-mover makes the re-verify re-schedule (staging NOT deleted) until the mover frees.

2. **No `isUnknownMode()` precondition** — `getAssignment()` is not unknownMode-guarded, so a corrupt ledger with populated assignments could pass preconditions and then THROW at the commit `recordAssignment` AFTER the keychain was already exchanged, violating the "never throws on a normal path" contract. **FIXED:** `swap()` now refuses upfront with `reason: 'ledger-unknown-mode'` when the ledger is in UNKNOWN mode, AND the whole mover body is wrapped in a try/catch that maps any unexpected throw to `reason: 'internal-error'` (the journal+staging left at phase `exchanged` are reconciled by Step-5c recovery). New test: a corrupt ledger → `ledger-unknown-mode`, keychain untouched.

The reviewer also flagged that **Step 5c (boot recovery) MUST handle the "phase=`exchanged`, credentials already exchanged, ledger partially/not updated" case** (a crash between the two `recordAssignment` calls leaves slotA=accountB, slotB absent via one-home enforcement; the journal at `exchanged` + on-disk credentials make it re-derivable) and the UNKNOWN-mode interaction during recovery's own `recordAssignment`. Both are recorded in the build-plan Step-5c resume notes. Spec-acknowledged residuals (metadata best-effort fire-and-forget; identity-proves-ownership-not-refreshability) were confirmed correctly handled, not defects.
