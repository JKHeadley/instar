---
title: "Telegram topic names reach every machine"
slug: topic-name-replication
parent-spec: docs/specs/no-data-loss-on-machine-death.md
eli16-overview: docs/specs/topic-name-replication.eli16.md
tier: 2
author: echo
created: 2026-11-20
closes: CMT-2095
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
lessons-engaged: "P19 No Unbounded Loops (carry-once, drain with backoff and ceiling); P20 Verify the State, Not Its Symbol (evidence reads the registry, not the emit); P21 multi-machine posture; P22 Self-Heal Before Notify (drain retries before the one report); Migration Parity (backfill of pre-upgrade names)"
parent-incident: "Post-mortem of the Mac Studio outage of 19-20 November 2026, ledger item N40 (approved by the owner, topic 145840, message 145918, 2026-11-20 10:33 PST)."
review-convergence: "2026-11-21T05:30:16.917Z"
review-iterations: 6
review-completed-at: "2026-11-21T05:30:16.917Z"
review-report: "docs/specs/reports/topic-name-replication-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 1
contested-then-cleared: 12
approved: true
approved-by: "Echo (author), self-approval under Approval Only Where Required (2.0 Rule 82): this spec amends neither the constitution nor a CODEOWNERS-protected path (checked 2026-11-20: only docs/STANDARDS-REGISTRY.md and .github/CODEOWNERS are owned). Basis: the owner approved the Studio outage post-mortem and its fix program (Justin, topic 145840, message 145918, 2026-11-20 10:33 PST: \"The postmortem is approved. We need to start on this work desperately.\"), of which this is ledger item N40 / CMT-2095; approved after reading the convergence report, including its Left behind section."
---

# Telegram topic names reach every machine

This is a standalone amendment to `docs/specs/no-data-loss-on-machine-death.md` (converged and approved 2026-11-20, PR #3530, not yet on `main`). That spec's state census lists `conversation-names` (its §2 table) among the categories that must not live on one machine, and names `conversation-graph-event` or a general `agent-setting` record kind (not built yet) as its carriers, decided per field. This spec closes the Telegram topic-name half of that row now, on the replication path that already ships, so it does not wait for `agent-setting`. When the census lands it names the kind below as the carrier of Telegram topic names.

## Problem statement

Telegram topic names live in each machine's own `.instar/topic-session-registry.json` (`topicToName`), held in memory by `TelegramAdapter` (`src/messaging/TelegramAdapter.ts`), written by `saveRegistry()` and read once at boot by `loadRegistry()`. A machine learns a name in only four ways, all local:

1. it created the topic (`createForumTopic`),
2. it renamed the topic (`editForumTopic`),
3. it saw Telegram's own creation or rename service message, or a message replying to the creation message (`captureTopicName`, from the poller or the lifeline forward),
4. a session was bound with a name (`registerTopicSession`).

Only the lead machine polls Telegram, so only the lead sees (3), and most creations and renames happen there too. Standbys never learn names or renames. When the old Studio died on 19-20 November, 13 project topics showed "Name not available" on every surviving machine, and the names were repaired by hand on the Studio, the Laptop and the Mini (ledger N40). The next lead loss repeats it.

Goal: a name, and every later rename, reaches every machine of the agent within minutes, is applied to that machine's in-memory map and persisted to its registry file, and survives the machine that learned it dying. An older name never replaces a newer one.

Out of scope here: what a surface displays when no name is known (#3546 and #3573, owned by topic 127504), and Slack or app conversation names (they have their own stores).

## What already exists

- The WS2 replicated-record path (`docs/specs/WS2-SEND-SIDE-EMISSION-SPEC.md`, `docs/specs/multi-machine-replicated-store-foundation.md`): a `ReplicatedKindRegistry`, the `CoherenceJournal` own streams, `ReplicatedRecordEmitter.emit(store, recordKey, build)`, `JournalSyncApplier` pulling peers' streams, `ReplicatedPeerStreamReader` for reading landed peer records at boot, and the peer-commit observer in `src/commands/server.ts` that hands each newly landed batch to the store that owns its kind.
- Small stores already ride it with the same shape this spec uses: `conversation-list-pin` (`src/core/ConversationListPins.ts` + `ConversationListPinsWiring.ts`) and `conversation-graph-suggestion-record` (`src/core/ConversationGraphSuggestionDecisions.ts`). Immutable rows, a state-file outbox with an `emitted` flag, landing of peer rows already on disk at boot, and a per-row re-send for rows the emitter refused.
- On a standby the server still builds a `TelegramAdapter` in send-only mode (`resolveTelegramStartupTopology`), with the same `topicToName` map and registry file. So every machine that runs the agent's server has a map to apply names into.

## Proposed design

### 1. The record kind

New kind `telegram-topic-name-record`, store key `telegramTopicNames`, registered in `server.ts` beside the other kinds and added everywhere a journal kind is listed: the `JournalKind` union, `JOURNAL_KINDS`, the per-kind maps in `CoherenceJournal.ts` (seq, high-water, retention `{ maxFileBytes: 2 MiB, rotateKeep: 0 }`, rate bucket), the kind list pinned by `tests/unit/CoherenceJournal.test.ts`, `JournalSyncApplier`'s feature-evidence map (`multiMachine.stateSync.telegramTopicNames`), `RECONCILER_ALLOWLIST`, the state coherence registry (category `telegram-topic-names`, `fixed-cardinality`) and the `BackupManager` file list.

Each record carries one immutable row:

```
{ eventId: uuid, chat: string, topicId: number, name: string, atMs: number, source: 'rename' | 'lead' | 'fill', seq?: number }
```

- `eventId`: random UUID, unique per change. `recordKey = sha256("telegram-topic-names\0" + eventId)`.
- `chat`: the agent's Telegram group id (config `chatId`). Thread ids restart when a group is replaced, so a machine ignores rows for any other group; an old group's renames can never name a new group's topics.
- `topicId`: a safe positive integer (Telegram thread ids, including the issues-group offset range).
- `name`: trimmed, 1 to 128 characters (Telegram's own limit), no control characters, line breaks, bidi overrides or zero-width marks (a name reaches prompts and screens on every machine), and it must pass `verifiedChannelIdentity('telegram', topicId, name)` so a `topic-N` placeholder is never shared.
- `atMs`: when the change happened (see section 3 for which clock).
- `source`: `rename` for Telegram's own evidence of a rename; `lead` for a name the Telegram lead held before this change shipped (section 4); `fill` for everything else (a creation, a reply quoting the creation message, a name another machine held before this change shipped). `lead` and `fill` rows are both gap-fills on a receiver (section 5).
- `seq`: Telegram's message id of a rename notice (ordered per chat), present only on rows made from a notice.

The validator is strict: an unknown or malformed field rejects the whole record, and `op: 'delete'` is refused (renames are new rows; a Telegram topic always has a name).

### 2. The fold: which row wins for a topic

For each `topicId` exactly one winning row: `rename` beats `lead` beats `fill`; then the larger `atMs`; then the larger `seq`, a row without one ranking lowest (two rename notices in the same second follow Telegram's message order); then the larger `eventId` (code-unit order); then the name (so even a malformed duplicate event id resolves the same everywhere). One lexicographic key, so the fold is a total order. The fold is order-independent, so every machine holding the same rows picks the same winner.

A peer row stamped more than the clock-drift bound in the future (the foundation's clamped `maxDriftMs`, default 5 minutes) is not accepted yet. A broken clock therefore cannot make one row win forever. The store holds such rows in memory by event id (at most 1000, dropping the farthest-future first) and reconsiders them on a timer when their time comes (at most hourly), so a long-running machine does not need a restart to take it; a restart re-reads it from the peer stream.

### 3. Where rows are made (local evidence)

`TelegramAdapter` gets one publish seam, `setTopicNameReplicationHook(hook, authority)`. The hook runs after the map changed and BEFORE `saveRegistry()`, at exactly these places:

| Place | Source | Stamp |
|---|---|---|
| `createForumTopic` success (stores Telegram's returned name) | `fill` | the author clock, after the held winner (an API result is what Telegram holds now) |
| `editForumTopic` success with a changed name | `rename` | the author clock, after the held winner |
| `captureTopicName` from a rename service message (poller or lifeline) | `rename` | Telegram's own message time when known, taken as the END of its second (`msg.date * 1000 + 999`, forwarded by the lifeline as `topicEventAtMs`), so an owner's rename in the same second as an agent's API rename wins; plus `seq` = the notice's message id (lifeline: `topicEventSeq`); else the author clock |
| `captureTopicName` from a creation service message or a reply quoting the creation message | `fill` | the author clock |

The author clock is the machine's wall clock (`Date.now()`, NTP-synced), which is comparable with Telegram's own message times. The HLC is deliberately not used for these stamps: it can run ahead of real time by a peer's skew, which would let an agent's API rename beat a later owner rename. "After the held winner" comes from `winner.atMs + 1`, not from the clock.

Whether Telegram also sends the bot a rename notice for its own `editForumTopic` call is not relied on either way: if it does, that notice becomes a second rename row with the same name, which changes nothing anyone sees.

A rename notice or rename API result is published even when its text equals the name shown, so a rename back to an earlier name advances the version (renames A, B, A delivered as A, A, B end on A everywhere). A creation name equal to the held name publishes nothing.

The hook returns the name the map should hold. It is the new name unless a held `rename` winner beats this evidence: a reply quoting the creation message after a rename, or a delayed rename notice older than a newer rename. Then the map is put back to the held name. So the creation name can never undo a rename, on this machine or any other.

`registerTopicSession` does not publish (its name comes from a caller, not from Telegram). When the store holds a rename winner for that topic, or a fill winner this machine applied, the bind keeps that name instead of the caller's (`authority`), so a standby re-binding a session with an old title cannot overwrite a replicated name, and a fill this machine refused is not forced in by a bind either. The replicated apply path never calls the hook.

### 4. Backfill: names held before this change

At boot, after peer rows are landed and the adapter reconciled (section 8), the store makes one `fill` row for every verified name in the adapter's map that has no row yet. Fill rows only fill gaps (section 5), so a stale name on one machine never overwrites a name another machine holds. This is the outage case: a machine that has no name for a topic gets one.

Standbys never saw renames, so their pre-upgrade names are often stale creation names, and whichever machine upgrades first would otherwise decide the shared fill. So the machine that is the Telegram lead at its first boot with this change (`coordinator.isAwake`, the machine that saw the renames) shares its pre-upgrade names as `lead` rows, including where the held winner is a fill (even one with the same text, so its rank protects it from a later stale fill). `lead` outranks `fill` whatever order the machines upgrade and reconnect in, and replaces names other machines hold only because a fill put them there. This is decided **once per machine, at its first boot with this change, whatever its role then** (a marker in the state file): a standby that becomes lead later never promotes its own pre-upgrade names, and the backfill turns a held `fill` into a `lead` row, never a held `lead` row. (Lead rows that two machines emitted independently still compete in the fold by time, as the residual risks describe.) So the lead role can move freely (it did in the outage) without leads re-filling against each other; only renames correct names from then on.

### 5. Applying a winning row on a receiver

When a peer row becomes the new winner for its topic:

- a `rename` winner is applied to the adapter (`applyReplicatedTopicName`);
- a `fill` winner is applied only where the adapter holds no verified name, or where the name it holds was put there by an earlier `fill` winner (the store remembers those in `filled`). So two empty machines that receive conflicting fills in opposite orders still end on the same name, while a name a machine held itself is never replaced by a fill.

If the registry file write itself fails, the adapter logs it as it does for any registry write today; the map already holds the name, so the adapter's next registry write (any session bind, capture or apply) carries it, and the boot reconcile re-applies every winner.

Write order: the store's state file (including `filled`, which records the fill being applied) is written before the registry file, and the registry is written only if that state write succeeded (memory holds both; the next change or boot retries). `filled` is stored with the chat it describes and ignored for any other group. A crash between the two is repaired at boot: the reconcile re-applies a fill whose name `filled` already records, and re-applies every rename winner.

Applying sets the map; a replaced real name fires the adapter's rename handler so a bound session's display label follows. That handler is now registered in the send-only branch too (standbys, and leads whose lifeline owns polling), not only the polling branch. A batch writes the registry file once and the store's state file once, never per row.

### 6. Carrying: names survive the machine that learned them

The foundation serves only a machine's own streams (relaying a departed origin's streams is `no-data-loss-on-machine-death` §3.3, increment 6, not built). So every machine that accepts a peer row as a new winner also emits the **identical** row (same `eventId`, `topicId`, `name`, `atMs`, `source`) into its own stream. A receiver that already holds that row does not see a new winner and does not carry it again, so each row is carried at most once per machine and carrying stops. Rows carry no claim of authorship; the first-hop sender binding stays the only origin. A rebuilt machine learns every current name from any survivor.

Cost: a rename produces one row per machine. The first boot after upgrade is a one-time burst: each machine backfills its names, and fills that win are carried, about machines × topics rows per stream at most (5 machines × 400 topics × under 400 bytes is about 800 KB per stream, inside one 2 MiB file, never deleted).

### 7. The store, its state file and the drain

`TelegramTopicNameStore` (`src/messaging/TelegramTopicNameReplication.ts`) keeps the winner per topic with an `emitted` flag, plus the `filled` names, in `state/telegram-topic-names.json` (tmp + fsync + rename, mode 0600). Only winners are kept, so the file grows with the number of topics, the same bound as `topicToName`.

Only `emitted` and `dropped:deduped` count as sent. `dropped:schema-rejected` and `dropped:oversize` are final (the journal will never take that row): the row is marked final in the state file, reported once, and never retried, also not after a restart (the own-stream check skips final rows). Every other outcome (including `unconfirmed` and `dropped:rate-limited`) leaves the row unsent. Rows go out in batches of at most 80 (under the journal's per-kind token bucket of 100), and a **drain** sends the rest while the process runs: after a tick that sent rows the next batch goes 5 seconds later; a tick that sends nothing backs off from 2 minutes, doubling to 1 hour; a new row resets it. After six ticks that send nothing it reports `TelegramTopicNames.replication` once and keeps trying hourly. At boot, rows marked sent that this machine's own stream does not hold are marked unsent again.

### 8. Boot wiring

`src/messaging/TelegramTopicNameReplicationWiring.ts` runs once the adapter, the emitter, the peer reader and the own machine id exist, and **before** `telegram.start()` (in the send-only branch, right after routing is wired), so no name the adapter learns goes unpublished:

1. build the store and attach the emitter hook and the drain; read the adapter's own names (before anything from a peer is applied: only these are backfilled, so a name borrowed from a peer's fill never gains `lead` authority);
2. land every peer row already on disk (own origin skipped), applying winners and carrying them;
3. reconcile: re-apply every held winner to the adapter (covers a crash between the store's write and the registry's);
4. backfill (section 4);
5. mark lost own-stream rows unsent; attach the adapter hook; send the first batch and arm the drain.

The peer-commit observer gets one line for this kind. Any wiring failure detaches the hook, is reported to `DegradationReporter` (`TelegramTopicNames.replication`) and leaves the adapter exactly as it is today; it never blocks boot.

### 9. Switch

On wherever the coherence journal runs (the suggestion-decisions posture): `_telegramTopicNamesOn = !!coherenceJournal && _stateSyncStoresBase?.telegramTopicNames?.enabled !== false`, forced into the resolved stateSync map (and into the resolver's return condition, so it survives an agent with no other forced store), with `multiMachine.stateSync.telegramTopicNames.enabled: false` as the kill switch. Ladder entry `disposition: finished`, `final: default-on`. Awareness entry `src/data/awareness/telegram-topic-names-shared.md`. An agent with journal replication off records feature evidence `held: journal-replication-not-on` at boot.

## Multi-machine posture

- Topic names: **replicated** through `telegram-topic-name-record` (store `telegramTopicNames`) on the WS2 path; every machine applies winners to its own `topicToName` and registry file.
- Survival of the learning machine: **replicated by carrying** (section 6) until relaying (parent §3.3) lands; carrying stays harmless after that.
- `state/telegram-topic-names.json`: the **outbox and fold cache of replicated rows**, not machine-local agent state. Its winner rows are exactly what crosses; a row not yet sent lives only here until the drain sends it, which it keeps doing, so it is replicated-in-transit, never stranded by design. The `emitted` flag is checked against this machine's own stream at every boot. `filled` is per-machine bookkeeping about this machine's copy of a replicated name (which names a fill put in its registry); losing it is safe: fill-applied names are then treated as the machine's own, so later fills stop replacing them (never a wrong overwrite), and the next rename corrects them.
- Notices: none. This feature sends no message to anyone.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| Which row wins for one topic (rename > lead > fill, then `atMs`, then `seq` with a missing one lowest, then `eventId`) | invariant; basis: enumerable-domain; evidence: the domain is the finite set of rows held for one topic id and the rule is a total order on row content every machine computes the same way, so all machines converge on one name | Convergence of a name, not a judgment between competing signals. |
| Which evidence counts as a rename (the `editForumTopic` API result, Telegram's rename service message) and which only fills (creation, reply quoting the creation message, pre-existing names) | invariant; basis: enumerable-domain; evidence: the name sources are the four listed in the problem statement; only a rename event says what the name is now, while a creation name or a reply quoting the creation message says what the name was at creation | A rename misclassified as fill only fills gaps (a missed update that the next rename fixes); a creation name misclassified as rename would undo real renames everywhere, the failure this rule exists to stop. |
| A fill winner replaces only a gap or a name an earlier fill put there | invariant; basis: irreversible-consequence; evidence: a fill row's age relative to another machine's held name is unknown, and replacing that name could overwrite a newer rename the owner made, with no newer evidence left anywhere to restore it | Fills gaps only; a mismatch present before the upgrade heals on the next rename. |
| An API result is stamped by the wall clock and after the held winner; a rename notice uses Telegram's time (end of its second) and message order | invariant; basis: external-constraint; evidence: after a successful `createForumTopic`/`editForumTopic` Telegram holds exactly that name, so it must beat what is held; a notice can arrive late (lifeline queue, restart), and only Telegram's time and message id place it against other renames; wall clocks are NTP-synced and so comparable with Telegram's time, unlike an HLC that absorbs peers' skew | The remaining window (an agent rename and an owner rename within about a second plus NTP error) is a residual risk. |
| A peer row stamped beyond the drift bound in the future is not accepted | invariant; basis: external-constraint; evidence: the foundation already clamps HLC skew to `maxDriftMs` (60 s to 15 min, default 5 min, `HybridLogicalClock.ts`); a row further ahead can only come from a broken clock and would otherwise win every later rename forever | Re-read at a later boot once its time has come. |
| Which emitter outcomes count as sent | invariant; basis: enumerable-domain; evidence: `EmitOutcome` is a closed set; only `emitted` (enqueued) and `dropped:deduped` (already held) prove the journal holds the row; every other outcome is retried by the drain | Retrying never harms; skipping a retry can strand a name. |
| A session bind keeps the replicated name over the caller's: a rename winner, a fill winner this machine applied, or any winner when the machine holds no name | invariant; basis: enumerable-domain; evidence: a bind's name comes from a caller (spawn name, a forwarded creation name), not from Telegram, so it is never newer evidence than a rename winner; a fill winner this machine refused (it held its own name) is not forced in by a bind, keeping the fill-fills-gaps-only rule | Otherwise the bind behaves as today. |
| The lead's pre-upgrade names outrank other machines' pre-upgrade names, decided once per machine at its first boot with this change | invariant; basis: enumerable-domain; evidence: before this change only the lead polled Telegram, so only its map saw renames, and a standby's pre-upgrade name is at best equal and often a stale creation name; this holds only for names held BEFORE the change, which is why each machine decides it once, at its first boot with this change, and a `lead` row never replaces another `lead` row | Gap-fills still never replace a name a machine held itself. |
| Which journal refusals are final (schema-rejected, oversize) | invariant; basis: enumerable-domain; evidence: `JournalEmitOutcome` is a closed set, and those two refuse the row's content itself, so the same row can never be accepted | Reported once instead of retried hourly forever. |

## Authority and fixed limits

This feature gates nothing, blocks nothing and sends nothing. What it writes is the topic-name map on each machine, and that map is more than a display string: it seeds session names at spawn, goes into the message context a session's model reads, and `findOrCreateForumTopic` reuses a topic by name. So a name another machine learned now reaches those places on this machine too. That is the point (the same name everywhere), and it is why names are validated strictly (no control characters, line breaks, bidi overrides or zero-width marks; Telegram's length limit; no placeholders) and why the only writers are the agent's own paired machines (first-hop sender binding in `JournalSyncApplier`). A name reuse by `findOrCreateForumTopic` on a standby now finds a topic the lead created, which avoids a duplicate topic rather than creating one.

Fixed limits:

- name length 128 characters; basis: external-constraint; evidence: Telegram's `createForumTopic`/`editForumTopic` reject longer names, and `captureTopicName` already clamps at 128.
- 1000 future-stamped rows held in memory; basis: irreversible-consequence; evidence: none is lost by the bound (a dropped row stays in its peer's stream and lands at the next boot), while an unbounded in-memory set fed by a broken peer clock would grow without limit; only a clock running more than the drift bound ahead produces such rows, so a healthy pool holds none.
- 80 rows per send batch; basis: external-constraint; evidence: the journal's per-kind token bucket holds 100 (`DEFAULT_RATE_CAP` in `CoherenceJournal.ts`); a batch under it leaves room for other emits of the kind in the same second.
- 5 seconds after a tick that sent rows; basis: external-constraint; evidence: the bucket refills 50 per second, so 80 rows are available again after under 2 seconds; 5 seconds leaves room for other emits of the kind, and a 400-name backfill finishes in under half a minute.
- drain 2 minutes doubling to 1 hour after a tick that sent nothing, report after six such ticks: **cheap-to-change-after** tunables, not invariants. They only set the retry cadence of an outbox that never drops a row, are constants in one file, and a revert or edit changes nothing stored. Chosen for the owner's goal (names within minutes: first retry minutes away), a bounded cost during an outage (at most 24 attempts a day at the ceiling), and about two hours of trying before anyone is told.
- journal retention 2 MiB per file with `rotateKeep: 0` is a file-rotation size, not a limit on what is kept (rotation never deletes); it matches the other small immutable-row kinds.

## Evidence (what each check reads)

- "A name reached machine B" is read from B's own `topic-session-registry.json` and its in-memory map (`getTopicName`), which is what the dashboard reads, never from the fact a record was emitted.
- "A row went out" is read from the emitter's outcome and, at the next boot, from this machine's own stream (rows marked sent but absent are sent again); an unknown outcome is retried, never assumed sent.
- Unmeasurable: if the peer stream is unreadable at boot, landing is skipped for that boot and reported; later commits still land through the observer.

## Residual risks

- A name learned by a lead that dies before any peer pulls its stream (a few minutes at most) is lost until the topic is renamed again or a display fallback names it. The display fallback for an unknown name is owned by topic 127504 (#3546, #3573), and Telegram itself still holds the name (a later message or rename in that topic re-teaches it).
- Two API renames of one topic on two machines within the same instant: the later stamp wins everywhere; Telegram keeps whichever call landed last, which may differ. Only the lead normally renames.
- Ordering between an agent's API rename (stamped by the wall clock) and an owner's rename in Telegram (stamped at the end of Telegram's second) that happen within about a second of each other plus the machine's NTP error may resolve either way, on every machine alike. The next rename fixes it. Telegram exposes no shared ordered version for topic edits to do better.
- A legacy mismatch (two machines held different names before upgrade) stays until the next rename on any machine that held its own name, because fills fill gaps only. Machines that had no name take the lead's.
- Two machines that each believe they are lead at their first boot with this change (a lease flap during a fleet-wide update), or that are lead on different upgrade days, both send `lead` rows; the later stamp wins as the shared gap-fill. Both saw renames during their time as lead, and `lead` rows only fill gaps, so the true lead keeps its own name and the next rename corrects the rest.
- A rename from a peer whose clock runs far ahead (more than the drift bound) waits until its stamp is due, and then beats real renames made in between, because its time is larger. It needs a clock off by more than 5 minutes; the next rename after it corrects the name.
- Replacing the agent's Telegram group: rows of the old group are ignored (the `chat` field), so the new group's names start fresh. The topic registry itself is not group-scoped (pre-existing); a machine whose registry still holds the old group's names would share them as gap-fills for reused topic ids. Replacing the group already requires resetting the registry today, and a rename in the new group corrects any such name.
- `TelegramAdapter`'s attention-item path overwrites the lead's map with the item title after creating the topic (`item.title` vs the created title) without the hook; the other machines show the created title. Pre-existing and cosmetic; left as is.
- A machine with journal replication off neither sends nor receives; recorded as held evidence at boot.

## Tests (all three tiers)

- Unit (`tests/unit/telegram-topic-name-replication.test.ts`): validator (bad ids, empty, overlong, control characters, placeholder, delete op, extra fields); fold (rename over fill, later `atMs`, `eventId` tiebreak, order independence); `recordLocal` stamps (API result beats a held winner whatever the clock; a rename notice older than a held rename loses and the held name is returned; a reply quoting the creation name after a rename returns the rename); backfill fills gaps and never replaces a verified name; opposite-order fills converge on two empty machines; a far-future row is not accepted; carrying emits the identical row once and a duplicate is not carried again; refused emits are retried by the drain without a restart and progress keeps the base cadence; a batch writes the registry once; reconcile re-applies a winner after a simulated crash; the state file survives a reload. Adapter: the hook fires on create, edit and capture only when the name changed, runs before the registry write, is not called by `registerTopicSession` or by apply; a bind keeps a held winner's name.
- Integration (`tests/integration/telegram-topic-name-replication.test.ts`): two machines, each with a real `CoherenceJournal`, emitter, peer reader and real `TelegramAdapter` (no network): a rename on A lands on B the way the observer hands it, B's registry file holds it after a reload, B's own stream holds the carried row, and a third machine C that only reads B's stream learns it with A gone.
- E2E (`tests/e2e/telegram-topic-name-replication-alive.test.ts`): the production init path with the kind registered exactly as `server.ts` does it and the real wiring module: a captured name emits one record into the own stream, a restart sends nothing again, the kill switch emits nothing; plus WIRED source checks on `server.ts` (registration, switch and resolver condition, observer line, wiring before `telegram.start()`, rename-label handler in the send-only branch).

## Rollback

Set `multiMachine.stateSync.telegramTopicNames.enabled: false` (or revert the PR). Names already applied stay in each registry file, which is correct data. Journal lines of the kind stay inert on disk (a machine that does not register the kind ignores them). No migration.

## Maturation plan

- **test-agent-live:** the integration test drives three machines through real journals, emitters, peer readers and real Telegram adapters, and the e2e test drives the production wiring; no throwaway agent is needed for a change that sends nothing. On Echo's machines, a rename made in Telegram is checked to appear on a standby's dashboard within one sync interval.
- **dev-agent-live:** Echo runs it on its machines from release; the check is that a renamed topic shows the new name on every machine, and that each boot log shows the pre-upgrade names shared once.
- **fleet:** ships on wherever the coherence journal runs (a fix for a tracked gap, CMT-2095, Studio outage ledger N40), with the off switch `multiMachine.stateSync.telegramTopicNames.enabled: false`.
- **graduation criterion:** no `TelegramTopicNames.replication` degradation on Echo's machines for 7 days, and no topic showing "Name not available" on a standby while the lead knows its name.
- **dark-window:** none: not a staged rollout (finished disposition in the ladder); rollback is the off switch or the release.
- **ladder:** multiMachine.stateSync.telegramTopicNames

## Parent census handoff

The parent's census row `conversation-names` (no-data-loss-on-machine-death §2) names `conversation-graph-event` or `agent-setting` as carriers, decided per field. For the Telegram topic-name field the carrier is now `telegram-topic-name-record`. This PR's description states that for the parent's census build, and this run's report to the run lead of topic 145840 (who owns PR #3530 and the census build) names the census row change, so the census build lists this kind when it is written.

## Frontloaded Decisions

1. Ride the WS2 record path with a new kind rather than the parent's planned `agent-setting` (not built yet).
2. Immutable rows keyed by `eventId`, one winner per topic, no deletes.
3. Order: rename > lead > fill, then `atMs`, then `seq` (missing lowest), then `eventId`: one lexicographic key, so the fold is a total order.
4. Only the rename API result and Telegram's rename service message are renames; creation names, replies quoting the creation message, and pre-existing names only fill gaps.
5. API results are stamped after the held winner; rename notices use Telegram's message time.
6. Carry accepted rows once into the own stream so names survive the learning machine.
7. Session binds keep the replicated winner's name.
8. Batches of 80 under the rate cap and an in-process drain, not boot-only retry.
9. Default on wherever the journal runs, with a kill switch; ladder disposition `finished`.
10. Wire before `telegram.start()`, and register the rename-label handler on every machine.

## Open questions

*(none)*
