# Side-Effects Review — a held reply is ended only for a cause (native-conversation-base slice 3a)

**Version / slug:** `ncb-3a-held-replies`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `independent general-purpose subagent (see below)`

## Summary of the change

Tier 2 (spec `docs/specs/native-conversation-base.md`, converged in 6 rounds and approved; this PR builds slice 3a only, on top of slice 3b, PR #3092, merged into this branch because 3a reads 3b's `receipt` fields `outcome`, `failure` and `role`). 19 source files changed or removed, about 1,000 added source lines; 5 new test files across all three tiers, 7 existing test files updated. One build pass, two test-fixture iterations; the spec's review rounds belong to the spec.

F1 (topic 141868): a reply written on a non-holder was ended by the holder's queued-reply review because a later message existed, and nobody was told. This slice:

- **Removes the timestamp review** (FD-1, FD-3). `QueuedReplySupersession.ts` and its test are deleted; the `reviewQueuedReply` option, its boot pass-through and its pool read in `server.ts` are gone; `allowQueuedRecovery` keeps only the historical-notice withhold. No timestamp comparison is computed anywhere (the spec removed the r3 shadow counter in r4).
- **Closed suppression reasons** (item 9). `recordOperationState` refuses `suppressed` without a reason from `quiet-notification-recorded`, `duplicate-content`, `historical-notice-retired`, `recorded-by-caller`, `suppressed-at-holder`. The three reasonless writers now pass `duplicate-content` (`TelegramOriginService` content check), `historical-notice-retired` (runtime) and `recorded-by-caller` (`recordSuppressed`). Detail strings up to 256 characters are kept whole; longer free text is cut at 200 with `…[cut]`, never refused; a held forward's authored `text` is kept whole.
- **The late first line** (item 2). Two nullable columns, `first_prepared_at` and `late_marked_at`, added at open with a duplicate-column-tolerant add; set by `supersedeWithAdmission` (which gains `replacementState: 'held' | 'admitted'` and a carrier argument) and copied to every later successor. A replacement seals `firstPreparedAt` in the envelope (never the admission), keeps the original's `deadlineAt` and sealed send-policy input (the content-check key), and is prepared under the original's producer record (`TelegramOriginService.runAsRecordedProducer`), so it stays `producerKind: 'session'` with its session binding. The content check (`OriginContentDedup`) looks back to `firstPreparedAt` when present. Forwarded replies are replaced by the author at a forward attempt (`recoverForwardedHold`); a one-machine reply is replaced `admitted` by direct recovery (`markLateDirect`) and sent in the same pass. A reply that cannot be marked (more parts than the original, producer record unavailable, refused replace) goes out as it is, is counted `lateUnmarked`, and is never tried again (`lateMarkUnavailable` on a forward, a keyed event on a direct row). `lateRecoveredReplyNotice(firstPreparedAt, now)` returns the fixed line or null at 300 s or under.
- **The author is told** (item 5). One line per recovery pass per session, every id grouped marked first, recorded as `<operationId>:late-line` after it was injected. The id named is the one the session was given (the chain is walked back through `supersedes`).
- **Reply-text route** (item 6). `GET /telegram/origins/operations/<id>/text`: Bearer API token only (a device principal is refused in the handler itself, and the path is not in `DEVICE_ALLOWLIST`), answered only on the authoring machine for a session reply, behind the topic history read's own conversation check (`deviceMayUse … read`); `unknown-operation` for any refusal of a known id; `gone` after the purge.
- **Ending with no stated reason is never final** (item 7). The forward ladder's receipt mapper is replaced by `classifyHolderReceipt`, which reads the raw `state` with `outcome`, `reason` and `failure` and never folds `suppressed` into "not accepted". Owner endings with a reason record `suppressed-at-holder` with `holderReason`; an owner verdict of non-delivery is merged as `ownerVerdict` (`mergeHoldDetail`, which also nulls `ladder.nextAt`) and its definite line goes out in the same pass; a reasonless ending from an older owner gets one fresh-time replacement, and a second reasonless ending settles the row (`ownerUnstated.settled`), with one session line and one record-only item per topic (`telegram-origin-unresolved:<topicId>`, count, cleared at zero). `recoverForwardedHold` returns at once for an `ownerVerdict` row; an `ownerUnstated` row asks its previous owner before any local send or holder-change supersede, and only that owner's own record moves it. The holder now answers a submit for an id it holds terminal with that ending (naming the operation id, so the forwarder asks its receipt) instead of sending.
- **Definite vs uncertain, each with a carrier** (item 8). Topic texts reworded exactly as the spec. The forward-expiry pass raises the hub item once (keyed event), injects the session line chosen by the pure `forwardExpiryArm(row)`, and writes `hold_expiry_reported_at` only after the line was injected; with no session it retries each pass until the purge horizon (`HOT_DETAIL_MS`, 7 days), then marks it reported and counts `neverHandedBack`. The existing scan carries the line for rows this machine wrote and sent (and forwards settled unknown); the owner's scan skips rows authored elsewhere. `heldForwardAdmissions` reads each due row by id (500 expired rows ahead can no longer hide a due forward) and skips `ownerVerdict` rows; the held count and health summary skip them too.
- **Counters** on `GET /telegram/origins/status` → `heldReplies`: `lateDeliveries`, `recoveredUnderThreshold`, `lateUnmarked`, `ownerUnstated`, `definiteNoSession`, `neverHandedBack` (`state: unknown` when the store cannot be read).
- **Awareness and ladder.** CLAUDE.md paragraph "Held replies are delivered late, not dropped:" for new agents (template) and existing agents (content-sniffed `migrateClaudeMd` step, mirrored to the framework shadow). `src/data/feature-ladders.json` gains the slice's maturation row as `finished` (live on every agent, no flag, rollback by version).

## Decision-point inventory

- End a queued reply on a timestamp — **remove** — the review and its pool read are deleted.
- Suppression without a reason — **modify** — refused by the state writer (the closed set).
- Deliver a reply later than 300 s — **add (label only)** — a first line is added; nothing is gated on the threshold.
- Forward recovery for a row the owner ended — **modify** — `ownerVerdict` stops all delivery of that row; `ownerUnstated` waits for the previous owner's own record.
- Holder submit for an id it holds terminal — **modify** — answers the ending instead of attempting a send.
- Reply-text route — **add** — a read with a device refusal and a conversation check.

---

## 1. Over-block

- A suppression with no reason is now refused at the store. Every in-tree writer passes a reason; an out-of-tree writer of `suppressed` with no reason would get `origin-store:suppression-reason-required` and the reply would stay in its prior state, i.e. be delivered. That errs toward sending, which is the spec's intent (a refused suppression must not silently drop a reply), but it could send something a caller meant to withhold. Every in-tree caller was found by grep and updated; the three tests that wrote reasonless suppressions were updated.
- An `ownerVerdict` row is never delivered again, even if the lease moves to the author. Intended: the session was told "will not be retried" and owns the decision.
- A settled `ownerUnstated` row is never delivered by this design against an older owner that never states an outcome (spec Left behind 19). It always ends as an uncertain hand-back to the author.
- The reply-text route refuses a device principal outright, including the owner's own phone. Intended (spec §5): no new route a phone can call.

## 2. Under-block

- Against an older owner, a replacement whose text Telegram accepted more than 15 minutes before the replacement was made is not stopped by the content check and can be delivered twice (stated bound, spec item 2). The new owner reads `firstPreparedAt` and stops it.
- A late reply already admitted at an owner that then stalls is sealed by another machine; the owner cannot mark it (CMT-058). It is counted `lateUnmarked` only where this machine sends it.
- A forwarded reply sent by `sendLocal` after the lease returns is not marked; it is counted `lateUnmarked` (spec Left behind 21).
- Direct-path marking is single-part only. A multi-part direct reply goes out unmarked and is counted `lateUnmarked`. The forward path marks up to the original's part count.
- Text under 40 characters is skipped by the content check (spec Left behind 16), so a short reply's replacement is not stopped by it.

## 3. Level-of-abstraction fit

Each decision sits where its evidence is. The owner keeps the only content-based retirement (it holds acceptance evidence). The author keeps the text and therefore makes the replacement and carries the hand-back. The runtime owns the carriers (passes it already runs: the forward ladder, the forward-expiry refresh, the session-exception scan); no new daemon, no new mesh verb, no new table. The store owns atomicity (replacement and retirement in one transaction; the verdict merge in one transaction). The server only wires effects (session injection through the existing `sessionManager.sendInput`; attention items through the existing adapter).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — this change removes a brittle blocking authority and adds no new one.

The removed timestamp review was a brittle check with blocking authority (it ended replies on a comparison that cannot tell a session's own acknowledgment from a conversation that moved on). Its replacement is not a new gate: replies are delivered; the one retirement left is the existing content check on platform acceptance evidence. The suppression-reason requirement is a data-integrity invariant on the store's own writer (enumerable domain), not a judgment. The `ownerVerdict` stop is the execution owner's own classified verdict, not a heuristic. The late line labels and gates nothing. The session lines are signals to the authoring session, which decides (Arbiter: the authoring session).

---

## 4b. Judgment-point check (Judgment Within Floors standard)

Two judgment-candidates, both declared in the spec's Decision points touched with floors and an arbiter: the 300 s late threshold (labels only; inherited from `recoverableLatencyCeiling`; every recovered reply's delay is counted, `recoveredUnderThreshold` for those under it; the 2026-11-25 review sets the value), and the purge horizon for an expired forward with no session (floor: never dropped unrecorded, never sent after its deadline; the hub item stays open; arbiter: the review, from `neverHandedBack`). No new number was introduced: the horizon is the store's existing `HOT_DETAIL_MS`.

---

## 5. Interactions

- **3b (outcome route).** 3b's classifier and `authorStatement` already read `ownerVerdict` / `ownerUnstated` / `holderReason`; this slice is now their writer. `authorStatement` answers `holding: false` for an `ownerVerdict` row, so §3b row 6 applies at once. This PR does not edit 3b's files (`OriginOwnerRead.ts`, `OriginOperationOutcome.ts`); the local classifier still reads a held `ownerVerdict` row as `pending` when no owner answer is available, which the route resolves through the author statement and the owner ask. Noted for the 3b owner.
- **Content check.** Unchanged for every new reply; only a replacement's look-back moves to its first draft time.
- **Forward ladder.** The receipt mapper changed: `suppressed`, `known-failed` and `expired` answers that carry an `outcome` are no longer read as "not accepted". An older owner's terminal answers with no `outcome` keep their old meaning (re-forward), except `suppressed`, which is now reasonless. A `superseded` answer with an `outcome` reads as unreachable (keep waiting) rather than re-forward.
- **Holder-side submit.** A submit for an id the holder holds terminal now returns a refusal naming the id instead of reaching `admit` (which refused it as a conflicting replay or re-ran). The forwarder already treats that shape as custody and asks the receipt.
- **Session exception scan.** Unchanged for its topic notice and attention items, plus the session line for rows authored here, plus a clause for settled `ownerUnstated` rows (which get no per-operation notice; their per-topic item comes from the refresh).
- **Double-fire.** One session line per operation across carriers (`<operationId>:session-line`); one hub item per operation (`<operationId>:handback-item`); one late line per operation (`<operationId>:late-line`); all recorded only after the effect succeeded, so a crash can repeat one line once but never skip one.
- **Races.** Every replacement goes through the existing single-transaction supersede, which refuses a row with a claimed entry or a non-queued child. The verdict merge refuses anything but a held `lease-not-held` row.

---

## 6. External surfaces

- **Users (Telegram/Slack/app readers):** a reply held more than 5 minutes now arrives (instead of being ended) with the first line "Late reply, written more than N minutes ago and held up in delivery. It answers an earlier message:". The two failure topic texts are reworded; the uncertain one never says "did not reach you".
- **Sessions:** new injected lines (late, definite, uncertain, older-owner). The CLAUDE.md paragraph tells sessions how to act on them.
- **Other machines:** the envelope gains an optional `firstPreparedAt`; an older receiver keeps the envelope bytes whole and ignores it (spec item 2, read at d54f26884). The holder's submit answer gains `terminal` on a refusal; older forwarders ignore it.
- **Persistent state:** two nullable columns; new keyed metric events (`late-line`, `session-line`, `handback-item`, counters).
- **Timing:** the forward-expiry pass now repeats a row until its line is injected (bounded by the 500-row listing and the 7-day horizon).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard or console file changed. The operator-facing additions are one record-only attention item per topic for unresolved replies ("Unresolved replies in <topic>", NORMAL, with a count, cleared at zero) and the status counters. The hub item for a reply handed back reuses the existing held-expiry item.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**proxied-on-read, operational state.** The execution owner's row is the source of delivery evidence; every other machine reads its verdict over the signed `receipt` verb, and a forwarder's `suppressed-at-holder` row or `ownerVerdict` detail is a copy of that verdict. The late-mark columns are the author's own record. The status counters are per machine; the 2026-11-25 review reads each machine and names any that did not answer (no pool view is built, spec Left behind 11). The retire rule is the same on every machine with no setting; a machine still on the previous release reviews only its own queued replies by the old rule, and items 4 and 7 cover an older owner. Session lines go only to sessions on the authoring machine (only it holds the text). The per-topic unresolved item is raised by the authoring machine. No URLs are generated.

---

## 8. Rollback cost

By version: the authoring machines go back one release. Safe mid-flight: old code ignores the two columns and the new detail fields, forwards an `ownerUnstated` or `ownerVerdict` row again and ends it by the old rules, so a session that already had its definite line can get a second, old-style notice for the same reply; suppressed rows with reasons read as suppressed. A rolled-back machine applies the timestamp rule again. No data migration in either direction. Kill criteria (spec maturation row): a reply delivered twice because of a replacement, a reply ended with no reason and no line, a late first line on a reply that was not late.

---

## Conclusion

The slice builds the whole of §3a items 1 to 9 plus the counters, awareness and maturation row. Bounds the spec states and does not close are listed under Under-block. Clear to ship once the second pass concurs.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (fresh context; read the diff, spec §3a and this artifact, traced the code paths)
**Independent read of the artifact: concur** (after one concern round, resolved)

First read: "Concern raised: when a reply that already carries its late first line moves to a new owner, the new copy goes out without the line but is still recorded as marked." It confirmed the safety properties hold (no double delivery, no reasonless ending without a line, no line on a reply that was not late, no text leak from the reply-text route). Findings and resolutions:

- **A marked reply lost its line on a later replacement (real).** `prepareSuccessor` built the successor from the authored text whenever `lateMarkDue` was null, which it is for a marked row, and copied `lateMarkedAt`. Fixed: a marked row's successor rebuilds the line at the time it was sealed (`lateRecoveredReplyNotice(first, lateMarkedAt)`, so "more than N" is unchanged) and stays marked; if the line cannot be carried, the successor is recorded unmarked, counted `lateUnmarked`, and gets `lateMarkUnavailable`. Tests: holder change on a marked reply, the reasonless-ending replacement of a marked reply, and the carry-over failure.
- **Session lines named a replacement id (real, cosmetic).** The hand-back, verdict, unstated and scan lines now name the id the session was given (walked back through `supersedes`); event keys stay per row.
- **Hub item wording for a verdict (real, cosmetic).** `raiseHandBackItem` is now wired in `server.ts` to `handBackItem`, which names the owner's cause instead of claiming the deadline passed.
- **Spec mismatch (kept, safer).** The `ownerUnstated` bullet says an owner `not-delivered` with a failure "clears the uncertainty so the ordinary route runs"; the build records `ownerVerdict` and stops, as the first bullet of item 7 does. Listed for the spec owner.
- **500-row summary listing (kept).** Expired rows waiting up to 7 days for a session sit in the listing `refreshHeldForward` uses for its counts and per-topic items. The due query was fixed; the summary is listed as an open problem.

**Re-check (same reviewer, after the fixes): "Concur with the review."** One cosmetic gap remains: a direct-path late copy made by `markLateDirect` has no hold detail linking it to the original, so a later failure line for that copy names the copy's id. The reply-text route answers for that id. Listed as an open problem.

## Evidence pointers

- Unit: `tests/unit/telegram-origin/held-reply-causal-retire.test.ts` (receipt classifier, `forwardExpiryArm`, `lateMarkDue`, every §3a item 7 path in `recoverForwardedHold`, the late mark on the forward path), `tests/unit/telegram-origin/held-reply-store.test.ts` (reason set, verdict merge, the 500-row case, `replacementState` and the carrier, a replacement sealed as the session reply that passes `validOriginAdmission`, the content check reading `firstPreparedAt`), `tests/unit/telegram-origin/session-delivery-notice.test.ts`, `tests/unit/telegram-origin-held-late-migration.test.ts` (awareness parity and server wiring).
- Integration: `tests/integration/telegram-origin-held-replies.test.ts` (forward-expiry carrier with and without a session, uncertain arm, purge horizon, owner verdict, settled reasonless ending, reply-text route over HTTP including the device refusal and conversation check, the scan carrier), `tests/integration/telegram-origin-worker-recovery.test.ts` (rewritten: a queued reply with a newer message in its topic is delivered).
- E2E: `tests/e2e/telegram-origin-causal-retire-alive.test.ts` (production boot path, one machine: acknowledgment and late reply both sent, marked once, session told once; status counters and the text route answer 200).

---

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `guard` (ratchet) — `src/testing/selfActionRegistry.ts#telegram-origin-forward-ladder`, proven by `tests/unit/self-action-convergence.test.ts`.
- **How it is caught:** every replacement this slice adds (the late mark, the one replacement after a reasonless ending, the holder change) runs inside an existing ladder step and keeps the original 6 h `deadlineAt`, so the modeled bound of 31 attempts per reply holds. An `ownerVerdict` or settled `ownerUnstated` row nulls `ladder.nextAt` and submits nothing. The hand-back line is injected at most once per operation (keyed event), and a row with no session stops at the store's purge horizon.
