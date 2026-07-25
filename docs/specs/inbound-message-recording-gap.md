---
title: "Record inbound messages at the injection seam (best-effort recording; first-loss health degradation while the process lives, best-effort across restarts)"
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
> **Build from `docs/specs/generated/inbound-message-recording-gap.contract.md`.**
> This file is the **rationale and review record**: why the contract is shaped as
> it is, what was tried and reversed, and which residuals were accepted
> deliberately.
>
> Six consecutive rounds (29-35) asked for this, from **both** reviewer families
> independently, and three of those rounds found a real instance of the hazard —
> a retired design still described in normative-looking prose, which is how the
> wrong thing gets built. Restating a design in a second place creates a second
> place to be wrong, and this document proved that repeatedly at a tenth the size
> of the spec that first taught the lesson (ACT-1215).
>
> §3.0 remains in this file as the in-place summary and stays authoritative *over
> the surrounding prose*; where §3.0 and the generated contract could ever differ,
> the generated one wins, because it is derived rather than maintained. The build
> check (`--check`) is what keeps that true over time.
>
> **And the review must follow the artifact (round-36, codex).** Declaring the
> generated contract normative while continuing to send *this* file to reviewers
> means no reviewer has ever read the thing being built — they cannot verify it,
> and every finding about "historical prose reading as normative" is a finding
> about a document that is no longer the contract. From round 37 the cross-model
> review runs against the **generated contract**, with this file supplied as
> rationale. That is a change to how this spec is converged, not just to what it
> says, and it belongs here because the previous six rounds of that finding were
> partly an artifact of reviewing the wrong file.

> **It is no longer small, and `single-run-completable` is now `false`
> (round-34, codex).** This opened as one mechanism, one seam, one flag. Review
> has since added — each for a good reason — a schema migration, a split logger
> API, rotation and retention, two AST build checks, a one-sided-conversation
> detector, a health surface with a synthetic self-check, and a privacy posture.
> Every one of those is defensible; the aggregate is not one run's work, and
> claiming otherwise would put the wrong thing in the frontmatter for a machine to
> read. **The natural split is retention/rotation** (§3.0 rows 5-9), which is
> independent of the recording fix and could ship separately. It is kept here for
> now because shipping unbounded-growth recording and *then* bounding it means
> deliberately shipping the unbounded version — but if this spec is broken up,
> that is the seam to break it on.
>
> **Round-37 (codex) pushed back on keeping it bundled, and is the second
> reviewer to do so.** The counter-argument is good: this spec is already
> `single-run-completable: false`, so bundling does not buy a single shippable
> unit — it buys one document that cannot be built in one go instead of two that
> can. And the half that stops live data loss is the seam call, which is small and
> could ship much sooner than the retention machinery. Against that, the
> unbounded-growth window is real but narrow: the log only grows on a machine
> where the flag is deliberately on, which today is one machine.
>
> **The recommendation is to split; the prioritisation is the operator's call**,
> because it trades "fix the data loss sooner" against "carry an unbounded log for
> a while", and that is a judgment about acceptable exposure rather than a
> technical fact. Registered as a decision rather than resolved unilaterally.
> <!-- tracked: ACT-1219 -->

**It began deliberately small.** One mechanism, one seam, one flag. The companion spec
`outbound-gate-advisory-override.md` took 33 review rounds and never converged,
because every fold of a 2,700-line document created new contradictions elsewhere
in it (ACT-1215). This spec is scoped so a fold cannot do that.

## 1. Problem

**The machine that composes replies has no record of what was said to it.**

**Scope, stated before the evidence rather than after it (round-32, codex).**
What this spec fixes is **session-resume completeness**: a session that restarts
should be able to read the conversation it is resuming, both halves. What it does
**not** deliver is an audit of everything Telegram ever sent this machine — a
message dropped or refused before it reaches a session is invisible to this
design and stays invisible (§4). The record it builds is therefore a
**session-injection received log**, not an intake log, and that name is used
throughout deliberately. The headline above is the symptom; this paragraph is the
boundary.

Verified on **this machine — Justin's MacBook Pro, the pool machine named
"Laptop"** — 2026-07-25.

**Correction (2026-07-25T14:0xZ): earlier revisions of this spec said "the Mac
Mini", and said the topic was owned by the Laptop while the Mini composed
replies. Both were backwards, and the error was carried all day.** Verified now:
`hostname` is *Justin's MacBook Pro*; `GET /pool` lists two online machines,
`Laptop` (`m_cc2ec651…`, this one) and `Mac Mini` (`m_4cbc0d4a…`); and the
serving lease is held by **`m_4cbc0d4a…`, the Mac Mini**. So the **Mini is the
router** and the **Laptop runs this session** — the reverse of what was written.
Every measurement below was taken on the Laptop and is unaffected; only the
machine names were wrong.

**Re-verified against live state at 2026-07-25T11:19Z**, and the re-check moved a
headline number in the worse direction — which is the reason for re-checking
rather than quoting the first measurement:

| Observation | Value |
|---|---|
| Messages stored for topic 33368 | 138 (was 111 at 11:19Z — **+27 outbound, still 0 inbound, while this spec was being reviewed**) |
| …of which inbound (`fromUser: true`) | **0** |
| **Last inbound row machine-wide (any topic)** | **2026-07-01T21:40:22Z — 24 days ago** |
| Last outbound row machine-wide | 2026-07-25T13:29:29Z (current) |
| Inbound / outbound since 2026-07-20 | **0** / 392 |
| Inbound / outbound on 2026-07-25 alone | **0** / 94 (re-measured 13:29Z) |
| Hits on the route that logs inbound (`/internal/telegram-forward`) in `logs/server.log` | **0** |

**The earlier figure was "zero inbound since 2026-07-20", which was true and
understated the defect by three weeks.** It was true because it was measured over
a window chosen for a different reason, and no one asked what lay before the
window. The real cutoff is 2026-07-01. Recorded because the same shape of error —
a correct statement over an unexamined range — is how the underlying bug went
unnoticed in the first place.

The recording code is not broken. **It is on a path that is not being used —
and the reason is now traced (`docs/specs/reports/inbound-intake-path-investigation.md`).**
This machine is a session-pool **worker**, not the router: `GET /health` reports
`holdsLease: false`, and its own log repeats `StateManager is read-only (this
machine is on standby)`. The router peer receives the Telegram message through
**its** intake route — which logs it **there** — then forwards a `deliverMessage`
across the mesh, and this machine injects it through the **owner-side bridge**
(`src/commands/server.ts:20722`, one of the id-less callers), which never touches
the local logger. So the intake route here is legitimately idle while the
sessions are busy.

**One link is unverified and stated as such:** no inbound message appears in the
current log window, so the path is shown to exist and to be the only plausible
one — not observed carrying a message. The two-minute check that closes it is in
the investigation report.

**It strengthens the seam choice.** If forwarded delivery bypasses the intake
route, the injection seam is not merely *a* verified point — it is the **only**
point local and forwarded delivery share.
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

### 3.0 Final contract

#### Normative checklist (build from this; everything after it is elaboration)

**Config keys**
- `messaging.inboundSeamLogging.enabled` — default `false`
- `messaging.inboundSeamLogging.captureBody` — default `true`
- `messaging.inboundSeamLogging.captureBodyAcknowledgedAt` — **no default; arming
  REFUSES to capture bodies until it is set** (round-79: a key that defaults
  `true` cannot distinguish "the operator chose this" from "the operator never
  looked", so "requires explicit opt-in" was incoherent as written — the
  acknowledgement needs its own storage). Unset ⇒ the feature arms in
  metadata-only mode. **Two distinct fields, because one key with two effective
  values is unimplementable (round-80): `requestedCaptureBody` (the config value)
  and `effectiveCaptureBody` (`requested && acknowledgedAt is set`). `/health`
  reports BOTH, plus `captureBodyAcknowledgedAt` itself — an ISO-8601 timestamp;
  any unparseable value is treated as unset rather than as acknowledgement.**: the operator flips two things, not one, because
  "record that a message arrived" and "keep the text of everything anyone types
  to this agent" are different decisions and only the second is a privacy
  decision. The default stays `true` because session-resume reading — the actual
  purpose — needs the body; what changes is that nobody gets it by not noticing.
- emergency disable honoured at the same key

**DDL**
```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS inbound_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_id TEXT NOT NULL,
  topic_id INTEGER NOT NULL,
  seam_received_at TEXT NOT NULL,
  from_user INTEGER NOT NULL DEFAULT 1,
  text TEXT,
  body_captured INTEGER NOT NULL DEFAULT 1,
  sender_name TEXT,
  telegram_user_id INTEGER,
  message_id INTEGER,
  id_source TEXT NOT NULL CHECK(id_source IN ('platform','derived')),
  text_truncated INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS inbound_recording_state (
  key TEXT PRIMARY KEY,
  last_failure_at TEXT,
  last_failure_reason TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_dedupe ON inbound_messages(dedupe_id);
CREATE INDEX IF NOT EXISTS idx_inbound_topic_seq ON inbound_messages(topic_id, seq);
```

**Arming** — **one migration row covers BOTH tables** (plus a second row, `name = 'inbound_messages_validation'`, holding `validation_version`). **Its branches, stated so they are not left to inference (round-79):** absent → run probes, INSERT the row; equal → run probes anyway (they are cheap and rolled back) and do not write; older → run probes, UPDATE the row; **newer than this build → run probes and do NOT write** — a newer validation version is not a reason to refuse arming, because validation is behaviour rather than schema and a newer build's stricter probes say nothing about whether THIS build can operate (`name = 'inbound_messages'`);
creating and validating `inbound_recording_state` happens inside the same
versioned transaction, and a failure to create or validate it **refuses arming**
like any other schema mismatch — it is load-bearing for restoring `degraded`
across a restart, so an unusable state table means the feature cannot honestly
report itself. WAL outside a transaction; then BEGIN → migrations-table shape →
branch on this feature's row (absent = create+validate+INSERT; equal =
validate only; older = migrate+validate+UPDATE; newer = refuse) → COMMIT.
Any mismatch: ROLLBACK, `armed: false`, log expected vs actual plus reconciling
SQL. Never auto-`ALTER`. Retry arming every 60 s, backing off to 15 m.

**Write** (`recordInboundMessage`, synchronous, before injection)
1. If not armed → no-op; count `inbound-messages-skipped-unarmed`; **inject**.
2. `dedupe_id` = `in:telegram:<botId>:<chatId>:<messageId>`, else `in:derived:<uuid>`.
3. Plain `INSERT` in a transaction (never `OR IGNORE`). Up to **3 attempts**, backoff 0/20/50 ms.
   Worst case ≈ 370 ms under sustained contention.
4. Return `appended` | `duplicate` | `failed`. `duplicate` **only** for a UNIQUE violation on `dedupe_id`; any other constraint error is `failed`. **Never throw.**
5. `failed` → count `inbound-log-failed`, set `recording: 'degraded'` **on the first
   failure**; clears by a state machine with exactly three inputs (round-67 found my previous
   wording self-contradictory — it required a successful insert to clear while
   claiming a store with no traffic could clear):

   **ONE rule, stated once (round-76 found three phrasings that implied a timer,
   an insert-only clear, and an operator clear, which cannot all be the rule):**

   ```
   on failure:            degraded = true;  last_failure_at = now  (durable, best-effort)
   on insert appended
     OR duplicate:        if (now - last_failure_at >= 60s) clear()
                          // a UNIQUE violation proves the DB is reachable, writable
                          // enough to reach the index, and enforcing constraints —
                          // it is recovery evidence. Round-80: without this, a
                          // machine seeing only redeliveries stays degraded while
                          // demonstrably healthy.
   on operator check ok:  clear()                                  // no wait
   clear():               degraded = false; DELETE the durable row (failure to
                          delete leaves degraded true; it NEVER rolls back an insert)
   ```

   **There is no background timer.** Nothing clears on the passage of time alone —
   a clear is always caused by a successful write, either a real message or an
   operator-requested check. So a quiet machine with no operator action stays
   `degraded`, which is the intended behaviour: it has produced no evidence it
   recovered.

**The invariant, weakened to what is actually true (round-72 — "present iff
unresolved failure" cannot hold alongside "the write is best-effort and can fail
for the same reason as the insert"; both were in the same paragraph):**
**presence of the row PROVES an unresolved failure; ABSENCE proves nothing**
unless the current process has itself observed the clear. That asymmetry is the
honest one — a missing row can mean recovered, or can mean the recorder could not
write — and it is why the in-memory flag, not the row, is the primary signal.
   `failure_count` accumulates while it exists and goes with it when it is
   deleted; the count is a diagnostic for the current episode, not a lifetime
   total.

   **No traffic therefore means `degraded` PERSISTS**, indefinitely, which is
   correct: a machine receiving nothing has produced no evidence it is fixed, and
   "quiet" is exactly what this bug looked like. Clearing requires proof of work,
   not the passage of time.
6. `appended` → `scheduleInboundTopicMemory` via `setImmediate` (skipped entirely
   when `captureBody: false`). Backlog cap 16.
7. **Inject — unconditionally, in every branch.**

**Retention** — daily; cutoff via `ORDER BY seq DESC LIMIT 1 OFFSET :keep`; delete
`WHERE seq IN (SELECT seq … LIMIT 1000)` in batches with yields; keep 200 000 rows;
cap stored text at **65 536 UTF-8 bytes, truncated on a character boundary** (never mid-sequence, so the stored value is always valid UTF-8); abort if an insert failed or p99 exceeded the gate in the
last 5 minutes.

**Health** — `recording`, `enabled`, `armed` (+reason), `lastArmAttemptAt/Result`,
`rowCountTotal`, `rowCountUserVisible`, `dbFileBytes`, `walFileBytes`, insert
failures, max latency, self-check result, last retention run, loop-tick counter.

**Latency thresholds — one window, three DIFFERENT consumers, named separately
(round-72: the document used 50 ms, 250 ms and 1 s in different places without
saying which governs what):**

| Consumer | Threshold | Effect |
|---|---|---|
| **Alert** | p99 > **50 ms** | Attention item — the filesystem is generally slow |
| **Alert** | any single insert > **1 s** | Attention item — a pathological stall |
| **Retention abort** | p99 > **50 ms** *(the alert threshold)* in the window, or any failure | Skip/abort the cleanup pass |
| **Rollout gate** | contended p99 > **250 ms**, or max > **1 s**, or `/health` > **1 s** | Blocks enablement; forces the worker-owned writer |

The rollout gate is deliberately looser than the alert: an alert says *look at
this*, a rollout gate says *do not ship this*, and they should not be the same
number.

**Latency measurement** — one rolling window, defined once because three rules
depend on it (round-68): a **5-minute sliding window** of primary-insert
durations, **excluding self-check inserts** (not user traffic, and including them
would flatter the numbers), reset only by process restart,
exported as p50 / p99 / max. "p99 exceeded the gate in the last 5 minutes" and
"max latency" both read that one window. Unpinned, one implementer's retention
never runs and another's runs during a stall.

**Counters** — process-local and monotonic, **plus a DURABLE last-failure record** in its own table:
`CREATE TABLE IF NOT EXISTS inbound_recording_state (key TEXT PRIMARY KEY,
last_failure_at TEXT, last_failure_reason TEXT, failure_count INTEGER NOT NULL
DEFAULT 0)`, one row keyed `'default'`, upserted on failure (count incremented,
timestamp and reason overwritten).

**It can fail for exactly the same reasons as the write it records (round-71 —
the third variant of this circularity tonight, after the in-process alarm and the
unreachable `/health` counter).** Disk full, read-only database, wedged SQLite,
lost permissions: the recorder lives in the same database as the failure. The
ladder is therefore stated rather than assumed: **(1) in-memory
`recording: 'degraded'` is set FIRST and needs no storage at all — it is what
`/health` reports, and `/health` is what the external watchdog reads; (2) the
durable row is written best-effort, its own failure counted, never retried, never
fatal; (3) an Attention item is attempted.** **Named residual, stated at its real size (round-78 — I had named only the
narrowest case): ANY restart after a failure whose durable row did not get
written loses the degraded state.** That is not just a same-instant crash. The
state table lives in the same database, so the disk-full / read-only / wedged
cases that cause the insert to fail are exactly the cases that stop the failure
being recorded — and then an ordinary restart hours later comes up clean. The
narrow crash window was the flattering version of this. **Persisting the marker
outside SQLite would close it and is deliberately not done**: it means a second
storage mechanism with its own failure modes, for a marker whose job is already
covered in-process while the process lives. In-memory covers the common case, the row covers restarts, neither
covers a same-instant crash — said plainly, because the alternative is implying a
guarantee that three layers of storage cannot give.

It gets the same shape validation as the other
tables. ("A `schema_migrations`-style row" was hand-waving — that table is
`(name, version)` and cannot hold any of this.) Process-local counters
alone lose the first-loss signal if the process dies shortly after the failure —
in a feature whose entire purpose is that losses are not silent. The durable row
survives the crash and is read at arm time, so `recording: 'degraded'` can be
restored rather than forgotten. Counters: `inbound-log-failed`, `inbound-search-index-dropped`,
`inbound-search-index-failed`, `inbound-log-arm-failed`,
`inbound-messages-skipped-unarmed`, insert-latency histogram.

**Wedge detection** — out-of-process: **no `/health` response within 30 s** is the
signal; a frozen loop-tick in a response is the weaker, partial case.

**Acceptance** — pre-enable local probe; flag ON for the affected machine; live
Telegram normal + long message with a call-path trace; restart; another message
with the row count still rising; id-less seam regression test; `armed: true`
confirmed; disclosure texts published.

---

**Local terms** — **injection seam**: `SessionManager.injectTelegramMessage`, the
function that hands an inbound message to a running session. **Forward route**:
`POST /internal/telegram-forward`, the lifeline's delivery path. **TopicMemory**:
the existing SQLite store behind conversation search. **Attention**: the deduped
operator alert queue. **Armed**: enabled *and* the store opened writable.

| | |
|---|---|
| **Where** | `SessionManager.injectTelegramMessage`, before the injection. |
| **Store** | A **new SQLite table**, `inbound_messages`, in the agent's existing database. **Schema migration is required; DATA migration is not (round-52 — "no migration" was too loose).** The DDL is idempotent `CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS`, run at arm time. **DDL success is not schema validation** — `IF NOT EXISTS` silently accepts a pre-existing table with wrong columns, constraints or index shape. Arming therefore VALIDATES: **a feature-local migration row** equals this build's expected schema version — **`version = 1` for the schema in this document, bumped on any change to a COLUMN or INDEX only. Probe changes bump a SEPARATE `validation_version`, stored as a second row in the SAME `schema_migrations` table (`name = 'inbound_messages_validation'`), and are NOT a migration (round-74: probes are validation behaviour, not schema, so a build with identical DDL but stricter probes would otherwise refuse a perfectly valid deployed database as if it needed migrating).** (round-72: "this build's expected version" named no integer, leaving equal/older/newer undecidable)** — `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, version INTEGER NOT NULL)`, this feature's row keyed `'inbound_messages'`. **The migrations table gets the same validation as the data table (round-60: it carries the identical pre-existing-wrong-shape hazard), and table creation, index creation and the migration row are committed in ONE transaction** so a crash cannot leave a version claiming a schema that was never created — **not `PRAGMA user_version`, which is database-GLOBAL (round-59): `TopicMemory` shares this database, so claiming that pragma would either falsely fail arming or overwrite another component's migration state**; **`PRAGMA table_info`** shows every expected column, compared on **normalised type affinity rather than raw string equality** (round-59: SQLite's loose typing means `INTEGER PRIMARY KEY`, `INT` and `integer` are the same thing and a literal comparison would fail arming on a correct table) — extra columns tolerated, missing ones not. **Trigger/constraint detection uses the stable surfaces, not SQL-text parsing (round-65: `sqlite_schema.sql` is a text blob, not a semantic API, and pattern-matching it is its own bug source).** Triggers: `SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='inbound_messages'` — an existence query, no parsing. Everything else is covered by **representative insert probes** rather than by reading DDL: the rolled-back probe round-trip exercises the realistic row shapes (body captured and not, `message_id` present and NULL, truncated and not), so a stricter `CHECK` or a generated column is caught by the insert failing rather than by a regex on schema text. **The probe set is enumerated rather than left to judgment (round-68):** (a) body captured with a platform id; (b) body captured, `message_id` NULL, `id_source='derived'`; (c) `body_captured = 0` with `text` NULL; (d) text at the 65 536-byte cap with `text_truncated = 1`; (e) a row at the `text_truncated` boundary with `body_captured = 0`. **Probes run inside a transaction that is ALWAYS rolled back (round-71): they must not commit, because a committed probe row would count toward retention and `rowCountTotal`, and arming retries every 60 s — so committing probes would let a machine that cannot arm slowly fill its own store with evidence of failing to arm.** **Representative, not exhaustive** — probes cannot prove every future valid row stays valid — so this is stated as coverage of the shapes this design actually writes, and any shape added later must add its probe — an existing table can pass a column-and-index check and still reject inserts because of a trigger or a stricter CHECK, and a single probe shape would only exercise one row shape. Unsupported extras refuse to arm rather than being worked around; **`PRAGMA index_list`/`index_info`** shows a UNIQUE index on `dedupe_id` alone; **`PRAGMA journal_mode`** reports `wal` — **set and verified OUTSIDE the schema transaction (round-63: journal-mode changes cannot be made inside one, so burying this in the DDL transaction would fail or silently not apply)**; and an **insert/read/rollback round-trip** passes. **When validation fails, the operator needs a path, not just a refusal (round-62).** `armed: false` naming the difference is the signal; the artifact is a **written repair note in the arm-failure log** giving the expected schema, the actual schema, and the exact SQL to reconcile them. **With the three things a hand-run migration needs and my first version omitted (round-69): (1) BACK UP the database file first, with the exact `cp` command and the path; (2) the statements are ordered and each is individually reversible, or the note says plainly which are not; (3) after running them, restart and confirm `armed: true` — do not assume.** The operator runs it, or does not, having read that. The code still never runs it: refusing to auto-`ALTER` is the safety property, and handing over the statement is not the same as executing it. Without that note the refusal is a dead end, and a dead end on the arming path means the bug stays unfixed for whoever hits it.

**Full arming algorithm** (round-64 found the previous ordering unimplementable: it validated the migration row *before* writing it, so on a first install — where the row cannot exist — a literal implementation either refuses to arm forever or quietly weakens its own validation):

1. Open the database; set/verify `PRAGMA journal_mode = WAL` **outside any transaction**.
2. `BEGIN`.
3. Create/validate the **`schema_migrations` table shape** itself.
4. Read this feature's row (`name = 'inbound_messages'`).
   **Every branch covers BOTH tables and all indexes** — `inbound_messages` with
   its unique and topic indexes, **and `inbound_recording_state`** (round-70: the
   branches named only the first table, so an implementer following these steps
   rather than the checklist would ship without the state table and lose
   degraded-across-restart silently).

   - **Row absent** → first install: create **both tables and both indexes**, validate the resulting schema of **both**, then **INSERT** the row.
   - **Row present and equal to this build's version** → validate the existing schema of **both**; **do not write**.
   - **Row present and older** → apply the ordered migration, validate **both**, then **UPDATE** the row.
   - **Row present and NEWER than this build** → refuse to arm. A downgrade must never rewrite a schema it does not understand.

   **That refusal is the SCHEMA row only. The VALIDATION row behaves oppositely
   (round-80 found the two conflated):** a newer `validation_version` runs the
   current probes, does not overwrite the row, and **does not refuse** — validation
   is behaviour, not structure, so a future build's stricter probes say nothing
   about whether this build can operate against this schema.
5. `COMMIT` — or `ROLLBACK` and `armed: false`, naming the difference, on any validation failure.

Validation always runs against the **actual resulting schema**, never against what the DDL intended, so a pre-existing wrong table fails identically whether this build created it or not.

**Exact ordering, because "create, validate, and commit atomically" is ambiguous about which happens first (round-61):** BEGIN → create table/index `IF NOT EXISTS` → **validate the ACTUAL resulting schema** (the pragmas above) → **only if validation passes**, write/update the migration row → COMMIT. Validation runs against what is really there, never against what the DDL intended, so a pre-existing wrong table fails the same way whether this build created it or not; and the migration row can never claim a schema that was not validated, because it is written after the check and inside the same transaction. **Any mismatch means ROLLBACK and `armed: false` naming the specific difference** — never a silent degrade, and **never an automatic `ALTER`**: repairing a schema this design did not create is how a careful guard destroys someone else's data. No existing row is read, moved, backfilled or rewritten. `better-sqlite3` is already a dependency and `TopicMemory` already opens it (`src/memory/TopicMemory.ts:154`). WAL mode, `busy_timeout = 100 ms`. |
| **Schema** | `seq INTEGER PRIMARY KEY AUTOINCREMENT`, `from_user INTEGER NOT NULL DEFAULT 1`, `dedupe_id TEXT NOT NULL` (uniqueness is enforced by the **named index** `idx_inbound_dedupe`, **not** by a table constraint — round-73: prose said `UNIQUE` on the column while the DDL created an index, and validation must accept exactly one of those, not either), `topic_id INTEGER NOT NULL`, `seam_received_at TEXT NOT NULL`, `text TEXT` (**nullable** — `NULL` when `body_captured = 0`; round-61 caught metadata-only mode contradicting a `NOT NULL` column), `body_captured INTEGER NOT NULL DEFAULT 1`, `sender_name TEXT`, `telegram_user_id INTEGER`, `message_id INTEGER` (nullable — no `-1` placeholder is needed), `id_source TEXT NOT NULL CHECK(id_source IN ('platform','derived'))`, `text_truncated INTEGER NOT NULL DEFAULT 0`. **No `synthetic` column — self-checks always roll back, so no non-user row is ever committed (round-75/76).** |
| **Write** | **Plain `INSERT` inside a transaction — NOT `INSERT OR IGNORE` (round-69, and this was a silent data-loss bug in a data-loss fix).** `OR IGNORE` suppresses *every* constraint violation, so a `NOT NULL` breach, a `CHECK` failure, a trigger side effect or a bad binding all return zero changes and would have been classified `'duplicate'` — reported as the system working correctly while the message was gone. Instead: catch the error, and classify **only a UNIQUE violation on `dedupe_id`** as `'duplicate'`; **every other constraint failure is `'failed'`**, which counts, degrades, and alerts. Synchronously, **before** injection. **Bounded retry: up to 3 attempts, 0/20/50 ms** — most realistic failures here are a transient busy lock (retention delete, TopicMemory write, WAL checkpoint), and one attempt against a shared database turns ordinary contention into permanent loss (round-60). **~370 ms is a LOCK-CONTENTION bound ONLY — it does NOT bound delivery latency
(round-73, and I had been using it operationally as though it did).**
`busy_timeout` bounds how long SQLite waits for a *lock*. It bounds nothing about
`fsync`, a stalled filesystem, disk firmware, a network volume, or an antivirus
filter driver — and synchronous `better-sqlite3` blocks the event loop through all
of those. So: **the contended-lock path is bounded at ~370 ms; the event-loop
stall is UNBOUNDED**, and the two must not be conflated. Every gate and alarm
below reads the first; the second is the named residual the pre-enablement
hostile-storage gates exist to measure and the worker-owned writer exists to fix.
This is the clearest reason yet that the worker fallback is a real requirement
rather than a nicety.

**The lock bound itself: ~370 ms, not 70 ms (round-61 — I counted only the backoff and forgot each attempt can itself block for `busy_timeout`):** 3 × 100 ms of lock wait + 70 ms of backoff, plus the SQLite work. That is the number the benchmark gates and the max-latency alarm must use; the 70 ms figure would have set both wrong. It is a **worst case reached only under sustained contention** — an uncontended insert is sub-millisecond — but a bound that only holds when nothing goes wrong is not a bound. After 3 attempts it gives up, counts, degrades — **and injection still proceeds.** |
| **What this actually guarantees** | **Best-effort recording. First-loss health degradation WHILE THE PROCESS LIVES; restoration across a restart is best-effort, because the durable marker can fail for the same reasons the insert did (round-79 — "first-loss alerting" was the flattering version, in the headline claim, one section after documenting that habit). NOT guaranteed recording (round-60, and this corrects the spec's own headline claim).** A record that cannot be written after retries is dropped, and the message is still delivered. The alternative — blocking delivery until the write succeeds — is rejected outright: making a person unreachable to protect a log inverts the priority. So the honest statement of what changes is: **loss goes from silent and undetected for 24 days, to alerted on the first occurrence with the message still delivered.** That is a large improvement and it is not the same thing as "no loss", and the difference is stated here because every other section is written as if recording succeeds. | Returns `'appended' \| 'duplicate' \| 'failed'` from `changes` and the error path. **Never throws** — a `'failed'` result is caught internally and counted. |
| **Dedupe** | **Storage-enforced for platform-identified messages; id-less messages are intentionally NOT deduped.** **Caller inventory, stated HERE because the strict contract excludes §2 and an outside implementer cannot otherwise verify the non-replay invariant they are asked to accept (round-66):** `src/server/routes.ts:20323` passes a platform id; `src/commands/server.ts` at 2763, 2985 and 20711 do not, and those three are server-internal and are **not known to replay — which is weaker than "cannot" (round-67: the allowlist catches a NEW caller, it does not prove an EXISTING one never retries, is invoked twice, or replays after a crash).** The consequence is bounded: an id-less replay produces a **duplicate row**, never a lost message, and a duplicate is visible in the topic history rather than silent. That is the accepted direction — this design trades a possible duplicate for a guaranteed record — but it is an accepted risk, not a proof. **Any new id-less caller must pass a stable envelope id as `dedupe_id`** — the argument already exists — and the fitness-test allowlist fails the build when a fifth caller appears. The `UNIQUE` index on `dedupe_id` is the mechanism, not best-effort — this answers round-51 directly: there is no in-memory set, no seeding, no restart window, and two processes cannot interleave a duplicate through it. `dedupe_id` = `in:telegram:<botId>:<chatId>:<messageId>` when a platform id is present, else `in:derived:<uuid>`. **Fully platform-scoped (round-53): Telegram message ids are unique per CHAT, and `topicId` is an instar-side surrogate, so keying on it alone would false-dedupe across a migrated topic, a re-bound topic, or two bots sharing one agent.** The scope now comes from the platform's own identifiers, and `topic_id` remains a column for querying rather than part of identity. |
| **Secondary write** | `scheduleInboundTopicMemory(entry)` via `setImmediate`, only on `'appended'`. Backlog capped at 16; beyond that, drop and count. TopicMemory remains a **lossy search index**, never the record. |
| **Authority** | This table is the **seam-received store** — the name says the whole guarantee (round-56: `delivery_state` was a fixed, never-updated column asserting a state nothing verified, so it is **removed** rather than kept as decoration; a column with one possible value carries no information and invites a reader to think it is checked). The row is committed **before** injection, so a crash between the two leaves a row for a message no session processed. That is deliberate — a recorded-but-unprocessed message is recoverable, an unrecorded one is not — and it is why the store is not called "delivered". A future `injected_at`, written after a successful injection, is the honest way to add that distinction if a consumer ever needs it; it is not needed now and is not faked now. It is the **primary received-history store**. It is not proof of receipt: a message dropped before the seam never reaches it (§4), and `synchronous: NORMAL` means a power loss can lose the last transaction. Absence of a row is **not** evidence a message was not received. |
| **Indexes + health queries** | `UNIQUE(dedupe_id)` for dedupe; `(topic_id, seq)` for per-topic history and the one-sided check; there is no `synthetic` column to index — self-checks roll back. **Every health query is bounded and named (round-60: unindexed health checks become the new load source):** `rowCountTotal` = `COUNT(*)` (fine at 200k), `rowCountUserVisible` = the same count today, since no non-user row is ever committed — kept as a distinct field so a future non-user writer restores the distinction; it is not a chat message and does not interrupt a conversation. |
| **One-sided-conversation check** | A periodic query for topics with recent outbound rows and zero inbound rows over the same window. **Cadence:** hourly. **Owner:** the agent, surfacing to the operator via one deduped Attention item. **Actionable:** it names the topic and the window, and means *either* the recording is broken *or* the agent legitimately spoke unprompted — so it reports a suspicion to check, never an assertion of failure. |
| **Coverage evidence** | Three signals that SHIP, ranked honestly, none of them enforcement. **(1) The live call-path trace at acceptance** — proves the seam is on the real path, once, at one moment. **(2) The one-sided-conversation check** — recent outbound with zero inbound rows for a topic. Detects TOTAL regression in a topic and nothing subtler; kept because it needs no cooperation from the sending side and would have caught the original 24-day defect. **(3) The AST fitness test** — a build-time guard against the easy regression, blind to dynamic dispatch, reflection and module boundaries. **Reconciliation against the forward route is DEFERRED, not shipped (round-62).** It would be the strongest signal — it alone catches partial loss and wrong-topic writes — but it needs a durable, crash-safe, wrap-aware store of observed ids that this spec had waved at rather than specified, and making acceptance depend on an unspecified store is how a check becomes decorative. Tracked as follow-up rather than claimed. <!-- tracked: ACT-1222 --> |
| **Retention** | **Two dimensions.** (1) Keep the newest **200 000 rows**. (2) Cap stored text at **65 536 UTF-8 bytes per row** (bytes, not characters; truncation lands on a character boundary so the value stays valid UTF-8), longer messages stored truncated with `text_truncated = 1`. Not time-based. **The two caps bound the PAYLOAD, not the store** — SQLite page overhead, the index, WAL growth and free pages after deletes all sit outside them, so `200k x 64KB` is not a filesystem guarantee. `/health` reports **actual DB and WAL file sizes** instead, which is a measured number rather than an inferred one. **Deletion is two-step and batched**, never one statement: `SELECT seq … ORDER BY seq DESC LIMIT 1 OFFSET :keep` for the cutoff, then `DELETE FROM inbound_messages WHERE seq IN (SELECT seq FROM inbound_messages WHERE seq <= :cutoff LIMIT 1000)` repeated with a yield between batches — **the subquery form because `DELETE … LIMIT` requires SQLite compiled with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, which is not guaranteed (round-59)**, reporting rows deleted and per-batch latency. Daily. A single large DELETE would take locks on the same database the synchronous insert uses. **Retention YIELDS to recording (round-64): it does not start, and aborts between batches, if there has been an insert failure or a p99 above the latency gate in the last 5 minutes** — recording is the point of the feature and cleanup is housekeeping, so under contention the housekeeping loses. Last retention run time, duration, rows deleted and abort reason are on `/health`. Deleted rows free pages for reuse; **no `VACUUM`** — returning disk to the OS is not worth an exclusive lock on the delivery path's database. |
| **Single writer** | SQLite serialises writers; it does **not** guarantee this write completes within `busy_timeout` (round-60 — "SQLite handles it" was too broad). The realistic contenders on this shared database are the retention delete, TopicMemory's own writes, and WAL checkpoints. Mitigations, in order: retention runs in **small batches with yields** (§Retention) so it never holds a long write lock; the seam uses its **own connection** with `busy_timeout = 100 ms`; and the **bounded retry** above covers the residual contention. **No lock file, no boot-id, no stale-reclaim rule, no filesystem allowlist.** Injection never waits on lock acquisition beyond the retry budget. |
| **`enabled` vs `armed`** | `enabled` = the config flag (configuration only, never the logging predicate). `armed` = enabled **and** the table opened writable. Arming is attempted at startup and **retried in the background** (60s, backoff to 15m), outside the per-message path. While unarmed the seam call is a no-op, incrementing `inbound-log-arm-failed` once per process and `inbound-messages-skipped-unarmed` per message. **Acceptance FAILS if `armed` is false.** |
| **Failure behavior** | A failed insert is caught, counted, and **injection proceeds**. A failed secondary write is caught and counted. |
| **Degraded state** | **Failure is a STATE, not a count, and it engages on the FIRST failed insert.** Counters alone are how this bug survived 24 days: relying on someone noticing a metric is monitoring discipline, and monitoring discipline is what failed. A threshold of "10 consecutive failures" would permanently lose up to nine messages before saying anything — ordinary alert-noise tuning applied where each event IS the harm. **One failed insert sets `recording: 'degraded'` immediately**; clearing follows the state machine in §3.0 Write step 5 — a successful insert 60 s after the last failure, or an operator check, never a timer. `recording` is a first-class `/health` field (`ok` | `degraded` | `off`) that the out-of-process watchdog already polls and can act on **without Attention delivery working at all**. Noise is managed at the notification layer — Attention dedupes and backs off — never by staying silent about the first losses. |
| **Why `/health` and not Attention** | Every other mitigation here leans on the Attention queue, whose reliability and persistence this spec does not own and cannot assert (round-56). `/health` is a synchronous read of local state by an external poller — no queue, no delivery, no dedupe window. **Anything load-bearing is expressed there**; Attention carries the human-readable version. |
| **Counters** | `inbound-log-failed` (the authoritative insert failed), `inbound-search-index-dropped` (shed by the backlog cap), `inbound-search-index-failed` (attempted and threw), `inbound-log-arm-failed` (once per process), `inbound-messages-skipped-unarmed` (per message), insert-latency histogram. All monotonic within a process; `topic_id` is the only label. |
| **Latency** | Attention on p99 > 50 ms **and** on any single insert > 1 s. **Operational bound with an ACTION (round-57), corrected (round-63): the primary signal is `/health` NOT ANSWERING, not a frozen counter in an answer.** A wedged event loop cannot serve the request at all, so the round-47 loop-tick counter — added to fix exactly this circularity — is *itself* unreachable in the failure it exists for. That is the same circular mistake twice, one layer deeper. So the watchdog treats **no `/health` response within 30 s** as the wedge signal (which its existing timeout already produces), and the loop-tick counter is the *weaker, secondary* case: a response that arrives with a frozen tick means partially-degraded rather than wedged. Either way it escalates through its existing path — the same treatment any hung server gets. This design does not add a new recovery mechanism; it makes sure the existing one can see this failure. A wedged device can still block the event loop; that residual is named below and detected **out-of-process** via the loop-tick counter on `/health`. |
| **Health** | `recording` (`ok`/`degraded`/`off`), `enabled`, `armed` (+ reason, naming any schema-validation mismatch), `lastArmAttemptAt` / `lastArmResult`, **`rowCountTotal`, `rowCountUserVisible`, and measured `dbFileBytes` / `walFileBytes`** — both, kept as distinct fields so a future non-user writer restores the distinction; today they are equal because self-checks roll back — insert failures, max latency, the startup self-check result, a monotonic loop-tick counter, and the one-sided-conversation check (recent outbound with zero inbound). |
| **Self-checks never commit** | The startup and operator store checks run `INSERT` → `SELECT` → **`ROLLBACK`**, always. **Nothing therefore ever writes a synthetic row, so the `synthetic` column and every rule about it are DELETED (round-75).** They existed only to describe rows the self-check committed, and a self-check that commits pollutes retention and the row counts on every arming retry — a machine that cannot arm would have slowly filled its own store with evidence of failing to arm. One consequence, stated: `rowCountTotal` and `rowCountUserVisible` are now the same number, and both are kept only because a future non-user writer would need the distinction back. |
| **Privacy** | Message text stored **unencrypted** in the agent's database, file mode 0600. Deleting rows removes them from this store only; TopicMemory and any backups are separate. No redaction — a credential pasted into chat is stored verbatim. |
| **Disclosure** | **Blocking gate before the first enablement on any machine**: a release-note entry and an operator-visible config description, both stating what is stored, where, that it is unencrypted, the retention bound, and that deletion covers this store only. Owner: the implementing agent; both texts linked from the acceptance record. End-user notice beyond the operator is **not enforced by this feature** — which is a statement about what the code does, **not** a claim that none is required (round-53: "not required" asserted a policy position this spec has no standing to assert; the operator is not necessarily the principal data subject when third parties message the agent). The config description therefore carries an explicit operator warning: **inbound third-party messages are stored verbatim, and any notice or legal obligation toward those people is external to this software and yours to meet.** |
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

**It is evidence, not enforcement, and the framing matters (round-51 — restored
here after the round-51 contract rewrite dropped it along with the JSONL
machinery; it is a real safeguard, not storage plumbing).** An AST scan misses
dynamic dispatch, reflection, indirect wrappers, runtime monkey-patching,
generated code and module boundaries; the counter shows a divergence without
attributing it. Calling that "architectural enforcement" would be exactly the
false confidence that let the original defect survive — someone assumed a path was
covered because a check existed. **The real production evidence is the live
Telegram call-path trace and the one-sided-conversation detector.** The AST test is
a cheap build-time guard against the easy regression, framed as that and no more.

**Lifecycle, one table (round-58 — the contract is argumentative prose and hard
to scan; this is the whole state machine in eight lines).**

| Stage | On success | On failure |
|---|---|---|
| **1. Arm** (startup + background retry) | `armed: true`, `recording: 'ok'` | `armed: false` naming the reason; seam is a no-op; per-message skip counter |
| **2. Record** (sync `INSERT`, before injection) | `'appended'` → stage 3 | `'failed'` → `recording: 'degraded'` immediately; **stage 4 still runs** |
| **3. Index** (`setImmediate`, only on `'appended'`) | row searchable | shed by cap → counted; threw → counted. **Never affects stage 4** |
| **4. Inject** | message reaches the session | — |

`'duplicate'` at stage 2 skips stage 3 and proceeds to stage 4. **Stage 4 runs in
every path**: no failure anywhere in 1-3 can stop a message reaching the session.

**One increment.** The round-46 A/B split existed because JSONL needed rotation
and retention machinery that a table does not. There is nothing left to defer.

> **On the JSONL fallback, honestly.** Round 50 said the JSONL design would be
> "retained in full as the fallback". Making the contract implementable (round-51:
> two incompatible designs cannot both be normative) meant **replacing** that
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
table contradicted the body on two counts (round-30), because restating a design
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
and the field is `seamReceivedAt`, not `shownAt`. If a consumer ever needs
agent-observed semantics, that is a new field with its own write, not a
reinterpretation of this one.

**"Received" still over-named it, though (round-27/28, codex — and the fix for an
overclaim carrying a smaller overclaim is now a pattern in this document).** The
seam is not the Telegram intake edge. A message that arrives at the bot and is
queued, dropped, or refused *before* injection is never seen here (§4 admits
this), so a bare `received` reads as "received by the agent" when it only means
"reached the point where a session was about to be handed it." The field is
therefore `seamReceivedAt` — the `session` prefix is load-bearing, not
decoration — and `deliveryState: 'injection_seam_received'` is defined in one line at its
definition site as **received by the session-injection seam, not by Telegram**.
The enum value stays short because it is written on every row; the definition
carries the precision.

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
`seamReceivedAt` and `deliveryState: 'injection_seam_received'` has to work to misread them,
where one reading `deliveredAt` would have to work not to. What it does not buy:
any mechanism preventing a determined consumer from treating presence as
delivery. **The only real enforcement available is the enum** — a future
`'injected'` value means a consumer that cares can *check* rather than assume,
and that is the honest ceiling here.

### 3.2 Failure direction: the essential write is synchronous and CAN delay delivery; the secondary write never does

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
review has found (round-29, codex).** `appendFileSync` can block *indefinitely* —
a wedged filesystem, a network mount that stops answering, a failing disk, an
antivirus filter driver. The whole "log failure never stops delivery" invariant
rests on the syscall **returning**, even to throw. If it never returns, the
message is not delivered late; it is not delivered at all, and the feature built
to protect the conversation is what stopped it. A p99 alarm reports this
afterwards. It does not prevent it, and a timeout cannot help — Node offers no
way to cancel an in-flight synchronous write, which is the same wall v4 hit.

Two things follow, and neither is a mechanism:

**The sync-append stall is a BLOCKING risk for opt-in, not a residual to measure
later (round-50).** A wedged disk or an antivirus filter driver blocking the Node
event loop stops *all* delivery on the machine — turning a recording fix into an
availability regression is a worse outcome than the bug it fixes. So it is not
carried as a "measured rollout concern": either the bounded mechanism below holds
under the hostile benchmark, or the design goes async with explicit
"may-miss-crash-before-flush" semantics. **Under the SQLite recommendation this
risk shrinks substantially** — a transactional insert on a WAL database is bounded
work against a file the driver has already opened, not an open-plus-append on a
path resolved per call.

**Compared against a durable append queue, properly (round-54 — "no new
subsystem" named the alternative without weighing it).** The industry pattern for
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
if any named gate in §3.3 fails (contended p99 > 250 ms, max > 1 s, `/health` > 1 s under contention, or any pathological case) — the queue is the documented
fallback, chosen on those numbers.

**CONSTRAINT, not just a description (round-64):** this design is **approved for
single-machine hotfix use only**, and **a revisit of the main-thread choice is
MANDATORY before any default-on beyond the affected machine.** **And the rule is
normative with a concrete trigger, not a review item (rounds 66/68): the
implementation MUST switch to the worker-owned writer before enablement if, on
the affected machine, ANY of — contended insert p99 > 250 ms, insert max > 1 s,
`/health` response > 1 s under contention, or any pathological-case gate — fails.**
A named number, not a judgement call. **And a specified BRANCH, not a revisit
(round-80): the seam calls a worker over a request/response channel and waits for
the worker's COMMIT acknowledgement before injecting — durability preserved,
because the wait is for the commit rather than for the enqueue — and the main
thread never opens a write connection at all. The blast radius is the reason a
gate failure must force this rather than prompt a discussion: a synchronous
main-thread write freezes every conversation in the process, and the watchdog
detects that after the harm instead of containing it.** **Also honest about the detector's limits:
a 30 s `/health` timeout is the WEDGE signal, far too slow to catch a
delivery-path stall that a user feels in seconds — the latency gates above are
what must catch that, before enablement, because nothing catches it live.** "Revisit" is how a
tactical choice becomes permanent; a failed gate with a vague follow-up is not a
gate. That is a gate, not an aspiration: the residual is a whole-process
stall on the delivery path, and carrying it to a fleet on a simplicity argument
would be choosing convenience over the thing the fleet is for.

**Narrowed claim:** this is a **local single-agent minimal fix**, not a general
message-durability architecture. At the point where multiple consumers, replay,
or cross-machine durability matter, the queue design is correct and this one is
not — and **that point is defined rather than left to judgment (round-55)**. Any
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

**Bounded append, not unbounded trust (round-46).** "Accept the stall and observe
it" is a weak answer for a chat system, where freezing the event loop is often
worse than losing one local history row. Increment A therefore appends to a
**pre-opened file descriptor** — the open, the path resolution and the locality
check all happen at arm time, so the hot path is a single `write` on an already-
open fd rather than an open-plus-write. That removes the whole class of stall
caused by path resolution and directory metadata, which is most of them, and
leaves only a genuinely wedged device.

**But the detector cannot detect the thing (round-47, and this is the sharpest
hole left).** Max-latency alarms, health degradation and Attention items are all
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

**A pre-enable local probe on the affected machine, before the benchmark
(round-63).** The gates below are a development-machine benchmark; the machine
being fixed can differ from it in exactly the ways that matter. So enabling on
any machine first runs a short local probe there: **healthy insert p99, a
contended insert bound, free disk space, and a forced read-only failure-path
check** confirming the seam degrades and still injects. It is minutes of work and
it tests the actual disk the actual messages will land on — which is the whole
lesson of a bug that existed because nobody checked the actual path.

**Hostile-storage evidence is a fleet precondition (round-45).** `appendFileSync`
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
   **operational requirement, not an enforced assertion** (round-30, codex —
   "asserted at startup" was the third overclaim in this paragraph's history, and
   the reviewer is right that a half-working check is worse than none). Reliably
   classifying a path as local across macOS and Linux means reasoning about
   symlinks, external drives, FUSE, cloud-synced folders, containers and
   platform-specific mount types; a check that gets that wrong either blocks a
   fine deployment or — far worse — passes a network mount and *manufactures*
   confidence. What ships instead is a **startup log line naming the resolved
   absolute log path**, so anyone diagnosing a stall can see immediately where
   the writes are going. The requirement is documented and the path is visible;
   neither is dressed up as a guarantee.

   **Narrowed to a hard rollout constraint (round-32, codex — "good enough for
   one machine" is not a pattern that should spread).** Fleet default-on is
   valid **only** where the log path resolves inside the application's own local
   data directory. An operator-configured arbitrary path is supported for this
   machine's opt-in fix, but it disqualifies a machine from the fleet default —
   because the residual being accepted here is acceptable in proportion to how
   well the storage is known, and an arbitrary path is by definition not known.
   That turns a soft requirement into a rollout precondition, which is the only
   form of it that survives contact with other machines.

   **Plus MAX latency, not only p99 (round-31, codex; round-31, gemini reached
   the same place from the other direction).** A p99 is the wrong statistic for
   this failure: the stall being guarded against is a *single* pathological
   append, and one sample in a thousand does not move a p99 at all. So the
   sampler records **max append latency per window**, and a single append above a
   high threshold (**1 s**) raises an immediate Attention item naming the log
   path. It still cannot prevent the stall — nothing available can — but it turns
   "delivery mysteriously froze" into "the message log took 4 seconds to write, on
   this path", which is the difference between an hour of confusion and a
   one-line diagnosis. Detection where prevention is unavailable is not a
   consolation prize; it is the honest control for this class.

   **An out-of-process writer was proposed and is not adopted (round-35,
   gemini).** A separate daemon or logging proxy would genuinely solve this: the
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
const r = recordInboundMessage(entry)     // sync plain INSERT, never throws;
                                          // counts inbound-log-failed itself
if (r.status === 'appended') {
  scheduleInboundTopicMemory(entry)       // setImmediate; sheds -> inbound-search-index-dropped,
}                                         // throws  -> inbound-search-index-failed
inject(...)                               // ALWAYS reached
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
| `recordInboundMessage(entry)` | Synchronous plain `INSERT` in a transaction (never `OR IGNORE` — it would classify every constraint failure as a duplicate). **Never throws.** Returns `{ status: 'appended' \| 'duplicate' \| 'failed' }`. A `'failed'` result has already been caught internally and counted as `inbound-log-failed`. |
| `scheduleInboundTopicMemory(entry)` | Returns immediately. Honours the backlog cap. Performs no dedupe of its own — it is called **only** on `status: 'appended'`, so the upstream check has already gated it. |

**Three outcomes, not two (round-31, codex).** A bare boolean collapsed
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

**One contract, not two (round-30, codex).** The round-29 contract table said
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

**This requires the logger to split its phases (round-20, codex).**
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
  **What this protects, stated exactly (round-8, codex):** *this* injection never
  awaits the TopicMemory write, so *this* message is never delayed **by that
  write**. It does **not** make a
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
- A failure is caught and counted (`inbound-search-index-failed` — **not** `inbound-log-failed`, which §3.0 reserves for the authoritative append; round-38, codex, and the third time a counter name has drifted between the contract and the prose). **No retry** — a retry
  is a loop, a loop needs brakes, brakes need a breaker, and that is exactly the
  subsystem this paragraph deleted twice. A best-effort log does not earn it.
- **No *application-level* queue, worker or retry — and the precision matters
  (round-16, codex).** `setImmediate` callbacks *are* queued work; they sit in
  Node's event loop rather than in a subsystem this design owns. Saying "no queue"
  flatly would mislead an implementer. What is true: **no persistent queue, no
  worker, no retry** — and, since round 17, the backlog is **bounded at 16** by
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
  **TopicMemory write** is dropped and counted (`inbound-search-index-dropped`) instead of
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
- **General event-loop congestion is a silent third cause, acknowledged
  (round-24, gemini).** The backlog counter sees *this feature's* pending writes.
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
  fired at all — round-26, codex),
  the early warning) and `inbound-search-index-dropped` (the bound actually firing). The
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

---

> **NORMATIVE AGAIN FROM HERE.** §3.3 (rollout + acceptance), §4 (honest limits)
> and §5 (test plan) are part of the contract.

---

### 3.3 Rollout

`messaging.inboundSeamLogging.enabled`, with an emergency disable.

**"Code landed" is NOT "bug fixed" (round-27, codex — the strongest finding in
the review, and it lands).** This spec opens by calling the defect unrecoverable
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

**And "on" has to stay on — verified, not assumed (round-32, codex, and this is
the finding most likely to actually bite).** The realistic failure is not that
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

**That pair detects total regression and nothing subtler (round-34, codex — a
health signal that only catches the loudest failure invites confidence it has not
earned).** It cannot see partial loss, TopicMemory
drops, or two processes writing the same file. So the health surface reports
four more things, each cheap and each already computed elsewhere in this design:
**insert failures**, **max insert latency**, **store readiness** (DB writable,
WAL mode confirmed, `busy_timeout` set, row count), and a **startup self-check**
that inserts a non-user row, reads it back, and **rolls back**. *(Round-52: this list
still named rotation state, which the SQLite design has no concept of.)* The self-check is the one that turns "the flag
says on" into "the path works right now" — it exercises append, dedupe and read
on the real configured path, at the moment the process starts, without waiting
for a real message to prove it. **The probe is rolled back, so nothing is written
and there is nothing to exclude from history reads.**

**A startup self-check proves the path once, not continuously (round-35,
codex).** It cannot see a permission change, a path change, a filled disk, or a
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

**Default-on is EARNED by explicit thresholds, not by a release count
(round-17, tightened round-19 — "default-off for exactly one release" was an
unresolved decision written as though it were closed; if the numbers come back
bad, "exactly one release" cannot hold).** The flag ships **default-off**, and
flips to default-on when **all of these hold** (round-72: it said "all three" while the table has since grown past three — a count that silently goes stale is worse than no count), measured on real hardware
and recorded here:

| Gate | Threshold |
|---|---|
| Loop delay added by a 200-message burst, healthy store | **< 250 ms** total |
| **`/health` still answers while inserts contend** (round-65) | **< 1 s** response, sustained |
| Loop delay, contended/wedged store | **< 2 s** total |
| `inbound-search-index-dropped` during the burst | **0** on a healthy store |
| **Slow `fsync`** (injected delay) | `/health` < 1 s, injection still proceeds |
| **Nearly-full / full disk** | insert returns `failed`, counted, **injection still proceeds** |
| **WAL checkpoint pause** | `/health` < 1 s, unrelated conversations unaffected |
| **Filter-driver / network-volume latency** (simulated) | `/health` < 1 s, injection still proceeds |
| **PRIVACY (round-71 — this belongs in the gate table, not only in §4)** | fleet default is `captureBody: false`, **or** the store is encrypted |

*(These four were reported as added at round 67 and were not: the batched edit
that introduced them aborted on a later assertion and wrote nothing. Caught at
round 70 when the reviewer said they were missing. Third time tonight that
batching edits has silently discarded work — and the first time it also produced
a false progress report.)*

If any gate fails, the flip does not happen and the design is revisited — the
gate is the decision, not the calendar.

**One machine's numbers cannot earn a fleet default (round-40, codex).** The
gates below are measured on the development agent's machine, and synchronous
filesystem behaviour is exactly the thing that does not generalise: local disks,
antivirus filter drivers, network-mounted home directories, container volumes and
nearly-full disks all differ. Measuring one laptop and flipping a fleet default
would be reasoning from a sample of one about the property most sensitive to
environment.

So the gates are **scoped to the affected machine's opt-in**, and fleet default-on
additionally requires a **staged rollout with per-host append-latency and
failure-rate health** (the numbers §3.0 already reports) across a meaningful set
of hosts. If that staged evidence is never gathered, the correct outcome is that
the fleet default never flips — not that it flips on one machine's numbers.

**Who measures, and what changes (round-26, codex — "flips when gates hold" named
no owner, and default-off preserves the known data-loss bug, so a rollout nobody
owns is the bug persisting by default).** The benchmark is a committed test
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
**stale numbers (round-54): TopicMemory's own connection uses `busy_timeout = 5000`, but this design opens its OWN connection at `100 ms` and caps the secondary backlog at 16 — the five-second-behind-an-unbounded-backlog figure described a shape this contract no longer has, and quoting it would have made the benchmark gates meaningless.** The real shape is not a place to
assume. One release is a small price for a measured answer. Not dark-shipped: it restores a recording that the system already
intends to perform and already performs on one path, and every day it is off is
another day of unrecoverable conversation. The lever exists for one reason — if
the write turns out to be hot on some install, the operator can stop it without
waiting for a release.

## 4. Honest limits

### 4.0 Privacy posture (round-34, codex)

The design retains the full plaintext of every message a person sends the agent.
Thirty-three rounds discussed atomicity, latency and dedupe keys before anyone
asked what that means for the person doing the typing. Stated plainly, chosen
rather than defaulted:

| | |
|---|---|
| **What is stored** | Full message text, sender display name, sender platform id, timestamps. |
| **Where** **(A)** | An app-controlled local data directory on one machine. Never transmitted, never replicated to other machines by this design. |
| **File permissions** | The database file's existing mode (**0600**), owned by the agent process user. Anyone with root or that user's account can read it. |
| **Default capture is a PRODUCT decision, not a rollout knob (round-75)** | Shipping `captureBody: true` by default means every install that enables this stores the full plaintext of everything anyone types to that agent. Defensible for an operator's own conversation; much less so for third parties — which is why the fleet gate requires the default to flip. Stated here, not only in the rollout section, because someone deciding whether to enable this on ONE machine is making the same decision at smaller scale. |
| **Metadata-only mode** | **Available from day one, not deferred to fleet rollout (round-60). And the DEFAULT is a product decision, not a rollout knob (round-75):** shipping `captureBody: true` by default means every install that enables this stores full plaintext of everything anyone types to that agent. That is defensible for an operator's own conversation and much less so for third parties — which is why the fleet gate requires the default to flip. Naming it here rather than only in the rollout section, because a reader deciding whether to enable this on ONE machine is making the same decision at smaller scale. |
| **Metadata-only mechanics** | **Available from day one.** `messaging.inboundSeamLogging.captureBody: false` records everything except `text` — identity, timing, topic, dedupe id — which still answers "was I sent something here?" and still powers reconciliation and the one-sided check, without storing a word of what anyone said. It does **not** fix session-resume reading, which is the feature's actual purpose; but an operator whose agent takes third-party messages should not have to choose between living with the bug and capturing full plaintext. **It suppresses the TopicMemory index write entirely (round-62): TopicMemory stores text, so scheduling it would leave plaintext on disk under a flag named metadata-only — a false name on a privacy control, which is worse than not offering one.** The cost is stated: with `captureBody: false` those messages are not searchable, because not storing the words and searching the words are the same decision. Default: body capture ON, because the operator's own conversation is the primary case. |
| **Encryption at rest** | **None** today, with a trigger rather than a permanent stance (round-44 — this is data minimisation, not a safety fence, and "we measured latency" is an underpowered reason to keep full message text in plaintext). **Before fleet default-on: the fleet default becomes `captureBody: false`, OR the store is encrypted.** (Round-66 caught the previous wording — "either capture becomes configurable or the store is encrypted" — as a gate already satisfied on the day it was written, since metadata-only capture is configurable *now* while the default stays `true`. A gate whose condition is already true gates nothing.) The point is to reduce plaintext on machines the operator did not individually decide about, so the gate must change a **default**, not confirm an option exists. The opt-in single-machine fix ships as-is; the fleet does not inherit the plaintext default by silence. |
| **Encryption rationale** | **None currently.** Disk-level encryption (FileVault) is the only protection, and it protects a powered-off machine, not a running one. |
| **Redaction** | None. Secrets pasted into a message are stored verbatim — which is one more reason Secret Drop exists and pasting credentials into chat does not. |
| **Retention** | Row-based plus a per-row text cap (§3.0): oldest rows deleted beyond a 200 000-row keep, daily; each row's stored text capped at 65 536 UTF-8 bytes. Not time-based. |
| **Deletion** | `DELETE FROM inbound_messages` (or drop the table). **This deletes THIS store only** — message text also reaches TopicMemory, which has its own delete path, and neither covers filesystem snapshots or any backup system. Any user-facing deletion instruction must say all three, because "delete the log files" will otherwise be read as "delete what I said to you" (round-39). |
| **Export** | No dedicated export. The table is readable with any SQLite client. |
| **Disclosure** **(A)** | **Blocking acceptance gate, with an owner and an artifact — not a config note (round-49).** Before the FIRST enablement on any machine: (1) a release-note entry, and (2) an operator-visible config description, both stating what is stored, where, that it is unencrypted, the retention bound, and that deletion covers the `inbound_messages` table only (TopicMemory's own rows and any backups are separate). **Owner: the implementing agent; artifact: both texts linked from the acceptance record; enablement is blocked until they exist.** **End-user notice beyond the operator is NOT ENFORCED BY THIS FEATURE** — a statement about what the code does, **not** a conclusion that none is required (round-55 found the old "explicitly NOT required" phrasing still here after §3.0 was corrected at round-53: another partial sweep). **Where an agent receives messages from third parties, whatever notice or legal obligation applies to those people is external to this software and the operator's to meet** — this spec has no standing to decide it, and says so instead of implying it is handled. |


**Encryption at rest was considered and not adopted**, deliberately rather than
by omission: the vault exists for secrets and this is not a secret store, the
essential write is on the delivery path where per-message crypto is real latency,
and a key that lives on the same disk as the data protects against a narrow
threat. That reasoning is stated so it can be *disagreed with* — if the answer
should be different, this is the paragraph to argue with rather than a gap to
discover later.


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

## 4.9 Retention rationale (not part of the contract)

**Retention, growth and what is actually being stored (round-33, codex — thirty-
two rounds went by without anyone, me included, asking how big this file gets or
how long it keeps people's messages).** The design writes the **full text of every
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

*Rewritten wholesale for the SQLite design (round-54). Three successive grep-based
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
- **Retention keeps exactly the newest N** and deletes the rest.
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
twice is stored TWICE, asserted as such (round-55).** A per-injection UUID cannot
dedupe across two delivery paths; claiming otherwise was a logical impossibility
sitting in the acceptance criteria. Cross-path dedupe covers platform-id messages
only, which is every Telegram-originated message; the id-less callers are
server-internal paths that do not double-deliver — **which is a local invariant an
outside reader cannot verify, so it is discharged rather than asserted (round-65):
the four callers are enumerated in §2 with file and line, and the architectural
fitness test's allowlist fixture IS that inventory, failing the build if a fifth
appears.** If a future caller can replay, the seam contract requires it to pass a
stable envelope id — the mechanism already exists, it is the `dedupe_id` argument,
and nothing prevents an internal caller supplying one. Narrowed rather than papered
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
`busy_timeout` is set, and an insert/read/rollback round-trip passes — i.e.
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
   detected out-of-process, and if any named gate in §3.3 fails (contended p99 > 250 ms, max > 1 s, `/health` > 1 s under contention, or any pathological case), the
   queue is the documented fallback chosen on those numbers.

   **That comparison strawmanned the alternative, and the correction matters
   (round-57).** "Durable queue" was weighed as *in-memory* enqueue, which does
   lose data on crash. The real industry pattern is a **durable outbox** — a
   synchronous write to durable storage, drained asynchronously by a worker.
   Weighed honestly: **that pattern is what this design already is.** The
   synchronous `INSERT` *is* the durable outbox write; `scheduleInboundTopicMemory`
   *is* the async drain. A separate outbox subsystem would add a second table, a
   worker and drain-state bookkeeping **without removing the stall, because the
   durable write is synchronous in both designs.**

   **That conclusion was ALSO wrong — second correction to this decision
   (round-59).** I wrote that the stall "lives in the requirement, not the
   implementation". False. Durability-before-injection is only synchronous *on the
   main thread*. A **worker-owned SQLite connection**, or an async binding, can
   wait for the commit before injecting while **yielding the Node event loop** —
   preserving the guarantee exactly and removing the whole-process stall. Standard
   practice, not exotic.

   **So the honest justification for main-thread `better-sqlite3` is far smaller
   than the argument I built around it:** it is already the dependency, already the
   pattern `TopicMemory` uses, and it is one call rather than a worker, a message
   protocol and a lifecycle. A **simplicity argument for a single-agent local
   fix** — not a claim the alternative is impossible.

   **The residual is therefore worse than previously stated:** a wedged device
   stalls every conversation on the machine, and that is the price of the simpler
   implementation, **not an unavoidable cost of the guarantee**. If the hostile
   benchmark shows it dominates, the worker-owned connection is the fix and it
   costs no durability. I twice constructed reasons why no better option existed;
   both times the reviewer found one.

1. **Log at the seam, not at each caller** — **four** callers today (§2), three of
   which pass no `messageId`. Logging per-caller would mean four correct
   implementations and a fifth silently reintroducing the gap.
2. **Commit the INSERT before injecting; schedule the index write after** (§3.1) — two
   writes, two rules. Named this way after three rounds of reviewers reading "log first" as a
   synchronous call, which is exactly how it would be mis-implemented.
3. **A logging *error* never intentionally aborts the message** (§3.2) — phrased
   this way because the stronger "never blocks delivery" is false and kept
   surviving folds in summary form (round-34, codex, catching it here after §3.2
   itself had been corrected). A synchronous storage **stall** can delay or
   prevent delivery; only the *error path* is guaranteed. The distinction is the
   whole of §3.2's accepted residual, and a summary that erases it re-tells the
   comfortable version.
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
11. **The SECONDARY SEARCH-INDEX write is fire-and-forget on the next tick, with no retry** (§3.2) — **not the essential write, which is synchronous, pre-injection, and retried up to 3 times (round-61: this said "the write" in a section about persistence, directly contradicting the contract)** — a
    retry is a loop, a loop needs brakes, and a best-effort received-log does not
    earn that machinery.

## Open questions (§8)

**No implementation blockers. Four MATERIAL PRODUCT questions remain open, and
calling them "residuals" understated them (round-71):**

1. **Cross-machine history** — each machine records only what it saw. A merged
   view is not designed here.
2. **Pre-seam loss** — messages dropped before the injection seam stay invisible;
   ACT-1217 (find the real intake edge) blocks fleet default-on.
3. **Partial-loss detection** — reconciliation is deferred (ACT-1222), so the
   shipped detectors see total regression in a topic, not partial loss.
4. **Encryption at rest** — plaintext today; a fleet gate, not a solved problem.

These do not block building Increment A. They are decisions someone has to make
before this is more than a one-machine fix, and they should be read as such
rather than as footnotes.


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
