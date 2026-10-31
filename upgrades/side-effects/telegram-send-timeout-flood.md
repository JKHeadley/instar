# Side-Effects Review — Telegram send timeout outlasts Telegram's throttled answer; outcome-unknown is logged

**Version / slug:** `telegram-send-timeout-flood`
**Date:** `2026-10-26`
**Author:** `Echo`
**Second-pass reviewer:** `not required (no gate, sentinel, block/allow or session-lifecycle change; a timeout constant and a log line)`

## Summary of the change

Tier 1: 3 source files, about 30 lines, plus tests. `src/messaging/telegram-egress.ts` exports `TELEGRAM_API_CALL_TIMEOUT_MS = 60_000`; `TelegramAdapter.apiCall` and `TelegramLifeline.apiCall` use it for every non-`getUpdates` call (was 15 000 ms). `TelegramOriginService` writes one `console.warn` (via the new exported `describeTransportUnknown`) on the `transport-acceptance-unknown` branch, with method, operation id, error name/message/cause/code and elapsed network time. Effort: one review pass, first commit attempt pending at the time of writing.

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
- Callers awaiting a send: `telegram-reply.sh` allows 125 s (`--max-time 125`), so it still gets the server's answer. Internal callers that await `apiCall` (topic creation, edits) now wait up to 60 s on a stalled Telegram instead of 15 s; they were failing in that case anyway.
- The credential-capacity grant is consumed before the network starts, so a longer network wait does not hold a capacity reservation.

---

## 6. External surfaces

Telegram sees no difference except that the client waits for its answer. Users see messages delivered (or retried) during throttling instead of silently lost. Logs gain one line per outcome-unknown send; the line excludes the URL and redacts token-shaped text.

## 6b. Operator-surface quality

No operator surface touched — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine's server and lifeline time their own requests. Standbys forward sends to the lease holder, which applies the same constant. The log line lands on the machine that made the call.

---

## 8. Rollback cost

Revert the commit; the next release restores 15 s and removes the log line. No state, migration or config involved.

---

## Conclusion

Safe to ship: a constant and a log line, no new authority, closes the silent loss seen on 2026-10-26.

## Second-pass review (if required)

Not required.

## Evidence pointers

- Live probe on the running Studio server, 2026-10-26: `sendMessage` aborted at 15.0 s; same bot's chat reads returned 429 after 28-33 s; other bots answered the same chat at once; with a 90 s wait a real origin-recorded send returned 200 after 14.4 s (message 130522 recorded).
- `tests/unit/telegram-origin/transport-deadlines.test.ts` (log line via the real origin runtime fails without the `console.warn`; timeout bound; redaction).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect (this is a source-code timeout/logging defect) and no self-triggered controller — not applicable.
