# Side-Effects Review — Feedback Readiness Serving Account

**Version / slug:** feedback-readiness-account
**Date:** 2026-11-26
**Author:** echo
**Second-pass reviewer:** not required (see bottom)

## Summary of the change
Tier 1. A revert fully undoes it, and with no pin and `triage.accountSelectionMode` off (the fleet default) readiness behaves byte-for-byte as before. Runtime files: `src/feedback-factory/drain/readinessAccountAdmission.ts` (new), `FeedbackDrainService.ts`, `FeedbackReadinessArbiter.ts`, `src/feedback-factory/triage/FeedbackTriageAccountSelector.ts` (adds `selectPinned`), `src/server/AgentServer.ts` (wiring), `src/core/types.ts` (config type), plus an awareness entry. Tests: two new unit files, one new integration file, one added e2e case. Effort: one build pass, no spec rounds (Tier 1, ELI16 companion supplied).

Readiness calls now reuse the triage account selector and its fresh, local verification. A new `feedbackFactory.readiness.account` pins readiness to one pool account: exactly that verified account, or a named refusal, never the shared default. `GET /feedback-factory/drain/status` reports `readinessAccount` { mode, pinnedAccountId, last }.

## Decision-point inventory
- **New: readiness account admission** (which account serves a readiness call). It is a precondition, not an authority: it can only defer a call, never approve or block a decision's content.
- **Unchanged:** the readiness authority (registry record, provider/model family match, prompt/schema canary, batch envelope, spend brake, demotion rules) and its resolved-model check.

## 1. Over-block
A pinned account that is temporarily unreadable (live quota read failed) defers readiness for 15 minutes even if the account is fine. That is intended: a pin means "only this account", and an unverifiable account must not serve. In mode `on`, if no account verifies, readiness is deferred rather than run on the shared provider. That matches triage's `on` behavior. Mode `off` (the default) admits everything, as before.

## 2. Under-block
Verification is credential identity plus a live quota reading under a minute old, the same as triage's. It does not detect an account that was healthy at launch and hits its limit mid-call; that surfaces as an ordinary call failure (transient, retried). The post-call `verified` flag reports credential drift during the call; it is a signal and does not retroactively void decisions (same contract as triage's execution-identity check).

## 3. Level-of-abstraction fit
Account choice lives in a small admission module beside the drain and reuses the existing triage selector rather than a parallel implementation. The drain loop only consults it before each chunk. The arbiter only passes `accountOverride`/`launchGuard` through to the existing IntelligenceOptions seam that triage already uses. No router or provider code changed (those files belong to PR 3904).

## 4. Signal vs authority compliance
Complies with docs/signal-vs-authority.md. The admission has no blocking authority over decisions: a refusal only defers rows to the next review and is counted as a failed tick for the existing stall notice. It never demotes, revokes or approves. The authority's own deterministic checks are unchanged.

## 5. Interactions
- Spend: admission runs before `reserveAuthoritySpend`, so a refusal reserves nothing.
- Stall notice: a refusal sets the transient-failure flag, so repeated refusals reach the existing once-per-episode stall attention, with the refusal reason in `lastReadinessFailure`.
- Triage: shares the selector class but has its own instance and cursor; no shared mutable state. Both may read the same account's quota; each read is bounded (≤5 s, ≤2 accounts per wave).
- Chunks: the chosen account is reused across chunks while `revalidate` holds (quota read < 60 s old, same credential); otherwise admission runs again.
- The built-in 30-minute drain job and manual ticks behave identically.

## 6. External surfaces
New config key (optional) and a new read-only status field. The status exposes the account id only, never config homes, login ids or tokens (asserted in the integration test). Codex quota reads go to the local Codex app-server, as triage's already do; no new network destination.

## 7. Multi-machine posture
Machine-local by design: readiness runs only on the drain's canonical owner, and the account pool and Codex logins are that machine's. `readinessAccount.last` is in-memory on the owner and resets on restart (null until the next readiness call). Non-owner reads of drain status already report the local view; no new replication is needed because only the owner calls readiness.

## 8. Rollback cost
Revert the PR, or unset `feedbackFactory.readiness.account` and leave `triage.accountSelectionMode` off: readiness returns to the shared provider immediately (read live, no restart). No durable state or migration is involved. Existing rows deferred with `readiness-account-refused` simply come due again.

## Migration parity
No new config default is written: an absent `readiness.account` and the existing triage mode default (`off`) mean the previous behavior, so existing agents need no migration. Awareness text ships as an entry file, which reaches existing agents on update without a migration.

## Second-pass review
Not required. The change touches none of the Phase 5 categories: it adds no block/allow decision on messaging or dispatch, does not touch session lifecycle, context, coherence or trust gates, and adds no sentinel, guard, gate or watchdog. The readiness authority's decision logic and checks are unchanged. Admission only chooses the serving account and can only defer a call.
