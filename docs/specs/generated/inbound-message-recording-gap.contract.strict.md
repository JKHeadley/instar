<!-- GENERATED FILE — DO NOT EDIT.
     Source: docs/specs/inbound-message-recording-gap.md
     Regenerate: node scripts/generate-spec-contract.mjs --spec docs/specs/inbound-message-recording-gap.md --strict
     STRICT IMPLEMENTATION CONTRACT: allowlisted contract sections only.

     Everything not on the allowlist is ABSENT BY DEFAULT — including all
     rationale. This file says WHAT to build, never why. Read the source
     spec for the reasoning, the alternatives, and the accepted residuals
     in their full form.
     (7 residual "round-N" reference(s) remain inline.)
-->
---
title: "Record inbound messages at the injection seam (best-effort, with first-loss alerting)"
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
### 3.0 Final contract

#### Normative checklist (build from this; everything after it is elaboration)

**Config keys**
- `messaging.inboundSeamLogging.enabled` — default `false`
- `messaging.inboundSeamLogging.captureBody` — default `true`
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
 text_truncated INTEGER NOT NULL DEFAULT 0,
 sender_name TEXT,
 telegram_user_id INTEGER,
 message_id INTEGER,
 id_source TEXT NOT NULL CHECK(id_source IN ('platform','derived')),
 synthetic INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS inbound_recording_state (
 key TEXT PRIMARY KEY,
 last_failure_at TEXT,
 last_failure_reason TEXT,
 failure_count INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_dedupe ON inbound_messages(dedupe_id);
CREATE INDEX IF NOT EXISTS idx_inbound_topic_seq ON inbound_messages(topic_id, seq);
```

**Arming** — **one migration row covers BOTH tables** (`name = 'inbound_messages'`);
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
 failure**; clears by a state machine with exactly three inputs:

 - **Enter `degraded`:** any failed primary insert, or a durable
 `inbound_recording_state` row found at arm time.
 - **Start the clear timer:** a **successful primary insert** — nothing else.
 - **Clear:** 60 s elapsed since the last failure, checked on each successful
 insert — so on a low-traffic machine the **first** success arriving after
 that window clears immediately, rather than waiting for a second one. **And
 clearing DELETES the durable `inbound_recording_state` row in the same
 transaction as the next successful insert**.

 **If that delete fails, the WHOLE transaction rolls back: the
 insert returns `failed` and the state stays `degraded`.** Committing the
 message while failing to clear the alarm leaves a permanently-degraded
 machine that is actually fine; committing the clear while losing the message
 is worse. Rolling both back costs one message the retry may recover, keeps
 the two consistent, and is honest — a state table that cannot be written is
 itself a reason to be degraded.

 **The invariant, weakened to what is actually true:**
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

**Retention** — daily; cutoff via `ORDER BY seq DESC LIMIT 1 OFFSET:keep`; delete
`WHERE seq IN (SELECT seq … LIMIT 1000)` in batches with yields; keep 200 000 rows;
cap stored text at **65 536 UTF-8 bytes, truncated on a character boundary** (never mid-sequence, so the stored value is always valid UTF-8); abort if an insert failed or p99 exceeded the gate in the
last 5 minutes.

**Health** — `recording`, `enabled`, `armed` (+reason), `lastArmAttemptAt/Result`,
`rowCountTotal`, `rowCountUserVisible`, `dbFileBytes`, `walFileBytes`, insert
failures, max latency, self-check result, last retention run, loop-tick counter.

**Latency thresholds — one window, three DIFFERENT consumers, named separately:**

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
depend on it: a **5-minute sliding window** of primary-insert
durations, **excluding synthetic self-check inserts** (not user traffic, and
including them would flatter the numbers), reset only by process restart,
exported as p50 / p99 / max. "p99 exceeded the gate in the last 5 minutes" and
"max latency" both read that one window. Unpinned, one implementer's retention
never runs and another's runs during a stall.

**Counters** — process-local and monotonic, **plus a DURABLE last-failure record** in its own table:
`CREATE TABLE IF NOT EXISTS inbound_recording_state (key TEXT PRIMARY KEY,
last_failure_at TEXT, last_failure_reason TEXT, failure_count INTEGER NOT NULL
DEFAULT 0)`, one row keyed `'default'`, upserted on failure (count incremented,
timestamp and reason overwritten).

**It can fail for exactly the same reasons as the write it records.** Disk full, read-only database, wedged SQLite,
lost permissions: the recorder lives in the same database as the failure. The
ladder is therefore stated rather than assumed: **(1) in-memory
`recording: 'degraded'` is set FIRST and needs no storage at all — it is what
`/health` reports, and `/health` is what the external watchdog reads; (2) the
durable row is written best-effort, its own failure counted, never retried, never
fatal; (3) an Attention item is attempted.** **Named residual: a crash between
the failed insert and the durable write loses the first-loss marker across that
restart.** In-memory covers the common case, the row covers restarts, neither
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
| **Store** | A **new SQLite table**, `inbound_messages`, in the agent's existing database. **Schema migration is required; DATA migration is not.** The DDL is idempotent `CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS`, run at arm time. **DDL success is not schema validation** — `IF NOT EXISTS` silently accepts a pre-existing table with wrong columns, constraints or index shape. Arming therefore VALIDATES: **a feature-local migration row** equals this build's expected schema version — **`version = 1` for the schema in this document, bumped on ANY change to a column, index, or probe shape** — `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, version INTEGER NOT NULL)`, this feature's row keyed `'inbound_messages'`. **The migrations table gets the same validation as the data table, and table creation, index creation and the migration row are committed in ONE transaction** so a crash cannot leave a version claiming a schema that was never created — **not `PRAGMA user_version`, which is database-GLOBAL: `TopicMemory` shares this database, so claiming that pragma would either falsely fail arming or overwrite another component's migration state**; **`PRAGMA table_info`** shows every expected column, compared on **normalised type affinity rather than raw string equality** — extra columns tolerated, missing ones not. **Trigger/constraint detection uses the stable surfaces, not SQL-text parsing.** Triggers: `SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='inbound_messages'` — an existence query, no parsing. Everything else is covered by **representative insert probes** rather than by reading DDL: the synthetic round-trip is extended to exercise the realistic row shapes (body captured and not, `message_id` present and NULL, truncated and not), so a stricter `CHECK` or a generated column is caught by the insert failing rather than by a regex on schema text. **The probe set is enumerated rather than left to judgment:** (a) body captured with a platform id; (b) body captured, `message_id` NULL, `id_source='derived'`; (c) `body_captured = 0` with `text` NULL; (d) text at the 65 536-byte cap with `text_truncated = 1`; (e) `synthetic = 1`. **Probes run inside a transaction that is ALWAYS rolled back: they must not commit, because a committed probe row is a synthetic row, synthetic rows count toward retention and `rowCountTotal`, and arming retries every 60 s — so committing probes would let a machine that cannot arm slowly fill its own store with evidence of failing to arm.** **Representative, not exhaustive** — probes cannot prove every future valid row stays valid — so this is stated as coverage of the shapes this design actually writes, and any shape added later must add its probe — an existing table can pass a column-and-index check and still reject inserts because of a trigger or a stricter CHECK, and the synthetic round-trip only exercises one row shape. Unsupported extras refuse to arm rather than being worked around; **`PRAGMA index_list`/`index_info`** shows a UNIQUE index on `dedupe_id` alone; **`PRAGMA journal_mode`** reports `wal` — **set and verified OUTSIDE the schema transaction**; and a **synthetic insert/read round-trip** passes. **When validation fails, the operator needs a path, not just a refusal.** `armed: false` naming the difference is the signal; the artifact is a **written repair note in the arm-failure log** giving the expected schema, the actual schema, and the exact SQL to reconcile them. **With the three things a hand-run migration needs and my first version omitted: (1) BACK UP the database file first, with the exact `cp` command and the path; (2) the statements are ordered and each is individually reversible, or the note says plainly which are not; (3) after running them, restart and confirm `armed: true` — do not assume.** The operator runs it, or does not, having read that. The code still never runs it: refusing to auto-`ALTER` is the safety property, and handing over the statement is not the same as executing it. Without that note the refusal is a dead end, and a dead end on the arming path means the bug stays unfixed for whoever hits it.

**Full arming algorithm**:

1. Open the database; set/verify `PRAGMA journal_mode = WAL` **outside any transaction**.
2. `BEGIN`.
3. Create/validate the **`schema_migrations` table shape** itself.
4. Read this feature's row (`name = 'inbound_messages'`).
 **Every branch covers BOTH tables and all indexes** — `inbound_messages` with
 its unique and topic indexes, **and `inbound_recording_state`**.

 - **Row absent** → first install: create **both tables and both indexes**, validate the resulting schema of **both**, then **INSERT** the row.
 - **Row present and equal to this build's version** → validate the existing schema of **both**; **do not write**.
 - **Row present and older** → apply the ordered migration, validate **both**, then **UPDATE** the row.
 - **Row present and NEWER than this build** → refuse to arm. A downgrade must never rewrite a schema it does not understand.
5. `COMMIT` — or `ROLLBACK` and `armed: false`, naming the difference, on any validation failure.

Validation always runs against the **actual resulting schema**, never against what the DDL intended, so a pre-existing wrong table fails identically whether this build created it or not.

**Exact ordering, because "create, validate, and commit atomically" is ambiguous about which happens first:** BEGIN → create table/index `IF NOT EXISTS` → **validate the ACTUAL resulting schema** (the pragmas above) → **only if validation passes**, write/update the migration row → COMMIT. Validation runs against what is really there, never against what the DDL intended, so a pre-existing wrong table fails the same way whether this build created it or not; and the migration row can never claim a schema that was not validated, because it is written after the check and inside the same transaction. **Any mismatch means ROLLBACK and `armed: false` naming the specific difference** — never a silent degrade, and **never an automatic `ALTER`**: repairing a schema this design did not create is how a careful guard destroys someone else's data. No existing row is read, moved, backfilled or rewritten. `better-sqlite3` is already a dependency and `TopicMemory` already opens it (`src/memory/TopicMemory.ts:154`). WAL mode, `busy_timeout = 100 ms`. |
| **Schema** | `seq INTEGER PRIMARY KEY AUTOINCREMENT`, `from_user INTEGER NOT NULL DEFAULT 1`, `dedupe_id TEXT NOT NULL UNIQUE`, `topic_id INTEGER NOT NULL`, `seam_received_at TEXT NOT NULL`, `text TEXT` (**nullable** — `NULL` when `body_captured = 0`; round-61 caught metadata-only mode contradicting a `NOT NULL` column), `body_captured INTEGER NOT NULL DEFAULT 1`, `sender_name TEXT`, `telegram_user_id INTEGER`, `message_id INTEGER` (nullable — no `-1` placeholder is needed), `id_source TEXT NOT NULL CHECK(id_source IN ('platform','derived'))`, `synthetic INTEGER NOT NULL DEFAULT 0`, `text_truncated INTEGER NOT NULL DEFAULT 0`. |
| **Write** | **Plain `INSERT` inside a transaction — NOT `INSERT OR IGNORE`.** `OR IGNORE` suppresses *every* constraint violation, so a `NOT NULL` breach, a `CHECK` failure, a trigger side effect or a bad binding all return zero changes and would have been classified `'duplicate'` — reported as the system working correctly while the message was gone. Instead: catch the error, and classify **only a UNIQUE violation on `dedupe_id`** as `'duplicate'`; **every other constraint failure is `'failed'`**, which counts, degrades, and alerts. Synchronously, **before** injection. **Bounded retry: up to 3 attempts, 0/20/50 ms** — most realistic failures here are a transient busy lock (retention delete, TopicMemory write, WAL checkpoint), and one attempt against a shared database turns ordinary contention into permanent loss. **Worst case is ~370 ms, not 70 ms:** 3 × 100 ms of lock wait + 70 ms of backoff, plus the SQLite work. That is the number the benchmark gates and the max-latency alarm must use; the 70 ms figure would have set both wrong. It is a **worst case reached only under sustained contention** — an uncontended insert is sub-millisecond — but a bound that only holds when nothing goes wrong is not a bound. After 3 attempts it gives up, counts, degrades — **and injection still proceeds.** |
| **What this actually guarantees** | **Best-effort recording with first-loss alerting — NOT guaranteed recording.** A record that cannot be written after retries is dropped, and the message is still delivered. The alternative — blocking delivery until the write succeeds — is rejected outright: making a person unreachable to protect a log inverts the priority. So the honest statement of what changes is: **loss goes from silent and undetected for 24 days, to alerted on the first occurrence with the message still delivered.** That is a large improvement and it is not the same thing as "no loss", and the difference is stated here because every other section is written as if recording succeeds. | Returns `'appended' \| 'duplicate' \| 'failed'` from `changes` and the error path. **Never throws** — a `'failed'` result is caught internally and counted. |
| **Dedupe** | **Storage-enforced for platform-identified messages; id-less messages are intentionally NOT deduped.** **Caller inventory, stated HERE because the strict contract excludes §2 and an outside implementer cannot otherwise verify the non-replay invariant they are asked to accept:** `src/server/routes.ts:20323` passes a platform id; `src/commands/server.ts` at 2763, 2985 and 20711 do not, and those three are server-internal and are **not known to replay — which is weaker than "cannot".** The consequence is bounded: an id-less replay produces a **duplicate row**, never a lost message, and a duplicate is visible in the topic history rather than silent. That is the accepted direction — this design trades a possible duplicate for a guaranteed record — but it is an accepted risk, not a proof. **Any new id-less caller must pass a stable envelope id as `dedupe_id`** — the argument already exists — and the fitness-test allowlist fails the build when a fifth caller appears. The `UNIQUE` index on `dedupe_id` is the mechanism, not best-effort — this answers round-51 directly: there is no in-memory set, no seeding, no restart window, and two processes cannot interleave a duplicate through it. `dedupe_id` = `in:telegram:<botId>:<chatId>:<messageId>` when a platform id is present, else `in:derived:<uuid>`. **Fully platform-scoped: Telegram message ids are unique per CHAT, and `topicId` is an instar-side surrogate, so keying on it alone would false-dedupe across a migrated topic, a re-bound topic, or two bots sharing one agent.** The scope now comes from the platform's own identifiers, and `topic_id` remains a column for querying rather than part of identity. |
| **Secondary write** | `scheduleInboundTopicMemory(entry)` via `setImmediate`, only on `'appended'`. Backlog capped at 16; beyond that, drop and count. TopicMemory remains a **lossy search index**, never the record. |
| **Authority** | This table is the **seam-received store** — the name says the whole guarantee. The row is committed **before** injection, so a crash between the two leaves a row for a message no session processed. That is deliberate — a recorded-but-unprocessed message is recoverable, an unrecorded one is not — and it is why the store is not called "delivered". A future `injected_at`, written after a successful injection, is the honest way to add that distinction if a consumer ever needs it; it is not needed now and is not faked now. It is the **primary received-history store**. It is not proof of receipt: a message dropped before the seam never reaches it (§4), and `synchronous: NORMAL` means a power loss can lose the last transaction. Absence of a row is **not** evidence a message was not received. |
| **Indexes + health queries** | `UNIQUE(dedupe_id)` for dedupe; `(topic_id, seq)` for per-topic history and the one-sided check; `synthetic` deliberately **not** indexed (low cardinality, and its queries are already bounded by `seq`). **Every health query is bounded and named:** `rowCountTotal` = `COUNT(*)` (fine at 200k), `rowCountUserVisible` = same with `synthetic = 0`, the one-sided check is `SELECT 1 … WHERE topic_id = ? AND seq > ? LIMIT 1` per active topic rather than a scan, and DB/WAL sizes are `stat()` calls, not queries. Health runs on the existing status cadence, never per request. |
| **Ordering** | `seq INTEGER PRIMARY KEY AUTOINCREMENT`, read `ORDER BY seq`. **Not bare `rowid`: rowid is insertion-ordered in practice but SQLite does not guarantee monotonicity across deletes or a table rebuild, and "monotonic" was a stronger claim than the store makes.** `AUTOINCREMENT` buys the guarantee explicitly, at the cost of one extra table SQLite maintains. |
| **Reading** | `SELECT`. No tolerant parsing, no bounded tail read, no torn-line class, no corruption counting — **none of these failure modes exist for a table**, which is most of why it is the recommendation. |
| **Attention** | The deduped operator alert queue (`POST /attention`). **Cadence:** raised at most once per condition per episode, never per event. **Owner:** the operator. **Actionable:** each item names the condition and the read surface to check; it is not a chat message and does not interrupt a conversation. |
| **One-sided-conversation check** | A periodic query for topics with recent outbound rows and zero inbound rows over the same window. **Cadence:** hourly. **Owner:** the agent, surfacing to the operator via one deduped Attention item. **Actionable:** it names the topic and the window, and means *either* the recording is broken *or* the agent legitimately spoke unprompted — so it reports a suspicion to check, never an assertion of failure. |
| **Coverage evidence** | Three signals that SHIP, ranked honestly, none of them enforcement. **(1) The live call-path trace at acceptance** — proves the seam is on the real path, once, at one moment. **(2) The one-sided-conversation check** — recent outbound with zero inbound rows for a topic. Detects TOTAL regression in a topic and nothing subtler; kept because it needs no cooperation from the sending side and would have caught the original 24-day defect. **(3) The AST fitness test** — a build-time guard against the easy regression, blind to dynamic dispatch, reflection and module boundaries. **Reconciliation against the forward route is DEFERRED, not shipped.** It would be the strongest signal — it alone catches partial loss and wrong-topic writes — but it needs a durable, crash-safe, wrap-aware store of observed ids that this spec had waved at rather than specified, and making acceptance depend on an unspecified store is how a check becomes decorative. Tracked as follow-up rather than claimed. <!-- tracked: ACT-1222 --> |
| **Retention** | **Two dimensions.** (1) Keep the newest **200 000 rows**; synthetic rows count toward the bound. (2) Cap stored text at **65 536 UTF-8 bytes per row** (bytes, not characters; truncation lands on a character boundary so the value stays valid UTF-8), longer messages stored truncated with `text_truncated = 1`. Not time-based. **The two caps bound the PAYLOAD, not the store** — SQLite page overhead, the index, WAL growth and free pages after deletes all sit outside them, so `200k x 64KB` is not a filesystem guarantee. `/health` reports **actual DB and WAL file sizes** instead, which is a measured number rather than an inferred one. **Deletion is two-step and batched**, never one statement: `SELECT seq … ORDER BY seq DESC LIMIT 1 OFFSET:keep` for the cutoff, then `DELETE FROM inbound_messages WHERE seq IN (SELECT seq FROM inbound_messages WHERE seq <=:cutoff LIMIT 1000)` repeated with a yield between batches — **the subquery form because `DELETE … LIMIT` requires SQLite compiled with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`, which is not guaranteed**, reporting rows deleted and per-batch latency. Daily. A single large DELETE would take locks on the same database the synchronous insert uses. **Retention YIELDS to recording: it does not start, and aborts between batches, if there has been an insert failure or a p99 above the latency gate in the last 5 minutes** — recording is the point of the feature and cleanup is housekeeping, so under contention the housekeeping loses. Last retention run time, duration, rows deleted and abort reason are on `/health`. Deleted rows free pages for reuse; **no `VACUUM`** — returning disk to the OS is not worth an exclusive lock on the delivery path's database. |
| **Single writer** | SQLite serialises writers; it does **not** guarantee this write completes within `busy_timeout`. The realistic contenders on this shared database are the retention delete, TopicMemory's own writes, and WAL checkpoints. Mitigations, in order: retention runs in **small batches with yields** (§Retention) so it never holds a long write lock; the seam uses its **own connection** with `busy_timeout = 100 ms`; and the **bounded retry** above covers the residual contention. **No lock file, no boot-id, no stale-reclaim rule, no filesystem allowlist.** Injection never waits on lock acquisition beyond the retry budget. |
| **`enabled` vs `armed`** | `enabled` = the config flag (configuration only, never the logging predicate). `armed` = enabled **and** the table opened writable. Arming is attempted at startup and **retried in the background** (60s, backoff to 15m), outside the per-message path. While unarmed the seam call is a no-op, incrementing `inbound-log-arm-failed` once per process and `inbound-messages-skipped-unarmed` per message. **Acceptance FAILS if `armed` is false.** |
| **Failure behavior** | A failed insert is caught, counted, and **injection proceeds**. A failed secondary write is caught and counted. |
| **Degraded state** | **Failure is a STATE, not a count, and it engages on the FIRST failed insert.** Counters alone are how this bug survived 24 days: relying on someone noticing a metric is monitoring discipline, and monitoring discipline is what failed. A threshold of "10 consecutive failures" would permanently lose up to nine messages before saying anything — ordinary alert-noise tuning applied where each event IS the harm. **One failed insert sets `recording: 'degraded'` immediately**; it clears after 60 s with no further failures. `recording` is a first-class `/health` field (`ok` | `degraded` | `off`) that the out-of-process watchdog already polls and can act on **without Attention delivery working at all**. Noise is managed at the notification layer — Attention dedupes and backs off — never by staying silent about the first losses. |
| **Why `/health` and not Attention** | Every other mitigation here leans on the Attention queue, whose reliability and persistence this spec does not own and cannot assert. `/health` is a synchronous read of local state by an external poller — no queue, no delivery, no dedupe window. **Anything load-bearing is expressed there**; Attention carries the human-readable version. |
| **Counters** | `inbound-log-failed` (the authoritative insert failed), `inbound-search-index-dropped` (shed by the backlog cap), `inbound-search-index-failed` (attempted and threw), `inbound-log-arm-failed` (once per process), `inbound-messages-skipped-unarmed` (per message), insert-latency histogram. All monotonic within a process; `topic_id` is the only label. |
| **Latency** | Attention on p99 > 50 ms **and** on any single insert > 1 s. **Operational bound with an ACTION, corrected: the primary signal is `/health` NOT ANSWERING, not a frozen counter in an answer.** A wedged event loop cannot serve the request at all, so the round-47 loop-tick counter — added to fix exactly this circularity — is *itself* unreachable in the failure it exists for. That is the same circular mistake twice, one layer deeper. So the watchdog treats **no `/health` response within 30 s** as the wedge signal (which its existing timeout already produces), and the loop-tick counter is the *weaker, secondary* case: a response that arrives with a frozen tick means partially-degraded rather than wedged. Either way it escalates through its existing path — the same treatment any hung server gets. This design does not add a new recovery mechanism; it makes sure the existing one can see this failure. A wedged device can still block the event loop; that residual is named below and detected **out-of-process** via the loop-tick counter on `/health`. |
| **Health** | `recording` (`ok`/`degraded`/`off`), `enabled`, `armed` (+ reason, naming any schema-validation mismatch), `lastArmAttemptAt` / `lastArmResult`, **`rowCountTotal`, `rowCountUserVisible`, and measured `dbFileBytes` / `walFileBytes`** — both, because synthetic rows count toward retention but not toward the user-visible count, and reporting one number would make the store look smaller than the pressure on it — insert failures, max latency, the startup synthetic self-check result, a monotonic loop-tick counter, and the one-sided-conversation check (recent outbound with zero inbound). |
| **Synthetic rows** | `synthetic = 1`. Excluded from **history reads**, from **`rowCountUserVisible`**, and from the **one-sided check**. **Included** in `rowCountTotal` and in retention. |
| **Privacy** | Message text stored **unencrypted** in the agent's database, file mode 0600. Deleting rows removes them from this store only; TopicMemory and any backups are separate. No redaction — a credential pasted into chat is stored verbatim. |
| **Disclosure** | **Blocking gate before the first enablement on any machine**: a release-note entry and an operator-visible config description, both stating what is stored, where, that it is unencrypted, the retention bound, and that deletion covers this store only. Owner: the implementing agent; both texts linked from the acceptance record. End-user notice beyond the operator is **not enforced by this feature** — which is a statement about what the code does, **not** a claim that none is required. The config description therefore carries an explicit operator warning: **inbound third-party messages are stored verbatim, and any notice or legal obligation toward those people is external to this software and yours to meet.** |
| **Flag** | `messaging.inboundSeamLogging.enabled`, default-off, with emergency disable. |
| **Acceptance** | **Not "code landed".** The flag ON for the affected machine; live Telegram proof (a normal and a long message) **with an instrumented trace of the real call path to the seam**; **a restart, then another message with the row count still increasing**; an id-less seam regression test; `armed: true` confirmed. |
| **Known residuals** | A wedged device can stall delivery (detected out-of-process, not prevented). Messages dropped before the seam are invisible. Message text is stored unencrypted. Three, all named, none mitigated. |

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
flips to default-on when **all of these hold**, measured on real hardware
and recorded here:

| Gate | Threshold |
|---|---|
| Loop delay added by a 200-message burst, healthy store | **< 250 ms** total |
| **`/health` still answers while inserts contend** | **< 1 s** response, sustained |
| Loop delay, contended/wedged store | **< 2 s** total |
| `inbound-search-index-dropped` during the burst | **0** on a healthy store |
| **Slow `fsync`** (injected delay) | `/health` < 1 s, injection still proceeds |
| **Nearly-full / full disk** | insert returns `failed`, counted, **injection still proceeds** |
| **WAL checkpoint pause** | `/health` < 1 s, unrelated conversations unaffected |
| **Filter-driver / network-volume latency** (simulated) | `/health` < 1 s, injection still proceeds |
| **PRIVACY** | fleet default is `captureBody: false`, **or** the store is encrypted |

*(These four were reported as added at round 67 and were not: the batched edit
that introduced them aborted on a later assertion and wrote nothing. Caught at
round 70 when the reviewer said they were missing. Third time tonight that
batching edits has silently discarded work — and the first time it also produced
a false progress report.)*

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
| **Metadata-only mode** | **Available from day one, not deferred to fleet rollout.** `messaging.inboundSeamLogging.captureBody: false` records everything except `text` — identity, timing, topic, dedupe id — which still answers "was I sent something here?" and still powers reconciliation and the one-sided check, without storing a word of what anyone said. It does **not** fix session-resume reading, which is the feature's actual purpose; but an operator whose agent takes third-party messages should not have to choose between living with the bug and capturing full plaintext. **It suppresses the TopicMemory index write entirely: TopicMemory stores text, so scheduling it would leave plaintext on disk under a flag named metadata-only — a false name on a privacy control, which is worse than not offering one.** The cost is stated: with `captureBody: false` those messages are not searchable, because not storing the words and searching the words are the same decision. Default: body capture ON, because the operator's own conversation is the primary case. |
| **Encryption at rest** | **None** today, with a trigger rather than a permanent stance. **Before fleet default-on: the fleet default becomes `captureBody: false`, OR the store is encrypted.** The point is to reduce plaintext on machines the operator did not individually decide about, so the gate must change a **default**, not confirm an option exists. The opt-in single-machine fix ships as-is; the fleet does not inherit the plaintext default by silence. |
| **Encryption rationale** | **None currently.** Disk-level encryption (FileVault) is the only protection, and it protects a powered-off machine, not a running one. |
| **Redaction** | None. Secrets pasted into a message are stored verbatim — which is one more reason Secret Drop exists and pasting credentials into chat does not. |
| **Retention** | Row-based plus a per-row text cap (§3.0): oldest rows deleted beyond a 200 000-row keep, daily; each row's stored text capped at 65 536 UTF-8 bytes. Not time-based. |
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
server-internal paths that do not double-deliver — **which is a local invariant an
outside reader cannot verify, so it is discharged rather than asserted:
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
 detected out-of-process, and if any named gate in §3.3 fails (contended p99 > 250 ms, max > 1 s, `/health` > 1 s under contention, or any pathological case), the
 queue is the documented fallback chosen on those numbers.

 **That comparison strawmanned the alternative, and the correction matters.** "Durable queue" was weighed as *in-memory* enqueue, which does
 lose data on crash. The real industry pattern is a **durable outbox** — a
 synchronous write to durable storage, drained asynchronously by a worker.
 Weighed honestly: **that pattern is what this design already is.** The
 synchronous `INSERT` *is* the durable outbox write; `scheduleInboundTopicMemory`
 *is* the async drain. A separate outbox subsystem would add a second table, a
 worker and drain-state bookkeeping **without removing the stall, because the
 durable write is synchronous in both designs.**

 **That conclusion was ALSO wrong — second correction to this decision.** I wrote that the stall "lives in the requirement, not the
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
11. **The SECONDARY SEARCH-INDEX write is fire-and-forget on the next tick, with no retry** (§3.2) — **not the essential write, which is synchronous, pre-injection, and retried up to 3 times** — a
 retry is a loop, a loop needs brakes, and a best-effort received-log does not
 earn that machinery.

## Open questions (§8)

**No implementation blockers. Four MATERIAL PRODUCT questions remain open, and
calling them "residuals" understated them:**

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
