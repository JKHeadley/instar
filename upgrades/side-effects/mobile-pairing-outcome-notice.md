# Side-Effects Review — Tell the conversation that asked for a pairing link whether the phone paired

**Version / slug:** `mobile-pairing-outcome-notice`
**Date:** `2026-11-14`
**Author:** `echo`
**Second-pass reviewer:** `independent general-purpose subagent (claude-opus-5-5)`

## Summary of the change

`POST /mobile/pairing-codes` accepts an optional `topicId`. A durable watch (`src/core/PairingOutcomeWatches.ts`, file `state/mobile-pairing-outcome-watches.json`) follows the minted link; the redeem route joins it to the new pending device inside the same registry write (`outcomeWatchId`, `pendingDeadline` on the device record) and marks take-time refusals and an undeliverable owner message. A 5 s reconciler pass reads the device registry with a new strict read (`DeviceRegistry.listStrict`), decides one outcome (paired, declined, expired, interrupted, ended, not-delivered, unknown, link-void, link-expired), freezes a fixed plain line (`src/core/PairingOutcomeText.ts`) and sends it through the ordinary automation reply path (`postOriginAutomationReply` → `/telegram/reply`) as the in-process producer `mobile-pairing-outcome`, with a stable logical send id and `X-Instar-System: true`. The answer is classified by body (`src/server/pairingOutcomeNotice.ts`); a send the outbox owns is followed by its operation outcome; a line that cannot be posted ends in one attention item per topic. A new protected notification category `pairing-outcome` delivers the line when it carries the operator's message id that the server verified at mint; otherwise the line is an ordinary quiet notice. `GET /mobile/devices` (owner callers) gains `pairingOutcomes`. The CLAUDE.md "Mobile pairing link" section gains an awareness bullet and a Mint example that passes `$INSTAR_TOPIC_ID`, both migrated to existing agents. Tier 2; 27 files, ~2,030 lines added (about 650 of runtime code, the rest tests and spec); spec converged in 5 review rounds (6-round cap); first commit attempt pending.

## Decision-point inventory

- `NotificationSelectivityGate.decide` — add — a `pairing-outcome` branch: deliver when the envelope carries `inboundMessageId`, else record (quiet).
- `NotificationSelectivityGate.destination`, status `configurable`, `POST /notifications/categories/:id/push` — modify — read `PROTECTED_DELIVERY_CATEGORIES` (conversation categories ∪ `pairing-outcome`) instead of `CONVERSATION_CATEGORIES`; the conversation categories behave exactly as before.
- `/telegram/reply` envelope construction — add — a branch beside the `presence-proxy` one: only the in-process `mobile-pairing-outcome` producer with a numeric `metadata.inboundMessageId` gets the `pairing-outcome` envelope.
- `matchesSystemTemplate` — modify — accepts the bounded pairing-outcome line grammar (tone-gate skip; credential wall still runs).
- Mint `topicId` admission and outcome classification — add — enumerable, deterministic (spec "Decision points touched").

---

## 1. Over-block

No new refusal. A malformed or non-Telegram `topicId` never refuses the link; the response carries `outcomeNotice: null` with a plain reason. Callers without `topicId` get a byte-identical response.

---

## 2. Under-block

- An anchored line is delivered without re-checking the gate's in-memory inbound rows (they do not survive a restart). The anchor is the operator's latest message in that topic within 15 minutes before the mint, a heuristic: a job session in a topic where the operator just spoke would anchor to that message. Accepted: the result is one past-tense, fixed-grammar line about a link that was in fact minted there.
- Any Bearer-token holder can already send `X-Instar-System: true` with a line of this exact shape to any topic; this grants nothing a token holder lacks.
- Names are filtered to letters, digits, spaces, apostrophes and hyphens, so a hostile phone name cannot carry a link, a domain, a mention or formatting.

---

## 3. Level-of-abstraction fit

The watch is a consumer of the device registry (the truth) and a producer into the existing reply pipeline; it does not add a second delivery path. Delivery policy stays in the selectivity gate (one new branch beside the existing presence-standby shape). The tone gate is skipped only through the existing reviewed system-template mechanism, for a bounded grammar.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface over anyone else's messages.

The only decision it adds is whether its own line goes to the conversation or the quiet feed, decided by evidence the server verified at mint (the operator's own message in that topic), never by text matching. Its own sends are classified deterministically from typed route answers.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Outcome classification maps the closed `DeviceStatus` union plus recorded observations; send classification maps typed answers; both are invariants declared in the spec. The anchor window (15 min) and retry/staleness numbers carry their evidence in the spec's "Decision points touched".

---

## 5. Interactions

- **Shadowing:** the new gate branch runs before the conversation-category branch and only for `pairing-outcome`; conversation categories are untouched. The new system-template grammar is checked after the existing templates.
- **Double-fire:** one watch per minted link; exactly one send per decided outcome (stable logical id; re-entrancy flag; the origin layer answers a replay with its stored receipt). A crash between Telegram accepting and the `sent` write is replayed with the same id and text.
- **Races:** `markTaken`, the device write and the take run in one synchronous block; a pass is a separate event-loop task. The registry's own normalisation expires pending devices; the watch only reads.
- **Feedback loops:** none; the line goes to Telegram, not back into pairing.
- **PR 3165** (open) changes `deliverOwnerDM` to keep a slow-delivered phone; it touches the same redeem block. This branch is rebased onto it once it merges; the `not-delivered` hook stays on the "removed" path.

---

## 6. External surfaces

- Telegram: one new fixed line per pairing link minted with a `topicId`, in that topic; an attention item when it cannot be posted.
- Persistent state: a new 0600 file `state/mobile-pairing-outcome-watches.json` (terminal entries pruned after 30 days); two optional fields on device records (older code ignores them).
- API: `topicId` on mint, `outcomeNotice`/`outcomeNoticeReason` in its response (only when `topicId` is given), `pairingOutcomes` on `GET /mobile/devices` (owner callers; never MSP/team phones).
- Dashboard: the Notifications page now lists "Phone pairing results" as a non-configurable category.
- **Operator surface:** no new operator action. The operator reads the line in Telegram; the attention item uses the existing attention surfaces.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface file touched — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- Watch store — **machine-local by design** (physical-credential-locality): the pairing code is a one-time bearer credential that exists only in the minting process; redeem reaches only that machine (`verifySoleServer`) and the device record is written there. If that machine is down, the line waits for it; `GET /mobile/devices?scope=pool` answers meanwhile.
- The line — unified through `/telegram/reply`'s origin layer (one voice: the machine serving Telegram sends it).
- Notices: yes, one line per link and one attention item per topic; no duplicate across machines because only the minting machine holds the watch.
- URLs: none generated.
- **Status surfaces:** `GET /mobile/devices` gains `pairingOutcomes` for this machine's links (labelled in the awareness bullet as "links minted here"); no `/status`, `/health`, `/capabilities` or `/channels` answer changes.

---

## 8. Rollback cost

`mobilePairing.outcomeNotice.enabled: false` stops new watches and all passes (read live, no restart). Reverting the PR removes the code; the watch file and the two optional device fields are inert without it. The CLAUDE.md bullet would stay on migrated agents until a later migration removes it (harmless: it points at `GET /mobile/devices`, which remains the truth).

---

## Conclusion

The review changed nothing beyond the converged spec; the spec's five review rounds already reshaped the design (atomic join, strict read, anchor-at-mint, typed answer classification, protected category, past-tense lines, filtered names). Clear to ship after the second-pass review and Local Verify.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (claude-opus-5-5), 2026-11-14 16:26 PST
**Independent read of the artifact: concur**

Concur with the review: nothing new is blocked; the `pairing-outcome` envelope is reachable only from the in-process `server-automation` producer (same trust check as `presence-proxy`); conversation categories behave as before; the redeem hooks sit on the right paths; no double send; migrations idempotent; the template grammar is anchored and bounded. Two small notes, both fixed before commit: a displaced doc comment above `isOutcomeNoticeEnabled`, and the migration marker was the full bullet text (now the stable phrase `PAIRING_OUTCOME_MARKER`, with a test that a reworded bullet is not inserted twice).

---

## Evidence pointers

- Unit (worktree, 2026-11-14 16:18 PST): `PairingOutcomeWatches.test.ts` 17, `pairing-outcome-text.test.ts` 10, `pairing-outcome-notice-adapter.test.ts` 8, `notification-pairing-outcome-category.test.ts` 4, `PostUpdateMigrator-pairingOutcomeBullet.test.ts` 5, all passing; neighbours `feature-delivery-completeness`, `mobile-pairing-word-code`, `notification-selectivity`, `system-templates`, `mobile-pairing-approve`, `mobile-pairing-tailscale-origin-awareness` passing (345 tests).
- Integration `tests/integration/mobile-pairing-outcome-notice.test.ts` (6) and e2e `tests/e2e/mobile-pairing-outcome-notice-alive.test.ts` (2) pass when run once through the unit lane; their own configs run in Local Verify.
- Live proof (2026-11-14 16:40–16:50 PST), throwaway agent `pairing-outcome-proof` from this branch's build on the Studio, spare test bot @instar_pr2760_livetest_bot, marked test group "Instar test - pairing outcome [itg-p5hzkn5ekg]" (chat -1004337366302), topic 3; only the pairing address check was pinned (the override used for PR 2933), everything else real: a real redeem, the owner's approval message sent by the test bot, and a real owner-phone approval (signed challenge + presence signature).
  - Leg 1, quiet mode enforcing (as on Echo), no operator message in the topic: mint answered `outcomeNotice: {topicId: 3}` with the quiet-feed reason; after approval the watch ended `paired`/`sent` and the line sat in the throwaway's quiet feed for topic 3, not in the chat.
  - Leg 2, quiet mode off (the fleet default): the paired line arrived in topic 3 as Telegram message 9 (00:41:47 UTC): A phone named "Proof's Pixel" was paired with pairing-outcome-proof (key AC43-B435-E57F-6519).
  - Leg 3, a 1-minute link never used: message 10, "…expired without pairing a phone." The live wording showed a doubled "for"; the three link lines now read "The pairing link for <agent> ("<label>") …" and the leg was re-run on the rebuilt branch: message 11 (00:46:27 UTC), "The pairing link for pairing-outcome-proof ("Proof phone") expired without pairing a phone."
  - Not proven live: the anchored delivery under enforcing quiet mode. The operator's browser profile may only send to granted destinations, and widening that grant is not this run's call; the anchored path is covered by unit, integration and e2e tests and is confirmed on Echo by the maturation plan's first real pairing.

---

## Class-Closure Declaration (display-only mirror)

This change adds a self-triggered controller (the pairing-outcome reconciler's retries), so it declares the `unbounded-self-action` class.

- **`defectClass`:** `unbounded-self-action`
- **`closure`:** `guard`
- **`guardEvidence`:** `{ enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts (controller pairing-outcome-notice-retry in src/testing/selfActionRegistry.ts), howCaught: sends retry only inside the 1 h window after the outcome was decided (15 attempts at most), then one attention-item upsert per topic with 30 s doubling to a 10 min cap and a 12-attempt per-process give-up (MAX_ESCALATION_ATTEMPTS); the pass reads nothing while no entry is open. Steady state under an always-rejecting target: 27 actions, horizon-independent; the ratchet drives the model built on the same sendRetryDelayMs / escalationRetryDelayMs helpers the class uses. }`

---

## Follow-up: Local Verify finding (2026-11-14 22:00 PST)

Local Verify on the M5 (head ebf5593e70, 67,392 unit tests) failed one file, `tests/unit/topic-ref-ratchet.test.ts`: two degradation messages in `PairingOutcomeWatches` printed a bare topic id. They now use `topicRef()` (`src/messaging/shared/topicRef.ts`). Wording of internal degradation reports only; no behaviour, decision point or user-facing line changes, so the review above stands. The other repo-wide ratchet tests were run on the branch before this push and pass.
