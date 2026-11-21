---
title: "Conversations suggestions: the owner's decisions reach every machine"
slug: conversation-graph-suggestions-replicated-decisions
parent-spec: docs/specs/conversation-graph-suggestions.md
eli16-overview: docs/specs/conversation-graph-suggestions-replicated-decisions.eli16.md
tier: 2
author: echo
created: 2026-11-17
closes: CMT-1650
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
review-convergence: "2026-11-18T01:26:55.990Z"
review-iterations: 6
review-completed-at: "2026-11-18T01:26:55.990Z"
review-report: "docs/specs/reports/conversation-graph-suggestions-replicated-decisions-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 17
cheap-to-change-tags: 0
contested-then-cleared: 6
approved: true
approval-note: "Approved under Justin's standing rule that only constitution changes need his approval (memory only-constitution-changes-need-justin; his words 2026-10-22: 'I should ONLY have to approve constitution changes'), plus his explicit go on 2026-11-17 15:37 PST in Telegram topic 134088: 'great, yes please proceed with this and the remaining \"instar topic managment\" work'. Checked 2026-11-17: this change touches no constitution file and nothing named in .github/CODEOWNERS (docs/STANDARDS-REGISTRY.md, .github/CODEOWNERS)."
---

# Conversations suggestions: the owner's decisions reach every machine

This is a delta to `docs/specs/conversation-graph-suggestions.md` (approved 2026-11-11, commit d85721679). It replaces that spec's §5 ("Multi-machine posture"), which declared all suggestion state machine-local and tracked this change as CMT-1650. Nothing else in the parent spec changes. The parent's approval covered a machine-local design only, so this delta needs its own convergence and approval before code.

Wording note: the user-facing word is "group" (the wording change on branch `echo/conversations-group-wording`); internal names (`effort`, `create-effort`, the `conversation-graph-suggestions.json` file) are unchanged.

## Problem statement

The suggestion step (`src/server/ConversationGraphSuggestionService.ts`) remembers three owner decisions per suggestion id in `.instar/conversation-graph-suggestions.json` (in the state dir) on the machine that served the request:

- `rejected[id]`: the owner tapped Reject. The parent spec promises it is "never offered again".
- `accepted[id]`: every Accept step finished. Never offered again.
- `accepting[id] = { createRequestId, startedAt, ... }`: an Accept has started. `createRequestId` is the idempotency key of the owner's `create-effort` request, so a reload, a second tab or a later visit continues the same request and gets the same group.

The dashboard can be served by any of the agent's machines. Today:

1. A rejection made on machine A is unknown to machine B. B can offer the same grouping again (its build's prompt filter and its offered list read only B's file). The parent spec scoped this gap explicitly (its §5, tracked as CMT-1650); this change closes it so "never offered again" holds on every machine.
2. On `main`, `beginAccept` mints a random `suggestion-<uuid>`, and the dashboard keeps the request id and the created group in the browser after the create step. An Accept started on A and continued on B (or in a second browser) mints a second id, so a second group is created and members can be split across the two.
3. An Accept started on A is unknown to B: B neither shows Continue nor keeps that suggestion's members out of its next build, so B may suggest an overlapping grouping while A's Accept is still moving conversations.

## Proposed design

### What replicates and what stays local

| State | Posture | Why |
|---|---|---|
| `rejected`, `accepted`, `accepting` (the owner's decisions) | **Unified**: replicated as `conversation-graph-suggestion-record` | The owner made them; every machine must honor them. |
| The suggestion an Accept is working on (its id, name, member refs, front door) | **Unified**: carried on the `accepting` row as a snapshot | B must be able to show Continue, keep the members out of its builds and finish the same Accept even when B's own build never produced that grouping. |
| What a finished Accept did (`acceptResults`, from `conversation-groups-phone`) | **Unified**: carried on the `accepted` row when present | A repeated Accept on B must answer what happened, not "nothing moved". |
| The built list (`suggestions`, `builtAt`, `lastAttemptAt`, `lastFailure`) | **Machine-local** (justification marker in Multi-machine posture) | A cache of advice the parent spec (approved, d85721679) declared machine-local; every input it is built from is already unified. |
| Accept progress (`accepting[id]` fields beyond the request id, from `conversation-groups-phone`) | **Machine-local**, a resumable cache | Every step's request id is derived, so a machine without the cache re-sends the same requests and finds each step done. |

### One request id per Accept on every machine

`beginAccept` stops minting a random id. The create request id is derived from the suggestion id: `suggestionCreateRequestId(id)` (in `src/core/ConversationGraphSuggestions.ts`) = `"sga-" + sha256("conversation-group-accept\n" + id + "\ncreate\n").hex.slice(0, 40)`, the same value as `acceptRequestId(id, 'create')` in the parallel change `conversation-groups-phone` (a unit test pins the formula), so both changes produce the same ids. Every tab and every machine sends the same `create-effort` request, and the owner pipeline's replicated idempotency returns one group. This removes the second group of problem 2 at its source, on `main`, independent of replication. The owner changes route already accepts this id shape (`^[A-Za-z0-9_.:-]{8,160}$`). An `accepting` entry written before the upgrade keeps its `suggestion-<uuid>` id (its create may already have committed with it).

### The store

The shape of the conversation-list-pins store (`src/core/ConversationListPins.ts` + `ConversationListPinsWiring.ts`: immutable owner rows, a local outbox file, landing of peers' rows), plus a drain tick. No new endpoint, peer route or transport.

- New module `src/core/ConversationGraphSuggestionDecisions.ts`: `SuggestionDecisionStore`, the schema, the fold, the kind registration, and `wireSuggestionDecisionStore(Safe)`.
- Journal kind `conversation-graph-suggestion-record`, store key `conversationGraphSuggestions`. Added to `JournalKind` / `JOURNAL_KINDS` and the per-kind tables in `CoherenceJournal.ts` (retention `maxFileBytes: 2 MiB, rotateKeep: 0`), the evidence-label table `STATE_SYNC_FEATURE_BY_KIND` in `JournalSyncApplier.ts` (labels only; nothing on the receiving side reads it), `RECONCILER_ALLOWLIST` (written only by the suggestion service; no CLI path; immutable rows), and registered with the `ReplicatedKindRegistry` beside the other registrations in `server.ts`.
- A row (exact; validated by the store schema on the send side and again on landing; any other field, a malformed value, or `op: 'delete'` is refused and counted, never repaired):
  - `suggestionId`: `^sg-[a-f0-9]{20}$`.
  - `decision`: `'rejected' | 'accepted' | 'accepting'`.
  - `atMs`: safe non-negative integer, wall-clock ms on the deciding machine.
  - `accepting` rows only, both required:
    - `createRequestId`: either exactly `acceptRequestId(suggestionId, 'create')`, or a legacy `^suggestion-[0-9a-f-]{36}$`. An `sga-` value that is not the derivation for this suggestion is refused, so a row can never point one suggestion's Continue at another suggestion's group.
    - `snapshot`: `{ title, members, frontDoor? }`. `title`: 1 to 60 UTF-16 code units, control characters refused; the sender normalizes the stored name first (control characters to spaces, whitespace collapsed, sliced to 60, `Group` if empty), because a project name is sliced but never cleaned. `members`: 1 to 12 distinct conversation refs, each passing `validateNodeRef` as a conversation. `frontDoor`: a conversation ref that is one of `members`. Integrity check: with `frontDoor`, `suggestionId` must equal `projectSuggestionId(nodeKey(frontDoor))`; without it, `members` must hold at least 2 refs and `suggestionId` must equal `suggestionId(member keys)`. A snapshot that does not hash to its id is refused. For a project suggestion only the front door is bound to the id; its other members are not verifiable from the id (they come from the deciding machine's Chief of Staff tree).
  - `accepted` rows only, optional `result` (on `main` no row carries one: `accepted(id)` takes no result until `conversation-groups-phone` merges): `{ group: effort ref | null, moved, skipped, placedElsewhere }` (`moved` and `skipped` are safe non-negative integers ≤ 12, `placedElsewhere` is a boolean, `group` passes `validateNodeRef` as an effort).
- Replicated data is `{ row }`. `recordKey = sha256("conversation-graph-suggestions\0" + canonicalJson(row))`: identity is the full row content, so two rows that differ in anything (time, snapshot) are two records, and an exact re-send is a duplicate everywhere.
- What a row discloses: the suggested group's name (a model-written name that may echo conversation titles, or a project's name) and conversation refs (ids, never message text), only to the agent's own paired machines, which already hold the full conversation graph and the project names. Kept for as long as the journal (never deleted).
- Local outbox `state/conversation-graph-suggestion-decisions.json` (tmp + fsync + rename, mode 0600): for each `(suggestionId, decision)` only the fold winner is kept, with `emitted: boolean` and `local: boolean`. At most four rows per suggestion id (three decisions plus a result-carrying accepted row), whatever a peer sends for that id; the number of ids is bounded by owner taps on honest machines (a misbehaving machine of the same agent could invent ids; that is inside the same-agent trust boundary). An unreadable outbox is reported (`DegradationReporter`, internal-only) and starts empty; peers' rows land again from the journal at boot.

### The fold (pure, order-independent)

For one `(suggestionId, decision)` the winner is the row with the smallest `atMs`, ties broken by the smaller `recordKey` (code-unit string comparison); for `accepting`, a legacy row (`suggestion-<uuid>`) beats a derived one before time is compared, because a legacy row can only come from before its machine's upgrade and its create may have committed, and clocks across machines can be skewed. Over the winners:

- `rejected` and `accepted`: ids with a winner.
- `accepting[id]`: its winner's `createRequestId` and `snapshot`, ignored when the id is in `rejected` or `accepted`.
- `results[id]`: the earliest `accepted` row that carries a `result` (a backfilled row carries none, and must not hide a later row's result). The outbox keeps one extra slot per id for such a row.
- With derived ids every `accepting` row for an id carries the same request id; the order matters only when a legacy row exists, and then the legacy row wins (the earliest legacy row if there are several).

### How the service uses it

`ConversationGraphSuggestionService` gains an optional dependency `decisions?: SuggestionDecisionStore`. Absent (tests; single machine without the journal; kill switch on) means today's behavior with the derived request id.

- **Reads.** `load()` overlays the folded decisions on the local file: `rejected` / `accepted` gain every folded id; a folded `accepting[id]` missing locally (or carrying a different request id) becomes `{ createRequestId, startedAt }` (local progress fields are kept when the request id matches); the winning snapshot governs the suggestion an Accept works on: when `state.suggestions` has no entry for that id, or its entry differs in name (compared after the row's normalization), members or front door, the snapshot stands in for it (`members` from the refs, `memberKeys` from `nodeKey`, `frontDoorKey = nodeKey(frontDoor)` when present, member titles fall back to `untitledConversationName` because `view` takes live titles only from the unassigned list, `reason`: "Started on another of your machines."). With `conversation-groups-phone`, `acceptResults[id]` is also filled from `results[id]` when absent locally. So `view` shows Continue on B, `start` keeps those members out of B's build input and `build` drops any model group that shares a member with a started Accept when it publishes (a peer's start can land while the model runs), the model-prompt filter excludes peer rejections, and `beginAccept` / `acceptTarget` / `acceptProgress` work on B. The fold result is cached in the store and recomputed only when a row is recorded or landed, so the overlay is a set merge per call.
- **No overlay is persisted.** `load()` attaches a ledger of what it added to the returned state object (a `WeakMap` keyed by that object, so concurrent `load()` calls across a build's await never share it). `save()` writes the state minus the ledger's entries the caller left untouched: an overlaid `rejected` / `accepted` value still equal to the overlay's, an overlaid `accepting` entry still the same object, and an overlay suggestion object still present; an untouched overlaid `accepting` entry or suggestion is replaced by the local entry it stood in for, or dropped when there was none (even inside a rebuilt `suggestions` array), so the local request id and suggestion are never lost by an unrelated save. An entry a local method rewrote (for example `saveAcceptProgress` writing progress for a peer-started Accept) is this machine's own from then on. The local file keeps holding only this machine's own decisions, so the backfill below never re-originates a peer's decision, and switching the feature off leaves the file holding only decisions the owner made on this machine.
- **Writes.** Every method that records a decision writes the local file first (unchanged), then calls `decisions.record(row)`: `reject` (rejected), `beginAccept` when it creates an entry (accepting, with the snapshot of the stored suggestion), `accepted` (accepted, with `result` when given), and, in `conversation-groups-phone`, `closeAccept` (rejected). `record` keeps the row if it wins its key, persists the outbox, and emits that row alone (older unsent rows are the drain's). A row's `atMs` is the same instant the method wrote into the local file (one clock read per decision), so a later backfill rebuilds the identical row. When the owner taps Reject, or finishes an Accept (`accepted`), on a suggestion another machine already decided, the value becomes this machine's own (it leaves the overlay ledger) and is saved in the local file. Continuing a peer's Accept (`beginAccept` returning the folded request id) writes nothing locally; it is the peer's start, and the local `accepted` records the finish.
- **An Accept counts as running only while it is neither rejected nor accepted** on any machine. The build's busy-member filter, the project refresh and the rebuild's keep rule all use that test, so a raw local `accepting` entry that outlived a Reject (from this machine or another) no longer keeps its members out of new suggestions.
- **Backfill.** At boot, right after the store is wired, `backfillSuggestionDecisions(stateDir, store)` reads the local file and hands every local `rejected`, `accepted` and `accepting` entry (except an `accepting` entry whose id is also rejected or accepted here; the fold drops it anyway) to the store's comparator, so a machine that never serves a suggestions request still shares its earlier decisions; the service's first `load()` runs the same step again as a guard (a no-op when nothing changed). Each entry goes to the comparator even when a row for that id and decision is already held: a held earlier or identical row makes it a no-op, and an earlier local row (a pre-upgrade start whose create may have committed) wins over a later one that landed first. Each row's `atMs` is the local entry's own time (`rejected[id]`, `accepted[id]`, `accepting[id].startedAt`), so a repeated backfill produces the same row content and record key, and a legacy start keeps its real start time. An `accepting` entry is recorded only when its stored suggestion is present to snapshot and the request id passes the format check; otherwise it is counted in the boot log. The rows go in as one batch (`recordMany`): one outbox write, at most 100 rows sent at once, the rest left to the drain. Backfill is also how this machine's own rows come back after an unreadable outbox.

### Emission, landing and the drain

- The wiring sets the store's emit hook (`emitter.emit(store, recordKey, data)`). Only `emitted` (the journal enqueued it) and `dropped:deduped` (the journal already holds it) count as sent; this deliberately differs from the list-pins mapping, which also counts `unconfirmed`. `unconfirmed`, a dark store, a rate-cap drop or an error leave the row unsent. A thrown hook is reported through `DegradationReporter` (feature `ConversationGraphSuggestions.replication`, internal-only).
- Boot check: `emitted` means enqueued, not yet fsynced, so a crash before the journal's flush could lose a row marked sent. At every boot each of this machine's own rows (`local: true`) is looked up by record key in this machine's own stream (`ReplicatedPeerStreamReader.loadOriginRecords`, origin = self): present means sent; missing means unsent, and it is sent again. A blind re-send is not used, because the journal's duplicate key includes the HLC, so it would append a new line every boot.
- Drain (with brakes): at boot and on a tick while any row is unsent, unsent rows are emitted, at most 100 per pass; the starting point rotates between passes, so rows refused for good can never starve the rows behind them. The tick starts at 10 minutes and doubles after each tick that leaves rows unsent, up to a 6-hour ceiling, and returns to 10 minutes when the outbox empties or the owner records a decision; it is an unref'd timer, absent when nothing is unsent. After 6 consecutive ticks that leave rows unsent, each such row is reported once per process through `DegradationReporter` (internal-only; the owner's action already took effect on the machine they used). The drain then keeps going at the ceiling, at most four in-memory ticks a day, so a journal that recovers drains with no owner action; a permanently refused row costs at most four attempts a day and one report.
- Landing: at boot the wiring lands every peer row from `ReplicatedPeerStreamReader` (`listRecordKeys` + `loadOriginRecords`, origin ≠ self). The envelope machinery has already checked the row's origin against the stream it came from. After boot, the `journalSyncApplier` commit observer lands each committed batch of this kind (`ingestReplicatedAll`); a batch (and the boot landing) costs one outbox write, not one per row; the store is a module-level `let` in `server.ts`, as `_listPinStore` is, because the observer is installed before the wiring runs. A landed row is never emitted again.

### Wiring path

`server.ts` builds the store where the journal, the emitter and the peer reader exist (outside the app-conversations block), and passes it to `AgentServer` as a new option `conversationGraphSuggestionDecisions`. `AgentServer` adds it to the `graphSuggestions` object, both surface paths (`createConversationGraphSurface` and `createConversationGraphDefaultSurface`) pass it into the service deps. A machine whose graph surface is not mounted still lands rows (they apply once it mounts).

### Enablement and kill switch

On wherever the coherence journal, the emitter and the peer reader exist, resolved like `recommendedServices`: `_suggestionDecisionsOn = !!coherenceJournal && _stateSyncStoresBase?.conversationGraphSuggestions?.enabled !== false`; when on, `_stateSyncStoresResolved.conversationGraphSuggestions = { enabled: true }` and `_suggestionDecisionsOn` joins the return condition of that resolver. Rationale: it carries only the owner's own decisions to the agent's own machines and restricts nothing for any agent ("updates never restrict existing agents"). Kill switch `multiMachine.stateSync.conversationGraphSuggestions.enabled: false`, read at boot: the store is not built at all, so nothing is emitted, nothing lands and nothing is overlaid; every machine returns to machine-local behavior with its local file unchanged (the derived request id stays, it needs no replication). Without the journal (single machine) the store is not built.

### Mixed versions

A peer on an older build does not have the kind in its `JOURNAL_KINDS` and skips these streams. It keeps machine-local behavior until it upgrades; its dashboard may re-offer. The upgrade note says so.

### How an abandoned Accept ends

An `accepting` row is never withdrawn. An Accept the owner gave up on ends when the owner taps Reject on it (the dashboard offers Reject on a started suggestion wherever that browser has not itself created the group; the server's `reject` accepts it), or, with `conversation-groups-phone`, through `closeAccept` when its group is gone. Before this change such an Accept was stuck on one machine with no way out except the same Reject.

### Coordination with `conversation-groups-phone`

That change (branch `echo/mobile-conversation-groups`, unmerged at the time of writing) moves the multi-step Accept into one server function, `src/server/ConversationGraphSuggestionAccept.ts`, derives every step's request id, keeps per-machine progress and results, and adds `acceptTarget`, `acceptProgress`, `saveAcceptProgress`, `acceptStarted` and `closeAccept`. This change does not touch the accept orchestration. It (a) overlays the folded decisions inside `load()`, which all of those methods call; (b) records a row in the decision-writing methods; (c) uses the same `acceptRequestId`. Whichever merges second: adds one `record` call to `closeAccept` (rejected; it is called from `groupGone` in the accept function), passes `result` through `accepted`, and keeps the overlay's rule that local progress fields survive when the request id matches (`saveAcceptProgress` rewrites the whole entry). Expected textual conflicts: the service header comment, `acceptRequestId` (identical), `beginAccept`, `accepted`, `load()`.

## Multi-machine posture

- Owner decisions (rejected, accepted, accepting with its snapshot and request id, a finished Accept's result): **unified**, replicated on the WS2 replicated-record path as `conversation-graph-suggestion-record` (store `conversationGraphSuggestions`), landed at boot and by the journal sync applier's commit observer, read through the service's overlaid `load()`.
- The built suggestion list: machine-local.
  - machine-local-justification: operator-ratified-exception (parent spec `docs/specs/conversation-graph-suggestions.md` §5, approved by the operator and merged in commit d85721679, declares the built list machine-local; this delta narrows that exception to the list alone)
  - Why it stays acceptable: the list is a cache of advice regenerated from inputs that are already unified (the replicated conversation graph, topic-project bindings, topic summaries). Every owner-visible promise (never re-offer a rejection, continue the same Accept, keep a started Accept's members out of new suggestions) is carried by the unified rows, including the snapshot of any suggestion an Accept works on. Two machines' lists can differ only in build timing and model output, never in what the owner decided.
- Accept progress cache (from `conversation-groups-phone`): machine-local.
  - machine-local-justification: operator-ratified-exception (inherits the parent spec's approved machine-local posture, commit d85721679; the cache holds no owner decision, and every step's request id is derived, so a machine without it re-sends the same requests)
- Single-machine survivability: every machine keeps each landed row in its own outbox file, so honoring a decision never needs another machine to be up; a row in flight is ordinary replication lag, the same window as every WS2 store. This is not a Conversations-hierarchy Pending item (Amendment 6): the rows are owner choices about advice, not graph information, so the three receipt states do not apply. The owner sees the effect at once on the machine they used.
- Notices: none added. URLs: none added. Topic transfer: the decisions are agent-wide, so a moved conversation strands nothing.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| Fold rule: which `accepting` row wins for one suggestion | invariant; basis: enumerable-domain; evidence: the domain is the finite set of `accepting` rows held for one id; with derived ids they all carry the same request id, and against a legacy row the earliest start is the one whose create may have committed; the rule is a total order on row content every machine computes identically | Convergence, not a judgment between competing signals. |
| A suggestion is hidden when any machine holds a rejected or accepted row | invariant; basis: enumerable-domain; evidence: the inputs are the three decision values for one id; the parent spec's approved promise is that a rejected or accepted suggestion is never offered again, and this change only extends that rule's reach to every machine | Hides advice only; places, moves and gates nothing. A mis-tapped Reject stays rejected on every machine (the parent has no un-reject; a future un-reject would be a new decision value). |
| A rejected row from B arrives while A's Accept for the same suggestion is still running | invariant; basis: enumerable-domain; evidence: rejected/accepted beat accepting in the fold; the effect is only that the suggestion stops being offered; the graph changes A already made are the owner's own and are never undone by advice | A dashboard Accept already running finishes its steps; if it stops part way, Continue is gone (the suggestion is rejected) and the partly built group stays as ordinary owner state the owner can finish or remove by hand. It is the owner's own Reject. |
| Which emitter outcomes count as sent | invariant; basis: enumerable-domain; evidence: the emitter's outcome set is closed (`EmitOutcome`); only `emitted` (enqueued) and `dropped:deduped` (held) report the journal took the row, every other outcome is retried with backoff, and the boot check against this machine's own stream covers an enqueued row lost to a crash | Retrying never harms; skipping a retry can strand a decision. |

## Authority and fixed limits

No gate, block or route decision is added, and no new authority: rows hide advice and never place, move, hide or send a conversation, and never gate an owner action.

Fixed limits: the outbox is bounded by distinct suggestion ids times four slots (owner taps), not by a chosen cap. Journal retention is `rotateKeep: 0`, which in `CoherenceJournal` means "rotate at the file size, never delete": no row is ever aged out, so the `2 MiB` rotation size decides only file splitting. The snapshot limits (1 to 12 members, a 60-character name): basis: enumerable-domain; evidence: they are the producer's own output domain, since the suggestion builder clips every name to `SUGGESTION_LIMITS.maxEffortNameChars` and never emits more than `maxMembers` members (`parseSuggestionReply`, `syncProjects`), so a 13-member or 61-character snapshot cannot come from a correct machine and refusing it rejects no legitimate row. The drain cadence (10 minutes doubling to a 6-hour ceiling), the 6-tick report point and the 100-rows-per-tick cap are operational brakes: another value changes only how soon a held row is retried or reported, never whether it is kept (the row stays in the outbox and keeps draining). fixed-limits: none introduced.

## Evidence (what each check reads)

- "This machine holds a peer's decision": SYMBOL = a landed row in the store; STATE = the owner decided on another machine; corroboration = the row passed the envelope validator, arrived in a paired machine's per-origin stream (origin checked by the envelope machinery), and, for `accepting`, its snapshot hashes to its suggestion id; unmeasurable (journal off, peer offline) = no row, and the suggestion may be offered (today's behavior, the least harmful outcome for advice).
- "A row was sent": SYMBOL = the emitter outcome; corroboration = only outcomes that report the journal accepted or already held the row flip the outbox flag; unmeasurable (`unconfirmed`, error) = the row stays unsent and is retried, never assumed sent.

## Residual risks

- **A legacy `suggestion-<uuid>` Accept started on two machines before the upgrade** can already have made two groups; this change cannot merge them. From the upgrade on, both machines continue the earliest one.
- **Mixed versions racing the same Accept.** If an upgraded machine starts a suggestion with the derived id while a machine still on the old build starts the same suggestion with a random id, both creates commit (two groups) before either machine knows. When the old machine upgrades, its legacy row wins the fold on every machine (the rule cannot know which create came first across skewed clocks), so Continue goes to the old machine's group and the other group stays as ordinary owner state. The window is the mixed-version period and needs the owner to start the same suggestion on two machines in it.
- **A decision made on an offline machine** (or held unsent) reaches the others when it reconnects or drains. Until then they may offer it. Same window as every WS2 store.
- **A misbehaving peer** of the same agent can send rejected rows that hide advice, and, for a project suggestion, can choose which conversations a Continue proposes to move (only the front door is bound to the id); the owner still sees the member list before tapping Continue, and each move is the ordinary previewed owner change. It cannot redirect a Continue to another suggestion's group with a derived id (checked against the derivation); a legacy `suggestion-<uuid>` id cannot be bound to its suggestion, so a misbehaving machine could name another suggestion's legacy id, and the owner's Continue would then reach that older group (inside the same-agent trust boundary; legacy rows exist only for Accepts started before the upgrade) and cannot grow the outbox past four rows per suggestion id (it can invent ids, inside the same-agent trust boundary).
- **A legacy start racing an upgraded machine.** If A holds a pre-upgrade `suggestion-<uuid>` Accept whose create already committed, and the owner starts the same suggestion on an upgraded B before A's backfilled row reaches B, B creates a second group with the derived id. Once A's row lands, both continue A's (the earliest); B's group stays as ordinary owner state. The window is the time between A's upgrade boot and the row reaching B, and needs an unfinished pre-upgrade Accept.
- **Losing the deciding machine before its row leaves.** A decision made on a machine that is lost before the row reaches any other machine is lost with it; the others may offer that suggestion again and the owner can reject it again. Same window as every WS2 store; advice, not continuity-bearing graph information.
- **The rejected set grows** by one id per owner Reject, forever, in the outbox and the prompt filter. Owner taps bound it.

## Tests (all three tiers)

- Unit (`tests/unit/conversation-graph-suggestion-decisions.test.ts`): schema accepts each decision shape and both request-id formats; refuses extra fields, a bad id, an `sga-` id that is not the derivation, a snapshot that does not hash to its id, missing snapshot or request id on accepting, a request id on a non-accepting row, and deletes; fold (peer rejected hides, peer accepted hides, earliest accepting wins in any arrival order, rejected/accepted beat accepting, one winner kept per key); outbox (only `emitted`/`dropped:deduped` count as sent, the drain re-sends, landed rows never emit, the file survives reload, an unreadable file is reported and starts empty); service with the store (`reject` records, `beginAccept` uses the derived id, B with an EMPTY built list shows Continue, keeps the members out of its build input and resumes with A's request id, `accepted` records with result, the prompt filter excludes a peer rejection, backfill records legacy entries once, no overlay entry is written to the local file); no store means today's behavior with the derived id.
- Integration (`tests/integration/conversation-graph-suggestions-replicated.test.ts`): two machines (two state dirs, two services, two stores) joined by a fake journal that carries each store's emitted rows to the other's `ingestReplicatedAll`, driven through each machine's real suggestion router: reject on A, then B's `GET /conversation-graph/suggestions` does not offer it; start on A, then B's GET shows Continue and B's start returns the same request id; concurrent starts on both converge on one id; legacy decisions on A migrate once and B honors them; re-delivery is idempotent.
- E2E (`tests/e2e/conversation-graph-suggestion-decisions-alive.test.ts`): the production pieces (a real `CoherenceJournal` with the kind registered, `ReplicatedKindRegistry`, `ReplicatedRecordEmitter` with the resolved flag, the real wiring function) emit one record on a reject into the own stream, the peer-commit path lands it into a second store, and `server.ts` carries the registration, the forced-on flag, the observer line and the AgentServer option.

## Rollback

Set `multiMachine.stateSync.conversationGraphSuggestions.enabled: false`, or revert the release. The local file holds only this machine's own decisions (including a tap the owner made here on a suggestion another machine had already decided), so either returns every machine to machine-local behavior with no data repair; rows already in journals are inert to builds without the kind. The derived request id is independent of replication and stays correct.

## Maturation plan

- **test-agent-live:** two throwaway agents are not needed: the integration test drives two machines through the real suggestion router with a journal stand-in, and the e2e test drives the real journal, emitter and peer reader. On the Studio and M5 pair, a Reject on one machine's dashboard is checked to disappear from the other's within one sync interval.
- **dev-agent-live:** Echo runs it on its machines from release; the check is that a suggestion rejected on one machine is not offered on the other, and that the boot log shows pre-upgrade decisions shared once.
- **fleet:** ships on wherever the coherence journal runs (a bug fix for a tracked gap, CMT-1650), with the off switch `multiMachine.stateSync.conversationGraphSuggestions.enabled: false`.
- **graduation criterion:** no `ConversationGraphSuggestions.replication` degradation on Echo's machines for 7 days, and no re-offer of a rejected suggestion observed across machines.
- **dark-window:** none: not a staged rollout (finished disposition in the ladder); rollback is the off switch or the release.
- **ladder:** multiMachine.stateSync.conversationGraphSuggestions

## Frontloaded Decisions

- Store shape: list-pins-style outbox + `{ row }` records, one fold winner kept per (id, decision).
- Record identity: the hash of the full row content.
- Fold order: `(atMs, recordKey)` on row content, not the envelope HLC.
- Backfilled rows carry the local entry's own time.
- The overlay ledger is attached to each loaded state object; `save()` drops untouched overlay entries per field.
- An `accepting` snapshot governs the suggestion it names, including on a machine that holds a different local entry for the same id.
- Boot checks every own row against this machine's own stream and re-sends only the missing ones.
- Create request id derived from the suggestion id on `main` (the same function as `conversation-groups-phone`).
- The `accepting` row carries the suggestion snapshot (name, member refs, front door), integrity-checked against the id; the `accepted` row may carry the result.
- Only `emitted` and `dropped:deduped` count as sent.
- Drain: after each record and on a tick from 10 minutes doubling to a 6-hour ceiling while rows are unsent, at most 100 rows per tick; after 6 failing ticks one report per row, then it keeps going at the ceiling.
- In the fold, a legacy `accepting` row beats a derived one regardless of time.
- Backfill hands every local decision to the comparator; a build drops model groups that share a member with a started Accept.
- The overlay is never persisted into the local file.
- Kill switch `multiMachine.stateSync.conversationGraphSuggestions.enabled: false`, read at boot, resolved like `recommendedServices`; it stops sending, landing and overlay alike.
- No un-reject in this change.
- The built list stays machine-local (operator-ratified in the parent spec).

## Open questions

*(none)*

## Parent spec §5, replacement text

> ## 5. Multi-machine posture
>
> The built list of suggestions is machine-local: a cache of advice regenerated from unified inputs, and each machine builds its own. The owner's decisions (rejected, accepted, an Accept in progress and its request id) replicate to every machine as `conversation-graph-suggestion-record` on the WS2 replicated-record path (spec `conversation-graph-suggestions-replicated-decisions.md`), so a rejection on one machine is honored on every machine and an Accept continued on another machine continues the same request. The graph changes an Accept makes are the ordinary replicated owner events.
