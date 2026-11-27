# Side-Effects Review — Telegram send timeout outlasts Telegram's throttled answer; outcome-unknown is logged

**Version / slug:** `telegram-send-timeout-flood`
**Date:** `2026-10-26`
**Author:** `Echo`
**Second-pass reviewer:** independent sub-agent (general-purpose), CONCUR 2026-11-27; see the Second-pass review section

## Summary of the change

Tier 1: 3 source files, about 30 lines, plus tests. `src/messaging/telegram-egress.ts` exports `TELEGRAM_API_CALL_TIMEOUT_MS = 60_000`; `TelegramAdapter.apiCall` and `TelegramLifeline.apiCall` use it for every non-`getUpdates` call (was 15 000 ms). `TelegramOriginService` already writes one `console.warn` on the `transport-acceptance-unknown` branch on main (its `describeTransportFailure` line, added after this PR was opened); this change adds the method and the elapsed network time to that line. Effort: one review pass, then a merge of main on 2026-11-26.

## Decision-point inventory

- Origin outbox outcome classification (`TelegramOriginService` send catch) — pass-through. The classification is unchanged; a longer wait means more sends reach a concrete answer (200 receipt, or 429 → `known-failed` with retry) instead of the unknown branch.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface. Remaining miss: a Telegram delay longer than 60 s still ends outcome-unknown (now with a log line saying so). Measured delays were 14-33 s.

---

## 3. Level-of-abstraction fit

The timeout lives where it already lived (each `apiCall`), now named once in the egress module that owns the network boundary, so the server and the lifeline cannot drift apart. The log line sits at the only place that knows the network threw after invocation.

---

## 4. Signal vs authority compliance

No decision authority added. The log line is a pure signal.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point added; a timeout value is a floor, not a judgment.

---

## 5. Interactions

- `transport-deadlines.test.ts` already proves the clock starts only after origin review, claim and capacity consumption; unchanged, so the 60 s is network time only.
- Callers awaiting a send: the binding budget is the server's `/telegram/reply` route timeout, `OUTBOUND_MESSAGING_TIMEOUT_MS` = 120 s (`telegram-reply.sh` allows 125 s outside it). One send's 60 s network wait plus the tone-gate review and the origin send-policy review (each bounded by `OUTBOUND_GATE_REVIEW_BUDGET_MS` = 20 s) is at most 100 s; `transport-deadlines.test.ts` asserts the inequality. Known limit: a reply split into several Telegram messages sends them one after another, so if Telegram is slow on each (for example three parts at 40 s), the route can answer 408 while later parts are still in flight. The relay script reports that as ambiguous and says to check the conversation; each part is a recorded origin child, so a part already accepted is not resent. Before this change the same reply's worst case was about 4 x 15 s. Internal callers that await `apiCall` (topic creation, edits) now wait up to 60 s on a stalled Telegram instead of 15 s; they were failing in that case anyway.
- The credential-capacity grant is consumed before the network starts, so a longer network wait does not hold a capacity reservation.

---

## 6. External surfaces

Telegram sees no difference except that the client waits for its answer. Users see messages delivered (or retried) during throttling instead of silently lost. The existing outcome-unknown log line gains the method and the network wait; it still excludes the URL and redacts token-shaped text.

## 6b. Operator-surface quality

No operator surface touched — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine's server and lifeline time their own requests. Standbys forward sends to the lease holder, which applies the same constant. The log line lands on the machine that made the call.

---

## 8. Rollback cost

Revert the commit; the next release restores 15 s and main's shorter log line. No state, migration or config involved.

---

## Conclusion

Safe to ship: a constant and a log line, no new authority, closes the silent loss seen on 2026-10-26.

## Second-pass review

**Reviewer:** independent sub-agent (general-purpose), 2026-11-27 14:15 PT, read only (no tests run on the M5 under the disk hold). Verdict: CONCUR.

Evidence it recorded: the log line at TelegramOriginService.ts:952 is built only from the operation id, `request.method` and `describeTransportFailure` (:1092-1095), whose code is bound by `PLAIN_CODE` (:1078), so a token, URL or chat id cannot match. `fetchFailureCode` (OriginTransportCancellation.ts:29-38) walks causes with a loop guard, and a DOMException TimeoutError maps by name. The no-resend order (:952 log, :953 `#outcomeUnknown`, :954 hold) is unchanged. It traced each new and existing test to pass, including the 429 path (:966-976, matching origin-service.test.ts:335-341). No catch block or fallback is added, so the silent-fallback and empty-catch ratchets are unaffected. Applied: this note's caller wording. Not applied (noted for later): allowlisting codes instead of a shape check, and a separate `aborted` category for a caller cancel after the request left (logged as `other` today).

Earlier passes: none was required for the original two-file change (2026-10-26). The 2026-11-26 merge review is recorded under "Merge of main, 2026-11-26" below.

## Evidence pointers

- Live probe on the running Studio server, 2026-10-26: `sendMessage` aborted at 15.0 s; same bot's chat reads returned 429 after 28-33 s; other bots answered the same chat at once; with a 90 s wait a real origin-recorded send returned 200 after 14.4 s (message 130522 recorded).
- `tests/unit/telegram-origin/transport-deadlines.test.ts` (the log line's exact shape through the real origin runtime, including method and wait; the timeout bound).
- `tests/integration/telegram-origin-routes.test.ts` now asserts the shared constant instead of the old 15 s value.

## Merge of main, 2026-11-26

An independent Claude Opus 5.5 reviewer subagent read the merged diff on 2026-11-26 and concurred, with one fix: the 60 s had been justified against the relay script's 125 s instead of the server's 120 s route budget. The test, the constant's comment and these notes now use the server budget, and the multi-part limit is stated in section 5.

Main had changed the same files: PR 3966 made the held-retry and connect checks deterministic, and main added its own outcome-unknown log line. The merge keeps main's log line and its wording ("send outcome unknown for <operation>", which main's connect-failure tests search for) and adds the method and the network wait to it. The PR's own helper `describeTransportUnknown` and its separate redaction test were removed as duplicates of main's `describeTransportFailure`. The 60 s timeout stays: main's 15 s expectations were pins of the old value with no recorded reason, while the 60 s comes from the measured 14 to 33 s throttled answers.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect (this is a source-code timeout/logging defect) and no self-triggered controller — not applicable.

## Repair on main 6aeaf1974 (2026-11-27, Pipeline Strategy brief)

The branch was merged with main twice (d8c928a64, then 6aeaf1974; the second merge was clean). On the brief's step 2, the outcome-unknown log line no longer carries the error message or its cause text. `describeTransportFailure` now returns one bounded category from `transportFailureCategory()` (`timeout`, `connection-reset`, `dns`, `tls`, `other`), read only from the error name and code, plus `code=<CODE>` when the code matches `^[A-Z][A-Z0-9_]{1,47}$`. The line still names the operation id, the method and the elapsed milliseconds. The earlier token redaction is no longer needed because no free text is written.

Side effects: anyone reading server.log for these lines sees a category instead of Node's message (for example `connection-reset code=ECONNRESET` instead of `fetch failed code=ECONNRESET cause=socket hang up`). No other production caller uses the helper (`git grep describeTransportFailure`: this file, and the unit test that imports it). The send path itself is unchanged. The no-retry rule for an unknown outcome (`#outcomeUnknown` followed by the `outcome-unknown` hold) is untouched, and the new timeout test checks that recovery does not resend it. A 429 answer still goes through the known-failed `telegram-429` path and is retried by the outbox; a test now pins that it never logs "outcome unknown".
