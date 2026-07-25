---
title: "Record inbound messages at the injection seam"
slug: "inbound-message-recording-gap"
author: "Instar Agent (echo)"
parent-principle: "Structure beats Willpower"
status: "draft"
approved: false
review-convergence: ""
review-iterations: 0
single-run-completable: true
eli16-overview: "docs/specs/inbound-message-recording-gap.eli16.md"
---

# Record inbound messages at the injection seam

**Deliberately small.** One mechanism, one seam, one flag. The companion spec
`outbound-gate-advisory-override.md` took 33 review rounds and never converged,
because every fold of a 2,700-line document created new contradictions elsewhere
in it (ACT-1215). This spec is scoped so a fold cannot do that.

## 1. Problem

**The machine that composes replies has no record of what was said to it.**

Verified on the Mac Mini, 2026-07-25:

| Observation | Value |
|---|---|
| Messages stored for topic 33368 | 71 |
| …of which inbound (`fromUser: true`) | **0** |
| Inbound rows machine-wide since 2026-07-20 | **0** |
| Outbound rows machine-wide in the same window | 324 |
| Confirmed independently in `topic-memory.db` | same result: 77 rows, 0 inbound |
| Hits on the route that logs inbound (`/internal/telegram-forward`) in `logs/server.log` | **0** |

The recording code is not broken. **It is on a path that is not being used.**
`TelegramAdapter.logInboundMessage()` has exactly one caller — the lifeline
forward route — and messages on this machine arrive by a different path.

**The observed cost, not a hypothetical.** On 2026-07-25 the agent re-derived a
design the operator had specified on 2026-07-23 and reported it back as a new
finding, because at session start it could read its own half of the conversation
and not the operator's. Every session resumes reading what the agent said and
not what it was asked.

## 2. What exists today (verified against the running tree)

- `SessionManager.injectTelegramMessage(tmuxSession, topicId, text, topicName?, senderName?, telegramUserId?, messageId?)` — `src/core/SessionManager.ts:3836`. **Every inbound message reaches a session through it**, whether injected inline or written to an inbound file for long messages.
- It already receives **every field the log needs**. No plumbing is required.
- Two callers: `src/server/routes.ts:15746` and `src/commands/server.ts:2097`.
- `TelegramAdapter.logInboundMessage()` (`src/messaging/TelegramAdapter.ts:1279`) already writes to both the JSONL log and TopicMemory, and `appendToLog` already de-duplicates on `{fromUser, topicId, messageId}`.
  **The key is normalized before use (round-1, codex; refined round-3):** the
  dedupe runs on the explicit `dedupeId` string (§3) with `topicId` coerced to a
  number, because a string/number mismatch between two callers would silently
  defeat it. Telegram message ids are unique
  per chat, not globally, which is why `topicId` is part of the key — and tests
  cover numeric/string equality, the same message arriving by two routes, and two
  topics carrying the same id.

## 3. Design

**Log at the injection seam.** `injectTelegramMessage` records the message
before injecting it — **always, whenever the feature is enabled**, using the
platform's `messageId` when present and a per-injection id when not.

That is the whole mechanism. **It is deliberately not a queue, an event bus or a
write-ahead log (round-1, codex — worth naming so the small design reads as
intentional):** the persistence it needs already exists and is already written to
by the same function on another path, the record is machine-local by nature
(§6), and nothing downstream consumes it transactionally. Introducing an
abstraction here would be the mistake the companion spec made four times and
undid three.

It works because:

- **The seam is the real chokepoint — and that claim carries a proof obligation
  (round-1, codex).** Stating it is not enough; the same "surely everything goes
  through here" assumption is what produced this bug. So the change ships with an
  **architectural fitness test** — the honestly-enforceable form (round-2, codex
  correctly noting that "Telegram-originated" is not statically knowable from a
  regex, given aliases, wrappers and dynamic dispatch). The test enumerates the **allowlisted callers of the two low-level primitives**
  — `SessionManager.injectMessage` and `SessionManager.rawInject` — in a fixture.
  Those, not `injectTelegramMessage`, are what the test scans, and deliberately:
  `injectTelegramMessage` is the seam that *does* the logging, so a new path that
  bypasses the gap would do so by reaching for the primitives underneath it. The
  fixture is the list of functions permitted to call them; any new
  caller fails it until the allowlist is updated deliberately, at which point a
  human has to decide whether that path also needs to log. It does not prove the
  seam is universal — it makes *adding a bypass* a conscious act rather than an
  invisible one, which is the achievable version of the guarantee. **Stated
  plainly because the E2E does not close the gap either (round-4, codex):** the
  E2E exercises a message injected into a live session, not the real production
  intake edge, so neither the fitness test nor the E2E proves every intake path
  records. What they jointly provide is: the known paths are covered, and a new
  one cannot be added silently. The residual — a dynamically-dispatched or
  future non-session intake path — is real and named rather than papered over.
- **De-duplication already exists.** The existing key is
  `in:<topicId>:<messageId>`, so a message that reaches both the forward route
  and the seam is written once. The forward route's call is left in place —
  removing it would be a second change for no benefit.
- **A missing `messageId` is recorded anyway, not dropped (round-1, raised
  independently by codex and gemini).** v1 said "no id ⇒ no log entry", justified
  by re-deliveries whose originals were already logged. That is an assumption
  about someone else's protocol, and if any first-class path lacks an id the gap
  simply survives in a subset — invisibly. Concretely:

  - `messageId` keeps its type: the platform's number, or `null` when absent.
  - a new **`dedupeId: string`** is always present and is what the dedupe uses:
    `String(messageId)` when the platform supplied one, otherwise a fresh
    **per-injection UUID**. Cross-redelivery dedupe therefore works exactly where
    it can be correct — on a platform id — and is not faked anywhere else. *(A
    separate string field, not a widened `messageId`: the existing key coerces to
    a number, so a string id left implicit is a `NaN` collision waiting to
    happen — round-3, codex.)*
  - the entry is marked `idSource: 'platform' | 'derived'`.

  **The per-injection UUID identifies this log entry and nothing more — it never
  collapses two messages (rounds 2–4, and corrected again in round 8: v7 still
  called it "retry idempotency", which stopped being true when round 6 deleted the
  retry).** Two earlier
  designs tried to derive identity from content: one hashed a timestamp the seam
  never receives (so a retry produced a *different* id, defeating the very dedupe
  it claimed), and one hashed topic+text (so every byte-identical message
  collapsed — and "ok", "yes", "continue" are common in chat *and semantically
  distinct*, which would have silently dropped real messages, reintroducing this
  spec's own bug inside its dedupe). **Without a platform id there is no honest
  way to tell a retry from a genuine repeat, so the duplicate is preferred:
  duplicate rows are cheap, a dropped message is the bug.** The accepted cost,
  stated rather than discovered: an id-less message that is genuinely re-delivered
  produces two rows.

### 3.1 Ordering: accept first, then inject — and it is a RECEIVED log

The entry is **accepted for logging before the injection is attempted**, so an
injection failure cannot produce an unrecorded message. *(Round-6, codex: earlier
drafts said "the log write happens before injection", which stopped being true
when the write moved off the tick — accepted-before is the honest guarantee, and
the residual is stated in §3.2.)*

**This makes it an inbound-*received* log, not an agent-*observed* log
(round-1, codex).** "Shown-or-nearly-shown" was a category that does not exist:
if injection fails, the entry still says the message arrived, and a later reader
could wrongly infer the agent saw it. Rather than add a delivery-status update
(a second write, for a distinction no consumer currently needs), the log is
**named** for what it honestly records — messages received for this session —
and the field is `receivedAt`, not `shownAt`. If a consumer ever needs
agent-observed semantics, that is a new field with its own write, not a
reinterpretation of this one.

**What a consumer must therefore assume (round-2, codex).** The session-start
history reader — the one consumer that matters today — may show a message that
was received but whose injection failed. That is the correct trade for its
purpose: it is far better for a resumed session to see a message the operator
sent and the agent possibly missed, than to miss it entirely. The reader is
documented as showing *what arrived*, and an injection failure is already loud
elsewhere. No consumer may read this log as proof the agent acted on a
message.

### 3.2 Failure direction: never block the message

**The write is fire-and-forget on the next tick. That is the whole mechanism
(round-6, codex — and this is the third and final iteration of this paragraph).**

The history is worth keeping because it is the same mistake three times. v4
wrapped the write in a 250 ms budget; codex pointed out a promise timeout does
not *cancel* a filesystem or SQLite write, so the budget bounded the wait while
leaving the work unbounded. v5 replaced it with a bounded queue, a worker,
retries, a breaker, a drop policy and alerting — and codex pointed out that a
document insisting "this is not a queue, no new abstraction" had just specified a
queue subsystem. Both fixes were bigger than the problem.

**The problem is only this: a synchronous write can block the injection path.**
The fix is to not do it synchronously:

```
try { setImmediate(() => { try { logInbound(entry) } catch { count() } }) }
catch { /* never block the injection */ }
```

- The injection proceeds on the current tick; the write happens on the next one.
  **What this protects, stated exactly (round-8, codex):** *this* injection is
  never awaited, so *this* message is never delayed. It does **not** make a
  synchronous store non-blocking — a wedged synchronous write on a later tick can
  still stall the event loop for everything behind it. So the operational
  assumption is explicit rather than implied: **the write must fail fast**
  (bounded SQLite `busy_timeout`, no unbounded file-lock waits).
- A failure is caught and counted (`inbound-log-failed`). **No retry** — a retry
  is a loop, a loop needs brakes, brakes need a breaker, and that is exactly the
  subsystem this paragraph deleted twice. A best-effort log does not earn it.
- **No queue, no worker, no cap, no drop policy.** Inbound messages normally
  arrive at human typing speed, so there is no burst to absorb.
- **That assumption is tested, not asserted (round-9, codex — Telegram genuinely
  bursts after a reconnect, a restart, a polling backlog or a forwarded batch).**
  A stress test drives 200 inbound messages and asserts injection latency is
  unaffected and no unbounded synchronous work occurs. If it ever fails, the
  assumption is wrong and the design is revisited — rather than pre-building a
  queue against a burst that may never happen.
- **One guardrail, not a subsystem (round-7, codex):** a counter tracks pending
  log callbacks, and crossing a small threshold (32) raises ONE deduped Attention
  item. It measures the assumption; it does not work around it.
- **A counter nobody reads is not observability (round-1, gemini):** a sustained
  non-zero failure rate over an hour raises ONE deduped Attention item. Silently
  degrading the agent's memory is precisely the failure this spec exists to end.

**Residual, stated plainly:** a crash between the injection and the next tick
loses that entry, and a wedged store loses entries for as long as it is wedged.
Both are real, both are counted, and both are vastly smaller than the defect being
fixed — which is *every* inbound message, always, silently. Making the write
durable across a crash would mean a write-ahead store on the inbound path, and
that is the abstraction §3 declines for a reason that has now been demonstrated
twice in this section's own history.

### 3.3 Rollout

`messaging.inboundSeamLogging.enabled`, **default true**, with an emergency
disable. Not dark-shipped: it restores a recording that the system already
intends to perform and already performs on one path, and every day it is off is
another day of unrecoverable conversation. The lever exists for one reason — if
the write turns out to be hot on some install, the operator can stop it without
waiting for a release.

## 4. Honest limits

- **This does not merge histories across machines.** If the operator's message
  lands on machine A and the reply is composed on machine B, each machine now
  records what it saw. Neither holds a merged view. That is a separate, larger
  change (pool-scope history read, or inbound replication) and is deliberately
  **not** attempted here — see §8.1.
- **It does not backfill.** Messages between 2026-07-20 and this shipping are
  gone on this machine and cannot be reconstructed.
- **It fixes the machine that injects.** If a message is never injected anywhere
  (queued, dropped, refused), it is still not recorded — correctly, since nothing
  saw it.

## 5. Test plan

**Unit** — `injectTelegramMessage` calls `logInboundMessage` with the fields it
received; **when `messageId` is absent it still logs, under a per-injection UUID, with
`idSource: 'derived'`** (round-2, standards gate: the test plan still asserted
the retired no-id-no-entry behaviour one fold after the design changed — caught
in a 200-line document, which is the point); two identical messages in the same
second produce two distinct rows (§3); the dedupe key coerces
string/number ids; a throwing logger is caught, counted, and the injection still
happens; the log call precedes the inject call (asserted by call order, not by
timing).

**Integration** — a message delivered through the real inject path appears in the
JSONL log and in TopicMemory with `fromUser: true`; the same message arriving via
**both** the forward route and the seam is written **once**; with the flag off,
no inbound row is written and delivery is unaffected.

**Live-user-channel proof (required before this is called done).** The E2E below
exercises the injection seam, **not** the real Telegram surface — the standards
gate flagged exactly that, and it is right: this is a Telegram-channel behavior,
so "done" requires a user-role live test that sends a real message through
Telegram and reads it back out of the topic history. That test is the acceptance
criterion, not the unit and integration tiers. The seam-level E2E below is the
fast check that the wiring exists; the live-channel test is the one that proves
the defect is actually gone, and it is the one that would have caught this bug in
the first place.

**E2E** — production initialization path: a message injected into a live session
is readable back from the topic history **within a bounded interval** (the write
lands on the next tick, so the test awaits it rather than asserting
instantaneity — round-6, codex: an immediate-read assertion against an
off-tick write is a race, and a flaky test here would be worse than no test). This is the
"feature is alive" test, and it is the one that would have caught the original
gap.

**Regression** — the specific defect: after a message is injected, a
session-start history read for that topic contains it. Asserted against the same
reader the session-start hook uses, so a future refactor that changes which store
that reader consults fails here rather than in production five days later.

## Decision points touched (§5)

| Decision point | What it decides | Classification | Justification |
|---|---|---|---|
| Whether to log an inbound message | Recording, not delivery | **invariant** | A deterministic predicate: **the feature is enabled**. An id is always available — the platform's when present, the derived one otherwise (§3) — so a missing id never decides whether to record. No judgment, no model, no context. |
| Log-vs-inject ordering | Which happens first on failure | **invariant** | Stated in §3.1: log first, unconditionally. Not situational. |
| Log-failure disposition | Whether a failed log blocks the message | **invariant** | Always proceed (§3.2). The conservative default here is *deliver*, because the harm being prevented is silence. |

## 6. Multi-machine posture

| Surface | Posture | Notes |
|---|---|---|
| The seam call | **unified** | Code — identical on every machine by construction. |
| The message log + TopicMemory rows it writes | **machine-local BY DESIGN** | `machine-local-justification: physical-credential-locality` — the Telegram bot token and the forum/topic ids it namespaces live on the machine that polls, and the log is that machine's record of what *it* saw. A machine cannot honestly record having been shown a message it was not shown. Merging the two halves into one readable history is the separate change in §8.1, and it is a *read*-side merge, not a replication of this write. |

## 7. Frontloaded Decisions

1. **Log at the seam, not at each caller** — two callers today, and a third would silently reintroduce the gap.
2. **Log before injecting** (§3.1).
3. **A log failure never blocks the message** (§3.2).
4. **The forward route's existing call stays** — dedup makes it harmless, and removing it is unrelated risk.
5. **A missing `messageId` gets a per-injection UUID** (§3), not silence and not a content hash — an id-less message is recorded, and no cross-message identity is inferred from its bytes.
6. **Ships enabled, not dark** (§3.3) — every day off is unrecoverable conversation.
7. **No backfill attempted** (§4).
8. **Cross-machine history merge is explicitly out of scope**, and tracked as
   ACT-1216 rather than left as a note (§8.1).
9. **This is a RECEIVED log, not an OBSERVED log** (§3.1) — the honest name for
   what it records, chosen over a second write to track delivery status.
10. **No new abstraction** — no queue, worker, event bus or write-ahead log
    (§3, §3.2). The persistence already exists and nothing consumes it
    transactionally. This decision was violated twice during review (a timeout
    budget, then a queue subsystem) and restored both times; the record is left
    in §3.2 because the violations were more instructive than the decision.
11. **The write is fire-and-forget on the next tick, with no retry** (§3.2) — a
    retry is a loop, a loop needs brakes, and a best-effort received-log does not
    earn that machinery.

## Open questions (§8)

*(none)*

> Nothing is parked on the operator. The one adjacent decision — whether to merge
> histories across machines — is recorded as a dependency below, not as a question.

## 8.1 Dependencies (external to this spec)

| Dependency | What blocks on it |
|---|---|
| A pool-scope conversation-history read (or inbound replication) — **tracked as ACT-1216** | Only the *merged* view. This spec is complete and useful without it: each machine gains an honest record of what it saw, which is what session-start history reads. Registered as a tracked action rather than left as a note, so the deferral has an owner and a cadence (Close the Loop — flagged by the standards gate on round 1 of this spec, and it was right: a dependency named only in prose is an orphan). |

## 9. What this does not do

- It does not merge or replicate histories across machines (§4, §8.1).
- It does not backfill what was lost.
- It does not change delivery, routing, or any gate.
