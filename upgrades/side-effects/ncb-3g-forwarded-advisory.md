# Side-Effects Review — a tone verdict on a forwarded reply reaches its author (native-conversation-base slice 3g)

**Version / slug:** `ncb-3g-forwarded-advisory`
**Date:** `2026-11-12`
**Author:** `echo`
**Second-pass reviewer:** `independent general-purpose subagent (see below)`

## Summary of the change

Spec: `docs/specs/native-conversation-forwarded-advisory.md` (sibling of `native-conversation-base.md`, approved by Echo under the standing grant; evidence `docs/specs/reports/ncb-f1-cause.md`). Built on slice 3a (PR #3102). Tier 2: it changes how a reply in custody ends, on every agent, with no flag.

When the outbound check (tone gate, credential wall, loopback-link guard) refuses a reply that is **in custody** (forwarded to the lease holder, or queued for recovery), the refusal used to be mishandled three ways: the holder's recovery logged it and reviewed again every tick; the author's recovery stored it as a plain refusal and submitted again; and the holder answered "not sent" while leaving its own row `admitted`, so a revised reply plus the original could both be sent. That is how the F1 reply in topic 141868 sat unseen until it was retired.

Now:
- `OriginPolicyClassifier.ts` (new): an allow-list reads the refusal body into `advisory` / `refused` / `retain`. Only a verdict on the text ends anything; a capacity shed, an outage, a timeout or an unknown rule is `retain` (unchanged). `routes.ts` adds `failedClosed` / `degradedToDeterministic` to both `tone-gate-blocked` bodies so a floor catch is told from an outage.
- `OriginPolicyVerdict.ts` (new, pure): the stored verdict (`{class, rule, suggestion, decisionRef, at, machineId}`, `issue` never stored), the answer reference (`decisionRef` or `op:<own id>`), and the session line.
- Store (`OriginStoreBackend.ts`): nullable column `policy_verdict_json`, never cleared; `recordOperationState` takes it in the same conditional transition (no claim, no unresolved dispatch, no accepted part, first verdict wins) and refuses `admitted` for an advisory row; both recovery selections and the due ladder leave advisory rows out; `markForwardAdvisory`, `listAdvisoryRows`, `recordOperationSum`; `expireOperation` no longer turns a `superseded` row into `expired`.
- Holder (`TelegramOriginRuntime.endForPolicy`, `OriginMesh.ts`): on a verdict it ends its own copy (`suppressed` + `tone-advisory`/`policy-refused` for a reply written elsewhere; `held`/`tone-advisory` or `suppressed`/`policy-refused` for its own), then answers `policyRefusal` with `copyEnded: true` and the verdict. Otherwise it answers custody. The `receipt` answer carries the verdict to the author only, never to a `reader`.
- Author (`OriginForwardToHolder.ts`): a `policyRefusal` without `copyEnded` (an older holder) is custody; the receipt and submit answers `owner-advisory` / policy `owner-verdict` are recorded and the row is never re-forwarded, never sent locally, never replaced on a holder change.
- Line and deadline: `runAdvisoryScan` (one line per operation, through 3a's `sessionLine` carrier; the deadline line through the forward-expiry carrier, adding "If you already sent a revised version, do nothing."); `scanSessionLine` arms for a held advisory row written here and for a holder-authored `policy-refused` row ("the outbound check refused it (`RULE`)… Rewrite it before sending again.").
- Answer (`TelegramOriginService`, `routes.ts`, `server.ts`): the reply route looks the reference up (one lookup for outbox and forward rows); a held match makes the send its replacement (3a's carrier: same draft time and deadline) and `supersedeWithAdmission` retires the original in the same transaction; a forwarded answer is superseded, marked `outcome-unknown`, then submitted. A match that is no longer held sends nothing and answers `409 telegram-origin-held` naming the old operation, so the script prints its recorded outcome. An `op:` reference is removed before the policy input is sealed.
- Counters on `GET /telegram/origins/status` → `heldReplies` and the federated `metrics` verb; two awareness sentences (`OriginAwareness.ts`, added to installed agents by `migrateClaudeMd`); a feature-ladder row.

Size: 2 new source files, 16 modified source files, 5 test files (≈ 900 added lines of source and tests). Effort: spec converged in 4 rounds before this build; this build took one commit attempt at writing time (see the Proportion line in the PR).

## Decision-point inventory

- `Which refusals end a reply in custody` (`policyVerdictClass`) — **add** — an enumerable allow-list over the outbound check's own refusal codes. The check itself is unchanged.
- `The verdict-and-end transition` (`recordOperationState` with `policyVerdict`) — **add** — a storage fence, not a judgment.
- `Recovery selection` (`readRecoverableAdmissions`, `reserveRecoveryAttemptLocked`, `heldForwardAdmissions`) — **modify** — advisory rows are left out.
- `recoverForwardedHold` — **modify** — returns at once for an advisory row; records a holder's copy-ended verdict instead of re-forwarding.
- `Outbound review` (`MessagingToneGate`, `evaluateOutbound`) — **pass-through** — two fields added to two refusal bodies; no decision changes.

---

## 1. Over-block

The classifier never blocks a send; it only decides whether a refusal the outbound check already made ends the reply. The cases where a reply now ends where it used to be retried:
- An advisory in custody: before, it was reviewed again every tick and could be sent if a later review passed. Now it waits for its author. If the session never answers, it ends at its existing deadline (G-2: accepted; a delay, never a duplicate). Counted (`advisoryExpiredUnanswered`) for the 2026-11-25 review.
- A blocking verdict (credential, link, blocking rule, floor catch) in custody: before, retried; now ended with one definite line. At the script the same refusal was already final.
- Where the advisory migration is dark, a judgment-rule verdict arrives as `tone-gate-blocked` with a real rule and is `refused`. This matches what the script already does (G-6).

No legitimate send is newly refused at the route.

---

## 2. Under-block

- `retain` covers every review that produced no verdict, so a sustained outage still reviews a reply each pace step until its deadline, as in 3a.
- A session that answers WITHOUT the reference sends a separate message and the held one stays held (counted `advisoryUnmatchedReply`). Revision without the reference cannot be proven, so it never releases the original (G-2).
- Left behind by the spec (precision items P-a … P-i): the holder's session-exception scan returns `policy-refused` rows authored elsewhere (P-e). This build skips their record-only notice so it does not double the author's line.

---

## 3. Level-of-abstraction fit

The judgment stays where it was: the outbound check (LLM tone gate plus deterministic walls) decides. This change is plumbing for what happens to a reply after that judgment. It sits in the origin delivery layer, which already owns custody, endings and session lines (3a's carriers are reused: `sessionLine`, the forward-expiry carrier, `supersedeWithAdmission`, the outcome classifier). No new gate.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface of its own.

The classifier reads the authority's answer by a closed list of its own codes. It does not hold a new brittle block: an unknown or new code is `retain`, which is the pre-change behaviour. The only new ending (`refused`) follows a verdict the authority already made final at the script.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The class is an enumerable domain (the refusal codes are a closed set in `routes.ts`, named in the spec's Decision points table). "An unanswered advisory waits rather than releases" is the one judgment-candidate; the spec declares its floor (never past the existing deadline, never sent without the author's answer) and arbiter (the authoring session; the 2026-11-25 review via the counters).

---

## 5. Interactions

- **Shadowing:** `endForPolicy` runs only in the `OriginSendPolicyRefusal` catch of the holder's submit and recovery; every other error path is unchanged. The `duplicate-content` refusal (written `suppressed` by its own writer first) is `retain` here, so the existing receipt path (`owner-ended`) still carries it.
- **Double-fire:** the advisory line is keyed (`<id>:advisory-line`) and both carriers (the advisory scan and the `scanSessionLine` arm) go through the same `sessionLine`, so a line is injected once. The deadline line shares 3a's `<id>:session-line` key. When the session read the verdict synchronously (an answer that got a new verdict), both keys are recorded so no later line repeats it.
- **Races:** a submit and a recovery of one operation can both reach review. The verdict-and-end write is one conditional transaction (claim, dispatch, accepted part and earlier verdict all refuse it); the loser answers custody. Test: "a submit and a recovery of one operation with divergent results". An answer racing expiry: supersede refuses an expired row; expiry no longer touches a superseded one (`expireOperation` change). Tests in both orders.
- **Feedback loops:** none. A replacement that gets its own verdict waits for its own answer, under the original deadline.

---

## 6. External surfaces

- **Sessions:** a new injected line; the reply script's existing 409/422 branches carry the answers (no script change).
- **Users (Telegram):** fewer duplicates; a held reply with an advisory no longer arrives unrevised on a later tick. Its revised version arrives once, when the session answers.
- **Persistent state:** one nullable column; additive and ignored by an older reader.
- **Other machines:** mixed versions are handled (an older author reads the new reasons as an ending with no stated reason; an older holder sends no `copyEnded`, read as custody).
- **Operator surface:** no operator-facing actions. Counters are read-only.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable (no dashboard, approval page or form is touched).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- **The verdict** (`policy_verdict_json`): proxied-on-read. The holder's row is the source; the author's copy arrives over the signed `receipt` (author only) or the submit answer.
- **The live copy:** exactly one row, on the machine that wrote the reply; supersede and expiry are transactions in that one store.
- **The session line:** injected on the machine running the authoring session, from its own row (one voice: only the author's machine).
- **Counters:** per machine, unified through the federated `metrics` verb (the answer-delay sum is read from the counts table).
- **Status surfaces:** `GET /telegram/origins/status` → `heldReplies` gains the advisory counters; this machine's counts (the pool view is the `metrics` verb with `?scope=pool`).
- No URLs are generated; durable state does not strand on topic transfer (the row stays with its author).

---

## 8. Rollback cost

By version, no data repair. Old code never sends a handed-back reply: a `suppressed` holder copy stays ended; a local `held`/`tone-advisory` row cannot be claimed (old recovery re-reviews it, the old behaviour); a forward row marked `outcome-unknown` is asked about at the holder and settles unresolved. Cost: repeated reviews and a vaguer line during the rollback window. The column stays and is ignored.

---

## Conclusion

The build follows the spec item by item. Two design points were settled during the build: (1) the classifier is split from the pure verdict module so the store worker never loads the tone gate; (2) `expireOperation` now leaves a `superseded` row alone, which the answer-vs-expiry test exposed. One pre-change integration test asserted the old behaviour (an advisory in custody re-reviewed and later sent); its pacing intent is kept with a `retain` refusal and the new behaviour has its own tests. Clear to ship once the second pass concurs.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (fresh context; read the diff, the 3g spec, §3a of the parent and this artifact, and traced the code paths)
**Independent read of the artifact: concern → resolved, then concur**

The reviewer confirmed the over-block, under-block, signal-vs-authority, race, multi-machine and rollback answers against the code (the verdict write is one immediate transaction; a held advisory row cannot be claimed; advisory rows leave both selections; older holders read as custody; an older 3a author reads the new reasons as a settled reasonless ending, never a resend). Two concerns, both fixed in this change:

- **A failed or slow local supersede fell into the recoverable in-memory hold** (`TelegramOriginService.admit`): a later recovery tick would admit the replacement plainly while the original stayed answerable, so a second answer could send twice. Fix: the supersede has its own catch and throws `advisory-answer-unrecorded`, which is not a recoverable hold reason, so nothing is parked; a supersede that committed late leaves one durable replacement that recovery sends once. Test: "a local answer whose supersede fails is not parked for a later replay" (one dispatch after a retried answer).
- **(low) `noteVerdictAnsweredInline` pre-recorded the deadline line's key**, so a forwarded replacement that got its own advisory at send time never got its deadline line. Fix: only the `advisory-line` key is recorded. Test: "a replacement that gets its own advisory … silence still ends in one deadline line".

---

## Evidence pointers

- `tests/e2e/telegram-origin-forwarded-advisory-alive.test.ts` — production boot path: handed back on recovery, one line through the injector, never re-reviewed or sent, counters 200 and moving, the answer sends once; the migration adds the column to an existing database.
- `tests/integration/telegram-origin-forwarded-advisory.test.ts` — two real runtimes over the signed mesh, 16 scenarios, each asserting the dispatch count.
- `tests/unit/telegram-origin/forwarded-advisory.test.ts`, `tests/unit/telegram-origin-forwarded-advisory-migration.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `guard` (ratchet) — `src/testing/selfActionRegistry.ts#telegram-origin-forward-ladder`, proven by `tests/unit/self-action-convergence.test.ts`.
- **How it is caught:** this slice only removes actions from the forward ladder: a row with an advisory verdict is left out of both recovery selections and the due ladder (`ladder.nextAt` null) and `recoverForwardedHold` returns at once for it; a copy-ended verdict on a submit is recorded instead of retried. The only new sends are a session's own answers, each one superseding the held row in one transaction under the original 6 h deadline, so the modeled bound of 31 attempts per reply still holds.
