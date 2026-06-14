# Side-Effects Review — Live credential re-pointing (Increment A, Step 4b: route writers through the funnel + forbidding lint)

**Version / slug:** `live-credential-repointing-increment-a-funnel-routing`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `required` (touches the live token-refresh hot path — see §5/§7; result appended below)

## Summary of the change

Routes every in-process write to the `Claude Code-credentials` keychain store through the Step-4a `CredentialWriteFunnel` (spec §2.2), and adds the forbidding lint that makes the routing structural:

- **`OAuthRefresher.refreshClaudeToken`** — its single `store.write` is now wrapped in `funnel.withSlotLock(configHome, …)`. A lock-acquire timeout returns the NEW typed reason `write-skipped` (the exchange already succeeded; the existing, still-valid credential is untouched). `RefreshDeps.funnel` is injectable, defaulting to the process-wide `credentialWriteFunnel` singleton.
- **`QuotaPoller.pollAccount`** — maps `write-skipped` to "no snapshot this cycle, retry next tick", explicitly NOT `markNeedsReauth`. A busy lock can never cry-wolf a healthy login into needs-reauth.
- **`CredentialProvider`** — adds `writeCredentialsSerialized(provider, slot, creds, funnel?)`, the sanctioned chokepoint that wraps `provider.writeCredentials` in `withSlotLock`. `KeychainCredentialProvider.writeCredentials` (the raw `security -i` write) is unchanged — it is a primitive; callers serialize.
- **`AccountSwitcher.switchAccount`** — now writes via `writeCredentialsSerialized(...)`; a busy lock returns a non-destructive "store busy, try again", never a corrupting half-write.
- **`scripts/lint-no-unfunneled-credential-write.js`** (+ wired into `npm run lint`, allowlisted in `lint-no-direct-destructive.js`) — forbids, outside the closed allowlist (the funnel + the two primitive owners + the lint itself): `defaultCredentialStore.write(`, a qualified `.writeCredentials(`, and a raw `add-generic-password` in a file that targets the `Claude Code-credentials` service (file-scoped so the OTHER vaults — WorktreeKeyVault / SecretStore / GlobalSecretStore / RemediationKeyVault, each a distinct service — never false-positive).
- Tests: `credential-write-routing.test.ts` (7) + `lint-no-unfunneled-credential-write.test.ts` (8).

Ships DARK: the credential-repointing feature gate is untouched and stays off+dry-run. The funnel is pure in-process serialization with NO behavioral change when no swap is running (which is always, while dark) — it only adds per-slot ordering and a bounded skip-and-retry under contention.

## Decision-point inventory

- `refreshClaudeToken` write → `withSlotLock` — **modify** — serialize the refresh write; contention → `write-skipped` (retry), never corruption.
- `QuotaPoller` `write-skipped` mapping — **add** — a busy lock is NOT a dead login; no `needs-reauth`.
- `writeCredentialsSerialized` — **add** — the one sanctioned provider-write chokepoint.
- `lint-no-unfunneled-credential-write` — **add** — structural enforcement that no future writer bypasses the funnel. Signal-only (a build-time lint), no runtime authority.

---

## 1. Over-block

The only new "refusal" is a try-lock-timeout SKIP, which is the §2.2 bounded-wait contract, not a content decision. A legitimate refresh write that loses the 15s race for its slot is reported `write-skipped` and retried next poll cycle — it is never dropped or failed. A legitimate account-switch write that loses the race gets a "store busy, try again" and the operator retries. Neither rejects a valid input; both defer it by one cycle. Because the feature ships dark (no swaps run), the only lock holders are these writes themselves (sub-millisecond `security` calls), so contention — and therefore any skip — is effectively unreachable until Step 5 introduces a longer-held swap lock.

---

## 2. Under-block

The funnel can only serialize a writer that routes through it. That is exactly what the new lint enforces: the real tree is now lint-clean, and any future callsite that hand-rolls a `Claude Code-credentials` write (raw `security`, `defaultCredentialStore.write`, or `provider.writeCredentials`) outside the allowlist fails the build. The lint is line-scoped and skips comments (a documentation mention is not a bypass) and file-scoped to the guarded service (the four sibling keychain vaults are out of scope by construction, verified: none contains the `Claude Code-credentials` literal). Residual not covered: a brand-new keychain service string for Claude credentials would not be caught by the service-literal scope — acceptable, because the service name is a fixed Anthropic-client constant (`claudeCredentialService`), not something a new writer invents.

---

## 3. Level-of-abstraction fit

Correct layer. The wrapping lives in the two files that OWN the write primitives (`OAuthRefresher`, `CredentialProvider`) — the SafeGit/SafeFs precedent of "the primitive's owner is the funnel-internal site, everything else routes through a named method." The QuotaPoller maps the new reason at the exact point it already classifies refresh outcomes. The lint mirrors `lint-no-unfunneled-topic-creation` / `-headless-launch` precisely (closed allowlist, comment-skipping, `--staged` bootstrap). No higher layer should own this — credential writes are a `src/core`/`src/monitoring` concern.

---

## 4. Signal vs authority compliance

Compliant. The funnel is mechanism (a per-slot mutex with a bounded outcome), not authority over agent behavior — it makes no allow/deny decision about content, only about lock availability, deterministically. The QuotaPoller mapping REMOVES a false-authority failure mode (a transient lock contention was never a real `needs-reauth`, and now can't masquerade as one). The lint is a build-time signal with zero runtime authority. No brittle check gains blocking authority over messaging, dispatch, or sessions.

---

## 5. Interactions

- **Hot path — token refresh:** the load-bearing interaction. `refreshClaudeToken` keeps every session's access token fresh; the only change to it is that its write is serialized. The existing 17 oauth-refresher + quota-poller + credential tests (193 → all green) prove the default-singleton path is behaviorally identical to today (a free lock ⇒ `ran:true` ⇒ same write, same result). The single NEW path is `ran:false` ⇒ `write-skipped` ⇒ QuotaPoller returns no-snapshot — covered by a dedicated test plus the CONTRAST test proving `exchange-failed` still marks `needs-reauth`.
- **No double-lock / deadlock:** the primitives (`store.write`, `provider.writeCredentials`) do NOT self-lock; callers lock once. `writeCredentialsSerialized` is the only locker for the provider path, so AccountSwitcher → serialized → provider.write is a single lock acquisition. Verified by the per-slot-isolation test (a busy slot does not block a different slot).
- **Shared singleton:** refresh, switch, and (Step 5) swap all use `credentialWriteFunnel`, so a refresh and a switch on the SAME slot genuinely serialize. Slot keys are the expanded config home; the default slot is `expandHome('~/.claude')` on both paths so they share one lock.

---

## 6. External surfaces

No new routes, no network, no notices. The only externally observable change is benign: an account-switch that hits a busy lock returns a clearer "store busy, try again" message instead of proceeding, and a refresh that hits a busy lock logs one warn line and skips a single poll cycle. Token values are never logged (the skip reason and warn line are credential-free). Nothing changes for other agents/users/machines.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** Credential writes target THIS machine's keychain, so the serialization that protects them is inherently per-process/per-machine — there is no shared state to replicate. The funnel singleton serializes writers WITHIN one process; cross-machine coordination of a credential move (a topic transfer mid-swap) is the existing handoff guard's responsibility, composed-with in Step 5, not this lock's. A second machine refreshing its OWN keychain copy of the same account is independent by construction (each machine has its own login lineage) — the spec's one-home-per-credential invariant is about config homes on a single machine, enforced by the ledger (Step 2), not by this lock.

---

## 8. Rollback cost

Low. Plain `git revert` of this commit restores the direct writes; no migration, no persisted state, no schema. The funnel singleton and primitive remain (shipped in Step 4a) but go unused. Because the feature is dark and the change is behaviorally identical under no-contention, a revert is invisible to production. The lint removal is a one-line edit to `npm run lint` if ever needed.

---

## Second-pass review

_Appended by the dedicated independent reviewer subagent (Phase 5), 2026-06-13._

**VERDICT: CONCUR.** The reviewer independently traced every hot-path concern and confirmed: tests 15/15 green; no hot-path regression (the `write-skipped` path returns no-snapshot and never `markNeedsReauth` — verified end-to-end through `QuotaPoller.pollAccount`); no lock-wedge (acquisition is bounded; `mine` releases only after the real prior holder settles; every `fn` here is a synchronous `security`/fs call); no double-lock/deadlock (neither primitive self-locks; `writeCredentialsSerialized` is the sole locker on the provider path); the lint is sound on both axes (regex matches qualified calls but not the method definition / interface / `writeCredentialsSerialized`; the raw-keychain rule is file-scoped to the guarded service so the four sibling vaults never false-positive); behaviorally inert when dark.

**One non-blocking concern raised → FIXED in this commit (not deferred).** The reviewer noted the per-slot lock key was string-identity-fragile: a default account enrolled non-canonically (`~/.claude/` with a trailing slash, or a differently-spelled path) could key the refresh write and the switch write to *different* locks for the *same* keychain entry, letting them race. Resolution: added `credentialSlotKey(configHome) = path.resolve(expandHome(configHome))` in `OAuthRefresher.ts` and routed all three lock keys through it (`refreshClaudeToken`, `DEFAULT_CREDENTIAL_SLOT`, `writeCredentialsSerialized`), so the shared-resource→lock-key mapping is canonical rather than dependent on operator spelling. This strictly improves on today's behavior (which has no funnel at all) and removes the latent footgun before Step 5's longer-held swap lock can expose it.
