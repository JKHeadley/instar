<!-- GENERATED FILE — DO NOT EDIT.
     Source: docs/specs/inbound-message-recording-gap.md
     Regenerate: node scripts/generate-spec-contract.mjs --spec docs/specs/inbound-message-recording-gap.md
     This is the IMPLEMENTATION CONTRACT.

     REMOVED: history sections, delimited round-annotations, and blockquote
     meta-blocks that talk about the document rather than the design.

     NOT REMOVED: narrative prose that states a rule and narrates its own
     history in the same sentence. A transform cannot separate those without
     judgment it deliberately does not have, so some review references remain
     below (19 occurrence(s) of "round-N" in this file).
     Where such a sentence describes what a design USED to be, the surrounding
     normative statement governs. Read the source spec for full context.
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
single-run-completable: false
eli16-overview: "docs/specs/inbound-message-recording-gap.eli16.md"
---

# Record inbound messages at the injection seam

> ## The normative artifact is the generated contract, not this file
>
**It began deliberately small.** One mechanism, one seam, one flag. The companion spec
`outbound-gate-advisory-override.md` took 33 review rounds and never converged,
because every fold of a 2,700-line document created new contradictions elsewhere
in it (ACT-1215). This spec is scoped so a fold cannot do that.

## 1. Problem

**The machine that composes replies has no record of what was said to it.**

**Scope, stated before the evidence rather than after it.**
What this spec fixes is **session-resume completeness**: a session that restarts
should be able to read the conversation it is resuming, both halves. What it does
**not** deliver is an audit of everything Telegram ever sent this machine — a
message dropped or refused before it reaches a session is invisible to this
design and stays invisible (§4). The record it builds is therefore a
**session-injection received log**, not an intake log, and that name is used
throughout deliberately. The headline above is the symptom; this paragraph is the
boundary.

Verified on the Mac Mini, 2026-07-25:

**Re-verified against live state at 2026-07-25T11:19Z**, and the re-check moved a
headline number in the worse direction — which is the reason for re-checking
rather than quoting the first measurement:

| Observation | Value |
|---|---|
| Messages stored for topic 33368 | 111 |
| …of which inbound (`fromUser: true`) | **0** |
| **Last inbound row machine-wide (any topic)** | **2026-07-01T21:40:22Z — 24 days ago** |
| Last outbound row machine-wide | 2026-07-25T11:19:46Z (current) |
| Inbound / outbound since 2026-07-20 | **0** / 392 |
| Inbound / outbound on 2026-07-25 alone | **0** / 67 |
| Hits on the route that logs inbound (`/internal/telegram-forward`) in `logs/server.log` | **0** |

**The earlier figure was "zero inbound since 2026-07-20", which was true and
understated the defect by three weeks.** It was true because it was measured over
a window chosen for a different reason, and no one asked what lay before the
window. The real cutoff is 2026-07-01. Recorded because the same shape of error —
a correct statement over an unexamined range — is how the underlying bug went
unnoticed in the first place.

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

- `SessionManager.injectTelegramMessage(tmuxSession, topicId, text, topicName?, senderName?, telegramUserId?, messageId?)` — `src/core/SessionManager.ts:5045` **on current main (v1.3.953)**. **Every currently-verified inbound session delivery reaches a session through it**, whether injected inline or written to an inbound file for long messages. 
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

### 3.0 Final contract

**Local terms** — **injection seam**: `SessionManager.injectTelegramMessage`, the
function that hands an inbound message to a running session. **Forward route**:
`POST /internal/telegram-forward`, the lifeline's delivery path. **TopicMemory**:
the existing SQLite store behind conversation search. **Attention**: the deduped
operator alert queue. **Armed**: enabled *and* the store opened writable.

| | |
|---|---|
| **Where** | `SessionManager.injectTelegramMessage`, before the injection. |
| **Store** | A **new SQLite table**, `inbound_messages`, in the agent's existing database. **Schema migration is required; DATA migration is not.** The DDL is idempotent `CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS`, run at arm time; a DDL failure means `armed: false` with the SQLite error surfaced, never a silent degrade. No existing row is read, moved, backfilled or rewritten. `better-sqlite3` is already a dependency and `TopicMemory` already opens it (`src/memory/TopicMemory.ts:154`). WAL mode, `busy_timeout = 100 ms`. |
| **Schema** | `seq INTEGER PRIMARY KEY AUTOINCREMENT`, `from_user INTEGER NOT NULL DEFAULT 1`, `dedupe_id TEXT NOT NULL UNIQUE`, `topic_id INTEGER NOT NULL`, `seam_received_at TEXT NOT NULL`, `text TEXT NOT NULL`, `sender_name TEXT`, `telegram_user_id INTEGER`, `message_id INTEGER` (nullable — no `-1` placeholder is needed), `id_source TEXT NOT NULL CHECK(id_source IN ('platform','derived'))`, `synthetic INTEGER NOT NULL DEFAULT 0`, `text_truncated INTEGER NOT NULL DEFAULT 0`. |
| **Write** | `INSERT OR IGNORE` inside a transaction, synchronously, **before** injection. Returns `'appended' \| 'duplicate' \| 'failed'` from `changes` and the error path. **Never throws** — a `'failed'` result is caught internally and counted. |
| **Dedupe** | The `UNIQUE` index on `dedupe_id`. **Storage-enforced, not best-effort** — this answers round-51 directly: there is no in-memory set, no seeding, no restart window, and two processes cannot interleave a duplicate through it. `dedupe_id` = `in:telegram:<botId>:<chatId>:<messageId>` when a platform id is present, else `in:derived:<uuid>`. **Fully platform-scoped: Telegram message ids are unique per CHAT, and `topicId` is an instar-side surrogate, so keying on it alone would false-dedupe across a migrated topic, a re-bound topic, or two bots sharing one agent.** The scope now comes from the platform's own identifiers, and `topic_id` remains a column for querying rather than part of identity. |
| **Secondary write** | `scheduleInboundTopicMemory(entry)` via `setImmediate`, only on `'appended'`. Backlog capped at 16; beyond that, drop and count. TopicMemory remains a **lossy search index**, never the record. |
| **Authority** | This table is the **seam-received store** — the name says the whole guarantee. The row is committed **before** injection, so a crash between the two leaves a row for a message no session processed. That is deliberate — a recorded-but-unprocessed message is recoverable, an unrecorded one is not — and it is why the store is not called "delivered". A future `injected_at`, written after a successful injection, is the honest way to add that distinction if a consumer ever needs it; it is not needed now and is not faked now. It is the **primary received-history store**. It is not proof of receipt: a message dropped before the seam never reaches it (§4), and `synchronous: NORMAL` means a power loss can lose the last transaction. Absence of a row is **not** evidence a message was not received. |
| **Ordering** | `seq INTEGER PRIMARY KEY AUTOINCREMENT`, read `ORDER BY seq`. **Not bare `rowid`: rowid is insertion-ordered in practice but SQLite does not guarantee monotonicity across deletes or a table rebuild, and "monotonic" was a stronger claim than the store makes.** `AUTOINCREMENT` buys the guarantee explicitly, at the cost of one extra table SQLite maintains. |
| **Reading** | `SELECT`. No tolerant parsing, no bounded tail read, no torn-line class, no corruption counting — **none of these failure modes exist for a table**, which is most of why it is the recommendation. |
| **Attention** | The deduped operator alert queue (`POST /attention`). **Cadence:** raised at most once per condition per episode, never per event. **Owner:** the operator. **Actionable:** each item names the condition and the read surface to check; it is not a chat message and does not interrupt a conversation. |
| **One-sided-conversation check** | A periodic query for topics with recent outbound rows and zero inbound rows over the same window. **Cadence:** hourly. **Owner:** the agent, surfacing to the operator via one deduped Attention item. **Actionable:** it names the topic and the window, and means *either* the recording is broken *or* the agent legitimately spoke unprompted — so it reports a suspicion to check, never an assertion of failure. |
| **Coverage evidence** | The AST fitness test is a build-time guard, **not** proof of coverage. **The primary production evidence that the seam is on the real path is (1) the live Telegram call-path trace at acceptance and (2) the ongoing one-sided-conversation check** — recent outbound in a topic with zero inbound rows. Round-52 is right that dynamic and import-boundary bypasses stay plausible; the one-sided check is what would catch one *in production*, without knowing where it is, and is therefore the load-bearing detector rather than a nice-to-have. |
| **Retention** | **Two dimensions.** (1) Keep the newest **200 000 rows**; synthetic rows count toward the bound. (2) Cap stored text at **64 KB per row**, longer messages stored truncated with `text_truncated = 1`. Not time-based, and no whole-store byte measurement — the product of the two caps bounds the store. **Deletion is two-step and batched**, never one statement: `SELECT seq … ORDER BY seq DESC LIMIT 1 OFFSET:keep` for the cutoff, then `DELETE FROM inbound_messages WHERE seq <=:cutoff LIMIT 1000` repeated with a yield between batches, reporting rows deleted and per-batch latency. Daily. A single large DELETE would take locks on the same database the synchronous insert uses. Deleted rows free pages for reuse; **no `VACUUM`** — returning disk to the OS is not worth an exclusive lock on the delivery path's database. |
| **Single writer** | SQLite's own locking. **No lock file, no boot-id, no stale-reclaim rule, no filesystem allowlist or denylist.** A second writer is handled by the database, not by this design. |
| **`enabled` vs `armed`** | `enabled` = the config flag (configuration only, never the logging predicate). `armed` = enabled **and** the table opened writable. Arming is attempted at startup and **retried in the background** (60s, backoff to 15m), outside the per-message path. While unarmed the seam call is a no-op, incrementing `inbound-log-arm-failed` once per process and `inbound-messages-skipped-unarmed` per message. **Acceptance FAILS if `armed` is false.** |
| **Failure behavior** | A failed insert is caught, counted, and **injection proceeds**. A failed secondary write is caught and counted. |
| **Degraded state** | **Counters alone are how this bug survived 24 days.** Relying on someone noticing a metric is monitoring discipline, and monitoring discipline is what failed. So sustained failure is a **state, not a count**: after **10 consecutive** failed inserts, or any failure persisting **5 minutes**, the feature enters `degraded` — reported on `/health` as a **first-class field** (`recording: 'ok' \| 'degraded' \| 'off'`), which the out-of-process watchdog already polls and can act on **without Attention delivery working at all**. An Attention item is raised too, but it is the *second* line of defence, not the only one. Recovery clears the state automatically. |
| **Why `/health` and not Attention** | Every other mitigation here leans on the Attention queue, whose reliability and persistence this spec does not own and cannot assert. `/health` is a synchronous read of local state by an external poller — no queue, no delivery, no dedupe window. **Anything load-bearing is expressed there**; Attention carries the human-readable version. |
| **Counters** | `inbound-log-failed` (the authoritative insert failed), `inbound-search-index-dropped` (shed by the backlog cap), `inbound-search-index-failed` (attempted and threw), `inbound-log-arm-failed` (once per process), `inbound-messages-skipped-unarmed` (per message), insert-latency histogram. All monotonic within a process; `topic_id` is the only label. |
| **Latency** | Attention on p99 > 50 ms **and** on any single insert > 1 s. **Operational bound with an ACTION, not just an alarm: if the out-of-process watchdog sees the loop-tick counter frozen for > 30 s while the process still answers, it treats the agent as wedged and escalates through its existing path** — the same treatment any hung server gets. This design does not add a new recovery mechanism; it makes sure the existing one can see this failure. A wedged device can still block the event loop; that residual is named below and detected **out-of-process** via the loop-tick counter on `/health`. |
| **Health** | `recording` (`ok`/`degraded`/`off`), `enabled`, `armed` (+ reason, naming any schema-validation mismatch), `lastArmAttemptAt` / `lastArmResult`, **`rowCountTotal` AND `rowCountUserVisible`** — both, because synthetic rows count toward retention but not toward the user-visible count, and reporting one number would make the store look smaller than the pressure on it — insert failures, max latency, the startup synthetic self-check result, a monotonic loop-tick counter, and the one-sided-conversation check (recent outbound with zero inbound). |
| **Synthetic rows** | `synthetic = 1`. Excluded from history reads, row counts, and the one-sided check. |
| **Privacy** | Message text stored **unencrypted** in the agent's database, file mode 0600. Deleting rows removes them from this store only; TopicMemory and any backups are separate. No redaction — a credential pasted into chat is stored verbatim. |
| **Disclosure** | **Blocking gate before the first enablement on any machine**: a release-note entry and an operator-visible config description, both stating what is stored, where, that it is unencrypted, the retention bound, and that deletion covers this store only. Owner: the implementing agent; both texts linked from the acceptance record. End-user notice beyond the operator is **not enforced by this feature** — which is a statement about what the code does, **not** a claim that none is required. The config description therefore carries an explicit operator warning: **inbound third-party messages are stored verbatim, and any notice or legal obligation toward those people is external to this software and yours to meet.** |
| **Flag** | `messaging.inboundSeamLogging.enabled`, default-off, with emergency disable. |
| **Acceptance** | **Not "code landed".** The flag ON for the affected machine; live Telegram proof (a normal and a long message) **with an instrumented trace of the real call path to the seam**; **a restart, then another message with the row count still increasing**; an id-less seam regression test; `armed: true` confirmed. |
| **Known residuals** | A wedged device can stall delivery (detected out-of-process, not prevented). Messages dropped before the seam are invisible. Message text is stored unencrypted. Three, all named, none mitigated. |

### 3.0b OPEN QUESTION raised by grounding, not by review

**Does this need a new table at all?** Reading `src/memory/TopicMemory.ts:246`
after writing §3.0 — grounding the design against the code rather than against my
memory of it — the existing `messages` table already has:

| §3.0 asked for | `messages` already has |
|---|---|
| `seq INTEGER PRIMARY KEY AUTOINCREMENT` | `id INTEGER PRIMARY KEY AUTOINCREMENT` |
| A uniqueness constraint for dedupe | `UNIQUE(message_id, topic_id)` |
| `topic_id`, `text`, `sender_name`, `telegram_user_id`, timestamp | all present |
| An inbound/outbound marker | `from_user INTEGER NOT NULL DEFAULT 0` |

**If the seam writes synchronously to `messages` instead of a new table, a further
large chunk of §3.0 disappears**: the secondary write, the `setImmediate` backlog,
the cap-and-drop rule, its two counters, the "lossy index" contract, the
authoritative-store question, and the crash-between-two-writes case all stop
existing. One store, one synchronous write.

**The cost is not zero.** `message_id` is `NOT NULL` and the unique constraint is
`(message_id, topic_id)`, so an id-less message still needs a value or a schema
change — the `-1` placeholder problem, returning by a different road. And making
TopicMemory synchronous on the delivery path changes the performance profile of a
store currently written asynchronously.

**Recorded, not acted on.** Two large structural changes tonight (the increment
split at round 46, the storage rewrite at round 51) each introduced defects the
next round had to clean up. A third unreviewed restructure would be the same
mistake a third time. This goes to review as a question.

*(Worth noting where it came from: not from a reviewer, but from reading the code
the spec depends on. Fifty-two rounds of review never opened that file. The spec's
own §1 says the original defect existed because nobody checked which path was
actually in use.)*

**The seam is the chokepoint, and that claim carries a proof obligation.** The
same "surely everything goes through here" assumption is what produced this bug,
so the change ships with an **architectural fitness test**: a fixture enumerating
the allowlisted callers of the two low-level primitives `SessionManager.injectMessage`
and `SessionManager.rawInject`. Those, not `injectTelegramMessage`, are what the
test scans — a new path bypassing the seam would do so by reaching for the
primitives beneath it. The test is **AST-based, not a regex**, so renamed imports
and aliases are caught. A **runtime counter** records raw primitive use outside
the approved call sites.

**It is evidence, not enforcement, and the framing matters.** An AST scan misses
dynamic dispatch, reflection, indirect wrappers, runtime monkey-patching,
generated code and module boundaries; the counter shows a divergence without
attributing it. Calling that "architectural enforcement" would be exactly the
false confidence that let the original defect survive — someone assumed a path was
covered because a check existed. **The real production evidence is the live
Telegram call-path trace and the one-sided-conversation detector.** The AST test is
a cheap build-time guard against the easy regression, framed as that and no more.

**One increment.** The round-46 A/B split existed because JSONL needed rotation
and retention machinery that a table does not. There is nothing left to defer.

> **On the JSONL fallback, honestly.** Round 50 said the JSONL design would be
> "retained in full as the fallback". Making the contract implementable meant **replacing** that
> table, not keeping it beside this one — 52,000 characters became 6,400. The
> JSONL contract is therefore **not in this file any more**; it is recoverable in
> full from the commit that removed it, and §§3.1-3.2 below still carry its
> reasoning. Saying "retained" while deleting it would have been the same species
> of overclaim this review has corrected eight times.
>
> **The 88% reduction is itself the argument.** Nothing was cut for brevity — every
> deleted row described machinery that only existed to make a text file behave like
> a database.
>
> **Sections 3.1-3.2 below are JSONL-era rationale.** They explain why the ordering
> is accept-then-inject and why the essential write is synchronous — both still
> true — alongside torn lines, rotation and lock files, which are not. They are
> history, not instructions.


### 3.0a Why the contract is a table (rationale — not part of the contract)

*Three reviewers across rounds 24, 28 and 29 asked for the same thing: the
contract without the archaeology. The generated companion at
`docs/specs/generated/inbound-message-recording-gap.contract.md` strips history
document-wide, but a reader opening the source spec should not have to leave it
to find out what is being built. Everything below this table is reasoning; this
table is the build.*

*And it immediately proved the point in the worst way: the first version of this
table contradicted the body on two counts, because restating a design
in a second place creates a second place to be wrong. That is the same mechanism
that stopped the 2,700-line companion spec from ever converging (ACT-1215),
appearing here at a tenth the size. **The table is normative; where the body
disagrees with it, the table wins and the body is the bug.** The only durable fix
is generation rather than restatement, which is why the generated contract exists
— this table is a readability convenience with a known failure mode, and naming
that is cheaper than pretending duplication is free.*

### 3.1 Ordering: accept first, then inject — and it is a RECEIVED log

The **essential JSONL append happens before the injection is attempted**, and the
secondary TopicMemory write is scheduled for after it — so an
injection failure cannot *by itself* produce an unrecorded message.

**The invariant, stated exactly:** *recording is attempted before injection, unless the backlog guard
drops it; the essential JSONL write is synchronous and may briefly delay delivery;
the deferred TopicMemory write never can.* Three things can still leave a
message unrecorded — the JSONL append **failing** (counted), or, for the
*searchable copy only*, the backlog guard dropping it or a crash before the next
tick. All are counted. What the ordering buys is
narrower than it sounded: an injection that fails does not *cause* the gap.


**This makes it an inbound-*received* log, not an agent-*observed* log.** "Shown-or-nearly-shown" was a category that does not exist:
if injection fails, the entry still says the message arrived, and a later reader
could wrongly infer the agent saw it. Rather than add a delivery-status update
(a second write, for a distinction no consumer currently needs), the log is
**named** for what it honestly records — messages received for this session —
and the field is `seamReceivedAt`, not `shownAt`. If a consumer ever needs
agent-observed semantics, that is a new field with its own write, not a
reinterpretation of this one.

**"Received" still over-named it, though.** The
seam is not the Telegram intake edge. A message that arrives at the bot and is
queued, dropped, or refused *before* injection is never seen here (§4 admits
this), so a bare `received` reads as "received by the agent" when it only means
"reached the point where a session was about to be handed it." The field is
therefore `seamReceivedAt` — the `session` prefix is load-bearing, not
decoration — and `deliveryState: 'injection_seam_received'` is defined in one line at its
definition site as **received by the session-injection seam, not by Telegram**.
The enum value stays short because it is written on every row; the definition
carries the precision.

**What a consumer must therefore assume.** The session-start
history reader — the one consumer that matters today — may show a message that
was received but whose injection failed. That is the correct trade for its
purpose: it is far better for a resumed session to see a message the operator
sent and the agent possibly missed, than to miss it entirely. The reader is
documented as showing *what arrived*, and an injection failure is already loud
elsewhere. No consumer may read this log as proof the agent acted on a
message. **Naming makes that harder to get wrong; it does not enforce it.** What naming buys: a consumer reading
`seamReceivedAt` and `deliveryState: 'injection_seam_received'` has to work to misread them,
where one reading `deliveredAt` would have to work not to. What it does not buy:
any mechanism preventing a determined consumer from treating presence as
delivery. **The only real enforcement available is the enum** — a future
`'injected'` value means a consumer that cares can *check* rather than assume,
and that is the honest ceiling here.

### 3.2 Failure direction: the essential write is synchronous and CAN delay delivery; the secondary write never does

**The invariant, split by write.**

| Write | Timing | May it delay delivery? | May it be dropped? |
|---|---|---|---|
| **JSONL** (essential — what history reads) | **synchronous, before injection** | **Yes — briefly, and deliberately** | Never |
| **TopicMemory** (secondary — search, summaries) | deferred to the next tick | No | Yes, above the backlog bound |

**The JSONL append is not "non-blocking", and saying so was wrong.** `fs.appendFileSync` can stall on disk pressure, a full disk, a slow
mount or a filesystem hiccup. The trade is deliberate: a microsecond-scale append
in exchange for the essential record surviving a crash, on a path where the
alternative — deferring it — demonstrably bought nothing. It is bounded by
measurement rather than by hope: **append latency is sampled, and both a p99
above 50 ms and any single append above 1 s raise a deduped Attention item** —
the p99 catches a filesystem that has become generally slow, the max catches the
one pathological append a p99 cannot see (§3.0). **Both ship**; round-36 (codex)
found this paragraph stating only the p99 after §3.0 had added the max, which
read as two competing requirements rather than two complementary ones. At either
threshold the local filesystem is the problem and this feature is merely the
messenger. Delivery may wait for this append; it may never wait for the
TopicMemory write.

**But sampling a p99 does not bound a stall, and this is the sharpest hole the
review has found.** `appendFileSync` can block *indefinitely* —
a wedged filesystem, a network mount that stops answering, a failing disk, an
antivirus filter driver. The whole "log failure never stops delivery" invariant
rests on the syscall **returning**, even to throw. If it never returns, the
message is not delivered late; it is not delivered at all, and the feature built
to protect the conversation is what stopped it. A p99 alarm reports this
afterwards. It does not prevent it, and a timeout cannot help — Node offers no
way to cancel an in-flight synchronous write, which is the same wall v4 hit.

Two things follow, and neither is a mechanism:

**The sync-append stall is a BLOCKING risk for opt-in, not a residual to measure
later.** A wedged disk or an antivirus filter driver blocking the Node
event loop stops *all* delivery on the machine — turning a recording fix into an
availability regression is a worse outcome than the bug it fixes. So it is not
carried as a "measured rollout concern": either the bounded mechanism below holds
under the hostile benchmark, or the design goes async with explicit
"may-miss-crash-before-flush" semantics. **Under the SQLite recommendation this
risk shrinks substantially** — a transactional insert on a WAL database is bounded
work against a file the driver has already opened, not an open-plus-append on a
path resolved per call.

**Compared against a durable append queue, properly.** The industry pattern for
this is an append queue or event log with async indexing and backpressure. Honest
comparison on the four axes that matter here:

| | Synchronous INSERT (chosen) | Durable queue + async writer |
|---|---|---|
| **Event-loop stall** | A wedged device blocks delivery. **Worse.** | Enqueue is bounded; a stall hits the writer, not delivery. **Better.** |
| **Crash before durability** | Committed before injection — the message is recorded or the injection did not happen. **Better.** | A queued-but-unflushed message is lost on crash: exactly this bug's failure mode, reintroduced. **Worse.** |
| **Disk full** | INSERT fails, counted, delivery proceeds. Equal. | Enqueue fails or the queue grows unboundedly. Equal-to-worse. |
| **Multi-process contention** | SQLite handles it. Equal. | Needs its own coordination. **Worse.** |

**It is genuinely a trade, not a walkover**, and the queue wins the axis that
worried round-50 most. The synchronous INSERT is chosen because **the crash axis
is the one this bug is about**: a design whose failure mode is "recently received
messages were lost on crash" would be reintroducing the defect while fixing it.
The stall risk is real, is named as a residual, is detected out-of-process, and —
if the hostile benchmark shows it dominates — the queue is the documented
fallback, chosen on those numbers.

**Narrowed claim:** this is a **local single-agent minimal fix**, not a general
message-durability architecture. At the point where multiple consumers, replay,
or cross-machine durability matter, the queue design is correct and this one is
not — and **that point is defined rather than left to judgment**. Any
one of these triggers the event-stream migration:

| Trigger | Threshold |
|---|---|
| Consumers | a **third** reader beyond history and search |
| Replay | any consumer needing to re-process past messages, not just read them |
| Cross-machine | history required to be complete on a machine that did not receive it |
| Retention pressure | the row or byte cap discarding data anyone still wants |

Until one fires, SQLite is acceptable because the requirement is genuinely
"one machine records what it received". If none ever fires, the migration
correctly never happens.

**Bounded append, not unbounded trust.** "Accept the stall and observe
it" is a weak answer for a chat system, where freezing the event loop is often
worse than losing one local history row. Increment A therefore appends to a
**pre-opened file descriptor** — the open, the path resolution and the locality
check all happen at arm time, so the hot path is a single `write` on an already-
open fd rather than an open-plus-write. That removes the whole class of stall
caused by path resolution and directory metadata, which is most of them, and
leaves only a genuinely wedged device.

**But the detector cannot detect the thing.** Max-latency alarms, health degradation and Attention items are all
**in-process**. A wedged `write` blocks the event loop — which is what runs the
detector. The design was proposing to observe a stall using the machinery the
stall stops. That is circular, and it means the most serious failure mode was
formally the *least* observable one.

The honest fix is out-of-process, and it needs less new machinery than first
written — **checked against the code rather than assumed**:
`src/templates/scripts/instar-watchdog.sh` is launchd-scheduled, runs outside the
server, and already probes `http://localhost:<port>/health` per agent, escalating
via a healthy peer. **A blocked event loop cannot answer that probe**, so the
existing check already sees the failure; what it cannot do is tell a blocked loop
apart from a dead process.

So the addition is one field, not a new watcher: `/health` carries a **monotonic
loop-tick counter** bumped on a timer. The watchdog then distinguishes three
states it previously conflated — *answering and tick advancing* (healthy),
*answering but tick frozen* (loop blocked, which is this failure), and *not
answering at all* (process dead or hard-blocked). It does not *prevent* the
stall; it makes it visible from outside, which the in-process alarms provably
cannot.

*(The first draft of this paragraph invented "a heartbeat counter the watchdog
polls" without checking what the watchdog does. It polls `/health`. Writing a
design against an assumed interface is how the original defect happened — the
recording code was on a path nobody verified was in use.)*

For the remainder the position stays honest rather than mechanical: it is
**detected out-of-process**, it **degrades health**, and it is **named as a
residual**. What it is not is silently traded away — and if the hostile
benchmark below shows the remainder is worse than losing rows, the async
alternative with explicit "may miss crash-before-flush" semantics is the fallback,
chosen on those numbers rather than on this paragraph.

**Hostile-storage evidence is a fleet precondition.** `appendFileSync`
on a wedged disk freezes the *event loop*, which means it freezes **every**
conversation on the machine, not just the topic being written. That is the real
shape of this risk and the spec had been describing it per-message. Before fleet
default-on, the benchmark must include **hostile cases, not just healthy and
contended**: a full disk, a disk made to stall, and a revoked-permission path —
with the measured effect on *other* topics' delivery, not only on the append. If
availability turns out to matter more than pre-injection persistence, the
alternative is an async bounded queue with a crash-aware flush, and that
trade is the operator's to make with those numbers in hand.

1. **The log path is required to be local, non-network storage.** This is an
 **operational requirement, not an enforced assertion**. Reliably
 classifying a path as local across macOS and Linux means reasoning about
 symlinks, external drives, FUSE, cloud-synced folders, containers and
 platform-specific mount types; a check that gets that wrong either blocks a
 fine deployment or — far worse — passes a network mount and *manufactures*
 confidence. What ships instead is a **startup log line naming the resolved
 absolute log path**, so anyone diagnosing a stall can see immediately where
 the writes are going. The requirement is documented and the path is visible;
 neither is dressed up as a guarantee.

 **Narrowed to a hard rollout constraint.** Fleet default-on is
 valid **only** where the log path resolves inside the application's own local
 data directory. An operator-configured arbitrary path is supported for this
 machine's opt-in fix, but it disqualifies a machine from the fleet default —
 because the residual being accepted here is acceptable in proportion to how
 well the storage is known, and an arbitrary path is by definition not known.
 That turns a soft requirement into a rollout precondition, which is the only
 form of it that survives contact with other machines.

 **Plus MAX latency, not only p99.** A p99 is the wrong statistic for
 this failure: the stall being guarded against is a *single* pathological
 append, and one sample in a thousand does not move a p99 at all. So the
 sampler records **max append latency per window**, and a single append above a
 high threshold (**1 s**) raises an immediate Attention item naming the log
 path. It still cannot prevent the stall — nothing available can — but it turns
 "delivery mysteriously froze" into "the message log took 4 seconds to write, on
 this path", which is the difference between an hour of confusion and a
 one-line diagnosis. Detection where prevention is unavailable is not a
 consolation prize; it is the honest control for this class.

 **An out-of-process writer was proposed and is not adopted.** A separate daemon or logging proxy would genuinely solve this: the
 stall would land in a process whose blocking harms nothing, and the delivery
 path would hand off asynchronously. It is the correct answer to the problem as
 stated. It is not adopted because it inverts the entire argument of §3.2 — the
 thing that makes a synchronous append *worth* its risk is that the record
 exists before the message is handed on, and any handoff to another process
 reintroduces the queue, the worker, the retry ladder and the crash window that
 rounds 5 and 6 spent real effort deleting. Trading a rare stall for a
 permanent new subsystem, in a change whose purpose is closing a data-loss bug,
 is the wrong trade at this size. Recorded as considered-and-declined with its
 reasoning, so the option is visible if the balance ever changes.
2. **The residual is accepted and named: a wedged local disk can stall message
 delivery.** That is a real dependency this change introduces and it is not
 argued away. The reasoning for accepting it is that a machine whose local disk
 has stopped answering is not a machine that is about to have a working
 conversation anyway — every other write on the delivery path is in the same
 position. What makes it acceptable is that it is *stated*, so a future reader
 deciding to move this log somewhere clever knows what they are trading.

The alternative — deferring the essential write too — was tried in v4 and v5 and
loses the crash-survival property that is the entire point. Trading a certain
data-loss bug for a rare stall is the trade being made, deliberately.

**The SECONDARY write is fire-and-forget on the next tick; the essential one is
not. That is the whole mechanism.**

The history is worth keeping because it is the same mistake three times. v4
wrapped the write in a 250 ms budget; codex pointed out a promise timeout does
not *cancel* a filesystem or SQLite write, so the budget bounded the wait while
leaving the work unbounded. v5 replaced it with a bounded queue, a worker,
retries, a breaker, a drop policy and alerting — and codex pointed out that a
document insisting "this is not a queue, no new abstraction" had just specified a
queue subsystem. Both fixes were bigger than the problem.

**The problem was only ever the SLOW write blocking the injection path — and once
the two writes are split (below), only one of them is slow.**
Deferring the JSONL append too was cargo-culted from before the split: it is a
microsecond append-only write, so deferring it bought nothing and cost real
crash-loss on the record that actually matters. The shape is the ordinary
write-ahead pattern — durable minimal record synchronously, secondary indexes
asynchronously:

```
const r = recordInboundMessage(entry) // sync INSERT OR IGNORE, never throws;
 // counts inbound-log-failed itself
if (r.status === 'appended') {
 scheduleInboundTopicMemory(entry) // setImmediate; sheds -> inbound-search-index-dropped,
} // throws -> inbound-search-index-failed
inject(...) // ALWAYS reached
```

**The ordering invariant, stated so nothing is inferred from the listing.** Only two orderings are guaranteed and only two matter: the
**JSONL append completes before `inject` is called**, and the TopicMemory write
executes on a **later event-loop turn**. Whether that later turn lands before or
after `inject` returns is deliberately unspecified — `inject` may yield
internally, and **no correctness depends on the answer**. Reading an ordering out
of the source lines above would be inferring a guarantee the design does not
make.

**The exact logger API, named.** Two new methods
replace the composite call on this path:

| Method | Contract |
|---|---|
| `recordInboundMessage(entry)` | Synchronous `INSERT OR IGNORE` in a transaction. **Never throws.** Returns `{ status: 'appended' \| 'duplicate' \| 'failed' }`. A `'failed'` result has already been caught internally and counted as `inbound-log-failed`. |
| `scheduleInboundTopicMemory(entry)` | Returns immediately. Honours the backlog cap. Performs no dedupe of its own — it is called **only** on `status: 'appended'`, so the upstream check has already gated it. |

**Three outcomes, not two.** A bare boolean collapsed
*duplicate* and *failed* into the same `false`. The caller's behavior is
identical for both — do not schedule the secondary write — but everything else
about them differs: a duplicate is the system working correctly, a failure is
data loss, and a test asserting `false` cannot tell which one it caught. The
distinction costs one field and buys honest counters and tests that mean
something. The seam's rule stays a single line: schedule the TopicMemory write
**iff** `status === 'appended'`.

The seam calls the first, and calls the second **only on `status === 'appended'`**.
`logInboundMessage()` remains for the forward route and becomes a thin composite
of the two, so that caller is unchanged.

**One contract, not two.** The round-29 contract table said
"never throws" while this table said "throws only on filesystem failure, which
the seam catches" — two different contracts for the same function, introduced by
the very fix that was supposed to make the design easier to read. The settled
answer is **never throws**: the helper owns its own failure, counts it, and
returns a `'failed'` status. The seam then has exactly one rule — *call the
second write only on `status === 'appended'`* — instead of a rule plus a
try/catch, and the impossible-to-forget
version of "a logging failure never stops delivery" is the one where the caller
has nothing to remember. (The seam still wraps the call defensively, because a
helper promising never to throw and a caller assuming it are two different
things; but that wrapper is a backstop, not the contract.)

**This requires the logger to split its phases.**
`TelegramAdapter.logInboundMessage()` currently does both writes in one call, so
it gains an internal split — the JSONL append and the TopicMemory write become
separately callable — rather than the seam calling one combined method and hoping
for these semantics. Naming that explicitly, because "one call to the existing
logger" and "JSONL is never dropped while TopicMemory is" cannot both be true of
the current API.

**Everything in this list is about `scheduleInboundTopicMemory` ONLY.** The
essential JSONL append is synchronous and completes *before* injection; it is
never deferred and it *can* delay delivery (§3.0). Round-31 (codex) found this
list still reading as though it described "the write" generally — leftover
framing from the pre-split design, when both writes were deferred — and flagged
the real danger correctly: the most likely way this ships wrong is not a bad
decision but **contradictory prose causing the old async design to be partially
implemented**. So: below, "the write" always means the TopicMemory write, never
the JSONL append.

- The injection proceeds on the current tick; the **TopicMemory** write happens on
 the next one.
 **What this protects, stated exactly:** *this* injection never
 awaits the TopicMemory write, so *this* message is never delayed **by that
 write**. It does **not** make a
 synchronous store non-blocking — a wedged synchronous write on a later tick can
 still stall the event loop for everything behind it. So the operational
 assumption is explicit rather than implied: **the write must fail fast** — and
 it is, verified rather than asserted. `TopicMemory` opens its database with `journal_mode = WAL` and
 **`busy_timeout = 5000`** (`src/memory/TopicMemory.ts`), so a contended write
 fails after five seconds rather than waiting indefinitely, and WAL means readers
 never block it in the first place.

 **The two writes are split, because only one of them matters for this bug.**
 They were being treated as one write and bounded as one. They are not alike:

 - **JSONL is the essential record** — it is what the session-start history
 reader consults, so it is the write that fixes this bug. It is a single
 `fs.appendFileSync` to an append-only file: no lock negotiation, no
 transaction, microseconds. It is **never dropped by the backlog guard** — the
 precise claim. No guard sheds it; a filesystem can still refuse it.
 - **TopicMemory is secondary** — it backs search and summaries. It is the write
 that can contend, wait and stall. It is the one the guard drops, and the one
 that may lag.

 That change alone removes most of the ceiling: the unbounded-ish cost lived
 entirely in the SQLite write, and the record this spec exists to create was
 never the slow one. Splitting them also makes the drop rule honest — under
 burst you lose *searchability* for some messages, not the messages.

 **Five seconds is far too long for the TopicMemory write, and 64 × 5s was the
 real ceiling.** A log write that waits five seconds has already failed at its
 job. This path therefore uses **its own dedicated SQLite connection with
 `busy_timeout = 100 ms`**. A second connection to the same
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
- A failure is caught and counted (`inbound-search-index-failed` — **not** `inbound-log-failed`, which §3.0 reserves for the authoritative append; round-38, codex, and the third time a counter name has drifted between the contract and the prose). **No retry** — a retry
 is a loop, a loop needs brakes, brakes need a breaker, and that is exactly the
 subsystem this paragraph deleted twice. A best-effort log does not earn it.
- **No *application-level* queue, worker or retry — and the precision matters.** `setImmediate` callbacks *are* queued work; they sit in
 Node's event loop rather than in a subsystem this design owns. Saying "no queue"
 flatly would mislead an implementer. What is true: **no persistent queue, no
 worker, no retry** — and, since round 17, the backlog is **bounded at 16** by
 the drop rule below rather than left to grow. Inbound messages normally arrive
 at human typing speed, so there is normally nothing to bound at all.
- **That assumption is tested, not asserted.**
 A stress test drives 200 inbound messages and asserts **event-loop delay**
 during and after the burst — not merely injection latency. The Attention
 threshold is likewise expressed in **measured loop delay**, with the pending
 count as a secondary signal, because the count is a proxy and the delay is the
 harm. If it ever fails, the assumption is wrong and the design is
 revisited — rather than pre-building a queue against a burst that may never
 happen.
- **The backlog IS bounded — three lines, not a subsystem.** A counter tracks pending **TopicMemory** writes. Above **16**, the
 **TopicMemory write** is dropped and counted (`inbound-search-index-dropped`) instead of
 scheduled. **The bound and the rollout gate are consistent by construction:** v24 paired a 64-write cap with a gate requiring under 2 s
 of contended loop delay, but 64 × 100 ms is 6.4 s — the gate could only have
 passed on luck, contended writes usually failing faster than their timeout,
 while the stated bound said otherwise. At **16** the worst case is 1.6 s and
 the gate tests the bound rather than the weather.
 **The JSONL append is never affected by the guard** — it is
 synchronous and has already happened by the time the guard is consulted.

 **And it is a bounded best-effort in-memory buffer. Calling it "not a queue"
 obscured the model.** `setImmediate`
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
 (`inbound-search-index-dropped`) and surfaced**, so the corpus knows exactly how much it
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
- **General event-loop congestion is a silent third cause, acknowledged.** The backlog counter sees *this feature's* pending writes.
 It does not see the loop being busy with unrelated work, which delays the
 deferred TopicMemory write just as effectively and increments nothing. So a
 quiet `inbound-search-index-dropped` is **not** evidence that searchable copies are
 landing promptly — only that this feature did not shed them. That is an
 inherent property of `setImmediate` scheduling and is accepted rather than
 worked around; the JSONL record, which is what history reads, is unaffected
 because it never waits for a turn.
- **What the test still does not prove.** Up to 16 scheduled writes can run
 back-to-back on the next tick, so a burst still costs *some* loop delay — it is
 bounded now, not eliminated. The earlier phrase "no unbounded synchronous work
 occurs" was wrong and is removed; so is v16's "observable but not mitigated",
 which stopped being true when the bound landed. The honest position: a burst
 costs at most 16 writes of loop time and sheds the rest, and the measured delay
 figure tells us whether 16 is the right number.
- **Two counters, still not a subsystem:** pending callbacks (Attention above
 **8** — half the drop cap, so the warning fires *before* the cap bites; the old
 32/64 pair survived the cap change to 16 and would have meant the warning never
 fired at all. The
 first measures the assumption; the second records what it cost when the
 assumption was wrong.
- **And the alert names its own remediation.** The Attention item says
 exactly what to do: if pending callbacks or event-loop delay stay above
 threshold across more than one episode, switch to batched or yielding writes as
 a follow-up change. That is the trigger for building the thing this design
 deliberately did not pre-build — written down now, so the decision is a
 threshold rather than someone's judgment months from now.
- **A counter nobody reads is not observability:** a sustained
 non-zero failure rate over an hour raises ONE deduped Attention item. Silently
 degrading the agent's memory is precisely the failure this spec exists to end.

**Residual, stated plainly — and it is permanent, which round 24 did not say.** A crash between the JSONL append and
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

---

---

### 3.3 Rollout

`messaging.inboundSeamLogging.enabled`, with an emergency disable.

**"Code landed" is NOT "bug fixed".** This spec opens by calling the defect unrecoverable
data loss, then ships the fix default-off. Those two facts together mean the PR
can merge, the tests can pass, the work can be reported complete — and **not one
additional inbound message is recorded**. The defect would continue for exactly
as long as nobody performs the flip, which is precisely the failure mode a
default-off rollout is supposed to be careful about, applied to a bug where being
careful costs the thing being protected.

So the two states are named separately and neither is allowed to stand in for the
other:

| State | Meaning | Evidence |
|---|---|---|
| **Code landed** | The seam records when enabled; tests green; flag exists, default-off. | Merged PR. |
| **Bug fixed** | The flag is ON for the affected machine and inbound rows are accumulating. | A non-zero inbound row count for a live topic, read back after a real message. |

**Acceptance for this work is "bug fixed", not "code landed."** The benchmark
gates below govern the *fleet* default; they do not govern the affected machine,
which is the one currently losing data. On that machine the flag is turned on as
part of the same change, verified by reading back a real inbound row, and if the
benchmark then shows the cost is unacceptable the flag comes back off — a
measured retreat, not an unmeasured wait. Reporting "done" with the flag off on
the machine that has the bug is not a partial success; it is the bug.

**And "on" has to stay on — verified, not assumed.** The realistic failure is not that
someone forgets to flip it. It is that the flag is flipped, the fix is confirmed
working, and then a deploy, a restart, or a config reload quietly drops it — and
because nothing was watching, the bug resumes in exactly the silent form it had
before, with a merged PR and a live proof sitting in the record saying it was
fixed. That is the same shape as the original defect: a thing that was supposed
to be happening, wasn't, and nothing said so.

So the state is **reported, not remembered**: the health surface carries
`inboundSeamLogging.enabled` alongside a **recent inbound row count** for this
machine. The pair is what matters — the flag alone says what was configured, the
count says what is actually being written. A machine reporting `enabled: true`
with zero inbound rows over a window in which it sent outbound messages is the
one-sided-conversation signal from §3, pointed at this feature's own regression.

**That pair detects total regression and nothing subtler.** It cannot see partial loss, TopicMemory
drops, or two processes writing the same file. So the health surface reports
four more things, each cheap and each already computed elsewhere in this design:
**insert failures**, **max insert latency**, **store readiness** (DB writable,
WAL mode confirmed, `busy_timeout` set, row count), and a **startup self-check**
that inserts a synthetic non-user row and reads it back. The self-check is the one that turns "the flag
says on" into "the path works right now" — it exercises append, dedupe and read
on the real configured path, at the moment the process starts, without waiting
for a real message to prove it. Synthetic records are marked and excluded from
history reads.

**A startup self-check proves the path once, not continuously.** It cannot see a permission change, a path change, a filled disk, or a
store going read-only at 3am on a process that started
yesterday — and a machine can run for weeks between restarts. Rather than add a
periodic synthetic writer (a background job writing fake records into a message
log, forever, to guard a rare failure), the honest position is: **the self-check
is a startup gate, and ongoing correctness is reported by the failure counters,
not proven by a probe.** The first real append after a breakage is what surfaces
it — which is acceptable *because* the append failure path is now counted, max
latency is alarmed, and the one-sided-conversation check runs on a cadence. The
distinction matters so nobody reads a green self-check from last Tuesday as
evidence about today.

**Default-on is EARNED by explicit thresholds, not by a release count.** The flag ships **default-off**, and
flips to default-on when **all three** of these hold, measured on real hardware
and recorded here:

| Gate | Threshold |
|---|---|
| Loop delay added by a 200-message burst, healthy store | **< 250 ms** total |
| Loop delay, contended/wedged store | **< 2 s** total |
| `inbound-search-index-dropped` during the burst | **0** on a healthy store |

If any gate fails, the flip does not happen and the design is revisited — the
gate is the decision, not the calendar.

**One machine's numbers cannot earn a fleet default.** The
gates below are measured on the development agent's machine, and synchronous
filesystem behaviour is exactly the thing that does not generalise: local disks,
antivirus filter drivers, network-mounted home directories, container volumes and
nearly-full disks all differ. Measuring one Mac Mini and flipping a fleet default
would be reasoning from a sample of one about the property most sensitive to
environment.

So the gates are **scoped to the affected machine's opt-in**, and fleet default-on
additionally requires a **staged rollout with per-host append-latency and
failure-rate health** (the numbers §3.0 already reports) across a meaningful set
of hosts. If that staged evidence is never gathered, the correct outcome is that
the fleet default never flips — not that it flips on one machine's numbers.

**Who measures, and what changes.** The benchmark is a committed test
(`tests/perf/inbound-seam-logging.bench.ts`) run by the implementing agent on the
**development agent's machine**, against both a healthy and a deliberately
contended database. Results are recorded in this section as a dated table — three
numbers, in the spec, reviewable. The flip itself is a one-line default change in
`ConfigDefaults`, shipped as its own small PR citing that table. If the numbers
are not recorded, the default does not move; if they are recorded and fail, the
design is revisited rather than the gate lowered. The reasoning that made
default-on attractive still stands — every day off is unrecoverable
conversation — but "probably fine at human typing speed" is an assumption about
the same class of thing this spec keeps catching, and a synchronous write with a
**stale numbers: TopicMemory's own connection uses `busy_timeout = 5000`, but this design opens its OWN connection at `100 ms` and caps the secondary backlog at 16 — the five-second-behind-an-unbounded-backlog figure described a shape this contract no longer has, and quoting it would have made the benchmark gates meaningless.** The real shape is not a place to
assume. One release is a small price for a measured answer. Not dark-shipped: it restores a recording that the system already
intends to perform and already performs on one path, and every day it is off is
another day of unrecoverable conversation. The lever exists for one reason — if
the write turns out to be hot on some install, the operator can stop it without
waiting for a release.

## 4. Honest limits

### 4.0 Privacy posture

The design retains the full plaintext of every message a person sends the agent.
Thirty-three rounds discussed atomicity, latency and dedupe keys before anyone
asked what that means for the person doing the typing. Stated plainly, chosen
rather than defaulted:

| | |
|---|---|
| **What is stored** | Full message text, sender display name, sender platform id, timestamps. |
| **Where** **(A)** | An app-controlled local data directory on one machine. Never transmitted, never replicated to other machines by this design. |
| **File permissions** | The database file's existing mode (**0600**), owned by the agent process user. Anyone with root or that user's account can read it. |
| **Encryption at rest** | **None** today, with a trigger rather than a permanent stance. **Before fleet default-on, either field-level capture becomes configurable (store metadata without body) or the store is encrypted.** The opt-in single-machine fix ships as-is; the fleet does not inherit the plaintext default by silence. |
| **Encryption rationale** | **None currently.** Disk-level encryption (FileVault) is the only protection, and it protects a powered-off machine, not a running one. |
| **Redaction** | None. Secrets pasted into a message are stored verbatim — which is one more reason Secret Drop exists and pasting credentials into chat does not. |
| **Retention** | Row-based plus a per-row text cap (§3.0): oldest rows deleted beyond a 200 000-row keep, daily; each row's stored text capped at 64 KB. Not time-based. |
| **Deletion** | `DELETE FROM inbound_messages` (or drop the table). **This deletes THIS store only** — message text also reaches TopicMemory, which has its own delete path, and neither covers filesystem snapshots or any backup system. Any user-facing deletion instruction must say all three, because "delete the log files" will otherwise be read as "delete what I said to you". |
| **Export** | No dedicated export. The table is readable with any SQLite client. |
| **Disclosure** **(A)** | **Blocking acceptance gate, with an owner and an artifact — not a config note.** Before the FIRST enablement on any machine: (1) a release-note entry, and (2) an operator-visible config description, both stating what is stored, where, that it is unencrypted, the retention bound, and that deletion covers the `inbound_messages` table only (TopicMemory's own rows and any backups are separate). **Owner: the implementing agent; artifact: both texts linked from the acceptance record; enablement is blocked until they exist.** **End-user notice beyond the operator is NOT ENFORCED BY THIS FEATURE** — a statement about what the code does, **not** a conclusion that none is required. **Where an agent receives messages from third parties, whatever notice or legal obligation applies to those people is external to this software and the operator's to meet** — this spec has no standing to decide it, and says so instead of implying it is handled. |


**Encryption at rest was considered and not adopted**, deliberately rather than
by omission: the vault exists for secrets and this is not a secret store, the
essential write is on the delivery path where per-message crypto is real latency,
and a key that lives on the same disk as the data protects against a narrow
threat. That reasoning is stated so it can be *disagreed with* — if the answer
should be different, this is the paragraph to argue with rather than a gap to
discover later.


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

## 4.9 Retention rationale (not part of the contract)

**Retention, growth and what is actually being stored.** The design writes the **full text of every
inbound message** to an append-only local file, forever, and called that
authoritative. Three things follow that the spec had simply not addressed:

- **Growth is unbounded.** No rotation, no max size, no retention. The disk-full
 test proves the *failure* is handled; nothing prevents reaching it.
- **Reading is unbounded too.** `seedMessageLogDedupe()` reads the file at
 startup. A large enough log makes process start slow, which round-28 flagged as
 a test and this makes a policy: seeding reads a bounded tail, not the file.
- **This is personal content, not telemetry.** An indefinitely-retained plaintext
 record of everything a person has said to the agent is a privacy posture, and
 one that should be *chosen* rather than arrived at by leaving retention
 unspecified.

## 5. Test plan

*Rewritten wholesale for the SQLite design. Three successive grep-based
sweeps left pockets of JSONL-era material — rotation protocols, suffix ordering,
dedupe seeding, append helpers, file interleaving — and partial sweeps are how
residue survives. The JSONL test plan is recoverable from the removing commit.*

**Unit** — `injectTelegramMessage` calls `recordInboundMessage` with the fields it
received, and calls `scheduleInboundTopicMemory` **only on `status: 'appended'`**
(asserted as three distinct cases: `'appended'` schedules, `'duplicate'` does not,
`'failed'` does not). When `messageId` is absent the row is still written, under
`id_source: 'derived'` with a per-injection UUID. The text logged is the
operator's message, not the injection wrapper. A failing `INSERT` is caught inside
`recordInboundMessage`, which returns `'failed'` and **never throws** — asserted at
the seam boundary, so "does a throw cross the seam?" has exactly one answer. **The
INSERT has COMMITTED before the inject call**, asserted by call order against the
seam API rather than by timing.

**Store-level (SQLite).**

- **Idempotent DDL.** Running the `CREATE TABLE IF NOT EXISTS` / `CREATE UNIQUE
 INDEX IF NOT EXISTS` twice is a no-op. A DDL failure leaves `armed: false` with
 the SQLite error surfaced — never a silent degrade.
- **Uniqueness is storage-enforced**, including **from two connections**, which an
 in-memory dedupe set structurally could not have caught.
- **Dedupe survives restart with no seeding step**: insert, close, reopen, insert
 the same `dedupe_id`, assert `'duplicate'`.
- **`dedupe_id` is platform-scoped**: the same Telegram `messageId` under two
 different `chatId`s produces **two** rows, not one — the false-merge this key
 was changed to prevent.
- **Ordering is monotonic across deletes**: insert, delete oldest, insert again,
 assert `seq` still ascends.
- **Retention keeps exactly the newest N**, deletes the rest, and counts synthetic
 rows toward the bound.
- **Insert failure is contained**: make the DB read-only, assert `'failed'`, the
 counter incremented, no throw crossing the seam, **and the injection still
 happening**.
- **A crash between the INSERT and the secondary write** leaves the row present
 and the search index short — the accepted lossy-index case, asserted rather than
 assumed.
- **`enabled && !armed`** is a no-op that increments `inbound-log-arm-failed` once
 per process and `inbound-messages-skipped-unarmed` per message, and the
 background re-arm recovers without a restart.

**Integration** — a message delivered through the real inject path appears in
`inbound_messages` with `from_user = 1`; a message **carrying a platform id** arriving via **both** the
forward route and the seam is stored **once** — **and an id-less message arriving
twice is stored TWICE, asserted as such.** A per-injection UUID cannot
dedupe across two delivery paths; claiming otherwise was a logical impossibility
sitting in the acceptance criteria. Cross-path dedupe covers platform-id messages
only, which is every Telegram-originated message; the id-less callers are
server-internal paths that do not double-deliver. Narrowed rather than papered
over, and a stable envelope id would be the fix if that ever changes; with the flag off, no row is written
and delivery is unaffected.

**Live-user-channel proof (required before this is called done).** The integration
tier exercises the seam, **not** the real Telegram surface. This is Telegram-channel
behaviour, so "done" requires a user-role live test through Telegram itself.

| Step | Proves |
|---|---|
| 1. A normal Telegram message | `id_source: 'platform'`, dedupe against redelivery |
| 2. A long Telegram message (file-pointer injection) | The stored text is the operator's message, not the wrapper |
| 3. **Restart the server / reload config** | — |
| 4. Another message; row count still increasing | **The fix survives the thing most likely to undo it** |

Steps 3-4 are the point: a single readback proves the code works, not that the
machine is fixed, and the realistic regression is the flag or the arm not
surviving a restart.

**Also verified during acceptance (SQLite-specific, replacing the JSONL lock
check):** the DB is writable, WAL mode is confirmed, the unique index exists,
`busy_timeout` is set, and a synthetic insert/read round-trip passes — i.e.
`armed: true` is true for the reasons it claims.

**Id-less seam regression** — a separate seam-level test, not a live-channel
claim, exercising the callers in `src/commands/server.ts` that pass no
`messageId`. That is **three of the four callers**, the majority of the seam's
traffic shape, and a path a Telegram message cannot reach.

**The acceptance trace artifact.** Three structured log lines sharing a span id —
first instar frame, any hand-off, `injectTelegramMessage` — behind the same flag,
removed after acceptance. **It passes iff** every observed message's chain
terminates at `injectTelegramMessage` **and** the `inbound_messages` row for that
`dedupe_id` exists. A chain terminating elsewhere is a *finding*, not a test
failure: it means a second delivery path exists, which is what ACT-1217 hunts.
**Handling:** acceptance record only, never the repo; redacted to message ids,
topic ids and function names — no message text, no display names, no user ids;
deleted at sign-off.

**E2E** — production initialization path: a message injected into a live session
is readable back from topic history within a bounded interval, and `GET /health`
reports `armed: true` with a non-zero row count.


## 6. Multi-machine posture

| Surface | Posture | Notes |
|---|---|---|
| The seam call | **unified** | Code — identical on every machine by construction. |
| The message log + TopicMemory rows it writes | **machine-local BY DESIGN** | `machine-local-justification: physical-credential-locality` — the Telegram bot token and the forum/topic ids it namespaces live on the machine that polls, and the log is that machine's record of what *it* saw. A machine cannot honestly record having been shown a message it was not shown. Merging the two halves into one readable history is the separate change in §8.1, and it is a *read*-side merge, not a replication of this write. |

## 7. Frontloaded Decisions

0. **Synchronous SQLite insert on the delivery path, rather than a durable queue
 or worker-thread writer.** *(Promoted here at round-56: the comparison lived in
 §3.2, which the strict contract excludes — so a reviewer reading the contract
 saw the riskiest decision with none of its justification. A decision the
 contract asks a reader to accept has to be defensible **in** the contract.)*

 | | Sync INSERT (chosen) | Durable queue / worker writer |
 |---|---|---|
 | Event-loop stall | Blocks delivery. **Worse.** | Bounded enqueue. **Better.** |
 | Crash before durability | Committed before injection. **Better.** | Queued-but-unflushed is lost — **this bug's exact failure mode, reintroduced**. |
 | Disk full | INSERT fails, counted, delivery proceeds. Equal. | Enqueue fails or queue grows. Equal-to-worse. |
 | Multi-process | SQLite handles it. **Better.** | Needs its own coordination. |

 The queue wins the stall axis, which is the biggest operational risk here. It
 is still not chosen because **the crash axis is what this bug is about** — a
 design whose failure mode is "recently received messages lost on crash" would
 reintroduce the defect while fixing it. The stall is named as a residual,
 detected out-of-process, and if the hostile benchmark shows it dominates, the
 queue is the documented fallback chosen on those numbers.

 **That comparison strawmanned the alternative, and the correction matters.** "Durable queue" was weighed as *in-memory* enqueue, which does
 lose data on crash. The real industry pattern is a **durable outbox** — a
 synchronous write to durable storage, drained asynchronously by a worker.
 Weighed honestly: **that pattern is what this design already is.** The
 synchronous `INSERT` *is* the durable outbox write; `scheduleInboundTopicMemory`
 *is* the async drain. A separate outbox subsystem would add a second table, a
 worker and drain-state bookkeeping **without removing the stall, because the
 durable write is synchronous in both designs.** That is the whole answer: the
 stall lives in "make it durable before proceeding" — the requirement, not the
 implementation. A design that removes the stall removes the durability, which
 is where this started.

1. **Log at the seam, not at each caller** — **four** callers today (§2), three of
 which pass no `messageId`. Logging per-caller would mean four correct
 implementations and a fifth silently reintroducing the gap.
2. **Commit the INSERT before injecting; schedule the index write after** (§3.1) — two
 writes, two rules. Named this way after three rounds of reviewers reading "log first" as a
 synchronous call, which is exactly how it would be mis-implemented.
3. **A logging *error* never intentionally aborts the message** (§3.2) — phrased
 this way because the stronger "never blocks delivery" is false and kept
 surviving folds in summary form. A synchronous storage **stall** can delay or
 prevent delivery; only the *error path* is guaranteed. The distinction is the
 whole of §3.2's accepted residual, and a summary that erases it re-tells the
 comfortable version.
4. **The forward route's existing call stays** — dedup makes it harmless, and removing it is unrelated risk.
5. **A missing `messageId` gets a per-injection UUID** (§3), not silence and not a content hash — an id-less message is recorded, and no cross-message identity is inferred from its bytes.
6. **Ships default-OFF; the flip to default-on is earned by three measured gates**
 (§3.3), not by a release count. 
7. **No backfill attempted** (§4).
8. **Cross-machine history merge is explicitly out of scope**, and tracked as
 ACT-1216 rather than left as a note (§8.1).
9. **This is a RECEIVED log, not an OBSERVED log** (§3.1) — the honest name for
 what it records, chosen over a second write to track delivery status.
10. **No new SUBSYSTEM** — no queue, worker, event bus, retry ladder or new
 persistent store. (Not "no write-ahead log": §3 names the design as a
 miniature write-ahead split, and FD10 contradicting that was review scar
 tissue.)
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
