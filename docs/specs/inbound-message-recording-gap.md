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
  **The key is normalized before use (round-1, codex):** `messageId` is coerced
  to a number and `topicId` to a number, because a string/number mismatch between
  two callers would silently defeat the dedupe. Telegram message ids are unique
  per chat, not globally, which is why `topicId` is part of the key — and tests
  cover numeric/string equality, the same message arriving by two routes, and two
  topics carrying the same id.

## 3. Design

**Log at the injection seam.** `injectTelegramMessage` calls
`telegram.logInboundMessage(...)` before injecting, when a `messageId` is
present.

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
  regex, given aliases, wrappers and dynamic dispatch). The test enumerates the
  **allowlisted callers** of `injectMessage`/`rawInject` in a fixture; any new
  caller fails it until the allowlist is updated deliberately, at which point a
  human has to decide whether that path also needs to log. It does not prove the
  seam is universal — it makes *adding a bypass* a conscious act rather than an
  invisible one, which is the achievable version of the guarantee.
- **De-duplication already exists.** The existing key is
  `in:<topicId>:<messageId>`, so a message that reaches both the forward route
  and the seam is written once. The forward route's call is left in place —
  removing it would be a second change for no benefit.
- **A missing `messageId` gets a DERIVED id, not silence (round-1, raised
  independently by codex and gemini).** v1 said "no id ⇒ no log entry", justified
  by re-deliveries whose originals were already logged. That is a fragile
  protocol assumption, and if any first-class path lacks an id the gap simply
  survives in a subset — which is exactly the failure being fixed. So: when the
  source id is absent, the entry is logged under a **derived id** —
  `sha256(topicId ‖ text)` truncated, marked `idSource: 'derived'`.
  **No timestamp is in the hash, deliberately (round-2, codex).** v2 hashed a
  timestamp and called the result deterministic; the seam never receives one, so
  it would have been generated at log time and a retry would have produced a
  *different* id — defeating the dedupe the design claimed. Hashing only the
  topic and the text makes a retry collapse reliably, which is the case that
  matters. The accepted cost, stated rather than discovered: **two genuinely
  distinct but byte-identical messages in the same topic collapse to one entry.**
  For a received-log that is a small, bounded loss; a duplicated record of a
  retry is the worse failure, and the platform-supplied id covers the normal
  path anyway.

### 3.1 Ordering: log first, then inject — and it is a RECEIVED log

The log write happens **before** the injection, so an injection failure cannot
produce an unrecorded message.

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

A throw from the log call is caught, counted (`inbound-log-failed`), and the
injection proceeds. **A counter nobody reads is not observability (round-1,
gemini):** a sustained non-zero rate over an hour raises ONE deduped Attention
item naming the failure class, because silently degrading the agent's memory is
precisely the failure this spec exists to end — and it would otherwise degrade
in exactly the same invisible way, just for a different reason. **Recording is observability; it must never become the reason
the operator cannot reach the agent** ("The Agent Is Always Reachable"). This is
the opposite of the outbound spec's authority-for-evidence bargain, and correctly
so: no authority is being granted here, so no evidence is owed.

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
received; **when `messageId` is absent it still logs, under the derived id, with
`idSource: 'derived'`** (round-2, standards gate: the test plan still asserted
the retired no-id-no-entry behaviour one fold after the design changed — caught
in a 200-line document, which is the point); two identical messages in the same
second collapse to one entry via the derived id; the dedupe key coerces
string/number ids; a throwing logger is caught, counted, and the injection still
happens; the log call precedes the inject call (asserted by call order, not by
timing).

**Integration** — a message delivered through the real inject path appears in the
JSONL log and in TopicMemory with `fromUser: true`; the same message arriving via
**both** the forward route and the seam is written **once**; with the flag off,
no inbound row is written and delivery is unaffected.

**E2E** — production initialization path: a message injected into a live session
is readable back from the topic history immediately afterwards. This is the
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
5. **A missing `messageId` gets a deterministic DERIVED id** (§3), not silence — the platform is not trusted to always supply one.
6. **Ships enabled, not dark** (§3.3) — every day off is unrecoverable conversation.
7. **No backfill attempted** (§4).
8. **Cross-machine history merge is explicitly out of scope**, and tracked as
   ACT-1216 rather than left as a note (§8.1).
9. **This is a RECEIVED log, not an OBSERVED log** (§3.1) — the honest name for
   what it records, chosen over a second write to track delivery status.
10. **No new abstraction** — no queue, event bus or write-ahead log (§3); the
    persistence already exists and nothing consumes it transactionally.

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
