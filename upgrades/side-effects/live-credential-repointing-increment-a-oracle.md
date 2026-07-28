# Side-Effects Review — Live credential re-pointing (Increment A, Step 3: CredentialIdentityOracle)

**Version / slug:** `live-credential-repointing-increment-a-oracle`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `not required` (pure read+classify signal producer, fail-closed, no authority, no writes — see §4)

## Summary of the change

Adds `src/core/CredentialIdentityOracle.ts` (spec §2.3 verify / §2.11) — the implementation of the `IdentityOracle` interface the ledger (Step 2) already depends on. Given a config-home slot, it reads the slot's current credential blob (reusing `readClaudeOauth` from OAuthRefresher — no hand-rolled keychain access), takes the OAuth access token, and asks the read-only `GET /api/oauth/profile` endpoint which account that token belongs to. Returns the raw probed email, or an `unavailable` result on any failure. Pool-mapping (email→accountId) stays in the ledger.

Also: adds `src/core/CredentialIdentityOracle.ts` to the `lint-no-direct-llm-http.js` ALLOWLIST (the profile call is read-only identity bookkeeping, not an LLM inference call — same class as QuotaPoller's `/api/oauth/usage`), and `tests/unit/credential-identity-oracle.test.ts` (9 tests).

Not wired into any runtime construction yet — the ledger is constructed with this oracle at the route/server layer in Step 7. No keychain WRITES (the refresh-before-profile optimization for an expired token is tracked to Step 4/5 when the write funnel exists; until then an expired token classifies `unavailable`, the safe direction).

## Decision-point inventory

- `CredentialIdentityOracle.resolveSlotTenant` — **add** — classifies a slot probe as confirmed-email or unavailable. Signal producer only; returns a value, blocks nothing. Fail-closed: every uncertain outcome → `unavailable` (never a guessed/mismatched identity).

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** The oracle rejects nothing; it returns either an email or `unavailable`. The conservative direction (treat any non-2xx / parse-failure / missing-email as `unavailable`) means a momentarily-flaky probe yields "can't tell" → the ledger quarantines and re-probes, never a wrong assignment. That is the intended safety bias.

---

## 2. Under-block

**Limited.** The oracle does not currently refresh an expired access token before probing (the spec optimization needs the Step-4 write funnel). The effect is a possible spurious `unavailable` on a slot whose token just expired — which is safe (quarantine + re-probe), never a wrong identity. Tracked to Step 4/5. It also cannot detect a token that is valid but belongs to a DIFFERENT account than expected — that's exactly the point: it reports the REAL owner; the ledger/audit compares against expectation (§2.11 divergence).

---

## 3. Level-of-abstraction fit

Correct layer. A `src/core` detector that REUSES the established per-slot blob read (`readClaudeOauth`, OAuthRefresher) and mirrors the existing profile-call shape (QuotaCollector.oauthGet). It does not re-implement keychain access or invent a second profile-fetch convention. The fetch lives behind a bounded timeout and an injectable `fetchImpl` for tests, matching `refreshClaudeToken`'s dependency-injection style.

---

## 4. Signal vs authority compliance

Compliant — textbook signal producer. It reads credential reality and emits a classification; it holds no authority and performs no mutation. Per the spec's RULE 3.1 registration, it is a HIGH-criticality state detector whose fallback is fail-closed (no answer → `unavailable`, never guessed). `docs/signal-vs-authority.md` prescribes exactly this for a brittle external probe. **Second-pass review: not required** under Phase 5 — no block/allow on messaging/dispatch, no session-lifecycle, no gate/sentinel/watchdog, no write. Every classification branch is unit-tested. The high-risk WRITE logic (the staged swap executor) is Step 5 and will carry a second-pass review.

---

## 5. Interactions

- **Lint allowlist** — adding the file to `lint-no-direct-llm-http.js` ALLOWLIST is the only cross-file effect; it is narrowly justified (read-only OAuth identity endpoint, same class as the already-listed QuotaPoller `/usage`). It does not weaken the lint for any other file.
- **No runtime construction yet** — nothing builds this oracle at runtime in this commit, so it cannot race or shadow any existing credential reader. The ledger (Step 2) holds it as an injected interface; the server wires the concrete instance in Step 7.
- It is READ-only against the keychain (via `readClaudeOauth`); it never competes with the QuotaPoller refresh-write or the (future) swap executor.

---

## 6. External surfaces

One external call: `GET https://api.anthropic.com/api/oauth/profile` with the slot's own access token — the same read-only endpoint the official client and QuotaCollector already call, bounded by a 10s timeout. No new outbound surface to other agents/users. No routes added (Step 7). The token is sent only as a Bearer header to Anthropic's own endpoint and is never logged.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN** — the oracle probes credentials in THIS machine's keychain/config homes (a slot only exists on the machine whose keychain holds it). Identity is resolved against the live local credential, so the probe is meaningful only on the machine asking. No replication, no proxied read; another machine's oracle answers about its own slots. This matches the ledger's machine-local posture (Step 2).

---

## 8. Rollback cost

Near-zero. New file + new test + one allowlist line; no runtime construction, no writes, no migration. Plain `git revert`. Because nothing constructs the oracle at runtime yet, a revert leaves no orphaned behavior.
