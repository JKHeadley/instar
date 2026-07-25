<!-- GENERATED FILE — DO NOT EDIT.
     Source: docs/specs/inbound-message-recording-gap.md
     Regenerate: node scripts/generate-spec-contract.mjs --spec docs/specs/inbound-message-recording-gap.md --strict
     STRICT IMPLEMENTATION CONTRACT: allowlisted contract sections only.

     Everything not on the allowlist is ABSENT BY DEFAULT — including all
     rationale. This file says WHAT to build, never why. Read the source
     spec for the reasoning, the alternatives, and the accepted residuals
     in their full form.
     (8 residual "round-N" reference(s) remain inline.)
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
| **Store** | A **new SQLite table**, `inbound_messages`, in the agent's existing database. **Schema migration is required; DATA migration is not.** The DDL is idempotent `CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS`, run at arm time; a DDL failure means `armed: false` with the SQLite error surfaced, never a silent degrade. No existing row is read, moved, backfilled or rewritten. `better-sqlite3` is already a dependency and `TopicMemory` already opens it (`src/memory/TopicMemory.ts:154`). **No migration**: nothing existing is moved or converted. WAL mode, `busy_timeout = 100 ms`. |
| **Schema** | `dedupe_id TEXT NOT NULL UNIQUE`, `topic_id INTEGER NOT NULL`, `seam_received_at TEXT NOT NULL`, `text TEXT NOT NULL`, `sender_name TEXT`, `telegram_user_id INTEGER`, `message_id INTEGER` (nullable — no `-1` placeholder is needed), `id_source TEXT NOT NULL CHECK(id_source IN ('platform','derived'))`, `delivery_state TEXT NOT NULL DEFAULT 'injection_seam_received'`, `synthetic INTEGER NOT NULL DEFAULT 0`. |
| **Write** | `INSERT OR IGNORE` inside a transaction, synchronously, **before** injection. Returns `'appended' \| 'duplicate' \| 'failed'` from `changes` and the error path. **Never throws** — a `'failed'` result is caught internally and counted. |
| **Dedupe** | The `UNIQUE` index on `dedupe_id`. **Storage-enforced, not best-effort** — this answers round-51 directly: there is no in-memory set, no seeding, no restart window, and two processes cannot interleave a duplicate through it. `dedupe_id` = the platform message id when present, else a per-injection UUID, namespaced `in:<topicId>:<id>`. |
| **Secondary write** | `scheduleInboundTopicMemory(entry)` via `setImmediate`, only on `'appended'`. Backlog capped at 16; beyond that, drop and count. TopicMemory remains a **lossy search index**, never the record. |
| **Authority** | This table is the **primary received-history store**. It is not proof of receipt: a message dropped before the seam never reaches it (§4), and `synchronous: NORMAL` means a power loss can lose the last transaction. Absence of a row is **not** evidence a message was not received. |
| **Ordering** | `seq INTEGER PRIMARY KEY AUTOINCREMENT`, read `ORDER BY seq`. **Not bare `rowid`: rowid is insertion-ordered in practice but SQLite does not guarantee monotonicity across deletes or a table rebuild, and "monotonic" was a stronger claim than the store makes.** `AUTOINCREMENT` buys the guarantee explicitly, at the cost of one extra table SQLite maintains. |
| **Reading** | `SELECT`. No tolerant parsing, no bounded tail read, no torn-line class, no corruption counting — **none of these failure modes exist for a table**, which is most of why it is the recommendation. |
| **Coverage evidence** | The AST fitness test is a build-time guard, **not** proof of coverage. **The primary production evidence that the seam is on the real path is (1) the live Telegram call-path trace at acceptance and (2) the ongoing one-sided-conversation check** — recent outbound in a topic with zero inbound rows. Round-52 is right that dynamic and import-boundary bypasses stay plausible; the one-sided check is what would catch one *in production*, without knowing where it is, and is therefore the load-bearing detector rather than a nice-to-have. |
| **Retention** | `DELETE FROM inbound_messages WHERE seq < (SELECT MAX(seq) FROM inbound_messages) -:keep`, on a daily cadence. Default keep **200 000 rows**. **No rotation, no file sequence, no rotation helper, and no size bound** — row count is the only retention dimension. Deleted rows free pages for reuse; **no `VACUUM`** — reclaiming disk to the OS is not worth an exclusive lock on the delivery path's database. |
| **Single writer** | SQLite's own locking. **No lock file, no boot-id, no stale-reclaim rule, no filesystem allowlist or denylist.** A second writer is handled by the database, not by this design. |
| **`enabled` vs `armed`** | `enabled` = the config flag (configuration only, never the logging predicate). `armed` = enabled **and** the table opened writable. Arming is attempted at startup and **retried in the background** (60s, backoff to 15m), outside the per-message path. While unarmed the seam call is a no-op, incrementing `inbound-log-arm-failed` once per process and `inbound-messages-skipped-unarmed` per message. **Acceptance FAILS if `armed` is false.** |
| **Failure behavior** | A failed insert is caught, counted, and **injection proceeds**. A failed secondary write is caught and counted. Sustained failures raise one deduped Attention item. |
| **Counters** | `inbound-log-failed` (the authoritative insert failed), `inbound-search-index-dropped` (shed by the backlog cap), `inbound-search-index-failed` (attempted and threw), `inbound-log-arm-failed` (once per process), `inbound-messages-skipped-unarmed` (per message), insert-latency histogram. All monotonic within a process; `topic_id` is the only label. |
| **Latency** | Attention on p99 > 50 ms **and** on any single insert > 1 s. A wedged device can still block the event loop; that residual is named below and detected **out-of-process** via the loop-tick counter on `/health`. |
| **Health** | `enabled`, `armed` (+ reason), `lastArmAttemptAt` / `lastArmResult`, row count, insert failures, max latency, the startup synthetic self-check result, a monotonic loop-tick counter, and the one-sided-conversation check (recent outbound with zero inbound). |
| **Synthetic rows** | `synthetic = 1`. Excluded from history reads, row counts, and the one-sided check. |
| **Privacy** | Message text stored **unencrypted** in the agent's database, file mode 0600. Deleting rows removes them from this store only; TopicMemory and any backups are separate. No redaction — a credential pasted into chat is stored verbatim. |
| **Disclosure** | **Blocking gate before the first enablement on any machine**: a release-note entry and an operator-visible config description, both stating what is stored, where, that it is unencrypted, the retention bound, and that deletion covers this store only. Owner: the implementing agent; both texts linked from the acceptance record. End-user notice beyond the operator is **not** required — instar is operator-run software and the operator is the principal data subject; an operator whose agent receives third-party messages owns whatever notice their context requires, and §4 gives that guidance rather than implying it is handled. |
| **Flag** | `messaging.inboundSeamLogging.enabled`, default-off, with emergency disable. |
| **Acceptance** | **Not "code landed".** The flag ON for the affected machine; live Telegram proof (a normal and a long message) **with an instrumented trace of the real call path to the seam**; **a restart, then another message with the row count still increasing**; an id-less seam regression test; `armed: true` confirmed. |
| **Known residuals** | A wedged device can stall delivery (detected out-of-process, not prevented). Messages dropped before the seam are invisible. Message text is stored unencrypted. Three, all named, none mitigated. |

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
five-second `busy_timeout` behind an unbounded callback backlog is not a place to
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
| **Disclosure** **(A)** | **Blocking acceptance gate, with an owner and an artifact — not a config note.** Before the FIRST enablement on any machine: (1) a release-note entry, and (2) an operator-visible config description, both stating what is stored, where, that it is unencrypted, the retention bound, and that deletion covers the JSONL store only (TopicMemory and backups are separate). **Owner: the implementing agent; artifact: both texts linked from the acceptance record; enablement is blocked until they exist.** **End-user notice beyond the operator is explicitly NOT required**, and the reason is stated rather than assumed: instar is operator-run software where the operator is the principal data subject of their own conversation. **Where an agent receives messages from third parties, that operator is responsible for whatever notice their context requires** — this spec cannot make that call for them, and says so instead of implying it has been handled. |


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

**Unit** — `injectTelegramMessage` calls **`recordInboundMessage`** (the SQLite
insert seam; the `appendInboundJsonlSync` / `appendRawJsonlSync` pair belonged to
the superseded JSONL design — round-52) with the
fields it received, and calls **`scheduleInboundTopicMemory` only when that
returned `status: 'appended'`** — and does NOT schedule on `'duplicate'` or
`'failed'`, asserted as three separate cases rather than one negative; **when `messageId` is absent it still logs, under a per-injection UUID, with
`idSource: 'derived'`**; two identical messages in the same
second produce two distinct rows (§3); the dedupe key coerces
string/number ids; **a failing `INSERT` is caught inside `recordInboundMessage`,
which returns `status: 'failed'` and never throws** — tests assert the status at
the seam boundary, so "does a throw cross the seam?" has one answer; the injection still
happens regardless; the dedupe key is inserted **only after a successful append**, so a
throwing append leaves the message eligible to be written on its next arrival; and **the JSONL append has COMPLETED — not merely been scheduled —
before the inject call**, with the TopicMemory write asserted separately as
happening after it.

That last assertion is by **call order against the split logger API**, not by
timing.

**The round-36 version of this protocol was wrong in a way that destroyed data, and it is worth stating plainly.** It said suffixes ascend
with *age*, then renamed the current file to `highest + 1`, then deleted the
highest. Those three rules together mean **the newest rotation is deleted every
time** and history reads back in the wrong order. That is not a wording problem;
it is a specification that, implemented exactly as written, throws away the most
recent messages it just rotated.

Two coherent schemes exist and the choice is deliberate:

- **Conventional logrotate** — shift every file down (`.1`→`.2`, current→`.1`),
 delete the highest. Familiar, and ages read naturally. Costs **N renames per
 rotation**, so a crash mid-rotation can leave the set half-shifted.
- **Monotonic sequence (chosen)** — the suffix is a *sequence number*, ascending
 = newer. Current becomes `highest + 1`; the **lowest** suffix is deleted.
 Costs **one rename**, so the crash window is a single atomic operation and any
 interruption leaves a valid set.

The monotonic scheme is chosen for that crash property, which matters more here
than familiarity — this is a log whose entire purpose is surviving crashes. The
cost is that "the.1 file" is the *oldest*, which is the opposite of most
people's instinct, so it is stated in the contract rather than left to be
inferred.

**Rotation needs a protocol, not a size number.** Retention, bounded seeding and deletion completeness all now depend on
rotation behaving predictably, including when a process dies in the middle of it.
The protocol in §3.0 is chosen so that every interruption point leaves a
recoverable state:

- **Crash after rename, before the new current file exists** → the next append
 creates it. No data is lost; the rename already succeeded.
- **Crash between the size check and the append** → the append lands in whichever
 file the re-resolved path points at. Both are valid log files, so a message can
 land in the tail of the old file rather than the head of the new one. Harmless:
 nothing depends on which file a given message is in.
- **Missing or skipped rotation numbers** → tolerated and never repaired.
 Renumbering to close a gap would rewrite history to look tidier than it was,
 which is the opposite of what a message log is for.

The one real consequence is stated rather than hidden: **a message in a rotation
older than the current file is not seeded into the dedupe set** (§3.0), so a
redelivery of a very old message would be written twice. That is the accepted
cost of a bounded startup read, and a duplicate is the recoverable direction.

The policy is deliberately the smallest one that answers all three: **rotate at a
size bound, keep a fixed number of rotated files, and let resume history read
across the current file plus rotations.** Resume history is consequently bounded
by the retention window — an explicit, statable limit ("I can read back roughly
the last N days") rather than an implicit promise of forever that the disk would
eventually break anyway. The exact numbers belong with the benchmark in §3.3,
because the right size bound depends on the same measurement.

**Store-level tests (SQLite).** These replace the JSONL-era rotation invariants,
append-failure classes and `-1` migration tests, which described a design this
spec no longer contains:

- **Idempotent DDL.** Running the `CREATE TABLE IF NOT EXISTS` / `CREATE UNIQUE
 INDEX IF NOT EXISTS` twice is a no-op; a DDL failure leaves `armed: false` with
 the SQLite error surfaced, never a silent degrade.
- **Uniqueness is storage-enforced.** Insert the same `dedupe_id` twice and assert
 one row and a `'duplicate'` status — including from two connections, which the
 old in-memory set could not have caught.
- **Dedupe survives restart with no seeding step.** Insert, close, reopen, insert
 the same `dedupe_id`, assert `'duplicate'`. There is no dedupe set to rebuild.
- **Ordering is monotonic across deletes.** Insert, delete the oldest rows, insert
 again, and assert `seq` still ascends — the `AUTOINCREMENT` guarantee that bare
 `rowid` does not give.
- **Retention deletes oldest-first and only beyond the keep count**, leaving the
 newest N intact.
- **Insert failure is contained.** Make the DB read-only and assert
 `status: 'failed'`, the counter incremented, no throw crossing the seam, and
 **the injection still happening**.
- **A crash between insert and the secondary write** leaves the row present and
 the index short — the accepted lossy-index case, asserted rather than assumed.


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

**One message is not enough.** §2 found four callers of the
seam and only one passes a platform id — so a single live message proves at most
one of four paths, and most likely the *best-covered* one. Acceptance requires
three:

**These are two different tiers, and round-29 (codex) is right that merging them
was sloppy** — only one of the four callers is reachable by sending a Telegram
message; the id-less ones are server/command paths a user cannot trigger. Calling
all three "live-user proof" would have meant either failing acceptance on a path
no user can exercise, or quietly reclassifying it later. So they are split:

**Live Telegram acceptance** — performed by sending real messages:

| Step | Proves |
|---|---|
| 1. A normal Telegram message (platform id present) | `idSource: 'platform'`, dedupe against redelivery |
| 2. A long Telegram message (file-pointer injection) | The logged text is the operator's message, not the wrapper |
| 3. **Restart the server / reload config** | — |
| 4. Another normal message; inbound count still increases | **The fix survives the thing most likely to undo it** |

**Observing a row is not proving the path.** A row appearing
after a message proves *something* wrote it; it does not prove the message
travelled the route this design assumes, and the whole defect is that inbound
traffic takes a route nobody had traced. So acceptance carries an artifact, not
just an observation: **the live proof runs with the seam instrumented, and
records the actual call path from Telegram arrival to `injectTelegramMessage`.**
**The trace artifact, concretely.** A JSON file committed alongside the
acceptance record, one object per observed inbound message, each carrying:
`telegramMessageId`, `topicId`, the **ordered list of function names** from the
first instar frame that saw the message to `injectTelegramMessage`, the module
path of each, a monotonic timestamp per hop, and the resulting `dedupeId`.

**The minimum acceptable implementation:** a temporary structured log
line at three explicit instrumentation points — the first instar frame that sees
the message, any intermediate hand-off, and `injectTelegramMessage` — each
carrying a span id shared across the three. Not distributed tracing, not a
framework: three `console`-level structured lines behind the same flag, removed
or left dark after acceptance. **Normative artifact handling:** stored **only** in the acceptance
record, **never** in the repo and never in the log directory; **redacted to
message ids, topic ids and function names** — no message text, no display names,
no user ids; **deleted at sign-off**, with the acceptance record noting the
deletion. If that handling cannot be met, the fallback is temporary structured
logs plus a written acceptance transcript, which proves the same thing with no
durable artifact at all. The artifact is **attached to the acceptance
record, not committed to the repo**, because it contains real message ids —
**and message ids are the only identifier it may carry: no message
text, no sender names, no user ids.** It is deleted once the acceptance record is
signed off. A diagnostic artifact that outlives its diagnosis is just another
copy of the data this spec is trying to be careful with.

**It passes iff** every observed message's chain terminates at
`injectTelegramMessage`, and the JSONL row for that `dedupeId` exists. A chain
that terminates anywhere else is the finding, not a failure of the test — it
would mean a second delivery path exists, which is the thing ACT-1217 is looking
for.

That trace is the evidence that the seam is genuinely on the production path —
the claim §2 makes and that this spec otherwise asks the reader to accept. It
also feeds ACT-1217 directly, since tracing the path *is* the beginning of
finding the intake edge.

**Steps 3 and 4 are the point.** A single readback proves the
code works; it does not prove the *machine* is fixed, because the realistic
regression is the flag not surviving a restart (§3.3). An acceptance test that
stops at step 2 would pass on a machine that reverts to the bug an hour later —
and would leave a recorded proof saying otherwise. Restarting *during* acceptance
costs a minute and closes that gap.

**Also verified during acceptance: the store is genuinely armed** — DB writable,
WAL confirmed, the unique index present, and the synthetic insert/read round-trip
passing — on the
affected machine. The whole dedupe story rests on one writer
per log path, and two processes appending to the same file risk interleaved
records, not merely duplicate ones. The lock is what makes that hypothetical; an
acceptance run that never checks the lock is trusting the load-bearing assumption
without looking at it.

The second is included because long messages take the file-pointer path rather
than inline injection, and a log that recorded the pointer instead of the message
would look healthy in every count while storing nothing readable.

**Id-less seam regression** — a separate test at the seam, not a live-channel
claim, exercising the three callers in `src/commands/server.ts` that pass no
`messageId`. It proves the derived-UUID path that **three of the four callers
take**, which is the majority of the seam's traffic shape and the part a Telegram
message cannot reach. Both tiers are required for "done"; neither substitutes for
the other.

**E2E** — production initialization path: a message injected into a live session
is readable back from the topic history **within a bounded interval** (the write
JSONL row is readable immediately while the searchable copy lands on the next
tick, so the test awaits the latter rather than asserting
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
