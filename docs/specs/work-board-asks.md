---
title: "Work Board, phase 1 — a card for everything the agent needs from a person, whose chat is a native conversation"
slug: work-board-asks
author: echo
parent-principle: "An Instar Agent Always Serves a Team"
eli16-overview: docs/specs/work-board-asks.eli16.md
origin: "Telegram topic 142440, Justin 2026-11-12 11:00 PT (idea and requirements) and 12:11 PT ('yes please!' to writing the spec and starting the first piece)."
lessons-engaged:
  - "Structure > Willpower (status and closure are derived from records; approval is refused in code)"
  - "Signal vs. Authority (the agent proposes and attests; only a verified person approves or confirms)"
  - "An Instar Agent Always Serves a Team (visibility follows the bound conversation's team access; one-person scope stated with its reason)"
  - "Cross-Machine Coherence Standard A (one replicated store; the one machine-local surface is justified)"
  - "Verify the State, Not Its Symbol (detector table)"
  - "Truthful Provenance (server-written lines carry a system-source field and say they are the work board's; the brief carries a system origin)"
  - "Canonical Pipeline Operational Completeness (a refused pickup retries on a timer)"
  - "Session Input Is a Principal (the brief names the tap record; the session verifies it in the store)"
  - "L16 Project Scope (the six phases are registered as one project)"
  - "L17 Integrated-Being Ledger (each hand-over is noted in the shared ledger on every machine, by card id only; the card store is the one lifecycle)"
  - "Archiving May Never Mean Deleting (a person can remove a card's text from every read; secrets are refused at the door)"
  - "No Unbounded Loops and Capacity Safety (attempts that spend anything are capped and park; free capacity checks are slow and bounded per day)"
  - "Close the Loop (a replaced question stays visible as replaced)"
  - "Occam's Razor (built from app conversations and the existing approval paths)"
review-convergence: "2026-11-12T20:58:56.334Z"
review-iterations: 6
review-completed-at: "2026-11-12T20:58:56.334Z"
review-report: "docs/specs/reports/work-board-asks-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 29
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Work Board, phase 1: asks

## Problem statement

A person who works with an Instar agent has no single place that shows what the agent needs from them. Today those needs are spread over approvals, plans, promises, secret requests, Chief of Staff rows and attention items, each with its own page and its own shape, and plain questions asked in a conversation appear in none of them.

Luna (the SageMind agent) built a card board outside Instar on 2026-11-09 and three people have used it daily since. The operator reports it "VERY effective" for coordinating the three of them (topic 142440). Its evidence, read from her code and her own account over Threadline on 2026-11-12:

- What worked: one place for everyone; approve before the agent starts; "done when" on every card; a trail of who carried the card; attachments.
- What did not: the chat on a card and the conversation where the work happens are two separate things, so context is copied by hand and the card falls behind; a person's note waits up to 5 minutes for a polling job; status goes stale unless a job forces it; the people are three hardcoded names.

Instar already has the parts that remove those four problems: native conversations whose inbound messages reach a session at once, a signed team record, and person-only approval paths. This spec builds the first slice from those parts.

## Operator requirements (topic 142440)

- **R1:** an easy view where a person sees exactly what their agent needs from them and talks to the agent (or other people) on a card.
- **R2:** card groups and several boards.
- **R3:** files and metadata on cards.
- **R4:** ExO 3.0: the agent is a real team member that carries the work; people make only the decisions that exceed its authority.
- **R5:** a card's chat IS a native Instar conversation.
- **R6:** integrated with team and role support, conversations and multi-agent coordination.

Phase 1 delivers R1, R3, R5 and the team-visibility half of R6. On R4: the default asks a person before the agent starts a card it wrote, which is the operator's own rule from Luna's board; the `outward-only` policy (§4) is the setting that lets the agent carry internal work without that tap, and the choice is put to the operator with this spec. R2 is delivered as one board with fixed lanes. The rest is the later phases listed under Non-goals and carried by CMT-1420.

## Vocabulary

- **Team owner:** the one person the team record names as owner. In this spec "the team owner" always means that person.
- **Carrier:** the principal who carries a card to its finish. Never called "owner" here.
- **Person-proven:** a request that authenticated as a person (§4). Everything else is **agent-written**.

## Proposed design

### Non-goals (phase 1)

- No scheduled progress cadence, work leases or stalled detection; no blocker links between cards; no server-run checks on done items; no journal compaction (phase 2).
- No named boards or manual groups; no meeting ingestion; no card carried or created by a team member; no approval by a member (phase 3). Phase 1 cards are carried by the agent or by the team owner, and every tap is the team owner's. **Reason for the one-person scope:** the only presence proof that exists today is the team owner's (`mobilePermissionsRoutes` write gate, `createMandatePinCheck`), and a conversation created for a member needs a member-owned conversation path and member write routes that this slice does not build. Members and guests still see and discuss any card whose conversation the team owner shares with them.
- No assignment to a peer agent (phase 4). No client or guest audience with a preview (phase 5).
- No change to Chief of Staff bindings, commitments, the blocker ledger or initiatives (phase 6 folds them in).
- No new Telegram or Slack notice source.

### One home for each need

The board would be a seventh place for needs unless the rule is stated, so it is:

| The agent needs | Home |
|---|---|
| a standing permission | an authorization request (unchanged) |
| a credential | a secret request (unchanged) |
| approval of a plan | the plan (unchanged) |
| a person to clear something recorded as a true blocker | the blocker ledger (unchanged) |
| the person to know about a health or system condition | the attention queue (unchanged) |
| sign-off that a Chief of Staff project is finished | the Chief of Staff binding (unchanged) |
| a decision, an answer or a sign-off on a piece of work | a card |
| nothing from a person; it made a promise | a commitment (unchanged) |

A card may link a Chief of Staff project (`projectKey`) for context, and a card for a subtask of that project can have its own sign-off. The floor is structural: nothing a card records ever advances or finishes a Chief of Staff binding, so a project can only be signed off in one place. Whether a given piece of work is the project's own finish or a subtask is the agent's judgment (see Decision points). The agent-facing line in CLAUDE.md states the table above. Showing the other need sources read-only inside the board's first lane is phase 2 scope.

### 1. The card

A card is a work agreement between named principals. It is not a conversation and not a message: it holds the structured facts that code must enforce, and it owns one conversation for everything else.

Fields (M = *material*: an approval covers exactly these):

| Field | Meaning |
|---|---|
| `id` | `wc_` + 16 hex, minted at creation. |
| `title` M | one line. |
| `need` M | what is needed and why. Light Markdown rendered by the console's existing safe renderer: paragraphs, lists, bold, links; no images, no raw HTML. |
| `recommendation` | the agent's recommended answer. Optional. Not material; it is advice shown beside the question. |
| `doneWhen` M | one or more items `{id, text, certify: 'owner-confirms' | 'agent-may-certify'}`; `certify` defaults to `owner-confirms`. This is the card store's own type. (The Chief of Staff's `DoneItem` also has a `deterministic` kind evaluated by a probe, and its loop does not yet honour `agent-may-certify`; the card store does not reuse either.) |
| `carrier` M | `agent` or the team owner's `personKey`. |
| `outward` M | boolean: doing the work sends something outside the team or spends money. |
| `links` M | each is either `{label, url}` (`https:` only, shown with its host) or `{label, attachmentId, sha256}` naming a file in the card's own conversation (an id from any other conversation is refused). The file's sha256 is part of the link and so of the material hash; the approval screen checks the stored bytes still match and shows a purged file as removed. Material, so swapping a link voids approval. An approval covers a web link's address, not what that address serves later: the approval screen says so beside any web link, and scope that must not move belongs in `need` or in an attached file. |
| `waitingOn` | who must act next: `agent`, the team owner's `personKey`, or `none` once done. |
| `question` | set with `waitingOn` a person: `{text, options?: string[]}`. Approval and sign-off are not questions the agent writes: they are derived states (§5), so the agent can neither raise nor remove them. |
| `source` | optional `{conversationKey, messageId}` the card was made from. |
| `due` | optional ISO date; shown and used for sorting only. |
| `projectKey` | optional Chief of Staff project conversation key. |

A card never stores chat text or file bytes. Files live in the bound conversation's media store; an evidence record cites them by `attachmentId`.

### 2. The card's conversation

Each card owns exactly one app conversation (`AppConversationStore`), created for it. The card page shows that conversation as the card's chat; the conversation list shows it under the card's title. There is one transcript. Nothing is copied.

- **Creation.** The conversation key is derived from the card id (`sha256("work-card:" + id)` formatted as the store's UUID key), never minted at random. The machine that accepts the card's `created` record calls `AppConversationService.applyCreate` with that key, a device id of `work-board` and a request id equal to the card id (the event id is derived from those two, so it is stable too), and `ownerPerson: null` (the team owner's conversation, as `createAppSession` does). `applyCreate` appends the `created` event on any machine; binding stays with the lease holder as for every conversation. Because the key is a pure function of the card id, a second create for the same card finds the conversation already present and is a no-op.
- **A person's comment** is an ordinary message through the existing device-signed route or the console composer. It reaches the conversation's session through `appInboundDispatch` as any message does. There is no polling job and no second inbox.
- **Card events in the transcript.** For each tap, each material edit, each voided tap, each replaced question and each parked pickup, the server appends ONE message to the conversation from a fixed template that starts `Work board:`, so the line says in its own words that the infrastructure wrote it:
  - `Work board: approved by <name> · <when>`
  - `Work board: approval withdrawn by <name> · <when>`
  - `Work board: <name> answered "<option or first 120 characters>" · <when>`
  - `Work board: held by <name>` / `Work board: hold released by <name>`
  - `Work board: confirmed done by <name> · <when>`
  - `Work board: reopened by <name> · <when>`
  - `Work board: the card changed (<field names>); the earlier approval no longer applies`
  - `Work board: <name>'s <action> no longer applies; the card changed first`
  - `Work board: the earlier question was replaced. The agent's reason: "<first 120 characters>"`
  - `Work board: archived by <name>` / `Work board: restored by <name>`
  - `Work board: this could not be handed to the agent (<reason>)`
  - `Work board: <name> changed how approval works; this card can start now`

  The conversation store knows two roles (`operator`, `agent`) and refuses a role or event kind it does not know, so a third role would be refused by any machine on an older build. Its validator does accept a message carrying an optional field it does not know and drops that field (`agentOrigin`, `senderName` and `accessStamp` were added that way). So the line is stored with `role: 'agent'` plus a new optional `systemSource: 'work-board'`, set only by the server-side append and never accepted from a request body. A build that knows the field shows and reports the line as the work board's, not the agent's; an older build drops the field and falls back to the `Work board:` prefix. The card store also records the `messageId` of every line it wrote, and a surface styles a message as a card event only when its `messageId` is in that list, so an agent reply that imitates the text is shown as ordinary agent text. The line passes the same credential guard the session-reply route runs before it is appended, and a test covers a title containing a credential-shaped string.
- **Starting from an existing conversation.** A card can be created from a message; `source` records where. Work continues in the card's own conversation. Phase 1 does not attach a card to an existing conversation, because one conversation would then answer to two cards' approvals.
- **Telegram and Slack.** A card conversation is an app conversation and gets no Telegram topic or Slack thread.
- **Archived cards.** App conversations have no archive state (the only hide state is a tombstone, which is deletion). The console and mobile conversation lists therefore leave out any conversation whose key belongs to an archived card (the index keeps that set; the filter runs on the merged list before paging, and shows everything if the card store cannot be read); the conversation itself is untouched and stays readable from the card.

### 3. The store

`WorkCardStore` follows the `ChiefOfStaffStore` pattern: a replicated store (`workBoard`, kind `work-card-record`) of immutable records keyed by event id, each stamped with an HLC and its origin machine. The card is a pure fold over its records, in HLC order with ties broken by origin machine id.

Record kinds: `created`, `edited` (the changed fields only), `waiting-on` (principal + `question`; its event id is the **question id**; when a question is already open it must carry `supersedes: <question id>` and a `reason`), `tap` (§4), `evidence` (`{itemId, text, attachmentIds?, materialHash, reopens}`), `claimed-done` (`{materialHash, evidenceIds, reopens}`), `dispatching` and `dispatched` (§6), and one board-level kind, `policy` (person-proven; §4). Every record carries `by`: `{kind: 'person', personKey, proof: 'pin' | 'presence'}`, `{kind: 'agent'}` (a scoped session's writes are agent-written too), or `{kind: 'system'}` for the `dispatching`/`dispatched` records the pickup controller writes. The route stamps it from the authenticated principal, and `…/records` refuses the `dispatching`, `dispatched` and `policy` kinds from every caller: the first two are written only in-process by the controller, the third only by the settings route.

- **Material hash.** `sha256` over the canonical JSON of the M fields **as folded**. No record carries a hash the fold trusts: after any record is applied, the fold recomputes it. Two machines editing different fields at once therefore yield one card with one hash, the same on every machine.
- **Last writer per material field.** The fold keeps, for each M field, whether its newest write was person-proven or agent-written. §4's approval rule reads this. The edit route compares each submitted field with the folded value and records only the fields whose value differs, so a console form that posts every field on a typo fix moves the last writer of the title alone.
- **One hash and one generation bind everything.** Evidence and a done claim carry the material hash they were written against and the ids of the `reopen` taps their writer had seen (`reopens`); a `confirm-done` tap carries the same. Each counts only while its hash is the current one, its `reopens` equals the set the fold holds, and no record that changed a material field is ordered after it. That last rule is the same one approvals follow: nothing revives when a field is edited and then edited back. So a reopen made on another machine that the writer had not yet seen always wins when it arrives, whatever the clocks say. Changing the need, the links or an item's text therefore discards the evidence and the claim, and editing a finished card makes it unfinished. There is no separate checklist hash.
- **Carrier trail.** The fold keeps the carrier named at creation and every later change, with who made it. Nothing caps it.
- **Reads.** One in-memory index (card id → folded card, the lanes, the set of pending pickups) is built at boot and updated on each local write and each replicated apply. Every route reads the index; no request folds the journal. A route that reads then appends (create, edit, tap, claim) holds an in-process per-card lock, released before any conversation append or pickup.
- **Retention and growth.** The journal kind is registered with `maxFileBytes: 8 MB` and `rotateKeep: 0`, which in `CoherenceJournal` means: rotate the live file at 8 MB and never delete an archive. Approval, evidence and the carrier trail fold from the whole stream, so the boot fold reads the live file and every archive; a test builds a stream that spans a rotation and asserts an approval in the first archive still counts. Estimate: a card is about 12 records of about 1.5 KB, so 5 cards a day is about 33 MB a year; at the daily ceiling of 200 it would be about 1.3 GB a year. When the kind's total bytes (live plus archives) pass 64 MB the store emits a degradation event naming this spec. Per-card snapshot compaction is in phase 2's scope under CMT-1420. Until then `redact` (below) hides a card's text everywhere but does not remove the bytes.
- **Secrets are refused at the door.** Every card-record write passes the same credential guard the outbound message path uses, on all its text fields, and is refused on a hit with the field named. A never-rotated, replicated, backed-up store must not be where a pasted password lands.
- **Removing a card's text.** A person-proven `redact` tap makes the card terminal (`removed`) and makes the fold, the index and every read drop the text of all its records (title, need, questions, answers, evidence), showing "removed by <name>" in their place. After it, every record that is not a person's tap or the pickup controller's own closing record is refused `card-removed`, so nothing can write to the card or recreate its conversation; it is a stop cause (§6). It replicates like any record, so every machine's reads honour it. The card's conversation is removed with the conversation store's own tombstone, and its files with the existing purge. The bytes themselves stay in the journal files until phase 2's compaction (CMT-1420) rewrites them, and a backup taken before the redact still holds the text, so restoring one on a single machine brings it back; this spec does not call phase 1 erasure, and the page says both things beside the button.
- **Backup.** Journals are not in `BackupManager`'s `includeFiles` today (nor is the Chief of Staff's). The build adds the work-board kind's live file and archives; journal files are named per machine and kind, which the manifest's single-wildcard entries cannot select, so this is a small change in `resolveIncludedFiles`, not a config line. On an agent with more than one machine, a restored machine is brought current by its peers' streams. On a single machine a restore returns the board to the snapshot. App conversations are not in backups, so a restored card whose conversation file is absent says "this card's earlier chat was not in the backup"; the derived key recreates an empty conversation at the next write.

### 4. Who may do what

The route decides who the caller is from how the request authenticated, never from a field in the body.

| Caller | How it is proven | May |
|---|---|---|
| The agent | the server's Bearer token | create a card, edit it (a material edit to a `done` card is refused `reopen-required`: only a person unfinishes a card), set `waitingOn` and a `question`, add evidence, claim done. It cannot archive: a card leaves the board only by a person's tap, and the agent says in the card's chat when it thinks a card should go. |
| A session in a memory-scoped place | an `mps_` token | read, and write records on, the one card whose conversation is the session's own. The handler checks that binding (the `/app/media-path` precedent). No lanes read, no create, and refusals to these tokens carry no counts. |
| The team owner | console: the dashboard PIN check (`createMandatePinCheck`); phone: a device principal that is the active owner phone plus a presence signature over a single-use challenge (the `mobilePermissionsRoutes` write gate) | create and edit cards; every `tap` |
| A member or guest | a device principal bound to a `personKey` | read a card whose conversation they may read; post in that conversation if their grant allows it. For anyone but the team owner the card omits `source` and `projectKey`, which name conversations they may not be able to read. |
| A person acting for the team owner | a device whose person holds the team owner's signed `ownerConversations` grant (the existing `msp` role) | reads every card, as they already read every conversation of the team owner's; no taps. This is the existing grant's meaning, stated here so it is not a surprise, and a test covers it. |

**A tap** is a person-proven record `{action, cardId, …}`. Taps come in two kinds, because the one that stops work must never be refused:

| Action | Kind | Binds to | Effect |
|---|---|---|---|
| `approve` | permits | the material hash | approval for this exact card |
| `answer` | permits | the question id + the answer | answers that question |
| `confirm-done` | permits | the claim id (the `claimed-done` record) | finishes the card |
| `unhold` | permits | the `hold` tap it releases | not held, unless another `hold` exists that it did not name |
| `retry` | permits | the card, plus what is being retried: a park's record id, a waiting pickup's cause id, or a quiet card's newest record id | one more try (§6) |
| `unarchive` | permits | the `archive` tap it undoes | restores it, unless another `archive` exists that it did not name |
| `hold` | restricts | the card | held |
| `withdraw-approval` | restricts | the card | approval is required and absent, whoever wrote the fields, until a later `approve` |
| `reopen` | restricts | the claim id | unfinishes it; from then on every finish of this card needs the person's sign-off |
| `archive` | restricts | the card | archived |
| `redact` | restricts | the card | text removed from every read; the card is finished for good |

- A **permitting** tap is checked against the current card: the route recomputes from the index and refuses `stale-card` when the tap's hash, question id, claim id, `retryOf` or named restriction is not the current one (`question-replaced` names the replacement). The fold applies the same test and is the authority.
- A **restricting** tap is accepted whatever the card's state and however far behind this machine's view is. A release (`unhold`, `unarchive`) lifts only the restriction it names, so a hold made on another machine that the releasing person had not seen stays in force when it arrives, in either arrival order. A `reopen` is recorded and takes effect even when its claim is no longer the current one.

The proof covers the whole action on both paths:

- **Phone.** The signed `actionLine` is `Work card <id>: <action> [<sha256 of the canonical JSON of {action, cardId, materialHash, questionId, answer, claimId, retryOf, titleHash}>]`, built by a new `work-card-tap` kind in the write gate's closed action set. The title is shown on screen and enters the signature only through its hash. The server recomputes the line at verification. This path needs what the write gate already needs: `permissionActions` on and a dashboard PIN set.
- **Console.** The PIN request carries the same fields and the server makes the same comparison before accepting.

**What the person is shown before any tap:** the title, the need, every done item with a mark on those the agent may certify itself, the carrier, the `outward` flag in words ("This sends something outside your team or spends money"), the links with hosts, the question and the recommendation. For `confirm-done` it is each done item with the evidence the claim rests on. So the person sees everything the tap covers.

**Limits of the proof, stated plainly.** The console PIN proves knowledge of the PIN on that machine, not a body at a keyboard; this is the existing Approvals posture and the board inherits it. Each tap records which path proved it, and the card shows it.

**When approval is required.** Approval is about who wrote the card's material content, not about a field the writer can set. A card needs a valid `approve` tap unless **every** material field's last writer is person-proven. A `withdraw-approval` with no later `approve` always requires approval, under either policy and whoever wrote the fields. So a card the team owner wrote in full needs none (writing it was the instruction), and a card the agent wrote still needs approval after the team owner fixes its title, because the need and the checklist are still the agent's. One exception keeps the stricter rule: an `outward` card always needs its own `approve` tap. A board-level `policy` record chooses how far this goes. It is a person-proven record in the replicated store, so every machine folds the same policy. With no policy record, or a newest one that cannot be read, the board runs `every-agent-card`; there is no config value and no seed:

- `every-agent-card` (default): the rule above. This is the operator's own rule on Luna's board (9 Nov: "Luna works only cards Justin or Adriana approved").
- `outward-only`: a card that is not `outward`, and has no outstanding withdrawal, starts with the agent at once whoever wrote it; it is visible on the board and one `hold` tap stops it. Under this policy the agent's own `outward` flag is the only thing that asks for approval, and the settings screen says so in those words.

The policy is changed only by a person-proven record. A change that makes waiting cards workable is a pickup cause for each of them (§6).

**An approval is valid** when it is the newest of `approve`/`withdraw-approval`, and no record changed a material field after it in fold order. An approval never comes back: editing a field and then editing it back leaves the card unapproved.

**The agent may never:** write a tap; widen who can see a card; alter or remove a record; finish a card it was not approved to work; replace a question without saying so; archive a card; remove a card from the person's lane while it needs approval or sign-off. A Bearer or session principal on the tap route is refused `person-required`. Audience is the conversation's, which only the team owner's signed record changes.

**Visibility.** A person sees a card only if `mayUseConversation` lets them read its conversation; otherwise the card does not exist for them (`404`, never `403`). The agent cannot share a card; it can file a grant request (`POST /team/proposals`) naming the conversation.

### 5. Derived status and finishing

No route accepts a status, and there is no `closed` record. The fold computes everything, in this order:

| Status | Derived from | Lane for the team owner |
|---|---|---|
| `removed` | a `redact` tap exists | none (listed under "Archived" as removed) |
| `unknown` | the fold met a record it cannot validate; the card shows what could not be read | Waiting on you |
| `archived` | an `archive` tap exists that no `unarchive` names | none (listed under "Archived") |
| `held` | a `hold` tap exists that no `unhold` names | Waiting on you |
| `needs-approval` | approval is required (§4) and none is valid | Waiting on you |
| `claims-done` | a current done claim that needs the person's `confirm-done` | Waiting on you |
| `done` | a current done claim that needs no `confirm-done` or has one | Done |
| `parked` | a pickup for the workable card is parked (§6) | Waiting on you |
| `waiting-on-person` | an open question | Waiting on you |
| `with-person` | the carrier is the team owner, and none of the above | Waiting on you ("Yours to do") |
| `quiet` | the carrier is the agent, none of the above, no pickup for the card is pending or parked, and the card's newest record is older than `quietAfterHours` | Waiting on you ("The agent has gone quiet on this", with Try again) |
| `with-agent` | none of the above | With the agent |

The lane follows the derived status. `quiet` depends on the clock as well as on records, so the index stores each card's newest record time and the lane is worked out against the current time when a read is served, at a cost proportional to the number of open cards. No agent record can take a card out of "Waiting on you" while it needs approval or sign-off, or is held or parked.

**A done claim is current** when: its `materialHash` is the current one and its `reopens` is the current set; it lists, for every item, an `evidence` record with the same hash and `reopens` and non-empty `text`; the card is not held, not `unknown` and not `removed`; and approval is not required or is valid. Evidence written after a claim does not join it: a claim covers exactly the evidence it lists, so a person's `confirm-done` covers what they were shown, and a finished card stays finished until a `reopen` or a material edit by a person. The route refuses a claim that is not current with the first unmet condition (`held`, `not-approved`, `evidence-missing: <item ids>`, `reopened-since`, `card-unreadable`).

**A current claim needs the person's `confirm-done`** when any item is `owner-confirms`, or when the card has any `reopen` record. Otherwise the card is `done` on the agent's own evidence and says "Finished by the agent on its own evidence".

A person's tap outranks the agent: a `reopen` changes the generation, so every claim, piece of evidence and sign-off written without having seen it stops counting, and every later finish needs fresh evidence, a fresh claim and the person's sign-off.

**Questions.** One question is open on a card at a time. Writing a second while one is open needs `supersedes` and a `reason`; so does a `waiting-on` that names the agent while a question is open. The fold marks the earlier one `replaced`, the transcript gets a line, and the card keeps showing it as replaced. A person who answers a replaced question is told so and shown the new one.

Whether evidence truly meets an item is a judgment (see Decision points). Phase 1 makes it visible and reversible, not verified.

### 6. Picking up work: the agent's loop

A card is **workable** when it is carried by the agent, fully readable (not `unknown`), not removed, not held, not archived, not done, and approval is not required or is valid.

A **pickup** hands a card event to the card conversation's session. Pickups are derived from the fold, never from a list of record kinds, so no way of becoming workable can be missed:

| Cause (its id is the id of the record that produced it) | Brief |
|---|---|
| any record after which the card is workable and before which it was not (an approval, a release from hold, a restore from the archive, a reopen, a person's create or edit, a policy change, a carrier change) | work |
| an `answer` tap | the question and the answer; on a card that is not workable the brief says "answer only; do not start work" |
| a `retry` tap on a quiet card | the recovery brief (below), for an `outward` card too, because a person just asked for it; the tap is itself a card record, so it restarts the quiet window |
| any record after which the card is not workable and before which it was, except the card finishing (a hold, a withdrawal, an archive, a `redact`, a material edit that voids an approval, including one that arrives late from another machine) | stop; after a `redact` every pending or parked pickup for the card, work or answer, is voided, and the stop brief and its system tag carry the card id in place of the title (`[app:<alias> "wc_…" system:work-board]`) |

**The agent cannot manufacture pickups.** Between two person-proven records on a card, at most one work pickup may be caused by an agent-written record (for example the agent making itself the carrier under `outward-only`). A second is not attempted: the card parks with the reason "the agent keeps changing this card", and only a person's Try again releases it. Finishing a card is not a stop cause, and an agent cannot unfinish one (§4), so finish-and-unfinish cannot be cycled.

**One attempt at a work or answer pickup**, on the conversation's routing owner (the lease holder when there is no routing record):

1. **Re-fold.** A work pickup whose card is no longer workable, or an answer pickup whose question was replaced or whose card is archived, done or removed, gets `dispatched {for, outcome: 'void'}` and the "no longer applies" line, and stops.
2. **Free pre-check.** With no side effects, ask: is the relay ready, and does ownership admission admit this conversation? If the conversation already has a live session, that is enough, because delivery is an injection and needs no free slot. Only when a session would have to be started does a pure capacity probe (the same limits `spawnInteractiveSession` enforces, exposed as a read) also have to show room. A "no" ends the attempt with nothing written and no session touched. The pickup is **waiting for capacity**.
3. Write `dispatching {for, attempt, machineId}` and wait, outside the per-card lock, for the journal's durability acknowledgement (`CoherenceJournal.awaitDurableSeq`, which the Chief of Staff's action protocol uses). If the acknowledgement times out or fails, the attempt ends here with no brief. The intent is on disk before the act.
4. **Check again.** The wait in step 3 takes time, and a hold or an ownership change can land during it. Re-fold the card and re-check ownership admission; if the pickup no longer applies or this machine no longer owns the conversation, write the closing record `void` (or `refused: no-longer-owner`) and stop. Work and stop deliveries for one conversation run through a single in-process queue, so a stop can never be followed by a work brief that was admitted before it.
5. Append the transcript line (§2), with a `messageId` derived from the cause's id so a repeat is a no-op.
6. Deliver the brief through `appInboundDispatch` with a new `origin: 'system'` input: `appInjectionTag` gets a system branch that emits `[app:<alias> "<title>" system:work-board]` instead of `from <owner name>`, and the spawn it may make is admitted as `automatic`, never as the operator's, so a pickup cannot take the session slot kept for a person. A test asserts a system brief never renders as the owner speaking. `AppDispatchOutcome` is widened from `'delivered' | 'refused'` to a structured result (`injected`, `spawned`, or `refused` with a reason); existing callers read `injected` and `spawned` as delivered. A throw from the spawn is caught and treated as `refused`. The brief is a pointer, not a copy: the card id and title, the cause (who, what, when, its record id), and the instruction to read the card from `GET /work-board/cards/:id` and confirm the cause there before acting.
7. Write the closing record: `dispatched {for, attempt, outcome: 'injected' | 'spawned'}`, or `dispatched {for, attempt, outcome: 'refused', reason}`.

**A stop brief** uses the live-only injector (`createAppFollowUpInjector`) with the system tag: it reaches a running session and never spawns or restarts one. It is sent while the card is still not workable. Its closing record is `stopped` or `not-delivered` (the injector cannot tell "no session" from "inject failed", and the record says so). A stop is an instruction to the session, not a mechanical halt: what the store enforces is that a card that is not workable cannot be claimed done and gets no work pickup, and every send or spend still passes the outbound gates.

**What a tap on one machine cannot know.** A material edit made on another machine that has not replicated yet cannot void a pickup here; the fold only sees what has arrived. This is eventual revocation, and its limit is the replication lag: when the edit arrives the card stops being workable, which is itself a stop cause, and the transcript says the approval no longer applies. Work done in that window was done against the card the person approved. A test delivers an edit after dispatch and asserts the stop.

**Recovery.** A `dispatching` with no closing record, when this machine has no attempt in flight for it, means a machine died between steps 3 and 7, and nobody can know whether the brief landed. For a card that is not `outward`, the next attempt delivers a **recovery brief** in place of the work brief: "this card may already have been handed to a session that got part-way; read the card's conversation for what was done, and do not repeat a send or a spend that the conversation or the operations log shows as made". For an `outward` card nothing is delivered: the pickup is parked with the reason "this may already have been picked up before a machine change; check the chat first", and the person's Try again delivers the recovery brief. **Uncertainty belongs to the card, not to one pickup.** Once any pickup on a card is uncertain, the card stays marked "may already have been handed over" until a pickup on it closes `injected` or `spawned` with a recovery brief. Until then every work pickup on that card delivers the recovery brief, whatever caused it, and the approval screen shows the warning. So withdrawing approval and approving again, or an edit that voids the parked pickup, cannot turn an uncertain hand-over into an ordinary one.

**After an ownership change** the new owner may not have the old owner's last records yet. For any cause that existed before it became owner and has no closing record, it waits until the previous owner's stream is current (the same signal as `behind`). If that has not happened within ten minutes, it treats the pickup as uncertain delivery and takes the recovery path above, so an `outward` card is parked for the person and never handed over twice on a guess. "Current" has an exact meaning here, because the journal reader's own status reads `current` even for a machine that has gone dark: a status advert from the previous owner received after the moment of takeover, from the same incarnation, and what this machine holds of that owner's work-card stream at or past the sequence that advert names; a gapped or quarantined stream is not caught up. The build records the per-peer time of that exchange, which does not exist today. Reads use the same definition for `behind`.

The card layer does not make a session's external operations exactly-once. It makes the uncertainty explicit, shows the evidence (the transcript holds the session's own replies), and keeps a person in front of anything outward.

**Brakes.** The pickup controller is registered in `SELF_ACTION_CONTROLLERS` with a sustained-refusal test. It runs on boot, on a lease or ownership change, when a cause arrives, and on a 60-second tick over the index's pending set (parked pickups are not in it), one pickup at a time so two cannot pass the capacity probe for the same free slot. The probe is a read that does not write to the admission audit log.

- **Waiting for capacity** costs nothing, so it does not park. The free pre-check repeats at 1 minute doubling to 30 and stays at 30: at most 48 pure reads a day for each pending pickup, and pending pickups are bounded by events people caused. The card stays in "With the agent" and reads "Approved; waiting for a free session (<reason>), next check at <time>". If the reason names when capacity returns (a quota reset time), the next check is set to that time. After 24 hours waiting the card also appears in "Waiting on you" with Try again, Withdraw approval and Archive, so a person can close it deliberately; the checks carry on.
- **Attempts that spend something** are capped at three for a pickup, counted as its `dispatching` records whether or not they were closed, so an attempt that crashes the server counts too. When the third fails, the controller writes `dispatched {for, outcome: 'parked', reason}`, a replicated settling state. Because both the count and the park are replicated records, a restart or a new owner inherits them and mints no new budget.
- **Parks come in two kinds.** A *failure park* (three spending attempts failed) is tried once more on a lease or ownership change, at most once per park, recorded as a replicated record so repeated ownership changes cannot mint attempts; otherwise only by the person's `retry`. A *decision park* (uncertain delivery of an `outward` card; "the agent keeps changing this card") is released only by the person's `retry`. Every re-try is exactly one attempt: success clears the park, failure leaves it parked with nothing new in the transcript. A parked pickup whose card stops being workable is voided. A `retry` on a pickup that is waiting for capacity runs the free check at once.

**Visible, never silent.** A parked card is in "Waiting on you" with the plain-language reason and the buttons Try again, Withdraw approval and Archive; the transcript gets one line per park; the degradation reporter records one event per park. `GET /work-board` reports pending pickups, how many are waiting for capacity and since when, and how many are parked.

**Other sessions can see it.** When a `dispatched` record with outcome `injected` or `spawned` is applied live (not during the boot fold), each machine appends one note to its shared ledger, the one every session on that machine is shown at start: kind `note`, provenance `subsystem-asserted`, a new emitting subsystem `work-board`, a fixed counterparty naming the agent itself (type `self`, tier `trusted`), dedup key `work-card:<id>:<cause id>`, and the text "a work card was handed to the agent: <card id>". It carries the id only, never the title, because the ledger is shown to sessions that may be serving people who cannot see the card; the title and state are read from `GET /work-board`, which enforces access. The write is best-effort: if the ledger is off or refuses, the pickup is unaffected. Because every machine emits from the same replicated record, sessions on every machine see it; the ledger's in-memory dedup means a restart can repeat a note, which is harmless.

**A card that goes quiet is not silent.** Phase 1 has no work leases, so a session that dies after pickup would leave a card "With the agent" for ever. The `quiet` status (§5) closes that: it is derived from records every machine has (the card's own records), it moves the card to "Waiting on you" after `quietAfterHours`, and the person's Try again there causes one pickup with the recovery brief. An agent that is really working a card writes records on it (evidence, a question); one that only touches the card to look busy can hold it out of `quiet`, which this phase accepts and says, since the remedy for that is phase 2's leases. It adds no timer loop and sends nothing.

When the agent needs the team owner, it writes `waiting-on` with a `question` and posts the question as an ordinary reply in the conversation. That reply is the notification: the app's existing push for an agent message. The board adds no push of its own.

### 7. Surfaces

- **Console page "Work"** (`dashboard/console/work.js` + `work-model.js`). Its first screen is the lane **Waiting on you**: one row per card with what is needed in one line and its buttons. Below it: **With the agent**, **Waiting on others** (cards shared with the viewer that wait on someone else), **Done** (20 most recent; "Show all" pages 50 at a time). When more cards wait on the viewer than `softOpenCards`, the lane shows the oldest first and one line "N more waiting". Opening a card shows the fields, the done items with their evidence, the carrier trail, the proof behind each tap, and the conversation as its chat with the composer and attachments. Tap buttons open the PIN prompt, as Approvals do. A reply by the viewer after the open question shows on the row as "You replied; the agent has not updated the card".
- **Home.** A new `NEED_SOURCES` entry `workBoard` whose rows come from `work-model.js`'s own builder. It returns `UNREADABLE` for a 200 with the wrong shape; a 503 (feature off) counts as nothing waiting. The page's lead element carries `data-operator-need="workBoard"` and holds an enabled control at 1280x728 and 390x844.
- **Phone.** `GET /mobile/work-board` (cards the device's person may see, with lane and what is needed) and `POST /mobile/work-board/cards/:id/tap` (team owner only, presence-signed) are added to the device rule table. The iPhone card screen is built by this run in the app's source, which lives in the agent home on the Mac Studio (`apps/instar-ios`, where Xcode is installed; this run reaches it over its existing SSH access), as its own commit on a `work-board-cards` branch of that repository, against those two routes. It is complete for the run when the app compiles and the screen's parsing tests pass there. Until that app build is on a phone, the card's conversation already appears in the app's conversation list, and taps are made on the console.
- **Agent.** Bearer: `GET /work-board` (lanes, pending pickups, `behind`), `GET /work-board/cards/:id`, `POST /work-board/cards`, `POST /work-board/cards/:id/records` (`edited`, `waiting-on`, `evidence`, `claimed-done`). PIN-gated: `POST /work-board/cards/:id/tap`, `POST /work-board/cards` and `…/records` when made by the team owner from the console, and `POST /work-board/settings` (limits and the `policy` record). The PIN prompt for a policy change says how many waiting cards would start at once. Settings values are positive whole numbers; a free-check delay below 60 seconds and a spending-attempt cap below 1 are refused. Create and question responses carry `overSoftBudget` (below) so the session can weigh it.

### 8. Security

- A tap route accepts only a person-proven principal. The body's `by` is ignored.
- Card text is checked for credentials on every write and refused on a hit (§3).
- Card text is untrusted input to a session exactly as a message is. The brief carries no card text beyond the title; the session reads the card as data from the store.
- Text a person or peer writes in a card's chat is data. It can ask the agent to do things only within that card and within the agent's standing authority; it never substitutes for a tap. The CLAUDE.md line says so.
- The credential guard and tone gate cover agent replies in the card conversation as in any app conversation; server-written lines pass the credential guard (§2).

## Decision points touched

| Decision point | Classification | Floor / arbiter / justification |
|---|---|---|
| Whether a caller is a person | invariant; basis: enumerable-domain; evidence: a request authenticates in exactly one of four ways (server Bearer, session token, device signature with presence, dashboard PIN) and the route reads which from the middleware's principal; the PIN's known limit is stated in §4 and each tap records its proof. |
| Whether an approval covers the card as it stands | invariant; basis: enumerable-domain; evidence: equality of sha256 values the fold itself computes over a fixed field list, plus "no material change after the tap"; there is no partial match to weigh. |
| Which fields are material | invariant; basis: irreversible-consequence; evidence: an approval that survived a change to the need, the done items and who certifies them, the carrier, the links or the outward flag would let work the person never saw proceed, including a send or a spend that cannot be recalled; a longer list only asks again, which is recoverable. |
| Whether approval is required | invariant; basis: enumerable-domain; evidence: it is a function of recorded facts only (for each material field, whether its last writer was person-proven; the newest of approve and withdraw; the `outward` flag) and one person-written policy record with two values. |
| Whether a card write contains a credential | invariant; basis: irreversible-consequence; evidence: the store is never rotated away, replicates to every machine and is in backups, so a stored secret cannot be recalled; the check is the existing deterministic outbound guard, the refusal names the kind of credential matched, and the person can reword. |
| Whether a person may see a card | invariant; basis: enumerable-domain; evidence: `mayUseConversation` on the card's one conversation, the same check every conversation route uses. |
| Whether a scoped session may reach a card | invariant; basis: enumerable-domain; evidence: equality of the card's conversation and the session's bound conversation. |
| Whether the work is `outward` | judgment-candidate | Floor: under the default policy the flag only ever adds an approval (under `outward-only` it is the sole trigger, which the settings screen states); every real send or spend still passes the existing outbound and external-operation gates whatever the flag says; the flag is shown in words on the approval screen and is material. Default when unsure: `true`. Ladder: agent sets it → person sees it at approval → gates at the moment of sending. Arbiter: the agent's session, corrected by the team owner editing the card. |
| Whether recorded evidence meets a done item | judgment-candidate | Floor: non-empty evidence per item against the current material hash; `owner-confirms` items need the person's tap; an agent-attested finish is labelled and one `reopen` undoes it. Default when unsure: do not claim; ask in the conversation. Ladder: agent judges → claims → store checks the conditions → person may reopen. Arbiter: the agent's session for `agent-may-certify` items, the team owner otherwise. |
| When the agent asks a person, and when it replaces a question | judgment-candidate | Floor: a question needs text; replacing an open one needs `supersedes` and a reason, leaves a transcript line and stays visible as replaced; approval and sign-off are derived and cannot be replaced. Default when unsure: ask (a needless question costs one tap; a missing one stalls the card with no signal), and do not replace. Ladder: ask → answer, or replace with a reason → the person sees both. Arbiter: the agent's session. |
| Which done items the agent may certify itself | judgment-candidate | Floor: `certify` defaults to `owner-confirms`; it is material, so the person approves the choice; the approval screen marks each such item; a reopened card needs the person's sign-off whatever the marks say. Default when unsure: `owner-confirms`. Arbiter: the agent's session proposes, the team owner approves. |
| Whether a card is a project's own finish or a subtask | judgment-candidate | Floor: no card record ever advances or finishes a Chief of Staff binding, so a project is signed off in exactly one place whatever the agent decides. Default when unsure: the project's sign-off stays with the binding and the card covers the subtask only. Arbiter: the agent's session, corrected by the team owner archiving. |
| Whether a failing pickup keeps trying | invariant; basis: external-constraint; evidence: the No Unbounded Loops standard requires every repeating self-action to carry a brake and a settling state, and the controller is registered in `SELF_ACTION_CONTROLLERS` under that rule. The shape is the invariant: free checks back off to a fixed slow rate; attempts that spend are counted in replicated records and park; a park re-arms only on a person's tap or an ownership change. The numbers (three attempts, 30 minutes, 24 hours) are defaults in `workBoard.pickup`, listed under Fixed limits. |
| Whether to open a card at all, and how many | judgment-candidate | Floor: at least one done item; the single-home table; the daily creation ceiling below. At or over `softOpenCards` the create response says so and the lane aggregates; nothing is refused. Default: a question one reply settles stays a message. Arbiter: the agent's session, corrected by the team owner archiving. |

## Fixed limits

- **At least one done item** — invariant; basis: enumerable-domain; evidence: a card with no item has no condition under which the fold could ever derive `done`.
- **A record-size ceiling exists** — invariant; basis: irreversible-consequence; evidence: journal archives are never deleted (`rotateKeep: 0`) and replicate to every machine, so an unbounded record is permanent growth on every disk. Its value, 32 KB, and the per-field defaults (title 300, need 4,000, recommendation 2,000, done-item text 500, option text 200) are judgment-candidates in `workBoard.limits`, changeable by the team owner on the Work page. A write over a limit is refused with the field and the limit named, so the writer can shorten it, attach the long material as a file in the card's conversation, or ask the team owner to raise the limit. Nothing is truncated. The number of done items, options and links has no limit of its own; the record ceiling bounds them. Surfaces show more than four options as a list.
- **`softOpenCards`, default 30** — judgment-candidate, and not a refusal: when more cards than this sit in a person's "Waiting on you" lane, Home and the lane aggregate, and the agent's create and question responses carry `overSoftBudget` with the count. A legitimate counterexample to any hard number here is an urgent approval that happens to be the 31st.
- **A daily ceiling on agent-written cards exists** — invariant; basis: irreversible-consequence; evidence: each card writes journal records that are never deleted and replicate to every machine, and creates a conversation. Its value, `maxAgentCardsPerDay` default 200 (forty times the growth estimate's 5 a day), is a judgment-candidate the team owner sets; the day is the agent's configured timezone day. At the ceiling the create route refuses `daily-card-ceiling` with the reset time and the two other ways through: the team owner raises the limit, or writes the card (person-written cards are not counted). The count comes from the replicated `created` records in the index, so it can overshoot only by what two machines accept inside one replication lag.
- **Pickup defaults in `workBoard.pickup`:** tick 60 seconds; free-check delay 1 to 30 minutes; three spending attempts before a park; 24 hours waiting before the card also shows in "Waiting on you". Two further rules are fixed, not settings (basis: external-constraint; evidence: the No Unbounded Loops standard, which requires a settling state no setting can remove): at most one automatic re-try of a failure park, on an ownership change; and one agent-caused work pickup between person-proven records. Judgment-candidate defaults the team owner can change. The floor is the shape in the decision row: a free check is never faster than once a minute, and spending attempts always have a cap. A legitimate counterexample to parking on time alone is a quota wall that clears after ninety minutes, which is why waiting for capacity never parks.
- **One open question per card** — invariant; basis: enumerable-domain; evidence: an `answer` tap binds to one question id, and the lane shows one thing needed per card.
- **`quietAfterHours`, default 24** — judgment-candidate the team owner sets; it only moves a row between lanes. A legitimate counterexample is a card whose work takes days of silence, which is why Try again is offered and nothing is stopped.
- **Ten minutes for a previous owner's stream to catch up before a pickup is treated as uncertain** — a default; the floor is that an `outward` card is never handed over on a guess.
- **Degradation event at 64 MB of journal** — a signal only.
- **Done lane 20, pages of 50; answer excerpt 120 characters in the transcript line; "up to ten" sampled finishes at graduation** — presentation and process; the records keep the full text.

## Detectors (P20)

| Detector | Symbol read | State claimed | Corroboration | Unmeasurable ⇒ |
|---|---|---|---|---|
| Waiting on you | a derived status of `needs-approval`, `claims-done`, `held`, `parked`, `quiet`, `with-person` or `unknown`, or an open question | the person must act for the card to move | the status is recomputed from records the agent cannot retract; a reply by that person after an open question is shown on the row, so a stale question is visible | the Home source returns `UNREADABLE`; Home says it could not read the board and never shows zero |
| Approved | a `tap` with `action: approve` | a verified person agreed to this card as it stands | `by` came from the middleware principal with its proof recorded; the fold's own hash equals the tap's; no material change after it | not approved |
| Picked up | a `dispatched` record with outcome `injected` or `spawned` | the agent's session was handed the brief | the outcome is the widened return value of `appInboundDispatch`, written by the machine that ran it; a `dispatching` with no closing record is shown as "may have been picked up", never as picked up | "not yet picked up"; the pickup stays pending or parks |
| Being worked | the card is `with-agent`, not `quiet` | the agent is still moving this card | a card record newer than `quietAfterHours`, from the replicated store | `quiet`: the card moves to "Waiting on you" |
| Previous owner caught up | a completed sync exchange with that machine after the takeover, reaching the head it advertised | this machine has every record the old owner wrote | the exchange's own completion time and sequence numbers, never the reader's `current` label | not caught up: after ten minutes the pickup is treated as uncertain delivery |
| Done | the derived `done` status | the card's finish line was met | evidence per item against the current material hash, and the person's tap for `owner-confirms` items; agent-attested finishes are labelled as such, because the store cannot verify the evidence is true | not done |

## Multi-machine posture

Default posture is unified; every surface is unified through the `workBoard` replicated store unless stated.

- **Cards and every record, including `dispatching` and `dispatched`:** unified (immutable event records, whole-record HLC merge; the fold recomputes hashes). `multiMachine.stateSync.workBoard` is forced on with the feature.
- **The card's conversation:** unified by the existing `appConversations` replicated store; the key is derived from the card id, so every machine names the same conversation.
- **Pending pickups and parks:** derived from unified records; no local journal. Spending attempts and parks are counted from replicated records. The next free-check time is in memory on the acting machine; after a restart the first check runs at once, which costs one pure read.
- **The shared-ledger note per pickup:** each machine writes its own copy from the same replicated `dispatched` record, so the result is the same on every machine; the card's state is never read from it.
- **The approval policy:** unified, as a record in the store; no config value.
- **Ownership change:** a new owner waits for the previous owner's stream before acting on causes it inherited, by the exact definition in §6, and treats a stream it cannot get as uncertain delivery.
- **Redaction:** a replicated record; every machine's reads honour it.
- **Edits made on two machines at once:** converge by the fold; an approval overtaken by an edit that arrives late is revoked when it arrives, with a stop brief (§6).
- **Reads:** answered from the local index, so any machine answers the same once replication is current. Each response carries the fold's newest HLC and, when a peer stream is behind by more than one sync interval, a `behind` field naming the machine, which the page shows. While `behind` names the machine a card was last written on, the page warns "this card may have changed on <machine>"; the tap is still accepted, because the fold and the pickup's re-fold already void a tap that an unseen edit overtook, and a refusal here would let a sleeping machine block the person.
- **Console taps:** accepted on a machine that has a dashboard PIN; a machine without one answers 503 as Approvals do. Picked up by the conversation's routing owner.
- machine-local-justification: physical-credential-locality (the dashboard PIN is a per-machine credential held in that machine's config or vault; this is the existing Approvals posture).
- **Phone taps:** accepted only on the machine that holds that phone's device record and presence key. Elsewhere the phone gets the write gate's existing refusal, and the card screen tells the person to tap from the console or retry when their phone is routed to its own machine.
- machine-local-justification: physical-credential-locality (the phone's presence key lives in the per-machine device registry `state/mobile-devices.json`, and presence challenges are held in memory on the machine that issued them; the replicated device-key ledger carries no presence key).
- **Mixed builds or a machine with the feature off:** records for an unknown kind wait in that machine's stream and are not lost. A card created while the lease holder cannot bind its conversation shows "waiting for <machine> to open the chat" after two sync intervals. `enabled` must agree across an agent's machines, as the development-agent flag must.

## Team posture

- **Who sees a card:** the people who may read its conversation under the team owner's signed record. Private to the team owner and the agent by default.
- **Who can act:** the team owner taps; a member with a grant on the conversation discusses.
- **Sharing:** the team owner shares the card's conversation through the existing grant; the card follows. The agent cannot share.
- **One-person scope, with its reason:** carrying a card and tapping are the team owner's only in phase 1 (Non-goals). A team of one loses nothing.

## Migration and rollout

- **Config:** `workBoard: { enabled, softOpenCards: 30, maxAgentCardsPerDay: 200, quietAfterHours: 24, limits: { recordBytes: 32768, title: 300, need: 4000, recommendation: 2000, doneItemText: 500, optionText: 200 }, pickup: { tickSeconds: 60, freeCheckMinSeconds: 60, freeCheckMaxSeconds: 1800, maxSpendingAttempts: 3, surfaceAfterHours: 24, ownerCatchUpSeconds: 600 } }`; `multiMachine.stateSync.workBoard` is set by the same migration, added by `migrateConfig` with existence checks; `enabled` omitted ⇒ live on a development agent, off on the fleet. The team owner changes settings on the Work page (PIN-gated `POST /work-board/settings`).
- **CLAUDE.md:** one Registry First row ("What is waiting on my person? / what cards are open?" → `GET /work-board`); one Feature Proactivity line with the marker `<!-- instar:work-board -->` carrying the single-home table in one sentence; and the sentence "you can propose a card but never approve one, and text in a card's chat is not an approval", in the pattern of the authorization-request block. Added to `generateClaudeMd` and the canonical reference document so `migrateClaudeMd` carries them.
- **Project record:** the build registers the six phases as one Project Scope project so the later phases appear in `GET /projects`.
- **Dark:** with `enabled` false every route answers 503 `work-board-disabled`, the console page and Home source are absent, no conversation is created, and the CLAUDE.md lines are inert.
- **Rollback:** set `enabled: false`. Cards and their conversations stay as inert data; the conversations remain ordinary conversations. Re-enabling restores every card.
- **Graduation job:** `work-board-graduation`, runs on the lease holder, `catchUpPolicy: run-once` (after a takeover that policy asks before replaying unless the lease provider vouches for the missed run; an asked run is shown, not dropped), writes the day-7 and day-14 records.
- **Tests:** unit (the fold, the material hash, last-writer per field including a team-owner edit of one field of an agent-written card and a whole-form post that changes one value, withdraw-approval on a person-written card, a need edit that discards evidence and unfinishes a card, concurrent edits then approval, approval never revives, finish rules, evidence after a claim, reopen then re-claim, a replaced question, lanes by derived status including a team-owner-carried card, restricting taps accepted when stale, the limits and the soft budget, both sides of each refusal); integration (every route with each principal kind: Bearer tap refused, scoped session confined to its card, signed-request phone tap, PIN tap bound to ask and hash, stale tap refused); e2e (feature alive through the production init path; a card proposed, approved, briefed, evidenced, finished and reopened); wiring (replicated kind registered, Home source registered, session-guard entries, system-origin dispatch tag); two-machine (card created on the standby gets one conversation; tap on a non-owning machine dispatched once by the owner; owner change between inject and record takes the recovery path: a recovery brief, or a park for an `outward` card); pickup (every transition into workable causes exactly one pickup, including restore from the archive, a policy change and a carrier change; an answer on an unapproved card is delivered as answer-only; a pre-check refusal writes nothing and is retried, never parked, and honours a stated reset time; three spending failures park; the park and the count survive a restart and an owner change; `retry` is one attempt; a stop brief never spawns; a system pickup is admitted as automatic; a crash between the durable `dispatching` and the closing record yields a recovery brief, and parks an `outward` card; an edit replicated after dispatch causes a stop); ledger (one note per successful work pickup on each machine, carrying no title; a ledger that is off does not fail the pickup); redact (text gone from every route and from a second machine's reads; the card is terminal; a live session gets a stop that names no title; pending and parked pickups are voided; a later agent write is refused and creates no conversation); releases (an `unhold` that did not name a concurrent `hold` leaves the card held, in both arrival orders); a hold landing during the durability wait (the work brief is not delivered); an answer delivered to a live session while the session pool is full; uncertain delivery surviving a withdraw-and-approve; credential guard (a credential-shaped string in `need`, an answer or evidence is refused); material round trip (a need edited and edited back revives neither approval nor evidence nor a finish); withdrawal survives a policy change; an attachment link whose bytes were purged shows as removed; quiet (a card with no record for the window moves lanes at read time; one with a pending or parked pickup does not; Try again causes one recovery-brief pickup and restarts the window); flapping (a second agent-caused pickup parks; finishing sends no stop; an agent material edit on a done card is refused); generation (evidence, a claim and a sign-off written without seeing a remote reopen stop counting when it arrives); `unknown` (an unreadable record on a workable card stops pickups and claims); ownership change (a new owner waits for the old stream by the exact definition, parks an outward card when a dark owner never completes an exchange, re-tries a failure park once and only once however often ownership changes, and never releases a decision park); crashed attempts count toward the cap; a `systemSource` test (set by the server, refused from a request body, dropped harmlessly by a validator that does not know it); a rotation test (an approval in an archive still counts); team (a member and a guest cannot see an unshared card and can see a shared one without `source` or `projectKey`; a person with the `ownerConversations` grant reads but cannot tap).

## Maturation plan

- **test-agent-live:** a throwaway agent with a team owner, a member and a guest. Proves through the real console: propose, approve, brief delivered, ask and answer, evidence and both finish paths, reopen, a material edit voiding approval, hold reaching a live session, a tap refused for the agent's token, both visibility sides, a pickup that recovers after a refused spawn, a parked pickup and its Try again, and a lease-holder change between tap and pickup. The phone routes are proven by signed-request integration tests in the same run.
- **dev-agent-live:** first, the team owner drives the iPhone card screen on a real phone (the one step that needs a person's Face ID). Then Echo runs with the operator's real asks on cards for one week, and Luna runs the same build against copies of her real cards (she offered on 2026-11-12).
- **fleet:** delivered dark by the migration; the fleet default changes only after the graduation record below and the operator's own reading of it.
- **graduation criterion:** measured from the store over the pilot week: every pickup cause reached a closing record, and each park is listed with how it ended (a person's Try again, an ownership change, or still parked); no card was seen by a person without access; the median time from ask to tap; the share of agent-attested finishes the team owner reopened, plus the team owner's reading of up to ten of them (the store cannot tell whether evidence was true, so this one is a person's judgment); zero operator-found defects on the first screen. An incomplete week writes `incomplete`, never a pass.
- **dark-window:** 14 days dark on the fleet after dev-agent graduation; the day-14 record is written by the scheduled job.
- **ladder:** workBoard.asks

## Frontloaded Decisions

- A card owns its conversation; it is not one and is not a view over one. Basis: structured approval and done items need enforcement outside chat; one transcript removes the copying Luna reported.
- Card conversations are app conversations with no Telegram topic or Slack thread; the key is derived from the card id.
- Server-written transcript lines are stored as agent-role messages that start "Work board:", identified by the card store's own id list; no new conversation role or event kind, so older builds never refuse them.
- The store is a new replicated store of immutable records with its own done-item type.
- Approval binds to the material fields (not the revision) and to the question or claim shown; it never revives.
- Approval is required unless every material field was last written by a person, and always for `outward` cards. Default policy `every-agent-card` (the operator's own rule on Luna's board, and the stricter of the two, so nothing proceeds unapproved while it stands); `outward-only` is a person-set alternative that costs fewer taps. The review message names both and what each costs; the default stands unless he changes it, and changing it later undoes nothing.
- Phase 1 cards are carried by the agent or the team owner, and every tap is the team owner's. Member-carried cards and member approval are phase 3.
- Status and finishing are derived; there is no status route and no `closed` record. A person's tap outranks a concurrent agent record.
- Done items are text with a certify choice; server-run checks are phase 2. Agent-attested finishes are labelled and sampled at graduation. A reopened card always needs the person's sign-off to finish again.
- Approval and sign-off are derived states, not questions the agent writes; a question can be replaced only openly.
- Taps that stop work (hold, withdraw approval, reopen, archive, redact) are never refused as stale, and each always takes effect; a release lifts only the restriction it names.
- A pickup re-checks the card and ownership after its durable intent and before delivery, and a free session slot is needed only when a session must be started.
- An uncertain hand-over marks the card until a recovery-brief pickup succeeds.
- The brief is a pointer with a system origin tag, and its spawn is admitted as automatic. Pickups are derived from transitions into and out of workable, not from a list of taps. Waiting for capacity never parks; three attempts that spent something do, as a replicated record, and a park re-arms only by the person's Try again or an ownership change. An interrupted pickup gets a recovery brief, and an `outward` card is parked for the person first.
- A material edit made on another machine revokes an approval when it arrives, with a stop brief; the window is the replication lag.
- Other sessions learn of a hand-over from a shared-ledger note written on every machine, by card id only; there is no mirror commitment. A card with no record for `quietAfterHours` moves to the person's lane with Try again.
- A person can remove a card's text from every read with `redact`; bytes leave disk at phase 2's compaction. Card writes that contain a credential are refused.
- Evidence, claims and sign-offs follow the approval rule: none revives after a material edit.
- A decision park is released only by a person; a failure park gets one automatic re-try on an ownership change.
- The agent cannot archive a card or materially edit a finished one. The approval policy is a person-written record in the store; with none, every agent-written card needs approval.
- At most one agent-caused work pickup per card between a person's records; finishing a card is not a stop cause.
- A web link is approved as an address; content that must not change is attached as a file.
- One hash (the material hash) and one generation (the set of reopens seen) bind approval, evidence and finishing.
- Server-written lines carry an optional `systemSource` field that older builds drop harmlessly.
- `appInboundDispatch`'s result is widened to a structured outcome and its tag builder gains a system branch; existing callers keep their behaviour.
- No new push or notice source; the agent's reply in the card conversation is the notification.
- No refusal on a count of open cards; a soft budget of 30 aggregates. A daily ceiling of 200 agent-written cards and a 32 KB record ceiling are the only hard bounds, both owner-set.
- Card history lives in the replicated store, not in git; code, templates and config defaults are in git.
- The iPhone card screen is built by this run in the app source on the Mac Studio as its own commit; done for the run means it compiles and its parsing tests pass there.
- The work-board journal is added to backups by this build; app conversations stay outside backups as they are today.
- Build run boundary: ends when test-agent-live is green on the console, the phone routes pass their signed-request tests, and the app compiles with the card screen. The real-phone drive is the first operator-visible step of the pilot.

## Carrier for CMT-1420 <!-- tracked: CMT-1420 -->

The later phases named under Non-goals are carried by one commitment (frozen excerpt from the registry, 2026-11-12):

> **CMT-1420** — "Write and converge the specs for Work Board phases 2 to 6 (loop: leases, cadence, blocker cards; boards, groups and member approval; agent-to-agent handoff; client audience with preview; folding in Chief of Staff and initiatives), each after the phase before it is live on the development agent. Tracked here so the later phases cannot rot."

## Open questions

*(none)*
