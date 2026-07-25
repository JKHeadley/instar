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

- `SessionManager.injectTelegramMessage(tmuxSession, topicId, text, topicName?, senderName?, telegramUserId?, messageId?)` — `src/core/SessionManager.ts:5045` **on current main (v1.3.953)**. **Every currently-verified inbound session delivery reaches a session through it**, whether injected inline or written to an inbound file for long messages. *(Round-15, codex: "every inbound message" claims more than the fitness test can prove — the honest scope is the delivery paths verified today, plus the guarantee that a new bypass cannot be added silently.)*
- It already receives **every field the log needs**. No plumbing is required.
- **Four callers, not two** — `src/server/routes.ts:20323`, and `src/commands/server.ts` at 2763, 2985 and 20711. **Only the first passes a `messageId`**; the others call the seam without one, which is precisely why §3 records id-less messages rather than dropping them. Had that decision gone the other way, three of the four inbound paths would have stayed invisible.

  *(Re-verified against the worktree at v1.3.953 after discovering the earlier
  numbers came from the agent-home checkout, which is pinned at v1.3.626 — six
  hundred versions stale. The running server is v1.3.953, so the worktree is the
  tree that matters. The correction changed a real fact: "two callers" was wrong,
  and the extra two are exactly the id-less ones.)*
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

**The seam orchestrates; it does not do the logging (round-12, gemini raised
single-responsibility).** The concern is fair in shape but does not apply here:
`TelegramAdapter.logInboundMessage()` **is** the dedicated logger, and it already
exists and is already used by the forward route. `injectTelegramMessage` gains one
call to it — an orchestration line, not a second responsibility. What would
violate SRP is inlining the write into the seam, and that is expressly not what
this does.

That is the whole mechanism. **What it is, named honestly (round-21, codex — v20
still said "not a write-ahead log" while implementing exactly that shape):** it is
a **miniature write-ahead split** — a minimal record written synchronously,
secondary indexes updated asynchronously. That is an industry pattern, not an
invention, and pretending otherwise made the design harder to evaluate rather
than smaller.

**"Durable" is one word too far, though (round-22, codex).** `appendFileSync`
returns when the bytes reach the OS, not the platter: without `fsync` a power
loss or kernel panic can still lose the tail. Calling this a *durable* WAL
overclaims. It is a **synchronous best-effort append** — which survives the
failure this bug is actually about (a process crash or restart, where the OS
buffer is flushed normally) and does not survive a machine losing power
mid-write. `fsync` per message is deliberately **not** added: it would cost
milliseconds of real disk latency on every inbound message, on the delivery path,
to protect against a failure mode that loses the running session anyway.

**What it is still deliberately NOT:** a queue subsystem, an event bus, a worker,
a retry ladder, or any new persistent store. The persistence already exists and is
already written by the same function on another path; the record is machine-local
by nature (§6); nothing downstream consumes it transactionally. That is the real
distinction, and it is the one rounds 5 and 6 deleted machinery to preserve.

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
  **The test is AST-based, not a regex over source text (round-17, codex — a
  regex fixture invites exactly the false confidence this test exists to avoid).**
  It walks the parsed module graph for references to the two primitives, which
  catches renamed imports and aliases that a text search would miss. It still
  cannot see genuinely dynamic dispatch, so a **runtime counter** records raw
  primitive use from outside the approved call sites — the static test catches
  what is knowable at build time, the counter reports what is only knowable at
  run time, and neither pretends to be the other. **The guarantee is therefore
  "static enforcement plus runtime anomaly counting", not "runtime enforcement"
  (round-19, codex).** Attributing a call to an approved site at runtime would
  need stack inspection, which is expensive and fragile; the counter instead
  records *total* primitive invocations and compares against the count the
  approved sites report making. A divergence says "something else called this"
  without saying who — an anomaly signal, not an attribution mechanism, and
  described as such.
  The fixture is the list of functions permitted to call them; any new
  caller fails it until the allowlist is updated deliberately, at which point a
  human has to decide whether that path also needs to log. **Each entry carries a
  one-line reason and the fixture rejects an entry without one (round-9,
  gemini).** Otherwise the guarantee decays into "someone remembered to think
  about it when they added a line" — a willpower dependency, in a project whose
  founding principle is that willpower is not a mechanism. Requiring the reason
  means adding a bypass costs a sentence explaining why that path need not log,
  which is exactly the moment the question should be asked. It does not prove the
  seam is universal — it makes *adding a bypass* a conscious act rather than an
  invisible one, which is the achievable version of the guarantee. **Stated
  plainly because the E2E does not close the gap either (round-4, codex):** the
  E2E exercises a message injected into a live session, not the real production
  intake edge, so neither the fitness test nor the E2E proves every intake path
  records. What they jointly provide is: the known paths are covered, and a new
  one cannot be added silently. The residual — a dynamically-dispatched or
  future non-session intake path — is real and named rather than papered over.
  **And it is not what "done" rests on:** §5 requires a **user-role live test
  through the real Telegram surface** before this ships, precisely because
  seam-level tests prove wiring rather than experience. The caveat here describes
  the limits of the *static* guarantee; the live-channel test is the acceptance
  criterion, and the two are complements, not alternatives.
- **De-duplication already exists, and it is atomic within the process
  (round-16, codex asked whether the "written once" guarantee assumes atomicity
  it never specified).** Grounded in the implementation: `appendToLog` checks an
  **in-memory `Set`** and appends **synchronously**, with no `await` between the
  check and the write. Node is single-threaded, so two calls in one process
  cannot interleave — the forward route and the seam are serialized by the
  runtime, not by luck. The guarantee therefore holds **within a process**, which
  is the whole story here because the advisory design's single-instance lock means
  one server per agent home (§6). Across processes it would be best-effort, and a
  race-shaped test — both writers invoked in the same tick — pins the in-process
  case rather than only testing sequential delivery.
  **It also survives restart (round-18, codex asked; the answer is in the code):**
  `seedMessageLogDedupe()` rebuilds the in-memory set by reading the JSONL file on
  first use, so a restarted process re-learns every key. One caveat worth stating —
  seeding skips rows whose `messageId` is not a number, so **id-less entries are
  not re-seeded**. Harmless here precisely because their per-injection UUID never
  deduped across arrivals anyway: nothing is lost that was ever promised.
  The existing key is `in:<topicId>:<messageId>`, so a message that reaches both
  the forward route and the seam is written once **to JSONL**. **TopicMemory is a
  different story and the guarantee does not extend to it (round-24, codex):**
  its `(topic_id, message_id)` index is plain, so nothing there prevents a
  duplicate row. In practice the in-memory dedupe short-circuits before *either*
  write happens, so duplicates do not arise on this path — but the guarantee that
  is *enforced* is JSONL's, and TopicMemory's freedom from duplicates is a
  consequence of the caller, not a property of the store. Said plainly because
  "written once" reads as a storage guarantee and is not one. The forward route's call is left in place —
  removing it would be a second change for no benefit.
- **The logged `text` is the operator's message, not the wrapper (round-10,
  codex — "if the seam logs the wrong representation, history remains incomplete
  or misleading").** Verified against the seam: `injectTelegramMessage` receives
  the raw `text`, then *builds* the tagged form and, only when that exceeds the
  file threshold, writes the tagged form to an inbound file and injects a pointer
  to it. The `text` parameter is therefore always the full operator message —
  never a file path, never the `[telegram:N]`-tagged wrapper, never a truncation.
  The log records that parameter, so a long message is recorded **in full** even
  though what reached the session was a pointer to it.
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
  - the entry carries **`deliveryState: 'received'`** — a single-valued enum
    today, and deliberately an enum rather than a boolean or an absence
    (round-16, codex). It gives a later `'injected'` or `'delivered'` somewhere
    safe to live, so evolving this record never requires *reinterpreting* an
    existing field. The alternative — adding meaning to `sessionReceivedAt` later
    — is precisely the reinterpretation that makes old rows lie.

  **Storage contract, grounded in the real schema (round-10, codex — and checking
  it found a genuine blocker).** `topic-memory.db`'s `messages` table declares
  `message_id INTEGER NOT NULL`. A `messageId: null` entry therefore **cannot be
  inserted**: the design as written would have failed at implementation, not at
  review. So:

  - **JSONL** rows are free-form objects, so `dedupeId`, `idSource` and a null
    `messageId` cost nothing there. This is the record the session-start history
    reader uses, and it carries the full shape.
  - **TopicMemory gets a two-column migration, and the negative-id sentinel is
    withdrawn (round-22, codex — its fourth time on this, and it is right).** The
    sentinel avoided a migration by encoding meaning in the *sign* of a shared
    integer column, which every current and future SQL reader has to remember when
    sorting, joining, displaying or exporting. Successive rounds answered with a
    helper, then an ordering caveat, then a consumer audit — three mitigations for
    a convention that should not exist. `ALTER TABLE messages ADD COLUMN
    id_source TEXT` and `ADD COLUMN dedupe_id TEXT` are cheap in SQLite
    (metadata-only, no table rewrite), both nullable so every existing row and
    every existing reader is untouched, and `message_id` keeps a real value: **the
    platform's when present, and `-1` as an inert placeholder when absent**, with
    `id_source` carrying the meaning instead of the sign.

    **Why `-1` is inert rather than a sentinel (round-23, codex asked whether
    repeated `-1`s collide).** Grounded in the schema: `idx_messages_topic_id` on
    `(topic_id, message_id)` is a **plain index, not unique**, so many rows may
    share `-1` without colliding — the identity for new rows is `dedupe_id`, and
    nothing enforces uniqueness on `message_id`. Removing `NOT NULL` outright
    would need a full table rebuild in SQLite, which is a materially bigger
    migration than two added columns; `-1` plus `id_source` gets the same
    semantics for an `ALTER TABLE ADD COLUMN`. The difference from the withdrawn
    sentinel is that **no reader has to interpret it**: meaning lives in
    `id_source`, and `-1` is just a value that satisfies the constraint.

    That deletes the helper, the ordering caveat, the consumer audit and the
    "future reader might misread it" residual — a net reduction, which is why it
    is worth the migration this spec spent four rounds avoiding.
  - **Ordering still comes from `(timestamp, rowid)`, not `message_id`.** With the
    sentinel withdrawn this is no longer a sign-related trap, but it remains true
    for a plainer reason: burst messages can share a timestamp, and `message_id`
    was never an arrival order. Insertion order is.
  - **JSONL and TopicMemory now carry the same identity fields** (`dedupe_id`,
    `id_source`), which retires the round-15 "reduced contract" caveat — that
    caveat existed only because the migration was being avoided.
  - **This is best-effort received history, not a durable intake acknowledgment
    (round-13, codex).** A crash before the next tick loses the row, so a reader
    may not treat the absence of an entry as proof a message never arrived, nor
    its presence as proof of delivery. One sentence, stated in the storage
    contract itself, because "received log" is a name a consumer can over-read.

  **Back-compat for the dedupe key (round-9, codex).** A platform-id entry written
  by the seam and one written by the forward route MUST produce the identical key,
  or the first post-upgrade delivery of an already-logged message duplicates it.
  Rows written before this change have no `dedupeId`, so the comparison falls back
  to `messageId` when `dedupeId` is absent. An id-less entry never compares equal
  to a legacy row — a `null`/`NaN` key must not collapse distinct messages, which
  is the same failure the content-hash design was rejected for.

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

The **essential JSONL append happens before the injection is attempted**, and the
secondary TopicMemory write is scheduled for after it — so an
injection failure cannot *by itself* produce an unrecorded message.

**The invariant, stated exactly (round-18, codex — the sentence above was still
too strong):** *recording is attempted before injection, unless the backlog guard
drops it; the essential JSONL write is synchronous and may briefly delay delivery;
the deferred TopicMemory write never can.* Three things can still leave a
message unrecorded — the JSONL append **failing** (counted), or, for the
*searchable copy only*, the backlog guard dropping it or a crash before the next
tick. All are counted. What the ordering buys is
narrower than it sounded: an injection that fails does not *cause* the gap.
*(Round-6, codex: earlier
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
message. **Naming makes that harder to get wrong; it does not enforce it
(round-17, codex — and v16 said "enforced by naming", which is an overclaim
inside the fix for an overclaim).** What naming buys: a consumer reading
`sessionReceivedAt` and `deliveryState: 'received'` has to work to misread them,
where one reading `deliveredAt` would have to work not to. What it does not buy:
any mechanism preventing a determined consumer from treating presence as
delivery. **The only real enforcement available is the enum** — a future
`'injected'` value means a consumer that cares can *check* rather than assume,
and that is the honest ceiling here.

### 3.2 Failure direction: the essential write is synchronous, the rest never blocks

**The invariant, split by write (round-21, codex — the round-20 change made the
old single invariant false, and "recording never blocks delivery" survived it).**

| Write | Timing | May it delay delivery? | May it be dropped? |
|---|---|---|---|
| **JSONL** (essential — what history reads) | **synchronous, before injection** | **Yes — briefly, and deliberately** | Never |
| **TopicMemory** (secondary — search, summaries) | deferred to the next tick | No | Yes, above the backlog bound |

**The JSONL append is not "non-blocking", and saying so was wrong (round-21,
codex).** `fs.appendFileSync` can stall on disk pressure, a full disk, a slow
mount or a filesystem hiccup. The trade is deliberate: a microsecond-scale append
in exchange for the essential record surviving a crash, on a path where the
alternative — deferring it — demonstrably bought nothing. It is bounded by
measurement rather than by hope: **append latency is sampled, and a p99 above
50 ms raises the same deduped Attention item**, because at that point the local
filesystem is the problem and this feature is merely the messenger. Delivery may
wait for this append; it may never wait for the TopicMemory write.

**The SECONDARY write is fire-and-forget on the next tick; the essential one is
not. That is the whole mechanism
(round-6, codex — and this is the third and final iteration of this paragraph).**

The history is worth keeping because it is the same mistake three times. v4
wrapped the write in a 250 ms budget; codex pointed out a promise timeout does
not *cancel* a filesystem or SQLite write, so the budget bounded the wait while
leaving the work unbounded. v5 replaced it with a bounded queue, a worker,
retries, a breaker, a drop policy and alerting — and codex pointed out that a
document insisting "this is not a queue, no new abstraction" had just specified a
queue subsystem. Both fixes were bigger than the problem.

**The problem was only ever the SLOW write blocking the injection path — and once
the two writes are split (below), only one of them is slow (round-20, codex).**
Deferring the JSONL append too was cargo-culted from before the split: it is a
microsecond append-only write, so deferring it bought nothing and cost real
crash-loss on the record that actually matters. The shape is the ordinary
write-ahead pattern — durable minimal record synchronously, secondary indexes
asynchronously:

```
try { appendJsonl(entry) } catch { count('inbound-log-failed') }   // sync, essential, never dropped
try { setImmediate(() => { try { writeTopicMemory(entry) } catch { count() } }) }
catch { /* never block the injection */ }
inject(...)
```

**The ordering invariant, stated so nothing is inferred from the listing
(round-24, codex).** Only two orderings are guaranteed and only two matter: the
**JSONL append completes before `inject` is called**, and the TopicMemory write
executes on a **later event-loop turn**. Whether that later turn lands before or
after `inject` returns is deliberately unspecified — `inject` may yield
internally, and **no correctness depends on the answer**. Reading an ordering out
of the source lines above would be inferring a guarantee the design does not
make.

**The exact logger API, named (round-25, codex — "one call to the existing
logger" and "separately callable" were both being said).** Two new methods
replace the composite call on this path:

| Method | Contract |
|---|---|
| `appendInboundJsonlSync(entry)` | Synchronous. Runs the dedupe check; returns `false` if already logged. Appends and returns `true`. Throws only on filesystem failure, which the seam catches. |
| `scheduleInboundTopicMemory(entry)` | Returns immediately. Honours the backlog cap. Performs no dedupe of its own — it is called **only** when the JSONL append returned `true`, so the upstream check has already gated it. |

The seam calls the first, and calls the second **only on a `true` return**.
`logInboundMessage()` remains for the forward route and becomes a thin composite
of the two, so that caller is unchanged.

**This requires the logger to split its phases (round-20, codex).**
`TelegramAdapter.logInboundMessage()` currently does both writes in one call, so
it gains an internal split — the JSONL append and the TopicMemory write become
separately callable — rather than the seam calling one combined method and hoping
for these semantics. Naming that explicitly, because "one call to the existing
logger" and "JSONL is never dropped while TopicMemory is" cannot both be true of
the current API.

- The injection proceeds on the current tick; the write happens on the next one.
  **What this protects, stated exactly (round-8, codex):** *this* injection is
  never awaited, so *this* message is never delayed. It does **not** make a
  synchronous store non-blocking — a wedged synchronous write on a later tick can
  still stall the event loop for everything behind it. So the operational
  assumption is explicit rather than implied: **the write must fail fast** — and
  it is, verified rather than asserted (round-10, gemini asked *how* it is
  guaranteed). `TopicMemory` opens its database with `journal_mode = WAL` and
  **`busy_timeout = 5000`** (`src/memory/TopicMemory.ts`), so a contended write
  fails after five seconds rather than waiting indefinitely, and WAL means readers
  never block it in the first place.

  **The two writes are split, because only one of them matters for this bug
  (round-19, codex — "make JSONL-only the fast path and let TopicMemory lag").**
  They were being treated as one write and bounded as one. They are not alike:

  - **JSONL is the essential record** — it is what the session-start history
    reader consults, so it is the write that fixes this bug. It is a single
    `fs.appendFileSync` to an append-only file: no lock negotiation, no
    transaction, microseconds. It is **never dropped by the backlog guard** — the
    precise claim (round-22, codex: "never dropped" read as "never lost", and the
    write can still *fail*, which is caught and counted as
    `inbound-log-failed`). No guard sheds it; a filesystem can still refuse it.
  - **TopicMemory is secondary** — it backs search and summaries. It is the write
    that can contend, wait and stall. It is the one the guard drops, and the one
    that may lag.

  That change alone removes most of the ceiling: the unbounded-ish cost lived
  entirely in the SQLite write, and the record this spec exists to create was
  never the slow one. Splitting them also makes the drop rule honest — under
  burst you lose *searchability* for some messages, not the messages.

  **Five seconds is far too long for the TopicMemory write, and 64 × 5s was the
  real ceiling
  (round-18, codex — v17 said "some loop delay" and understated it by two orders
  of magnitude).** A log write that waits five seconds has already failed at its
  job. This path therefore uses **its own dedicated SQLite connection with
  `busy_timeout = 100 ms`** (round-23, codex — `busy_timeout` is a *connection*
  pragma, so setting it on the shared connection before each write would silently
  change the timeout for every unrelated TopicMemory operation, and restoring it
  afterwards would be a race waiting to happen). A second connection to the same
  WAL database is cheap and is the ordinary way to give one workload its own
  timeout policy. With the backlog capped at 16 (below), that bounds the worst
  case to **16 × 100 ms ≈ 1.6 seconds** of accumulated delay rather
  than ~320, and a contended store sheds entries quickly instead of holding the
  loop. The burst test runs against a **contended/wedged** database as well as a
  healthy one, because a healthy-storage burst test would have measured the easy
  case and reported the wrong number. Five seconds of loop stall is still bad, so
  the pending-callback guardrail below is what would surface a store behaving that
  way; but the unbounded case — the one that would wedge the process — is closed
  by the existing pragma, not by a new assumption.
- A failure is caught and counted (`inbound-log-failed`). **No retry** — a retry
  is a loop, a loop needs brakes, brakes need a breaker, and that is exactly the
  subsystem this paragraph deleted twice. A best-effort log does not earn it.
- **No *application-level* queue, worker or retry — and the precision matters
  (round-16, codex).** `setImmediate` callbacks *are* queued work; they sit in
  Node's event loop rather than in a subsystem this design owns. Saying "no queue"
  flatly would mislead an implementer. What is true: **no persistent queue, no
  worker, no retry** — and, since round 17, the backlog is **bounded at 64** by
  the drop rule below rather than left to grow. Inbound messages normally arrive
  at human typing speed, so there is normally nothing to bound at all.
- **That assumption is tested, not asserted (round-9, codex — Telegram genuinely
  bursts after a reconnect, a restart, a polling backlog or a forwarded batch).**
  A stress test drives 200 inbound messages and asserts **event-loop delay**
  during and after the burst — not merely injection latency (round-15, codex: the
  likely failure is not lost data, it is loop latency while a backlog drains, and
  a test that only measures the injection would miss it entirely). The Attention
  threshold is likewise expressed in **measured loop delay**, with the pending
  count as a secondary signal, because the count is a proxy and the delay is the
  harm. If it ever fails, the assumption is wrong and the design is
  revisited — rather than pre-building a queue against a burst that may never
  happen.
- **The backlog IS bounded — three lines, not a subsystem (rounds 13–17, codex
  three times and gemini independently; two reviewers converging on one residual
  is the strongest signal available, and "measure then fix" was the wrong answer
  to it).** A counter tracks pending **TopicMemory** writes. Above **16**, the
  **TopicMemory write** is dropped and counted (`inbound-log-dropped`) instead of
  scheduled. **The bound and the rollout gate are consistent by construction
  (round-25, codex):** v24 paired a 64-write cap with a gate requiring under 2 s
  of contended loop delay, but 64 × 100 ms is 6.4 s — the gate could only have
  passed on luck, contended writes usually failing faster than their timeout,
  while the stated bound said otherwise. At **16** the worst case is 1.6 s and
  the gate tests the bound rather than the weather.
  **The JSONL append is never affected by the guard** — it is
  synchronous and has already happened by the time the guard is consulted
  (round-20, codex flagged this as contradictory when the guard read as applying
  to "the entry"; it applies to the deferred half only).

  **And it is a bounded best-effort in-memory buffer. Calling it "not a queue"
  obscured the model (round-19, codex, and the point is conceded).** `setImmediate`
  plus a pending counter plus a drop threshold plus alerting *is* queue-shaped,
  whatever it is named. What the earlier phrasing was reaching for is still true
  and is what should have been said: **no worker, no retry, no persistence, no
  ordering guarantee, no lifecycle** — one comparison and an increment, riding
  Node's own scheduler rather than a subsystem this design owns and must maintain.
  That is a real distinction from what rounds 5 and 6 deleted. "It is not a queue"
  was not.

  **On deliberately dropping observations (the standards gate flagged this against
  *Observation Needs Structure*, and it is the right question to ask a spec whose
  entire purpose is reliable recording).** The standard asks for structure around
  observation, not for perfection: a dropped entry here is **bounded, counted
  (`inbound-log-dropped`) and surfaced**, so the corpus knows exactly how much it
  is missing and when. Compare the alternative this replaced — an unbounded
  backlog that keeps every entry and risks stalling the agent's responsiveness
  for everything behind it. **An observation system that takes down the thing it
  observes has not preserved observation.** A known, counted gap during a burst is
  the more honest failure, and it is the same reasoning that made §3.2 refuse to
  let recording block delivery. And dropping is the *right*
  failure here, which is what makes it small: this is an explicitly best-effort
  received log, so shedding entries during a burst is strictly better than
  stalling delivery for everything behind it. The alternative I kept defending —
  observe the pile-up, fix later — left the worst case unbounded in exchange for
  nothing.
- **General event-loop congestion is a silent third cause, acknowledged
  (round-24, gemini).** The backlog counter sees *this feature's* pending writes.
  It does not see the loop being busy with unrelated work, which delays the
  deferred TopicMemory write just as effectively and increments nothing. So a
  quiet `inbound-log-dropped` is **not** evidence that searchable copies are
  landing promptly — only that this feature did not shed them. That is an
  inherent property of `setImmediate` scheduling and is accepted rather than
  worked around; the JSONL record, which is what history reads, is unaffected
  because it never waits for a turn.
- **What the test still does not prove.** Up to 64 scheduled writes can run
  back-to-back on the next tick, so a burst still costs *some* loop delay — it is
  bounded now, not eliminated. The earlier phrase "no unbounded synchronous work
  occurs" was wrong and is removed; so is v16's "observable but not mitigated",
  which stopped being true when the bound landed. The honest position: a burst
  costs at most 64 writes of loop time and sheds the rest, and the measured delay
  figure tells us whether 64 is the right number.
- **Two counters, still not a subsystem:** pending callbacks (Attention above 32,
  the early warning) and `inbound-log-dropped` (the bound actually firing). The
  first measures the assumption; the second records what it cost when the
  assumption was wrong.
- **And the alert names its own remediation (round-14, codex — an alert with no
  stated response is a notification, not a control).** The Attention item says
  exactly what to do: if pending callbacks or event-loop delay stay above
  threshold across more than one episode, switch to batched or yielding writes as
  a follow-up change. That is the trigger for building the thing this design
  deliberately did not pre-build — written down now, so the decision is a
  threshold rather than someone's judgment months from now.
- **A counter nobody reads is not observability (round-1, gemini):** a sustained
  non-zero failure rate over an hour raises ONE deduped Attention item. Silently
  degrading the agent's memory is precisely the failure this spec exists to end.

**Residual, stated plainly — and it is permanent, which round 24 did not say
(round-25, codex traced the consequence).** A crash between the JSONL append and
the deferred write loses that message's *searchable copy*, and **it cannot heal
itself**: on restart the dedupe set is seeded from the JSONL file, so the row is
already "logged" and a redelivery short-circuits before either write runs. The
searchable copy is therefore **permanently absent** for that message, not merely
delayed. Accepted rather than repaired: a repair path means reconciling two stores
at startup, which is a background job with its own failure modes, for a
consequence whose blast radius is *one message missing from search* while history —
the thing this spec exists to fix — is intact. Recorded so the absence is a known
property rather than a future mystery.

The narrower loss: and a wedged store loses entries for as long as it is wedged.
Both are real, both are counted, and both are vastly smaller than the defect being
fixed — which is *every* inbound message, always, silently. Making the write
durable across a crash would mean a write-ahead store on the inbound path, and
that is the abstraction §3 declines for a reason that has now been demonstrated
twice in this section's own history.

### 3.3 Rollout

`messaging.inboundSeamLogging.enabled`, with an emergency disable.

**Default-on is EARNED by explicit thresholds, not by a release count
(round-17, tightened round-19 — "default-off for exactly one release" was an
unresolved decision written as though it were closed; if the numbers come back
bad, "exactly one release" cannot hold).** The flag ships **default-off**, and
flips to default-on when **all three** of these hold, measured on real hardware
and recorded here:

| Gate | Threshold |
|---|---|
| Loop delay added by a 200-message burst, healthy store | **< 250 ms** total |
| Loop delay, contended/wedged store | **< 2 s** total |
| `inbound-log-dropped` during the burst | **0** on a healthy store |

If any gate fails, the flip does not happen and the design is revisited — the
gate is the decision, not the calendar. The reasoning that made
default-on attractive still stands — every day off is unrecoverable
conversation — but "probably fine at human typing speed" is an assumption about
the same class of thing this spec keeps catching, and a synchronous write with a
five-second `busy_timeout` behind an unbounded callback backlog is not a place to
assume. One release is a small price for a measured answer. Not dark-shipped: it restores a recording that the system already
intends to perform and already performs on one path, and every day it is off is
another day of unrecoverable conversation. The lever exists for one reason — if
the write turns out to be hot on some install, the operator can stop it without
waiting for a release.

## 4. Honest limits

- **The local-only record is a deliberate trade, with a named ceiling (round-10,
  gemini).** This optimises for present simplicity and a machine-local record. If
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
`idSource: 'derived'`** (round-2, standards gate: the test plan still asserted
the retired no-id-no-entry behaviour one fold after the design changed — caught
in a 200-line document, which is the point); two identical messages in the same
second produce two distinct rows (§3); the dedupe key coerces
string/number ids; a throwing logger is caught, counted, and the injection still
happens; **the JSONL append has COMPLETED before the inject call** (asserted on
completion, not on scheduling), and — as a separate assertion — the scheduled
callback performs the TopicMemory write after it. **And the
JSONL append is asserted to have COMPLETED before injection**, not scheduled
(round-22, codex: the test plan still described the pre-split model). *(Round-13,
codex: asserting "the log call precedes the inject call" would force a
synchronous mock shape that does not match production.)* Asserted by call order, not by
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
JSONL row is readable immediately while the searchable copy lands on the next
tick, so the test awaits the latter rather than asserting
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
| Write ordering | Which write happens when, relative to injection | **invariant** | Per §3.1's table: the **JSONL append completes before injection** (synchronous, may briefly delay it); the **TopicMemory write is scheduled after** and may be dropped. Two writes, two rules — not one scheduling rule for both. |
| Log-failure disposition | Whether a failed write blocks the message | **invariant** | Always proceed — a failed JSONL append is caught and counted, never rethrown into the delivery path (§3.2). The conservative default is *deliver*, because the harm being prevented is silence. |

## 6. Multi-machine posture

| Surface | Posture | Notes |
|---|---|---|
| The seam call | **unified** | Code — identical on every machine by construction. |
| The message log + TopicMemory rows it writes | **machine-local BY DESIGN** | `machine-local-justification: physical-credential-locality` — the Telegram bot token and the forum/topic ids it namespaces live on the machine that polls, and the log is that machine's record of what *it* saw. A machine cannot honestly record having been shown a message it was not shown. Merging the two halves into one readable history is the separate change in §8.1, and it is a *read*-side merge, not a replication of this write. |

## 7. Frontloaded Decisions

1. **Log at the seam, not at each caller** — **four** callers today (§2), three of
   which pass no `messageId`. Logging per-caller would mean four correct
   implementations and a fifth silently reintroducing the gap.
2. **Append JSONL before injecting; schedule TopicMemory after** (§3.1) — two
   writes, two rules. Named this way after three rounds of reviewers reading "log first" as a
   synchronous call, which is exactly how it would be mis-implemented.
3. **A log failure never blocks the message** (§3.2).
4. **The forward route's existing call stays** — dedup makes it harmless, and removing it is unrelated risk.
5. **A missing `messageId` gets a per-injection UUID** (§3), not silence and not a content hash — an id-less message is recorded, and no cross-message identity is inferred from its bytes.
6. **Ships default-OFF; the flip to default-on is earned by three measured gates**
   (§3.3), not by a release count. *(Round-21: "exactly one release" survived here
   after §3.3 replaced it with the gates — if the numbers come back bad, a release
   count cannot hold.)*
7. **No backfill attempted** (§4).
8. **Cross-machine history merge is explicitly out of scope**, and tracked as
   ACT-1216 rather than left as a note (§8.1).
9. **This is a RECEIVED log, not an OBSERVED log** (§3.1) — the honest name for
   what it records, chosen over a second write to track delivery status.
10. **No new SUBSYSTEM** — no queue, worker, event bus, retry ladder or new
    persistent store. (Not "no write-ahead log": §3 names the design as a
    miniature write-ahead split, and FD10 contradicting that was review scar
    tissue — round-24, codex.)
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

## Review record (rounds 1–12)

Eleven review rounds plus a twelfth attempted. Kept short deliberately — the
change logs that swallowed the companion spec are exactly what this document is
scoped to avoid.

| Reviewer | Outcome |
|---|---|
| Standards-Conformance Gate | **0 findings**, stable across repeated runs; `fit: fit` against *Structure beats Willpower*. Caught three real defects along the way — an orphaned deferral, an unbounded retry loop introduced by a fix, and a test plan asserting behaviour the design had already replaced. |
| `gemini-cli:gemini-3.1-pro-preview` | **CLEAN four times** (rounds 3, 7, 9, 11). Its findings when not clean were maintainability points, each folded. |
| `codex-cli:gpt-5.5` | Drove every structural simplification. Last completed round (10) produced three findings, all folded and verified present. **Rounds 11–12 could not run: the provider returned HTTP 503 (`biscuit_baker_service_me_circuit_open`) on five consecutive reconnect attempts — an outage on their side, at 60% quota.** |

**No `review-convergence` tag is written.** The strongest reviewer's last
*completed* round found material issues; those were folded, but a fold is not a
verified round, and the reviewer that would verify it is unavailable. Recording
the outage rather than treating one reviewer's silence as agreement — a check
that *cannot run* is not a check that passed, which is the failure this entire
spec exists to fix.

What the reviews actually produced, since the count matters less than the shape:
three designs were **deleted** rather than refined (a timeout budget that bounded
the wait but not the work; a queue subsystem in a document insisting it had no
queue; a content-derived id that would have collapsed distinct messages), and one
finding — checking `message_id INTEGER NOT NULL` against the real database rather
than reasoning about it — caught a blocker that would have failed at build time.
