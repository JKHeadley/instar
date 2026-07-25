<!-- GENERATED FILE — DO NOT EDIT.
     Source: docs/specs/inbound-message-recording-gap.md
     Regenerate: node scripts/generate-spec-contract.mjs --spec docs/specs/inbound-message-recording-gap.md
     This is the IMPLEMENTATION CONTRACT: the normative design only.
     Review history (change logs, retired designs, reversed decisions) is
     deliberately absent — read the source spec for how the design got here.
-->
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
forward route at `src/server/routes.ts:20124` — and messages on this machine
arrive by a different path. *(Confirmed on current main, v1.3.953.)*

**The observed cost, not a hypothetical.** On 2026-07-25 the agent re-derived a
design the operator had specified on 2026-07-23 and reported it back as a new
finding, because at session start it could read its own half of the conversation
and not the operator's. Every session resumes reading what the agent said and
not what it was asked.

## 2. What exists today (verified against the running tree)

- `SessionManager.injectTelegramMessage(tmuxSession, topicId, text, topicName?, senderName?, telegramUserId?, messageId?)` — `src/core/SessionManager.ts:5045` **on current main (v1.3.953)**. **Every inbound message reaches a session through it**, whether injected inline or written to an inbound file for long messages.
- It already receives **every field the log needs**. No plumbing is required.
- **Four callers, not two** — `src/server/routes.ts:20323`, and `src/commands/server.ts` at 2763, 2985 and 20711. **Only the first passes a `messageId`**; the others call the seam without one, which is precisely why §3 records id-less messages rather than dropping them. Had that decision gone the other way, three of the four inbound paths would have stayed invisible.

 *(Re-verified against the worktree at v1.3.953 after discovering the earlier
 numbers came from the agent-home checkout, which is pinned at v1.3.626 — six
 hundred versions stale. The running server is v1.3.953, so the worktree is the
 tree that matters. The correction changed a real fact: "two callers" was wrong,
 and the extra two are exactly the id-less ones.)*
- `TelegramAdapter.logInboundMessage()` (`src/messaging/TelegramAdapter.ts:1279`) already writes to both the JSONL log and TopicMemory, and `appendToLog` already de-duplicates on `{fromUser, topicId, messageId}`.
 **The key is normalized before use:** the
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

**The seam orchestrates; it does not do the logging.** The concern is fair in shape but does not apply here:
`TelegramAdapter.logInboundMessage()` **is** the dedicated logger, and it already
exists and is already used by the forward route. `injectTelegramMessage` gains one
call to it — an orchestration line, not a second responsibility. What would
violate SRP is inlining the write into the seam, and that is expressly not what
this does.

That is the whole mechanism. **It is deliberately not a queue, an event bus or a
write-ahead log:** the persistence it needs already exists and is already written to
by the same function on another path, the record is machine-local by nature
(§6), and nothing downstream consumes it transactionally. Introducing an
abstraction here would be the mistake the companion spec made four times and
undid three.

It works because:

- **The seam is the real chokepoint — and that claim carries a proof obligation.** Stating it is not enough; the same "surely everything goes
 through here" assumption is what produced this bug. So the change ships with an
 **architectural fitness test** — the honestly-enforceable form. The test enumerates the **allowlisted callers of the two low-level primitives**
 — `SessionManager.injectMessage` and `SessionManager.rawInject` — in a fixture.
 Those, not `injectTelegramMessage`, are what the test scans, and deliberately:
 `injectTelegramMessage` is the seam that *does* the logging, so a new path that
 bypasses the gap would do so by reaching for the primitives underneath it. The
 fixture is the list of functions permitted to call them; any new
 caller fails it until the allowlist is updated deliberately, at which point a
 human has to decide whether that path also needs to log. **Each entry carries a
 one-line reason and the fixture rejects an entry without one.** Otherwise the guarantee decays into "someone remembered to think
 about it when they added a line" — a willpower dependency, in a project whose
 founding principle is that willpower is not a mechanism. Requiring the reason
 means adding a bypass costs a sentence explaining why that path need not log,
 which is exactly the moment the question should be asked. It does not prove the
 seam is universal — it makes *adding a bypass* a conscious act rather than an
 invisible one, which is the achievable version of the guarantee. **Stated
 plainly because the E2E does not close the gap either:** the
 E2E exercises a message injected into a live session, not the real production
 intake edge, so neither the fitness test nor the E2E proves every intake path
 records. What they jointly provide is: the known paths are covered, and a new
 one cannot be added silently. The residual — a dynamically-dispatched or
 future non-session intake path — is real and named rather than papered over.
- **De-duplication already exists.** The existing key is
 `in:<topicId>:<messageId>`, so a message that reaches both the forward route
 and the seam is written once. The forward route's call is left in place —
 removing it would be a second change for no benefit.
- **The logged `text` is the operator's message, not the wrapper.** Verified against the seam: `injectTelegramMessage` receives
 the raw `text`, then *builds* the tagged form and, only when that exceeds the
 file threshold, writes the tagged form to an inbound file and injects a pointer
 to it. The `text` parameter is therefore always the full operator message —
 never a file path, never the `[telegram:N]`-tagged wrapper, never a truncation.
 The log records that parameter, so a long message is recorded **in full** even
 though what reached the session was a pointer to it.
- **A missing `messageId` is recorded anyway, not dropped.** v1 said "no id ⇒ no log entry", justified
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
 happen.)*
 - the entry is marked `idSource: 'platform' | 'derived'`.

 **Storage contract, grounded in the real schema.** `topic-memory.db`'s `messages` table declares
 `message_id INTEGER NOT NULL`. A `messageId: null` entry therefore **cannot be
 inserted**: the design as written would have failed at implementation, not at
 review. So:

 - **JSONL** rows are free-form objects, so `dedupeId`, `idSource` and a null
 `messageId` cost nothing there. This is the record the session-start history
 reader uses, and it carries the full shape.
 - **TopicMemory** keeps its existing columns and needs **no migration**. When
 the platform supplies no id, the insert uses a **synthetic negative integer**
 `message_id`. Negative is safe by construction — Telegram ids are positive, so
 a synthetic id can never collide with a real one, and a reader seeing a
 negative id knows it was minted locally.
 - **No existing reader is affected:** no column changed type, nothing became
 nullable, and no reader sees a field it did not see before.

 **Back-compat for the dedupe key.** A platform-id entry written
 by the seam and one written by the forward route MUST produce the identical key,
 or the first post-upgrade delivery of an already-logged message duplicates it.
 Rows written before this change have no `dedupeId`, so the comparison falls back
 to `messageId` when `dedupeId` is absent. An id-less entry never compares equal
 to a legacy row — a `null`/`NaN` key must not collapse distinct messages, which
 is the same failure the content-hash design was rejected for.

 **The per-injection UUID identifies this log entry and nothing more — it never
 collapses two messages.** Two earlier
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
injection failure cannot produce an unrecorded message. 

**This makes it an inbound-*received* log, not an agent-*observed* log.** "Shown-or-nearly-shown" was a category that does not exist:
if injection fails, the entry still says the message arrived, and a later reader
could wrongly infer the agent saw it. Rather than add a delivery-status update
(a second write, for a distinction no consumer currently needs), the log is
**named** for what it honestly records — messages received for this session —
and the field is `receivedAt`, not `shownAt`. If a consumer ever needs
agent-observed semantics, that is a new field with its own write, not a
reinterpretation of this one.

**What a consumer must therefore assume.** The session-start
history reader — the one consumer that matters today — may show a message that
was received but whose injection failed. That is the correct trade for its
purpose: it is far better for a resumed session to see a message the operator
sent and the agent possibly missed, than to miss it entirely. The reader is
documented as showing *what arrived*, and an injection failure is already loud
elsewhere. No consumer may read this log as proof the agent acted on a
message.

### 3.2 Failure direction: never block the message

**The write is fire-and-forget on the next tick. That is the whole mechanism.**

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
 **What this protects, stated exactly:** *this* injection is
 never awaited, so *this* message is never delayed. It does **not** make a
 synchronous store non-blocking — a wedged synchronous write on a later tick can
 still stall the event loop for everything behind it. So the operational
 assumption is explicit rather than implied: **the write must fail fast** — and
 it is, verified rather than asserted. `TopicMemory` opens its database with `journal_mode = WAL` and
 **`busy_timeout = 5000`** (`src/memory/TopicMemory.ts`), so a contended write
 fails after five seconds rather than waiting indefinitely, and WAL means readers
 never block it in the first place. Five seconds of loop stall is still bad, so
 the pending-callback guardrail below is what would surface a store behaving that
 way; but the unbounded case — the one that would wedge the process — is closed
 by the existing pragma, not by a new assumption.
- A failure is caught and counted (`inbound-log-failed`). **No retry** — a retry
 is a loop, a loop needs brakes, brakes need a breaker, and that is exactly the
 subsystem this paragraph deleted twice. A best-effort log does not earn it.
- **No queue, no worker, no cap, no drop policy.** Inbound messages normally
 arrive at human typing speed, so there is no burst to absorb.
- **That assumption is tested, not asserted.**
 A stress test drives 200 inbound messages and asserts injection latency is
 unaffected and no unbounded synchronous work occurs. If it ever fails, the
 assumption is wrong and the design is revisited — rather than pre-building a
 queue against a burst that may never happen.
- **One guardrail, not a subsystem:** a counter tracks pending
 log callbacks, and crossing a small threshold (32) raises ONE deduped Attention
 item. It measures the assumption; it does not work around it.
- **A counter nobody reads is not observability:** a sustained
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

- **The local-only record is a deliberate trade, with a named ceiling.** This optimises for present simplicity and a machine-local record. If
 cross-machine auditing, centralised analytics or distributed replay ever become
 requirements, that is **not** an extension of this design — it is a different
 one, built around an event stream rather than a per-machine log. Forewarned here
 so the eventual re-architecture is a known cost rather than a surprise; the
 first step toward it is ACT-1216.
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
`idSource: 'derived'`**; two identical messages in the same
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
instantaneity. This is the
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
| Log-scheduling-vs-inject ordering | Which happens first | **invariant** | Stated in §3.1: the log task is **scheduled** first, unconditionally. The write itself lands *after* injection, by design — the invariant is about scheduling order, never about the write having completed. |
| Log-failure disposition | Whether a failed log blocks the message | **invariant** | Always proceed (§3.2). The conservative default here is *deliver*, because the harm being prevented is silence. |

## 6. Multi-machine posture

| Surface | Posture | Notes |
|---|---|---|
| The seam call | **unified** | Code — identical on every machine by construction. |
| The message log + TopicMemory rows it writes | **machine-local BY DESIGN** | `machine-local-justification: physical-credential-locality` — the Telegram bot token and the forum/topic ids it namespaces live on the machine that polls, and the log is that machine's record of what *it* saw. A machine cannot honestly record having been shown a message it was not shown. Merging the two halves into one readable history is the separate change in §8.1, and it is a *read*-side merge, not a replication of this write. |

## 7. Frontloaded Decisions

1. **Log at the seam, not at each caller** — two callers today, and a third would silently reintroduce the gap.
2. **Schedule the log before injecting** (§3.1) — scheduling order, never write
 order. Named this way after three rounds of reviewers reading "log first" as a
 synchronous call, which is exactly how it would be mis-implemented.
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
