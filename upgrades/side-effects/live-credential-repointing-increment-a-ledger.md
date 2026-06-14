# Side-Effects Review — Live credential re-pointing (Increment A, Step 2: CredentialLocationLedger)

**Version / slug:** `live-credential-repointing-increment-a-ledger`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `not required` (no wired consumers, no keychain writes, no live decision surface — see §4)

## Summary of the change

Adds `src/core/CredentialLocationLedger.ts` (spec §2.2) — the durable, machine-local bookkeeping core that records, per config-home SLOT, which pool account's credential currently lives there. Plus `tests/unit/credential-location-ledger.test.ts` (17 tests). This is Step 2 of Increment A; it is **not wired into any consumer yet** (the §2.2 census re-routing is Step 6) and it performs **no keychain writes** (the staged swap executor is Step 5, the write funnel is Step 4). The identity oracle it seeds from is the injected `IdentityOracle` interface — Step 3 implements it against `api.anthropic.com/api/oauth/profile`.

Decision points the module embodies (all internal bookkeeping postures, not message/dispatch/session decisions):
- **Unknown-mode** on corrupt on-disk state: fail-closed for moves (every mutation throws), fail-open-LOUD for reads (return null + one HIGH attention item). Recovery = a fresh oracle re-seed.
- **Seed-never-guess**: a probed email mapping to ≥2 accounts (ambiguous) or 0 accounts (unknown) REFUSES auto-assignment + quarantines the slot + raises attention.
- **One-home-per-credential** invariant: re-pointing a slot evicts both the slot's prior tenant and any stale assignment of the same account elsewhere.

## Decision-point inventory

- `CredentialLocationLedger.assertMutable` — **add** — refuses every mutation while in unknown mode (fail-closed). No external authority; throws a typed error to the (future) caller.
- `CredentialLocationLedger.seedFromOracle` — **add** — refuse-to-guess on ambiguous/unknown email; quarantine on oracle-unavailable. Produces signals (attention items, quarantine flags), never blocks anything outside the ledger.
- `slotOf` / `tenantOf` — **add** — pure in-memory reads; return null in unknown/never-seeded mode so callers fall back to today's enrollment-home behavior.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** The only "refusals" are (a) mutations while corrupt (fail-closed, the safe direction — the alternative is moving a credential on guessed state) and (b) refusing to auto-assign a slot whose tenant can't be uniquely resolved (the alternative is guessing the wrong account, which would route a session to someone else's credential). Both refusals are deliberately conservative; neither rejects a legitimate user input (there is no user input — it's internal bookkeeping).

---

## 2. Under-block

**Limited block surface.** The ledger does not attempt to detect a credential that the *client itself* rotated out from under it (the §2.3 source-slot CAS + identity audit, Step 5, owns that). A slot whose on-disk blob silently changed tenant between probes would show a stale assignment until the next scheduled audit probe (§2.4). This is by design — the ledger is the record, the audit probe is the divergence detector — and is documented in §2.11. The unknown-mode trigger only fires on *unparseable / wrong-shape* state, not on a semantically-stale-but-valid ledger; staleness is the audit's job.

---

## 3. Level-of-abstraction fit

Correct layer. This is a `src/core` durable-state module mirroring `SubscriptionPool` (atomic tmp+rename save, narrow injected deps). It REUSES the established patterns rather than inventing new ones: the save/load shape from `SubscriptionPool.save`, the injected-attention-callback pattern from `AgentWorktreeDetector`, and an injected oracle interface so the network-touching implementation lives one layer out (Step 3). It does not re-implement keychain access (deferred to the write funnel) or HTTP (deferred to the oracle).

---

## 4. Signal vs authority compliance

Compliant. The ledger is a **record + signal producer**, not an authority over agent behavior. Its strongest action is to *refuse its own mutation* (fail-closed) and to *raise an attention signal* — it never blocks an outbound message, a session spawn, or a dispatch. The identity oracle is registered conceptually as a HIGH-criticality state detector (§2.2 RULE 3.1) whose fallback is fail-closed (no answer → quarantine, never guess) — exactly the signal-vs-authority posture `docs/signal-vs-authority.md` prescribes for a brittle external probe. **Second-pass review: not required** under Phase 5 — there is no block/allow on messaging/dispatch, no session-lifecycle mutation, no wired gate/sentinel/watchdog, and no keychain write in this module. The genuinely high-risk decision logic (the staged swap executor and the live consumer re-routing) lands in Steps 4–6 and WILL carry a second-pass review there.

---

## 5. Interactions

- **No wired consumers yet** — the §2.2 census (QuotaPoller, SessionManager spawn, InUseAccountResolver, etc.) is re-routed in Step 6. Until then nothing reads this ledger, so it cannot shadow or race any existing check. The `state/credential-locations.json` file is new and owned solely by this module.
- **Single-writer** — `version` is a journal sequence under the server-process single-writer assumption (the per-slot write funnel + single-mover mutex are Step 4). This module does not itself spawn writers.
- **Journal pruning** keeps all in-flight + last 50 terminal entries; an in-flight entry is never pruned (so crash-recovery, Step 5, can always find an interrupted swap).

---

## 6. External surfaces

None visible to other agents/users/systems in this commit. No routes (`/credentials/*` is Step 7), no notices except the two internal attention items (unknown-mode, seed-refusal) which only fire on a genuine degradation and are deduped by stable id. The feature remains dark (Step 1's gate); nothing constructs this ledger at runtime yet.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN** — credentials live in each machine's own keychain/config homes, so "which account is in which home" is inherently per-machine. The ledger file is `state/credential-locations.json`, machine-local, NOT replicated — replicating it would be actively wrong (machine B's keychain layout differs). A swap is always machine-local; cross-machine coordination of a topic move is handled by the existing handoff guard (composed-with in Step 5, not here). The attention items it raises are per-machine signals. There is no cross-machine read surface to proxy because the answer is only meaningful for the machine asking.

---

## 8. Rollback cost

Near-zero. New file + new test + a doc progress-log line; no wired consumers, no migration, no keychain mutation. Plain `git revert`. The `state/credential-locations.json` file is only ever created once the (dark) feature constructs the ledger — which nothing does yet — so even a deployed revert leaves no orphaned state.
