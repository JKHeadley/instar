<!-- GENERATED FILE — DO NOT EDIT.
     Source: docs/specs/inbound-message-recording-gap.md
     Regenerate: node scripts/generate-spec-contract.mjs --spec docs/specs/inbound-message-recording-gap.md --strict
     STRICT IMPLEMENTATION CONTRACT: allowlisted contract sections only.

     Everything not on the allowlist is ABSENT BY DEFAULT — including all
     rationale. This file says WHAT to build, never why. Read the source
     spec for the reasoning, the alternatives, and the accepted residuals
     in their full form.
     (16 residual "round-N" reference(s) remain inline.)
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

**Local terms used below**:

| Term | Meaning |
|---|---|
| **Injection seam** | `SessionManager.injectTelegramMessage` — the function that hands an inbound message to a running session. |
| **Forward route** | `POST /internal/telegram-forward`, the lifeline's delivery path and the only existing caller of `logInboundMessage`. |
| **TopicMemory** | The SQLite store backing conversation search/summaries. A lossy index here, never the record. |
| **Attention** | The operator alert queue (`POST /attention`), deduped, not a chat message. |
| **Armed** | Enabled **and** lock acquired **and** log path writable — see the row below. |
| **Increment A / B** | The two shipping halves defined immediately below. |


**Two increments, because a contract cannot mandate a subsystem while saying its
foundation may be wrong.** Round 45 concluded the store choice may be wrong; round 46
correctly pointed out that the contract nevertheless still ordered the entire
hand-built log subsystem. Those cannot both stand. The split — already recommended
independently as ACT-1219 — is what makes them coherent:

| | **Increment A — stop the loss** | **Increment B — retention machinery** |
|---|---|---|
| **Ships** | Now, opt-in, this machine | After the store decision (ACT-1220) |
| **Store** | JSONL, **accepted** — at this size the format genuinely is the smaller change | **Open**: JSONL or SQLite, decided on evidence |
| **Includes** | The seam call, the split write API, dedupe, the arm/enabled states, counters, disclosure | Rotation, retention, ordering key, torn-line recovery, bounded seeding, corruption classes |
| **Excludes** | Everything in Increment B | — |

**Increment A does not rotate and does not bound the file.** That is a named,
accepted, time-boxed exposure — one machine, deliberately switched on, with the
size visible on the health surface — and it is strictly better than the current
state, which is losing every message. Increment B is where the store choice is
decided, and if it lands as SQLite then most of the machinery below is never
built at all, which is precisely why building it now would be waste.

**Rows below are marked (A) or (B).** A reader building today builds only (A).


| | |
|---|---|
| **Where** **(A)** | `SessionManager.injectTelegramMessage`, before the injection. |
| **Essential write** **(A)** | `appendInboundJsonlSync(entry)` — synchronous append to the JSONL log. It wraps a lower-level **`appendRawJsonlSync`, which MAY throw**; the wrapper is the throw boundary, so nothing below the seam ever propagates. **Never throws *once the syscall returns*** — a synchronous filesystem stall can still block the event loop indefinitely (§3.2); the guarantee covers the error path, not the time path. Returns `{ status: 'appended' \| 'duplicate' \| 'failed' }`. Not shed by any application policy — but it can still *fail*, and a failure is counted, not silent. Log path: an app-controlled local data directory is **required for fleet default-on**; an operator-configured arbitrary local path is **accepted for opt-in use** with the stall risk named (§3.2). Network storage is out of scope for either. |
| **Secondary write** **(A)** | `scheduleInboundTopicMemory(entry)` via `setImmediate`, called **only on `status: 'appended'`**. **On `'duplicate'` the index is NOT scheduled.** The forward route's `logInboundMessage` writes both stores with the same identity fields (verified against `TelegramAdapter.logInboundMessage`, the sole other writer) — **but calling that "safe" overclaimed.** If a first write appended JSONL and its async index write was dropped, failed, or lost to process exit, a later duplicate suppresses the append and **the index gap is never repaired**. Accepted explicitly rather than papered over: TopicMemory is a lossy index by contract (§3.0 Authority), and this is one more way it can be lossy. It is NOT a lost message — JSONL has it. If a future writer appends JSONL without the index, this assumption breaks silently — so the architectural fitness test's allowlist covers the JSONL writer set, not just the injection primitives. Dedicated SQLite connection, `busy_timeout = 100 ms`. Backlog capped at **16**; beyond that, drop and count. |
| **Fields (JSONL)** **(A)** | `seamReceivedAt`, `text` (the operator's message, not the wrapper), `topicId`, `senderName`, `telegramUserId`, **`messageId: number \| null`** (present-and-null when absent, never omitted — one shape, so a reader never has to distinguish missing-key from missing-value), `dedupeId`, `idSource: 'platform' \| 'derived'`, `deliveryState: 'injection_seam_received'`, `fromUser: true`. |
| **Dedupe key** **(A)** | Canonical form, exactly: **`` `in:${Number(topicId)}:${dedupeId}` ``** — never `dedupeId` alone, never a different join. `dedupeId` is the platform id when present, else a per-injection UUID. **If `topicId` is not a finite number the entry is NOT deduped** (a `NaN` would collapse every malformed row onto one key, which is worse than a duplicate); it is written and counted as `inbound-log-undedupable`. **Inserted into the in-memory set only after a successful append.** Scope: **best-effort duplicate suppression within one process** — atomic in-process, not a storage-level uniqueness guarantee. |
| **Ordering (TopicMemory)** **(A)** | `(timestamp, rowid)`. Never `message_id`. |
| **Ordering (JSONL)** **(B)** | JSONL has no `rowid` — round-42 caught the contract borrowing TopicMemory's key for a store that cannot supply it. The key is **`(seamReceivedAt, fileSequence, lineNumber)`**, where `fileSequence` is the rotation suffix and the **current** file takes `highest + 1` **computed from a single stable file inventory taken before the read begins**. The helper snapshots the inventory once; every record in that read is numbered against it and `lineNumber` is the 0-based line within that file. Ties on `seamReceivedAt` are broken by file then line, which is append order — the only true ordering a log has. |
| **History order** **(B)** | Session history returns **chronological (oldest first)**. Rotation read order is newest-file-first for *locating* records; the assembled result is re-sorted by the ordering key above. Those are different things and conflating them was the round-42 ambiguity. |
| **Authority** **(A)** | JSONL is the **primary received-history store — authoritative *among local stores*, not a proof of receipt**. It has no `fsync`, so a power loss can drop the tail, and an append can fail while injection proceeds. **Absence of a row is therefore not evidence a message was not received**. TopicMemory is a **lossy index** — search, never counting. Its identity columns are informational; no uniqueness constraint. |
| **Failure behavior** **(A)** | A failed append is caught, counted, and **injection proceeds**. A failed TopicMemory write is caught and counted. Sustained failures raise one deduped Attention item. |
| **Counters** | Four distinct conditions, never merged: `inbound-log-failed` — the **authoritative** JSONL append failed (reserved for that alone); `inbound-search-index-dropped` — a TopicMemory write **shed by the backlog cap** before it was attempted; `inbound-search-index-failed` — a TopicMemory write that **was attempted and threw**; plus pending-callback depth (Attention above **8**). A shed and a failure are different problems with different fixes, and neither is a lost inbound record. |
| **Latency** **(A)** | Append latency sampled; Attention on **p99 > 50 ms** (generally slow filesystem) **and** on any **single append > 1 s** (the pathological stall a p99 cannot see). Both ship. |
| **Health** **(A)** | `enabled` **and** `armed` (with arm-failure reason), `lastArmAttemptAt` / `lastArmResult`, the **resolved absolute log path**, **current file size**, **`rotationCount: not_applicable` until (B) ships** (present-and-explicit beats absent — a missing field reads as a bug, `not_applicable` reads as a decision), last/max append latency, recent inbound row count, append failures, max latency, rotation state (current size + rotation count), startup synthetic self-check result, and a one-sided-conversation check (recent outbound with zero inbound). |
| **Storage** **(A)** | Append-only JSONL in an **app-controlled local data directory**, file mode **0600**, owned by the agent process user. Plaintext — no encryption at rest (§4). |
| **Rotation** **(B)** | Rotate at **32 MB**; keep **4** rotated files. Oldest is deleted on rotation — that deletion IS the retention mechanism. **Filenames:** `inbound.jsonl` (current) and **`inbound.jsonl.seq-000001` … `inbound.jsonl.seq-NNNNNN`** — the `seq-` prefix is deliberate: bare `.1`/`.2` look like logrotate age ranks while meaning the opposite here, and a "use the helper" rule is a social guard, not a technical one. A name that encodes the model is discoverable without reading this document. **N ascending = NEWER** — the suffix is a monotonic sequence number, not a logrotate age rank. **Protocol (ordered, crash-recoverable, ONE rename):** re-resolve the path → rename current to `.{highest existing suffix + 1}` → append to a fresh current file. **Deletion selects the LOWEST suffix** (the oldest), by suffix and never by mtime, so a restored or touched file cannot change its own age. Missing or skipped suffixes are tolerated and never renumbered; "keep 4" means *at most 4 rotations survive a rotation event*, counted by suffix. **Read ordering** for history is current first, then **descending** suffix (newest rotation first). **A small rotation helper is the ONLY supported reader/writer**: no caller infers order from filenames, because a scheme that fights logrotate convention will eventually be read by someone who assumes the convention. The invariants in §5 test the helper, not each caller. |
| **Retention** **(B)** | Whatever fits in current + 4 rotations (~160 MB of message text). Resume history is bounded by this window, not by time. No time-based expiry. |
| **Reading (current file)** **(A)** | Increment A reads JSONL for its startup self-check, recent-row count, restart acceptance and dedupe seeding — **so tolerant reading is (A), not (B).** Line-by-line, an unparseable line skipped and counted, bounded to the current file's last 64 MB. |
| **Reading (across rotations)** **(B)** | Reading rotated files, and the mid-file-vs-final-line corruption distinction: an unparseable line is skipped and counted (`inbound-log-corrupt-line`), never fatal, because a process killed mid-append leaves exactly that shape. Corruption **beyond the final line** of a file raises Attention: one torn tail is normal, damage in the middle is not. |
| **Seeding** **(A)** | `seedMessageLogDedupe()` reads the **current file only**, and at most its **last 64 MB** — never the rotations. **(A), not (B): Increment A's restart acceptance depends on dedupe surviving a restart, so seeding ships with it.** A redelivered message older than the current file is written twice; that is the accepted cost of a bounded startup read. |
| **Deletion (JSONL store only)** **(A)** | Deleting the **current** file removes everything Increment A holds. **Under (A) no rotated files exist** — if any are present, the build is already past (A) and (B)'s deletion rule applies. TopicMemory, filesystem snapshots, and any backup system are **separate stores with separate deletion** — this is not a whole-system erasure guarantee. |
| **Single writer** **(A)** | One writer per log path, enforced by a lock file beside the log. **Schema:** `{ pid, bootId, host, acquiredAt }`. **Acquire:** `open(path, O_CREAT|O_EXCL)` — atomic create, no read-then-write race. **bootId source:** `kern.boottime` (macOS) / `/proc/sys/kernel/random/boot_id` (Linux); if unavailable, the lock is treated as valid on a live pid alone and health says so. **Valid** = live pid + matching bootId + matching host. **Stale** (reclaimed automatically) = matching host + matching bootId + dead pid — the ordinary crash case. **Ambiguous** (refuse to arm, never take over) = foreign host, mismatched bootId, or an unreadable/unparseable lock file. Scope in (A) is append and seeding; rotation is (B). **Path locality** is checked at arm time against a DENYLIST of network filesystem types (`nfs`, `smbfs`, `afpfs`, `cifs`, `webdav`, `fuse.sshfs`) via `statfs`/`getmntinfo` (macOS) or `/proc/mounts` (Linux) — never an allowlist, which would refuse to arm on overlayfs, zfs, tmpfs, encrypted volumes, containers and CI. A matched network type refuses to arm, naming the concrete type; an undetectable type arms with a warning; `allowNonLocalLogPath: true` overrides. |
| **Fields (TopicMemory)** **(A)** | Same identity fields, except `message_id` is the platform number or the inert placeholder **`-1`** when absent (the column is `NOT NULL`; §3 explains why it is not made nullable). `id_source` carries the meaning. **Three wire shapes for one concept was the round-40 finding — there are now two, each stated where it applies.** |
| **`enabled` vs `armed`** **(A)** | `enabled` = the config flag. `armed` = enabled **and** the lock was acquired **and** the log path resolved writable. Both are reported; `enabled && !armed` is a first-class state, never inferred from a zero row count. **Arming** is attempted at startup and **retried in the background forever** (60s, exponential backoff to 15m), outside the per-message path, which never arms. `lastArmAttemptAt` / `lastArmResult` are on health. **While unarmed** the seam call is a no-op: it does not append, returns no status, and increments `inbound-log-arm-failed` once per process plus `inbound-messages-skipped-unarmed` per message. **Acceptance FAILS if `armed` is false**, whatever the flag says. |
| **Synthetic rows** **(A)** | The startup self-check record is marked `synthetic: true`. It is **excluded** from history reads, the recent-inbound count, the one-sided-conversation check and dedupe seeding. It **is** counted toward rotation size, because it occupies real bytes and pretending otherwise would make the size bound wrong. |
| **Metrics contract** **(A)** | Every counter, one table, so cardinality and reset scope are not left to prose. All are **monotonic within a process** and reset on restart; none carry a per-message or per-user label. **`topicId` is the only label and its cardinality is bounded by active conversations on one machine** — expected tens, not thousands. If a deployment exceeds ~500 distinct topics the label is dropped to a coarse bucket and topic-level detail moves to the log records. |
| | `inbound-log-failed` — counter, label `topicId`, alert on any sustained non-zero. |
| | `inbound-search-index-dropped` / `inbound-search-index-failed` — counters, label `topicId`, alert above the §3.0 backlog warning. |
| | `inbound-log-arm-failed` — counter, **once per process**, no labels, alert on any. |
| | `inbound-messages-skipped-unarmed` — counter, **per message**, label `topicId`, alert on any. |
| | `inbound-log-corrupt-line` **(B)** — counter, label `file`, alert when non-final-line. Belongs to (B)'s reading machinery, not (A). |
| | `inbound-log-undedupable` — counter, no labels, alert on sustained non-zero. |
| | append-latency — histogram, no labels, alert on p99 > 50 ms or any sample > 1 s. |
| **Flag** **(A)** | `messaging.inboundSeamLogging.enabled`, default-off, with emergency disable. |
| **Acceptance** **(A)** | **Not** "code landed". Requires: the flag ON for the affected machine; live Telegram proof (normal + long message) **with an instrumented trace of the real call path from Telegram arrival to the seam**, not merely a row observed afterwards; **a restart, then another message with the inbound count still increasing**; an id-less seam regression test; and the single-instance lock verified active. |
| **Known residuals** **(A)** | A wedged local disk can stall message delivery. Messages dropped before injection are invisible. Message text is stored in local plaintext. All three accepted and named, none mitigated. |


**Log at the injection seam.** `injectTelegramMessage` records the message
before injecting it — **always, whenever the feature is ARMED**, using the
platform's `messageId` when present and a per-injection id when not.

**The seam orchestrates; it does not do the logging.** The concern is fair in shape but does not apply here:
`TelegramAdapter.logInboundMessage()` **is** the dedicated logger, and it already
exists and is already used by the forward route. `injectTelegramMessage` gains one
call to it — an orchestration line, not a second responsibility. What would
violate SRP is inlining the write into the seam, and that is expressly not what
this does.

That is the whole mechanism. **What it is, named honestly:** it is
a **miniature write-ahead split** — a minimal record written synchronously,
secondary indexes updated asynchronously. That is an industry pattern, not an
invention, and pretending otherwise made the design harder to evaluate rather
than smaller.

**"Durable" is one word too far, though.** `appendFileSync`
returns when the bytes reach the OS, not the platter: without `fsync` a power
loss or kernel panic can still lose the tail. Calling this a *durable* WAL
overclaims. It is a **synchronous best-effort append** — which survives the
failure this bug is actually about (a process crash or restart, where the OS
buffer is flushed normally) and does not survive a machine losing power
mid-write. `fsync` per message is deliberately **not** added: it would cost
milliseconds of real disk latency on every inbound message, on the delivery path,
to protect against a failure mode that loses the running session anyway.

**Why not log at the intake edge instead?** The obvious industry shape
for this problem is an **outbox/intake event log**: append an event where Telegram
traffic actually enters — the webhook or polling boundary — and project it
forward into session history and search. It is a better-known pattern than what
this spec proposes, and it covers strictly more: the messages queued, dropped or
refused *before* injection, which this design admits it cannot see (§4). Twenty-six
rounds of review spent effort rejecting queues and workers and never named it.

It is still not what this spec does, for two reasons, and the second is the real
one:

1. **The goal is session-resume completeness, not audit completeness.** The
 defect is that a resumed session reads its own half of the conversation. That
 is fixed by recording what reaches the session. Recording everything Telegram
 ever sent is a different, larger goal — a genuinely good one, and not this one.
2. **The intake edge on the affected machine is not known.** The whole bug is that
 inbound traffic here does *not* arrive through the route that logs it (§1: zero
 hits on the forward route). An intake-edge log would first require finding
 where intake actually happens on this machine — the same discovery work, plus a
 new store, before recording a single message. The seam is chosen because it is
 the point that is *verified* to be on the path, not because it is the
 theoretically best point.

If audit completeness is later wanted, the intake-edge log is the right build and
this record does not obstruct it — they answer different questions and can
coexist.

**Why not a SQLite append table instead of JSONL?** SQLite would
give bounded reads, atomic appends with no torn tail, real migration discipline,
indexed lookups instead of a dedupe set rebuilt at startup, and retention as a
query rather than file rotation. Every one of those is a thing this spec had to
solve by hand — the torn-tail seeding rule, the bounded-read cap, the rotation
policy, the in-memory dedupe set and its restart seeding. **Roughly four of the
review findings across rounds 27-34 exist only because the store is a text
file.** That is not a small observation and it should not be buried.

**THAT JUSTIFICATION NO LONGER HOLDS, and round-45 is where it broke.** The
argument for JSONL was always "the smaller change". Count what the smaller change
now requires the implementer to hand-build:

rotation sequencing · a three-part ordering key · torn-line recovery · bounded
startup seeding · single-writer lock semantics with boot-id and stale reclaim ·
corruption counting with a mid-file/end-of-file distinction · a canonical dedupe
key with a malformed-input rule · a rotation helper that must be the only reader

**Every one of those is free in SQLite**, and every one of them arrived as a
review finding rather than as a design decision — which is what it looks like
when a format is being asked to do a job it was not chosen for. The spec has been
carrying an argument ("smaller change") that stopped being true somewhere around
round 38 without anyone re-checking it. Both reviewer families flagged the store
choice; one of them has now flagged it three times, each time with more evidence.

**The honest position: JSONL is no longer obviously the smaller change, and may
be the larger one.** A SQLite append table replaces the whole list above with a
schema and an INSERT. What it costs is a migration on an existing store — real
work, but bounded and well-understood, against an open-ended list of hand-built
log mechanics each of which is a place to be wrong.

**This is not resolved here, deliberately.** Switching the store mid-review would
restart a 45-round review on a different design while messages are actively being
lost, and the decision interacts with the split question (ACT-1219) — if the
recording fix ships separately from the retention machinery, most of the list
above goes with the *second* half, and the first half genuinely is small. It is
recorded as a decision the operator should make with the real numbers in front of
them, not one the author should quietly settle by continuing.
<!-- tracked: ACT-1218 -->

The original reason, kept for the record: **the log already exists and is already
written by the same function on the other path.** This spec's job is to close a
data-loss bug by adding a call at a seam; converting the message log to a new
store is a larger change with its own migration, its own failure modes, and its
own review, undertaken while messages are actively being lost. Doing the smaller
thing first is the right sequencing, not a judgment that JSONL is better.

**Recorded with TRIGGERS, not as vague future debt.** ACT-1218 fires when
**any one** of these becomes true, and each is observable from the health surface
this spec already requires:

| Trigger | Threshold |
|---|---|
| Consumers of the log | **more than two** distinct readers beyond seeding + session history |
| Retention pressure | rotation dropping data **more than once a week** on any host |
| Query need | any consumer needing a filter the JSONL scan cannot answer in bounded time |
| Corruption rate | `inbound-log-corrupt-line` non-zero **beyond final lines** on any host |

Any one of those means the hand-built mechanics have outgrown the format. If none
of them ever fires, JSONL was the right call and the migration correctly never
happens — which is what makes these triggers rather than a plan.

**The known cost, restated:** if this log grows in
importance — more consumers, longer retention, real query needs — the SQLite
migration is the expected next step, and the hand-built machinery listed above is
the debt it would retire. <!-- tracked: ACT-1218 -->

**Both reviewer families reached this independently, which is worth more than either saying it alone.** They came at it from
different directions — codex counted the review findings that exist only because
the store is a text file; gemini weighed the hand-built machinery against
migration effort and judged the trade already favourable. Two families
converging on the same architectural call, without either seeing the other's
review, is the strongest signal this process produces. It does not change the
sequencing decision above — closing the data-loss bug still comes first — but it
does mean ACT-1218 should be treated as an expected next step rather than an
option someone might get around to.

**Choosing the seam does not close the routing question, and that is tracked, not
waved.** "The intake edge is unknown" is a reason to log
somewhere verified; it is not an answer. The likeliest next failure of this whole
area is another pre-injection drop, or a second intake path that never reaches
the seam at all — and neither is visible until someone traces where inbound
traffic actually enters this machine. That tracing is registered as its own work
item so it survives this spec shipping — **and it BLOCKS fleet default-on, rather than sitting alongside as adjacent debt.** The seam log is
emergency loss-reduction on a machine whose intake architecture is unknown;
rolling that to a fleet without ever having found the intake edge would be
shipping the unknown, not the fix. One machine, opt-in, is the right scope for a
fix built on an unverified map. <!-- tracked: ACT-1217 -->

**And there is a cheap detector for the gap in the meantime —
the one that would have caught this bug years earlier.** The fitness test stops
*new* bypasses; it says nothing about a pre-existing intake path nobody has
found. But an unrecorded intake path has an observable signature that needs no
knowledge of where it is: **the agent replies in a conversation that has no
recorded inbound message.** Outbound is already logged. So a periodic check for
topics with recent outbound activity and zero inbound rows over the same window
finds unrecorded traffic without knowing its route — which is precisely the
condition that held here for five days while everything looked healthy.

It ships as a counter and one deduped Attention item, not a gate. It will have
false positives (an agent-initiated message, a scheduled job posting into a quiet
topic), so it is tuned to a *sustained* imbalance rather than a single instance,
and it reports a suspicion rather than asserting a bug. That is the right
strength for it: the reason this defect survived is that nothing was watching for
a one-sided conversation, and a noisy watcher would have been infinitely better
than none.

**What it is still deliberately NOT:** a queue subsystem, an event bus, a worker,
a retry ladder, or any new persistent store. The persistence already exists and is
already written by the same function on another path; the record is machine-local
by nature (§6); nothing downstream consumes it transactionally. That is the real
distinction, and it is the one rounds 5 and 6 deleted machinery to preserve.

It works because:

- **The seam is the real chokepoint — and that claim carries a proof obligation.** Stating it is not enough; the same "surely everything goes
 through here" assumption is what produced this bug. So the change ships with an
 **architectural fitness test** — the honestly-enforceable form. The test enumerates the **allowlisted callers of the two low-level primitives**
 — `SessionManager.injectMessage` and `SessionManager.rawInject` — in a fixture.
 Those, not `injectTelegramMessage`, are what the test scans, and deliberately:
 `injectTelegramMessage` is the seam that *does* the logging, so a new path that
 bypasses the gap would do so by reaching for the primitives underneath it.

 **The test is AST-based, not a regex over source text.**
 It walks the parsed module graph for references to the two primitives, which
 catches renamed imports and aliases that a text search would miss. It still
 cannot see genuinely dynamic dispatch, so a **runtime counter** records raw
 primitive use from outside the approved call sites — the static test catches
 what is knowable at build time, the counter reports what is only knowable at
 run time, and neither pretends to be the other. **The guarantee is therefore
 "static enforcement plus runtime anomaly counting", not "runtime enforcement".** Attributing a call to an approved site at runtime would
 need stack inspection, which is expensive and fragile; the counter instead
 records *total* primitive invocations and compares against the count the
 approved sites report making. A divergence says "something else called this"
 without saying who — an anomaly signal, not an attribution mechanism, and it is
 described as such.

 **What to do when it fires.** The investigation path is deliberately manual and
 cheap: the counter reports the divergence *per topic and per session*, which
 narrows a search to one conversation's code path rather than the whole tree.
 From there the step is a one-off debug build that turns on stack capture at the
 two primitives — expensive enough that it stays off by default, cheap enough to
 switch on for an hour once something is known to be wrong. That is the honest
 plan: the counter tells you *that* and *roughly where*, and finding *who* costs
 a deliberate debugging session. Pretending otherwise would mean paying stack
 capture on every inject forever to answer a question that should almost never
 be asked.
 The fixture is the list of functions permitted to call them; any new
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
 **And it is not what "done" rests on:** §5 requires a **user-role live test
 through the real Telegram surface** before this ships, precisely because
 seam-level tests prove wiring rather than experience. The caveat here describes
 the limits of the *static* guarantee; the live-channel test is the acceptance
 criterion, and the two are complements, not alternatives.
- **De-duplication already exists, and it is atomic within the process.** Grounded in the implementation: `appendToLog` checks an
 **in-memory `Set`** and appends **synchronously**, with no `await` between the
 check and the write. Node is single-threaded, so two calls in one process
 cannot interleave — the forward route and the seam are serialized by the
 runtime, not by luck. The guarantee therefore holds **within a process**, which
 is the whole story here because the advisory design's single-instance lock means
 one server per agent home (§6). Across processes it would be best-effort, and a
 race-shaped test — both writers invoked in the same tick — pins the in-process
 case rather than only testing sequential delivery.
 **It also survives restart:**
 `seedMessageLogDedupe()` rebuilds the in-memory set by reading the JSONL file on
 first use, so a restarted process re-learns every key. One caveat worth stating —
 seeding skips rows whose `messageId` is not a number, so **id-less entries are
 not re-seeded**. Harmless here precisely because their per-injection UUID never
 deduped across arrivals anyway: nothing is lost that was ever promised.
 **The key is inserted only AFTER the append returns.** If the key
 went in first and the append then threw, the in-memory set would suppress every
 later retry of that same message: the write that failed would be the only write
 ever attempted. So `appendInboundJsonlSync` inserts on the success path only, and
 a thrown append leaves the key absent — the next arrival of the same message is
 treated as new and written. The cost of that ordering is a possible duplicate row
 if the append *partially* succeeded before throwing; the cost of the other
 ordering is losing the message entirely. A duplicate is recoverable and a loss is
 not, so the ordering follows the recoverable failure. **Seeding tolerates a torn
 tail**: `seedMessageLogDedupe()` parses line-by-line and skips a final unparseable
 line rather than aborting, because a process killed mid-append leaves exactly that
 shape and an aborted seed would drop every key in the file.

 The existing key is `in:<topicId>:<messageId>`, so a message that reaches both
 the forward route and the seam is written once **to JSONL — best-effort, within
 one process**. A second
 process appending to the same file would not be suppressed; nothing in the file
 format or the filesystem prevents it. The single-instance lock is what makes
 that hypothetical rather than routine, and the lock — not the dedupe — is the
 load-bearing part of that argument. **TopicMemory is a
 different story and the guarantee does not extend to it:**
 its `(topic_id, message_id)` index is plain, so nothing there prevents a
 duplicate row. In practice the in-memory dedupe short-circuits before *either*
 write happens, so duplicates do not arise on this path — but the guarantee that
 is *enforced* is JSONL's, and TopicMemory's freedom from duplicates is a
 consequence of the caller, not a property of the store. Said plainly because
 "written once" reads as a storage guarantee and is not one. The forward route's call is left in place —
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
 - the entry carries **`deliveryState: 'injection_seam_received'`**, and the
 timestamp is **`seamReceivedAt`**.

 **This name has now been wrong three times, each time by one notch of
 overclaim, and the sequence is worth keeping.** `received` implied Telegram
 receipt. `sessionReceived` implied the session got it — but the row is written
 *before* injection, so a crash between the append and the inject leaves a row
 claiming a session received something it never saw. Only
 `injection_seam_received` states what the row can actually prove: **this
 message reached the injection seam.** Not that Telegram delivered it, not that
 a session consumed it. Each rename was a real correction and each left a
 smaller overclaim behind, which is the most concrete illustration in this
 document of how hard it is to name a thing honestly. A message the bot
 took in and then queued, dropped or refused before injection never reaches
 this record at all (§4). It is a single-valued enum
 today, and deliberately an enum rather than a boolean or an absence. It gives a later `'injected'` or `'delivered'` somewhere
 safe to live, so evolving this record never requires *reinterpreting* an
 existing field. The alternative — adding meaning to `seamReceivedAt` later
 — is precisely the reinterpretation that makes old rows lie.

 **Storage contract, grounded in the real schema.** `topic-memory.db`'s `messages` table declares
 `message_id INTEGER NOT NULL`. A `messageId: null` entry therefore **cannot be
 inserted**: the design as written would have failed at implementation, not at
 review. So:

 - **JSONL** rows are free-form objects, so `dedupeId`, `idSource` and a null
 `messageId` cost nothing there. This is the record the session-start history
 reader uses, and it carries the full shape.
 - **TopicMemory gets a two-column migration, and the negative-id sentinel is
 withdrawn.** The
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

 **Why `-1` is inert rather than a sentinel.** Grounded in the schema: `idx_messages_topic_id` on
 `(topic_id, message_id)` is a **plain index, not unique**, so many rows may
 share `-1` without colliding — the identity for new rows is `dedupe_id`, and
 nothing enforces uniqueness on `message_id`. Removing `NOT NULL` outright
 would need a full table rebuild in SQLite, which is a materially bigger
 migration than two added columns; `-1` plus `id_source` gets the same
 semantics for an `ALTER TABLE ADD COLUMN`. The difference from the withdrawn
 sentinel is that **no reader has to interpret it**: meaning lives in
 `id_source`, and `-1` is just a value that satisfies the constraint.

 That deletes the helper and the ordering caveat — a net reduction, which is
 why it is worth the migration this spec spent four rounds avoiding.

 **The consumer audit is not deleted, though.** Claiming "no
 reader has to interpret it" was too strong: `-1` is still an observable value
 in a shared table, and an existing reader that sorts, filters, displays or
 exports on `message_id` sees it whether or not it is asked to interpret it. The
 honest scope is narrower — *no reader has to interpret it to get correct
 behavior from this feature*, and that is only true if no reader is currently
 keying on `message_id` in a way `-1` disturbs. So the change ships with a
 one-time audit of TopicMemory read paths, and the rule that follows it: **any
 read model exposing `message_id` exposes `id_source` alongside it.**

 **With a migration trigger, not an indefinite convention.** `-1`
 is a local convention over a shared SQL column, and the AST check protects
 the consumers that exist today. **If any consumer begins sorting or filtering
 by `message_id`, the table is rebuilt with a nullable column** — the full
 rebuild this spec avoided for cost reasons becomes correct the moment the
 placeholder starts being reasoned about rather than merely carried. That is
 an observable condition (the AST check sees the projection), so it is a
 trigger rather than an intention. <!-- tracked: ACT-1218 --> A column
 that can hold a placeholder must travel with the column that says whether it
 is one.

 **The rule is a test, not an audit.** An audit is a snapshot; the next read model
 someone adds is written after the audit and knows nothing about it. So the
 rule ships as an **AST check over TopicMemory read paths**: any select,
 export, or display projection that includes `message_id` must also include
 `id_source`, or be listed in an explicit exemption fixture with a reason. It
 rides the same machinery as the architectural fitness test above and fails the
 build the same way — which is the only version of this rule that is still true
 in six months.

 **TopicMemory's identity columns are INFORMATIONAL, and no index is added.**
 `dedupe_id` and `id_source` land there so a row can be traced back to its
 JSONL counterpart when someone is debugging — not so TopicMemory can enforce
 anything. Uniqueness is deliberately absent: enforcing it would make a
 duplicate a *write failure* on the lossy secondary store, which is exactly
 backwards — a duplicate searchable row is a cosmetic problem, a rejected
 write is a missing one. Correctness therefore stays with the JSONL-side
 in-memory gate, permanently and by design, and that is stated here rather
 than left as an implication of an absent constraint.
 - **Ordering still comes from `(timestamp, rowid)`, not `message_id`.** With the
 sentinel withdrawn this is no longer a sign-related trap, but it remains true
 for a plainer reason: burst messages can share a timestamp, and `message_id`
 was never an arrival order. Insertion order is.
 - **JSONL is authoritative for received history; TopicMemory is a lossy index.** After a crash between the
 two writes, TopicMemory is permanently missing that row, so search and
 summaries see a partial corpus with nothing marking the gap. Every consumer
 contract therefore reads: *count and completeness questions go to JSONL;
 TopicMemory answers "find me messages like…", never "how many were there".*
 A test asserts the session-start history reader consults JSONL, and this
 sentence exists so a future search feature does not quietly become a
 counting feature.

 **And the user should be told, not just the code.** A
 person who knows they sent a message and cannot find it in search has hit a
 real gap, and "the index is lossy" is only an answer if someone says it out
 loud. Any surface built on TopicMemory search or summaries carries a plain
 line to that effect when it returns nothing or returns during a known drop
 window — not a permanent disclaimer on every result, which trains people to
 ignore it. The honest framing for a user is: *search may miss messages from a
 period when the machine was overloaded or restarted; the full record is still
 kept.*

 **A dropped index row IS reconstructable, and no tool is built for it.** JSONL
 holds every field TopicMemory needs, so a gap can be repaired by re-reading
 the log and re-inserting the missing rows: a straightforward one-off script
 when someone actually needs it. It is deliberately not shipped now. Building
 a repair tool for a gap never yet observed is speculative, and a repair path
 that exists but is never exercised is worse than a documented manual one,
 because it invites trust it has not earned. What matters for a reader hitting
 a gap is that the data is *not gone* — the index is reconstructable from the
 record.
 - **JSONL and TopicMemory now carry the same identity fields** (`dedupe_id`,
 `id_source`), which retires the round-15 "reduced contract" caveat — that
 caveat existed only because the migration was being avoided.
 - **This is best-effort received history, not a durable intake acknowledgment.** A crash before the next tick loses the row, so a reader
 may not treat the absence of an entry as proof a message never arrived, nor
 its presence as proof of delivery. One sentence, stated in the storage
 contract itself, because "received log" is a name a consumer can over-read.

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

---

> **NON-NORMATIVE FROM HERE TO §3.3.** Sections 3.1 and 3.2 are *rationale*: why
> the contract in §3.0 is shaped the way it is, what was tried and reversed, and
> which residuals were accepted deliberately. **They record how the design got
> here; §3.0 records what to build.** Five consecutive review rounds (29-33) named
> the same hazard — normative and historical text coexisting, so an implementer
> reading linearly can follow a retired design — and three of those rounds found a
> real instance of it in this document. Where anything below disagrees with §3.0,
> **§3.0 wins and the text below is the defect**. Build from §3.0 and the generated
> contract; read this for judgment, not instructions.

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

**That pair detects total regression and nothing subtler.** It cannot see partial loss, a rotation misconfiguration, TopicMemory
drops, or two processes writing the same file. So the health surface reports
four more things, each cheap and each already computed elsewhere in this design:
**append failures**, **max append latency**, **rotation state** (current file
size and rotation count), and a **startup self-check** that writes a synthetic
non-user record and reads it back. The self-check is the one that turns "the flag
says on" into "the path works right now" — it exercises append, dedupe and read
on the real configured path, at the moment the process starts, without waiting
for a real message to prove it. Synthetic records are marked and excluded from
history reads.

**A startup self-check proves the path once, not continuously.** It cannot see a permission change, a path change, a filled disk, or a
rotation misconfiguration that happens at 3am on a process that started
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
| **File permissions** | **0600**, owned by the agent process user. Anyone with root or that user's account can read it. |
| **Encryption at rest** | **None** today, with a trigger rather than a permanent stance. **Before fleet default-on, either field-level capture becomes configurable (store metadata without body) or the store is encrypted.** The opt-in single-machine fix ships as-is; the fleet does not inherit the plaintext default by silence. |
| **Encryption rationale** | **None currently.** Disk-level encryption (FileVault) is the only protection, and it protects a powered-off machine, not a running one. |
| **Redaction** | None. Secrets pasted into a message are stored verbatim — which is one more reason Secret Drop exists and pasting credentials into chat does not. |
| **Retention** **(B)** | Bounded by rotation (§3.0): oldest rotation deleted, ~160 MB window. Not time-based. |
| **Deletion** | Delete the current **and rotated** JSONL files. **This deletes the JSONL store only** — message text also reaches TopicMemory, which has its own delete path, and neither covers filesystem snapshots or any backup system. Any user-facing deletion instruction must say all three, because "delete the log files" will otherwise be read as "delete what I said to you". |
| **Export** | No dedicated export. The files are plain JSONL and readable directly. |
| **Disclosure** **(A)** | **Blocking acceptance gate, with an owner and an artifact — not a config note.** Before the FIRST enablement on any machine: (1) a release-note entry, and (2) an operator-visible config description, both stating what is stored, where, that it is unencrypted, the retention bound, and that deletion covers the JSONL store only (TopicMemory and backups are separate). **Owner: the implementing agent; artifact: both texts linked from the acceptance record; enablement is blocked until they exist.** **End-user notice beyond the operator is explicitly NOT required**, and the reason is stated rather than assumed: instar is operator-run software where the operator is the principal data subject of their own conversation. **Where an agent receives messages from third parties, that operator is responsible for whatever notice their context requires** — this spec cannot make that call for them, and says so instead of implying it has been handled. |
followed contradicted that.** Resolved in one direction: **the
operator-visible description and the user-facing disclosure are BOTH preconditions
of the first enablement, on the affected machine.** The people there are data
subjects, and "it is only one machine" is a statement about scale, not consent.
Nothing about disclosure is deferred to fleet rollout. **What fleet rollout adds: the people whose messages are stored are the DATA SUBJECTS, and an operator reading a changelog is not the same as them being told.** A user-facing disclosure path — or an explicit policy decision that one is not required — is a **precondition of enabling this anywhere but the single affected machine**, and must account for TopicMemory storing message text separately. |

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

**Unit** — `injectTelegramMessage` calls **`appendInboundJsonlSync`** with the
fields it received, and calls **`scheduleInboundTopicMemory` only when that
returned `status: 'appended'`** — and does NOT schedule on `'duplicate'` or
`'failed'`, asserted as three separate cases rather than one negative; **when `messageId` is absent it still logs, under a per-injection UUID, with
`idSource: 'derived'`**; two identical messages in the same
second produce two distinct rows (§3); the dedupe key coerces
string/number ids; the **lower-level `appendRawJsonlSync` may throw and
`appendInboundJsonlSync` wraps it**, returning `status: 'failed'` — tests assert
the STATUS at the seam boundary and the THROW only at the raw layer, so "does a
throw cross the seam?" has one answer; the injection still
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

> **The three tests below are INCREMENT B ONLY.** They exercise rotation, which
> Increment A does not implement. An implementer building (A) today skips this
> block entirely (round-49: rotation tests sitting in an undifferentiated test
> plan invite (A) implementers to build (B) assumptions).

**Rotation invariants, asserted rather than described.** Three tests, each pinning one half of the round-38 bug:

- **Deletion selects the LOWEST suffix.** Rotate past the keep-count and assert
 `.1` is gone while the highest suffix survives. This is the test that would have
 caught the round-36 protocol, which deleted the newest file every time.
- **Read order is current, then descending suffix.** Assert a message written
 before rotation reads back *after* one written since.
- **A gap in the sequence changes nothing.** Delete a middle suffix by hand, then
 rotate and read: no renumbering, no reordering, no crash.

**Migration safety.** Four tests, all against a database with real
pre-existing rows rather than a fresh one: the migration **applies** to an
existing DB and leaves prior rows readable; running it **twice** is a no-op
(idempotency, since a partially-applied migration is the normal consequence of a
crash mid-upgrade); a reader hitting `message_id = -1` **with** `id_source`
resolves it correctly; and a reader hitting `message_id = -1` **without**
`id_source` — a row written by an older build — degrades to the documented
back-compat path rather than misreporting. The last one matters most: it is the
only test that exercises what an old row looks like to new code, which is the
state every deployed machine passes through.

**Append-failure classes.** Each is a test, not a hope: a **disk-full** append, a **permission-denied**
append, a **missing/unwritable log directory**, a **rotated log** (the file moved
out from under a held path), and **seeding against a very large existing file**.
The first three assert the same contract — the throw is caught, the counter
increments, the injection still happens — and that a *sustained* run of them
raises Attention rather than only incrementing a counter nobody reads, since a
counter that never surfaces is how this class of bug stays invisible. Rotation
asserts that the next append re-resolves the path rather than writing into an
unlinked handle. Large-file seeding asserts a bounded read, so a long-lived log
cannot make process start slow.

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
or left dark after acceptance. The artifact is **attached to the acceptance
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

**Also verified during acceptance: the single-instance lock is active** on the
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
