# Side-Effects Review — held reply outcome lookup (no duplicate resend)

**Version / slug:** `held-reply-outcome-lookup`
**Date:** `2026-10-27`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 1 (declared). A Telegram reply that Telegram accepted but whose receipt the origin store could not save used to surface as `409 telegram-origin-held`, outcome `outcome-unknown`; the relay script printed it as a failure; sessions resent; the user got duplicates (2026-10-27, op f659abab-…). Changes: `TelegramOriginService` reports such a send as the new outcome `accepted-unrecorded` carrying Telegram's message id, after writing the receipt to a new fsync'd fallback file (`OriginUnrecordedReceipts`); `TelegramOriginRuntime.recoverHeld` folds pending fallback receipts into the store via the existing `reconcileReceipt` after `reapAbandoned`; new read route `GET /telegram/origins/operations/:operationId/outcome` classifies an operation (`OriginOperationOutcome`); `sendOriginHoldResponse` adds `delivered`, `messageId`, `checkOutcome`; `/telegram/reply` records content/delivery-id dedup for `accepted-unrecorded`; `TelegramAdapter.sendToTopic` writes the delivered message to history; `OriginMesh` answers an `accepted-unrecorded` holder-side submit as sent and its receipt action reads the fallback; `telegram-reply.sh` gains a held branch; prior relay SHA registered; CLAUDE.md awareness + migration. Size: ~13 files, ~450 LOC incl. tests. Effort: one design pass, no spec rounds (Tier 1), first commit attempt pending.

## Decision-point inventory

- Caller resend decision after a held reply — modify (information only) — the script now reports a verdict; the agent still decides.
- `/telegram/reply` content dedup — pass-through/modify — an `accepted-unrecorded` send is recorded as delivered (same treatment as a success) instead of having its reservation released.
- Forward-to-holder re-forward decision — modify (input) — holder reports delivered on `accepted-unrecorded`, so the existing logic resolves instead of re-forwarding.
- Origin store receipt state — pass-through — uses the existing `reconcileReceipt`, which only upgrades an `outcome-unknown` attempt.

---

## 1. Over-block

The dedup recording means an identical-text resend within the dedup window after an `accepted-unrecorded` send is suppressed. That send would have been a duplicate of a message Telegram confirmed; a deliberate repeat still has `metadata.allowDuplicate`. No other block surface.

## 2. Under-block

- A send whose Telegram response carried no correlatable receipt stays `outcome-unknown` (correct: we do not know). The lookup says `unknown`, the script says do not resend — duplicates remain possible only if an agent ignores that.
- If the fallback file write also fails (disk refusal), the caller is still told `accepted-unrecorded` with the message id, but the later lookup cannot see it and answers `unknown` (still "do not resend").
- (Found by the second pass, fixed) a `known-failed` 409 with no lookup answer used to fall into "may already be delivered"; it now prints NOT DELIVERED with a check-first line, because the server may still retry it.
- (Found by the second pass, fixed) a send executed on another machine could read `not-delivered`/`safeToResend` from this machine's stale record; the route now downgrades that to `unknown`.
- Other `sendMessage` sites in `TelegramAdapter` (not `sendToTopic`) do not write the history row on `accepted-unrecorded`; the reply path does, which is the reported case.

## 3. Level-of-abstraction fit

Capture is at the single point where the receipt and the failure are both known (the service). Classification is a pure function over the existing audit record, reused by the route and the mesh. Fold-back reuses the existing store method and the existing recovery tick — no new loop.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface beyond recording a confirmed delivery for the existing dedup.

The lookup and the script output are signals; the agent keeps the resend decision. The dedup change treats a Telegram-confirmed delivery exactly like a recorded success, which the existing gate already does.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The classifier maps recorded facts (receipt present, dispatched-without-answer, terminal state) to an enumerable verdict.

## 5. Interactions

- **Shadowing:** the new 409 branch in the script runs before the generic 4xx branch, only for `error: telegram-origin-held`; `delivery-in-flight` 409s are unchanged.
- **Double-fire:** the fold-back and the existing diagnosis both see the operation; reconciling first (before `undiagnosedOrigins`) means a reconciled op is no longer outcome-unknown.
- **Races:** `reconcileReceipt` refuses unless the attempt is `outcome-unknown`, so a fallback entry for a still-claimed attempt waits; a late successful `recordOutcome` makes the later reconcile a no-op (`false`, entry stays pending until retention compaction — harmless; the store already says delivered).
- **Feedback loops:** none.

## 6. External surfaces

- 409 body gains fields (`delivered`, `messageId`, `fallbackRecorded`, `checkOutcome`); existing parsers read `error/reason/outcome/operationId` unchanged. `outcome` has a new value `accepted-unrecorded` — consumers (`deliverToConversation`, `PromiseBeacon`) pass it through as an opaque hold.
- New file under the agent state dir (0600, bounded at 2 MB with compaction, 14-day retention of unreconciled rows). Holds Telegram ids and receipts, no message text.
- New authenticated read route; no operator-facing action.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design for the fallback file: the receipt belongs to the machine that executed the send (the execution owner), which is the machine whose store reconciles it. Cross-machine reads go through the existing mesh receipt action, now reading the fallback too, so a forwarding standby gets the right answer. The lookup route answers for this machine, names `executionOwnerMachineId` when the send ran elsewhere, and in that case never answers `not-delivered` (this machine's record cannot prove non-arrival). No user-facing notices added.

## 8. Rollback cost

Pure code revert. The fallback file is inert without the code. Deployed agents keep the new relay script until the next template version (the old script's behavior returns only on revert + SHA registration).

## Conclusion

Clear to ship after the second-pass read. One defect was found and fixed during build: an append after a torn line glued the new row onto it (now starts on a fresh line).

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent, 2026-10-27 20:41
**Independent read of the artifact:** concern raised, then resolved

- Concern 1: a `known-failed` 409 without a lookup answer printed "may already be delivered" and exit 0 — fixed (NOT DELIVERED, exit 1, check-first wording; the `*` branch keeps exit 0 deliberately, matching the 408 AMBIGUOUS branch — exit 1 is what makes an agent regenerate and resend).
- Concern 2: a remote-owner send could read `safeToResend: true` from a stale local record — fixed (downgraded to `unknown`), integration test added.
- Concern 3: "the server delivers the rest itself" was unproven for multi-part operations — wording changed to "check before sending the rest yourself" in both the route and the script.
- Reconcile correctness, mesh `ok:true`, dedup recording, route auth and the history row were checked and found correct.

## Gate follow-ups (after the first local verify)

The first local verify of PR 2427 failed three repository gates, none a behavior defect: the new CLAUDE.md addendum had to be registered in the feature-delivery tracker (its shadow mirror entry is now a bare builder, so the awareness text is port-free); three route `catch` blocks that answer an explicit status needed the `@silent-fallback-ok` tag; and the check command the script prints needed the `X-Instar-AgentId` header. Effort: 2 commit attempts for the follow-up (the first was refused because these two artifacts were not restaged).

## Evidence pointers

tests/unit/telegram-origin/held-reply-outcome.test.ts, tests/unit/telegram-reply-held-outcome.test.ts, tests/integration/telegram-origin-routes.test.ts ("receipt could not be saved"), tests/unit/telegram-origin/origin-service.test.ts (updated).
