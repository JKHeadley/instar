# Side-Effects Review — sending email from an agent (email-v1)

**Version / slug:** `recommended-services-email-recipe`
**Date:** `2026-11-08`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see Second-pass review)`

## Summary of the change

Builds `docs/specs/backup-email-sending.md` (converged in 7 rounds, approved by the operator 2026-11-09T02:28:03Z, topic 135786 message 140861). An agent can email its owner, and only its owner. New: `src/email/` (pure rules and delivery mapping in `emailCore.ts`; the Resend and SMTP transports in `transports.ts`, SMTP through the new reviewed dependency `nodemailer` 10.2.1, pinned; the durable outbox `EmailOutbox.ts` as its own replicated journal kind `email-outbox-record` with a 16 MB / three-archive retention; the opt-in code and proof-mail bounds in `emailOptIn.ts`; the sender `EmailService.ts`; the server wiring `wireEmail.ts`; the store registration `EmailOutboxReplicatedStore.ts`), the routes `src/server/emailRoutes.ts` (`POST /email/send-to-owner`, `GET /email/outbox`, `GET /recommended-services/email/{status,recipient}`, `POST /recommended-services/email/{signup-mail,code}`), and the recipe `email-v1` in `src/recommended/recipes.ts`. Changed: the confirm page takes the owner-typed address for email and the proof email's code (`dashboard-pair/service-yes.js`); the confirm route stores the address in the vault and a keyed hash plus the email timezone on the yes row (`RecommendedServicesLedger.ts`: optional `recipientHash`, `timezone`); the key route accepts a recipe's structured key (`prepareKey`) and gains `POST /recommended-services/:id/prove`; key recipes get the regular once-a-day re-check the spec adds (a fail reopens setup as a failed copy already does); jobs gain `deliver` (`types.ts`, `JobLoader.ts`, `AgentMdJobLoader.ts`); `JobScheduler` writes the email row in the completion bookkeeping with `emailOutboxId` on the run record, extracts `deliverJobReport`, and gains `reconcileEmailReports`; `TelegramAdapter.onReconnect` (the poll-error-to-zero edge); the mesh command `email-send-forward` (`MeshRpc.ts` type + RBAC row, holder handler and standby sender in `commands/server.ts`); the catalog email row (`exercised`, drill `tests/e2e/email-sending-lifecycle.test.ts`, still `setupRecipe: null` — dark behind `recommendedServices.provingRecipes`); the ladder entry `recommendedServices.email`; the CLAUDE.md awareness section and its migration; the CapabilityIndex entry; four state-registry entries.

Tier 2 (new external side effect, a new credential, a replicated store, a mesh verb). Size: about 2,900 added lines of source and tests across 40 files. Effort: one build session; zero spec review rounds in this build (the spec converged before it); commit attempts recorded in the PR.

## Decision-point inventory

- Owner-only recipient (`EmailService.submit` has no recipient; transports refuse another `to`; SMTP `envelope.to`) — add — invariant, deterministic.
- Credential-exposure guard on every email subject and body before any row is written — pass-through (routes one more surface through the existing Wall 1 detector `detectOutboundCredential`; no new matcher).
- Key route refusals (`recipient-not-accepted`, `recipient-mismatch`, `presets-only`) — add — invariant input validation.
- Credential breaker (one credential refusal stops sends until a verify pass) — add — external-constraint invariant.
- Budget reservation and the provider's 429 as the hard cap — add.
- Opt-in code: five attempts, 30-minute expiry, three proof mails a day and twenty in all to an unconfirmed address — add.
- Lease checks at enqueue and fire time; a standby forwards — add.
- Quiet by Default for emailed reports (the same on-alert rule decides) — pass-through.
- Fallback to the topic on refused / unknown / not set up — add (fail toward reachability).

---

## 1. Over-block

- A one-off from a conversation with other readers (`place`, `person`, `none`) is refused with `topic-not-owner-only`, even when the person would accept their text there. Intended by the spec: a one-off has one text and its fallback would land in a shared place.
- A one-off whose text holds something the credential guard reads as a live key is refused outright, even if it is a false positive. The guard is the same Wall 1 detector Telegram uses, so its false-positive rate is unchanged; the session is told plainly.
- An address with a display name, a comma or a quoted local part is refused on the confirm page. A bare address always works.
- Shape A refuses a changed recipient (`recipient-is-the-account`); the page says a new address means a new setup.

## 2. Under-block

- A session that holds the sending credential can read the opt-in code (Resend's status call, or shape C's Sent folder). Stated on the page and in the spec as the honest limit; it closes when `ownerProof` ships.
- Across a lease handoff the local reservation can be exceeded by the outgoing holder's in-flight tail; the provider's 429 is the authority (stated in the spec).
- SMTP acceptance is never a delivery; a shape C recipient inbox that later bounces is invisible (named in the spec's Left behind).
- Shape B's throwaway browser profile lifetime (20 minutes, deleted on every exit path) is a rule in the setup brief, not code: the browser work is the setup session's. The recipe brief states it.

## 3. Level-of-abstraction fit

The transports are thin and bound to one address; the sender owns policy (budget, breaker, fallback); the scheduler only decides whether a run reports (its existing Quiet by Default rule) and hands the report over. The fallback reuses the scheduler's own report path (`deliverJobReport`, extracted, not duplicated) and, for a one-off, the routes' stamped Telegram seam. The outbox rides the existing replicated-record emitter and journal rather than a new transport. The credential check reuses the existing outbound guard. The re-check reuses the recommended-services reconcile machinery.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface over messages or agent behavior beyond deterministic invariants on its own new output.

The refusals here are invariants on a new outbound surface (a fixed recipient, a closed field set, provider answers), not brittle judgments about content. The one content check is the existing credential-exposure detector, which already holds Wall 1 authority over outbound text; this change grants it nothing new, it only routes email through it. Every refusal still delivers the report to its topic (fail toward reachability), except a one-off with a live secret, which is refused exactly as the same text would be on Telegram.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Each bound is declared in the spec's Decision points touched table as an invariant (with basis) or a judgment-candidate with its floor and default, and the defaults are implemented as stated (fallback 120 s; status window 30 minutes, max 60; transport timeout 15 s within 5–60; line cadence a day, floor an hour; checkpoint ten a second; live set 200; tombstone 24 hours).

## 5. Interactions

- **Shadowing:** an email-only job (`deliver: ['email']`) skips the Telegram report send in `notifyJobComplete` only when the email sender is wired; the email row's fallback then carries it through the same `deliverJobReport`. A job without `deliver` takes exactly the old path (tested).
- **Double-fire:** a report can arrive twice when email is `unknown` (intended, said on the page). One holder sends; a standby forwards; the holder re-checks the lease at fire time. Resend sends carry the row id as idempotency key.
- **Races:** the outbox version is `max(now*1000, newest seen + 1)`, so a successor's write always wins the fold (a restart bug in the first draft, caught by tests and fixed). The checkpoint re-emits live rows only; terminal rows the journal dropped are re-emitted without a local rewrite (the first draft churned them through retention; caught by the rotation test).
- **Feedback loops:** the fallback retry has the 24-hour breaker (its clock never reset by a relay give-up) and resumes only on Telegram's reconnect, the relay sentinel's `sentinel:recovered`, or a handoff; relay copies stop after three per row; the checkpoint stops re-queuing after ten passes over its keys. Registered as `email-fallback-retry` in the self-action convergence ratchet.
- **Recommended services:** the new once-a-day re-check applies to every key recipe (Jev, voice, GitHub, Bitwarden is a copy recipe and keeps its own). An outage never takes a pass away (`recordVerify` keeps a pass on `unknown`); only a real fail reopens setup and tells the person once, as a failed copy already does.

## 6. External surfaces

- External systems: Resend's API and Gmail/iCloud SMTP, only after the owner's yes, setup, and the proof. Dark on every agent without `email-v1` in `recommendedServices.provingRecipes` (and that list is honoured only on a throwaway or the development agent).
- Persistent state: `state/email-outbox/` (replicated), `state/email-outbox-text/` (holder-local, deleted at terminal), `state/email-opt-in.json`, `state/email-service.json`; vault keys `email_sending`, `email_recipient`, `email_provider_account`. All registered in the state-coherence registry.
- Operator surface: the confirm page gains the address field and the code box, both phone-completable with the PIN. No operator action is API-only.
- Dependency: `nodemailer` 10.2.1 (published 2026-10-22, pinned exact; `npm audit` shows no advisory for it). `@types/nodemailer` 8.0.2 dev.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes: the page still leads with the service and the yes; for email the address field sits directly above the PIN in the same form, and the code box appears as its own section only while a code is waiting.
2. **Zero raw internals?** Yes: refusals map to plain sentences (`invalid-recipient`, `recipient-is-the-account`, `code-*`); no ids or hashes are shown. The status route masks the address.
3. **Destructive actions de-emphasized?** Unchanged: the no stays below the yes; the switch-off box is unticked by default.
4. **Plain language + phone width?** Labels are plain ("Your email address", "Code from the test email"); inputs use the existing `pair-pin` styles that already render at phone width, with `type=email` and `inputmode=numeric` keyboards.

## 7. Multi-machine posture

- **Outbox and budget: replicated** through the `email-outbox-record` kind (store `emailOutbox`), advertised wherever the recommended-services store is; the holder is the only writer; peers fold and catch up from the peer streams at boot.
- **Owner report text: machine-local by design** — it is deleted at terminal and a successor needs only the destination-safe `topicText`, which replicates.
- **Opt-in nonce and proof results: machine-local by design** — minted and checked on the machine that took the yes; the confirm link names that machine.
- **Grant: per machine** (the parent spec's rule); the vault values replicate through secret sync, but a machine without a grant never sends (`not-set-up-here`).
- **One voice:** only the lease holder sends; a standby forwards one-offs and fired reports by the signed `email-send-forward` command; if the holder is unreachable a report goes to its topic with the not-set-up-here line and a one-off answers `holder-unreachable`.
- **Status surfaces:** `GET /recommended-services/email/status` answers for this machine (its grant, its lease view, its budget reading of the replicated record); `holdsLease` says whether this machine is the sender.

## 8. Rollback cost

Flip `email.enabled: false`: the hourly sweep drains every live row to its topic, `poll` falls `sent` rows back at once, and new reports go to Telegram. Then revert. Stored credentials stay unused; older validators reject `recipientHash` rows, which is harmless because a grant is per machine. Jobs with `deliver` load unchanged on an older version (`validateJob` has no closed field set; an AGENT.md job with `deliver` is withheld by an older version, which the upgrade note says).

## Conclusion

The review produced two design fixes found by tests (outbox version monotonicity across restarts; checkpoint churn) and one lint fix (the one-off fallback's Telegram send moved into the routes' stamped seam). Clear to ship dark behind the proving list; the test-agent live proof is the acceptance gate before the catalog row names `email-v1`.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (Claude), read-only, 2026-11-08 19:23 PST
**Independent read of the artifact: concur** (after two re-checks; the first pass raised the concerns below)

Concerns raised and how each was resolved in this change:

- **An email-only job could lose its report** when no row was written (no run id after a restart, or a throw in the email step): the Telegram path was skipped on `emailReports` being wired alone. Resolved: the Telegram path is skipped only when this run's `emailOutboxId` (a row or `quiet`) actually came back (`JobScheduler.notifyJobComplete`); the reconciliation floor is now recorded once on disk (`EmailService.wiredSince`) and the sweep also runs at boot, not only after an hour. Test: `JobScheduler-email.test.ts` "an email-only job whose row was not written … still reaches Telegram".
- **`relay-queued` rows could stick** when the relay sentinel escalated, tone-gated or age-retired the copy. Resolved: `EmailService.relayFailed` / `relayRetiredForTopics`, wired to `sentinel:escalated`, `sentinel:tone-gated` and `sentinel:stale-retired`; the row goes back to falling-back and is sent again. Tests in `email-service.test.ts` "review fixes".
- **A standby's failed fallback was a single attempt.** Resolved: if the holder can't be reached and the standby's own Telegram send fails, the copy is enqueued in the standby's relay queue keyed by the row id (`AgentServer.startEmail`).
- **A report holding a live secret replicated its topic copy.** Resolved: that row's `topicText` is the status line only. Test "a report holding a live secret replicates only its status line".
- **Behaviour for agents without email:** the messenger fallback for a job whose lazy topic can't be created is restored; the new key-recipe re-check no longer checks every working service at once after the update (first sight starts its clock; a refused email credential forces one now). The re-check itself is the spec's ("a new regular re-check for key recipes that this change adds").
- **Second re-check (relay retry):** a row whose relay copy was given up could be re-queued under the same id, which the queue ignores. Resolved: every relay attempt has its own id (`<row id>-r<n>`, `relayTries` on the row), the queue's insert answer is passed through (nothing new queued: the row stays falling-back and retries), and sentinel events map a relay id back to its live row; retired entries resolve their topic like the enqueue does. Reviewer's final read: "Concur with the review" (19:28 PST).
- **Owner-only hardening:** `readiness()` now requires the stored address to hash to the standing yes's `recipientHash`, so an address written without its yes (a failed `applyYes`) never sends. Test "a stored address that is not the one the yes recorded never sends".

---

## Evidence pointers

Unit: `tests/unit/email-core.test.ts`, `email-transports.test.ts`, `email-outbox.test.ts`, `email-opt-in.test.ts`, `email-service.test.ts`, `email-recipe.test.ts`, `JobScheduler-email.test.ts`. Integration: `tests/integration/recommended-services-email.test.ts`. E2E: `tests/e2e/email-sending-lifecycle.test.ts` (the drill).

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action` (this change adds self-triggered controllers: the email fallback retry and the paced hourly checkpoint).
- **`closure`:** `guard`.
- **`guardEvidence`:** `{ enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts }`. How it is caught: `email-fallback-retry` is registered in `SELF_ACTION_CONTROLLERS` and drives the real `fallbackRetryDelayMs`. The control-loop edge is a refused topic send feeding the next retry; the steady-state bound is 100 attempts per permanently refused row (1, 2, 4, 8, 15 minutes, then every 15, until the timer stops 24 hours after the row first fell back); the settling brake is that a relay give-up never resets that clock and the hourly sweep never resumes a stopped timer (only Telegram's reconnect, the relay sentinel's recovery or a handoff does). Relay copies are capped at three per row inside those attempts. The paced checkpoint is bounded per hourly tick (ten records a second, stops after ten passes over its keys).
- **`gap`:** none.
