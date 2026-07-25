<!-- GENERATED FILE — DO NOT EDIT.
     Source: docs/specs/inbound-message-recording-gap.md
     Regenerate: node scripts/generate-spec-contract.mjs --spec docs/specs/inbound-message-recording-gap.md --strict
     STRICT IMPLEMENTATION CONTRACT: allowlisted contract sections only.

     Everything not on the allowlist is ABSENT BY DEFAULT — including all
     rationale. This file says WHAT to build, never why. Read the source
     spec for the reasoning, the alternatives, and the accepted residuals
     in their full form.
     (5 residual "round-N" reference(s) remain inline.)
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
| **Schema** | `seq INTEGER PRIMARY KEY AUTOINCREMENT`, `from_user INTEGER NOT NULL DEFAULT 1`, `dedupe_id TEXT NOT NULL UNIQUE`, `topic_id INTEGER NOT NULL`, `seam_received_at TEXT NOT NULL`, `text TEXT NOT NULL`, `sender_name TEXT`, `telegram_user_id INTEGER`, `message_id INTEGER` (nullable — no `-1` placeholder is needed), `id_source TEXT NOT NULL CHECK(id_source IN ('platform','derived'))`, `delivery_state TEXT NOT NULL DEFAULT 'injection_seam_received'`, `synthetic INTEGER NOT NULL DEFAULT 0`. |
| **Write** | `INSERT OR IGNORE` inside a transaction, synchronously, **before** injection. Returns `'appended' \| 'duplicate' \| 'failed'` from `changes` and the error path. **Never throws** — a `'failed'` result is caught internally and counted. |
| **Dedupe** | The `UNIQUE` index on `dedupe_id`. **Storage-enforced, not best-effort** — this answers round-51 directly: there is no in-memory set, no seeding, no restart window, and two processes cannot interleave a duplicate through it. `dedupe_id` = `in:telegram:<botId>:<chatId>:<messageId>` when a platform id is present, else `in:derived:<uuid>`. **Fully platform-scoped: Telegram message ids are unique per CHAT, and `topicId` is an instar-side surrogate, so keying on it alone would false-dedupe across a migrated topic, a re-bound topic, or two bots sharing one agent.** The scope now comes from the platform's own identifiers, and `topic_id` remains a column for querying rather than part of identity. |
| **Secondary write** | `scheduleInboundTopicMemory(entry)` via `setImmediate`, only on `'appended'`. Backlog capped at 16; beyond that, drop and count. TopicMemory remains a **lossy search index**, never the record. |
| **Authority** | This table is the **primary received-history store**. It is not proof of receipt: a message dropped before the seam never reaches it (§4), and `synchronous: NORMAL` means a power loss can lose the last transaction. Absence of a row is **not** evidence a message was not received. |
| **Ordering** | `seq INTEGER PRIMARY KEY AUTOINCREMENT`, read `ORDER BY seq`. **Not bare `rowid`: rowid is insertion-ordered in practice but SQLite does not guarantee monotonicity across deletes or a table rebuild, and "monotonic" was a stronger claim than the store makes.** `AUTOINCREMENT` buys the guarantee explicitly, at the cost of one extra table SQLite maintains. |
| **Reading** | `SELECT`. No tolerant parsing, no bounded tail read, no torn-line class, no corruption counting — **none of these failure modes exist for a table**, which is most of why it is the recommendation. |
| **Attention** | The deduped operator alert queue (`POST /attention`). **Cadence:** raised at most once per condition per episode, never per event. **Owner:** the operator. **Actionable:** each item names the condition and the read surface to check; it is not a chat message and does not interrupt a conversation. |
| **One-sided-conversation check** | A periodic query for topics with recent outbound rows and zero inbound rows over the same window. **Cadence:** hourly. **Owner:** the agent, surfacing to the operator via one deduped Attention item. **Actionable:** it names the topic and the window, and means *either* the recording is broken *or* the agent legitimately spoke unprompted — so it reports a suspicion to check, never an assertion of failure. |
| **Coverage evidence** | The AST fitness test is a build-time guard, **not** proof of coverage. **The primary production evidence that the seam is on the real path is (1) the live Telegram call-path trace at acceptance and (2) the ongoing one-sided-conversation check** — recent outbound in a topic with zero inbound rows. Round-52 is right that dynamic and import-boundary bypasses stay plausible; the one-sided check is what would catch one *in production*, without knowing where it is, and is therefore the load-bearing detector rather than a nice-to-have. |
| **Retention** | **Two-step and batched, never one big statement (round-55: a daily `DELETE … NOT IN (SELECT … LIMIT:keep)` over a growing table takes locks on the same database the synchronous insert uses — self-inflicting the exact stall this design treats as its main residual).** Step 1: `SELECT seq FROM inbound_messages ORDER BY seq DESC LIMIT 1 OFFSET:keep` to find the cutoff. Step 2: `DELETE FROM inbound_messages WHERE seq <=:cutoff LIMIT 1000`, repeated with a yield between batches, reporting rows deleted and per-batch latency. Daily. **Stated as a set, not an arithmetic offset (round-53: `seq < MAX(seq) -:keep` keeps `:keep + 1` rows when dense and drifts arbitrarily when sparse).** **Synthetic rows count toward retention** — they occupy real rows and pretending otherwise makes the bound wrong — even though they are excluded from history reads and row-count reporting. Default keep **200 000 rows** **AND a stored-text cap of 64 KB per row** (longer messages are stored truncated, with a `text_truncated` flag) — **row count alone does not bound bytes, and one very large message can dominate a store that privacy and disk-growth arguments both assume is bounded**. Two dimensions, both enforced. **No rotation, no file sequence, no rotation helper, and no size bound** — row count is the only retention dimension. Deleted rows free pages for reuse; **no `VACUUM`** — reclaiming disk to the OS is not worth an exclusive lock on the delivery path's database. |
| **Single writer** | SQLite's own locking. **No lock file, no boot-id, no stale-reclaim rule, no filesystem allowlist or denylist.** A second writer is handled by the database, not by this design. |
| **`enabled` vs `armed`** | `enabled` = the config flag (configuration only, never the logging predicate). `armed` = enabled **and** the table opened writable. Arming is attempted at startup and **retried in the background** (60s, backoff to 15m), outside the per-message path. While unarmed the seam call is a no-op, incrementing `inbound-log-arm-failed` once per process and `inbound-messages-skipped-unarmed` per message. **Acceptance FAILS if `armed` is false.** |
| **Failure behavior** | A failed insert is caught, counted, and **injection proceeds**. A failed secondary write is caught and counted. Sustained failures raise one deduped Attention item. |
| **Counters** | `inbound-log-failed` (the authoritative insert failed), `inbound-search-index-dropped` (shed by the backlog cap), `inbound-search-index-failed` (attempted and threw), `inbound-log-arm-failed` (once per process), `inbound-messages-skipped-unarmed` (per message), insert-latency histogram. All monotonic within a process; `topic_id` is the only label. |
| **Latency** | Attention on p99 > 50 ms **and** on any single insert > 1 s. A wedged device can still block the event loop; that residual is named below and detected **out-of-process** via the loop-tick counter on `/health`. |
| **Health** | `enabled`, `armed` (+ reason), `lastArmAttemptAt` / `lastArmResult`, row count, insert failures, max latency, the startup synthetic self-check result, a monotonic loop-tick counter, and the one-sided-conversation check (recent outbound with zero inbound). |
| **Synthetic rows** | `synthetic = 1`. Excluded from history reads, row counts, and the one-sided check. |
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
| **Retention** | Row-based (§3.0): oldest rows deleted beyond a 200 000-row keep, daily. Not time-based, not size-based. |
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
