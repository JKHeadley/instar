---
title: "Conversations and Work as Instar's front: one tree, one Needs-you list, a fleet"
slug: work-front-doors
author: echo
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: docs/specs/work-front-doors.eli16.md
origin: "Telegram topic 142440, Justin 2026-11-15T02:44:35Z (msg 143192), direction agreed 03:01:04Z (143211) and 03:06:26Z (143219)."
review-convergence: "2026-11-15T03:54:00Z"
review-iterations: 4
review-completed-at: "2026-11-15T03:54:00Z"
review-report: ".instar/lanes/work-front-doors-1114/ (out-fable.md, out-astra.md, out2-*.md, const-out-rules-astra.md, const-out-registry-fable.md, conformance-gate*.json)"
review-note: "Converged through two independent direction/draft rounds (Fable 5.2 and GPT 6 Astra), a full constitution round on both books, and four Standards-Conformance Gate runs; the residue is recorded in the Review record section below."
cross-model-review: "codex-cli:gpt-6-astra"
approved: true
approved-by: Justin
approved-at: "2026-11-15T04:54:46Z"
approval-source: "telegram 142440/143256 2026-11-15T04:54:35Z ('Yes, I agree with all of this') and 142440/143258 04:54:46Z ('Please proceed with everything you've stated here'), answering the message that asked for 'approved, C'."
stage-tracking: "Stage 1 is this build. Next-rung reviews ride on CMT-1802 (stage 2, owner Echo, review 2026-11-28; it names the phone tree piece) and CMT-1803 (stage 3, owner Echo, review 2026-12-12), as section 11 says."
---

# Conversations and Work as Instar's front: one tree, one Needs-you list, a fleet

**Status:** draft for review, 2026-11-14. Direction agreed by Justin: "Yes, this sounds wonderful" [source: telegram 142440/143211 2026-11-15T03:01:04Z], with fleet control in the same message and the relationship foundation in [source: telegram 142440/143219 2026-11-15T03:06:26Z]. **Approved for build with option C:** "Yes, I agree with all of this" [source: telegram 142440/143256 2026-11-15T04:54:35Z] and "Please proceed with everything you've stated here" [source: telegram 142440/143258 2026-11-15T04:54:46Z], answering the trust-journey message that asked for "approved, C".

**parent-principle:** The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred. Fit: one front, one needs list and one tree make the agent reachable and coherent across every surface.

**Sources:** Fable 5.2 brainstorm (`.instar/lanes/front-doors-brainstorm-1114/primary-ux-brainstorm.md`); independent reviews by Fable 5.2 and GPT 6 Astra (`.instar/lanes/work-front-doors-1114/out-fable.md`, `out-astra.md`); Luna's report of 2026-11-14 on the sagemind admin board [source: threadline 8d2a537e-7106-4f0b-890e-c82c4c993e6f, msg-1794709689538-a8xrc8, 2026-11-15T02:28:12Z]; the Mac app plan (`.instar/lanes/desktop-brainstorm-1114/mac-m1-plan-draft.md`).

## Justin's words this spec answers

- "The Instar app and desktop app and the dashboard should work to make conversations and this project management feature its primary user interface ... quickly reach conversations and the work/project management feature and easily navigate between them ... intimately integrated with each other." [source: telegram 142440/143192 2026-11-15T02:44:35Z]
- "We want to make the experience extremely simple and easy for a user to digest ... At the same time ... fine-grained insight into the agent." [source: telegram 142440/143211]
- "A user should be able to declare a default or primary agent that the app opens up with ... swap to any agent that is part of their fleet." [source: telegram 142440/143211]
- "Compatible with ... the conversation hierarchy structure ... a holistic infrastructure that tracks rich relationship data between conversations, tasks, projects ... that the agent can leverage to maintain holistic awareness at all times ... keeps things as relevant and simple for the user as possible." [source: telegram 142440/143219]
- "The constitution's whole purpose is that everything built on Instar is aligned with it and that it's fundamentally a part of every design process" [source: telegram 142440/143232 2026-11-15T03:37:10Z]

Quotations are abridged with "..."; the logged messages hold the full words. They confer no authority beyond what they say.

## Frontloaded decisions

1. **Three doors on every surface: Conversations, Work, Agent.** Same on the iPhone app, the Android app, the native Mac app and the web console. Everything about how the agent runs (sessions, schedule, machines, accounts, costs, people, permissions, settings, insights) lives behind Agent.
2. **One Needs-you list above both main doors.** It is the only inbox and the only badge count. One server read returns the person's needs, built from the `NEED_SOURCES` set that `dashboard/console/needs-model.js` composes today (all of its sources, not only cards) plus the phone's existing fleet rows (`FleetAsk`), filtered per viewer. The console, the phone and the Mac app all draw that one read. Each item appears once, under its most pressing reason, says why it needs this person, and carries its own action. It hides only when a complete read returns zero. If the read, or any source in it, fails or is still loading, the strip stays and says "could not check <source>", and the badge is marked incomplete.
3. **A card has a conversation; it is not one.** The card (agreement: what is needed, done-when, carrier, whose turn, evidence) and its conversation are separate records, as `docs/specs/work-board-asks.md` and `WorkCardStore.ts` define. On screen they are one page: the card strip pinned on top, the chat below.
4. **Project = effort. One tree.** The user word "Project" names the existing effort node of `docs/specs/conversation-effort-hierarchy-v3.md`. The conversation graph is the only tree. Presentation: Chief of Staff first, projects beneath, conversations inside projects, and each card attached to its own conversation. No grouping is added to the card store.
5. **No second database of truth.** Each existing store stays the authority for its own facts. A derived, rebuildable relationship index (links only, never text) answers "what is connected to this?" for both the agent and the screens.
6. **Show first, convert never by default.** Promises, authorizations, passwords, Chief of Staff completion and external blockers keep their own lifecycles and actions. They appear in the Needs-you list; they do not become cards. A card may reference one.
7. **Fleet is aggregation on the device, not shared authority.** Each agent keeps its own graph, identities and team grants. The client combines only what its paired identity may read from each agent. A primary agent is a client setting.
8. **This work does not silently change approval policy, and it does not add any.** Each action keeps its existing authorization path (work-board PIN or Face ID; mandates; Secret Drop). A card organizes work; it never narrows an existing standing grant, and being an agent-written card or an outgoing message is not by itself a sign-off condition. The board's current default (`every-agent-card`) was set when Justin approved phase 1 without picking a rule [source: telegram 142440/142571 2026-11-13T00:41:29Z]; it is broader than the Purpose's short sign-off list, so it is put to Justin as an explicit decision (see "Decision for Justin" below) rather than inherited unexamined. A board tap approves the card workflow, not by itself a protected effect; protected effects use their existing enforcement path and custodian.
9. **Neither app nor dashboard is required** (rules 105, 120). These screens are the best way to see and act, not the only way. Every read and every permitted action here has a conversational equivalent through the verified standing of the person in Telegram or Slack, under the same authority contract, registered in the existing channel-parity inventory. Equal capability does not mean identical layouts.

### Decision for Justin

The work board asks Justin to approve every card the agent writes. The 2.0 Purpose says the agent acts inside its standing role and asks only for its short sign-off list (money or a resource above the level the person named; cannot be undone and falls outside the agent's role; speaks publicly in the person's name; widens the agent's own role or authority; touches a matter the person marked sensitive); rules 18, 82, 103 and 104 say the same. Choose:
- **A (constitution as written):** cards inside standing grants proceed without a new yes; the board asks only when a sign-off condition applies or Justin has reserved that kind of decision; repeated asks of the same kind are offered as standing grants.
- **B (keep today's rule):** every agent card waits for approval, recorded as Justin's explicit governing decision for this board, reviewable later.
- **C (recommended after the trust-journey reflection, `trust-journey.md`):** the person's chosen starting level, the agent acting freely inside what is granted, and an evidenced way to grant more. For Justin today: cards inside Echo's existing permissions proceed; cards that hit an always-ask item or a kind Justin has chosen to see first ask, with his track record on that kind shown on the card; after a streak the board offers to stop asking for that kind. New owners start from their onboarding answer. Not the board's existing "outward only" setting. The per-kind trust journey itself is a separate spec.

### Changes to already-approved specs (approve knowingly)

- **Hierarchy v3 §3.2:** adds a `card-record` authority that may write a `coordinates` placement for a card's own conversation (§3.2 below). Today only `delegates-to` is allowed from the agent.
- **Chief of Staff:** its `tree` parent records are retired into the graph after a full reader and writer cutover (§3.1). Bindings are unchanged.
- **Work board phase 1:** its "one home for each need" table stays. Needs are shown together; none is converted.

## Review record

Round 1: independent direction reviews by Fable 5.2 and GPT 6 Astra (both agreed the direction). Round 2: both reviewed this draft. Fable found 5 must-fix items and Astra 3, one of them shared (seven distinct): the card-placement authority, the phone's missing needs read, existing console links, the agent's read scoped to the conversation's audience, the Chief of Staff tree cutover, split project-status authority, and non-card decisions. All are fixed in this version, together with most of the notes.

Constitution round (added after Justin asked whether alignment had been checked [source: telegram 142440/143228 2026-11-15T03:35:07Z]; it had only partly been):
- Code-backed Standards-Conformance Gate (`POST /spec/conformance-check`, 1.x registry): 98 standards, 2 possible violations: the phone-tap machine rule (a declared `physical-credential-locality` exception inherited from the work board, now cited in §5) and fixed timings (check-in ceiling, undo window; now judgment within declared bounds, §6). Report: `conformance-gate.json`.
- 2.0 constitution, every rule and Purpose article, by GPT 6 Astra (`const-out-rules-astra.md`): 87 aligned, 6 must-fix: approval scope (decision 8, decision for Justin), protected sends (§6), a live and self-checking connected view (§4.2, §4.3), resource bounds (§4.2, §5), the measurement contract (§1), and attributable sources (quotes now carry message ids). All fixed above.
- 1.x Standards Registry, every article (plus the 2.0 book cross-checked), by Fable 5.2 (`const-out-registry-fable.md`): no outright conflict except untracked "later" items, plus nine missing declarations: tracked deferrals <!-- tracked: CMT-1803 -->, a maturation plan, multi-machine posture (§4.5), team posture (§4.4), a notification bound (§8), live proof per stage (§7), a canary for the only inbox (§7), empty-versus-failed reads (decision 2), a parent principle, and three unsourced statements. All fixed. Results are summarised in §9.
- Gate residue: after four runs the code gate still raised two wording-level points on the §4.2 ceilings (how each ceiling is derived, and retry caps versus long outages). Each run named a different detail of the same two standards rather than a new problem, so after the fourth fix they are recorded here instead of re-run, and they are checked again in the stage 2 build review.
- Simplest robust route (rule 116): regroup navigation and draw one needs read. The only added machinery is the derived relationship index (prevents the agent and screens each guessing connections, and a second database of truth) and the `card-record` authority (prevents cards being unfiled or placed by an unauthorised path).

## 1. User outcome

Open Instar anywhere and you land in your primary agent, on Conversations or Work (whichever you used last), with the Needs-you list on top. Moving between a conversation and the work it carries is one tap each way. Switching agent is one tap on the agent's name. The fine detail is always one tap away under Agent, and never competes for the front.

Success, measured on Echo: every item that needed Justin was reachable from the Needs-you list in one tap; going card → conversation → card took one tap each way on the phone; nothing that Home used to show went missing; and Justin found work faster than before.

Measurement (rule 39): before stage 1, record a baseline on today's navigation for time-to-act on a need, duplicate asks, dismissals with reasons, and "could not check" coverage. Echo owns a weekly review through the existing measurement surfaces, with the method versioned, sample size, freshness and gaps shown, and a visual history Justin can read. No invented daily target; missing evidence blocks an improvement claim, never ordinary use.

## 2. Screens

### 2.1 Every surface

```
┌──────────────────────────────┐
│ Echo ▾                 ⓘ     │   ← agent name opens the switcher
│ Needs you · 2            ›   │
│  Renew the domain   Approve  │
│  Luna · Pick a logo  Answer  │   ← fleet rows carry the agent's name
│ ──────────────────────────── │
│ (Conversations or the board) │
│ [Conversations] [Work] [Agent]
└──────────────────────────────┘
```

- **Conversations:** the hierarchy view where available (Chief of Staff first, projects, conversations), or the flat list where it is not (members and guests in v1, agents without the hierarchy). A small card mark shows on any conversation that carries open work.
- **Work:** opens straight on the board. Lanes: Waiting on you, With the agent, Waiting on others, Done (folded). Filter by project.
- **Agent:** the Agent menu shows names and icons only, no descriptions; every page it opens keeps its purpose line. Every count, dot and badge opens its detail, and a refresh never replaces a row being acted on. Fleet first, then today's four console groups (Work's remaining pages, Capacity, People, Settings) as sections, so every existing page keeps a home and none is orphaned. A problem with the agent shows as a Needs-you row when the person must act, otherwise as a dot on the Agent door. No warning without a path to act.
- **Home** stops being a door. Its job becomes the Needs-you strip. Its old link lands on Conversations with the strip open.

### 2.2 A card and its conversation

The pinned strip shows the card title, whose turn, the done-when progress and the one main action. The main action opens the existing approval review (material terms and evidence, `work-board-asks.md` §4) before anything is signed; the strip alone never approves. Row and strip titles are labels; the approval review shows a statement the source agent's server writes from the structured request, never one the client composes, including in merged fleet rows. A row clears only on its source machine's confirmed result. Tapping the strip opens the full agreement (evidence, history, approvals). Opening the card from the board or its conversation from the list lands on this same page. The card shows "From: <source conversation>" when it was made from a message.

### 2.3 Surface specifics

- **iPhone and Android:** five tabs (Home, Chat, Work, Capacity, More) become three. Capacity and More move under Agent.
- **Native Mac app:** a far-left rail of all agents with per-agent Needs-you counts (click or ⌘1–9), the same three doors, the menu-bar and Dock badge counting needs across the fleet. Owned by the desktop app session (topic 143051); this spec is its shared model.
- **Web console:** the sidebar becomes Conversations, Work, Agent. The four groups in `nav-model.js` (Work, Capacity, People, Settings) fold under Agent as sections. Stage 1 regroups the sidebar only: every existing `#/group/page` hash (for example `#/work/board`, `#/capacity/accounts`, `#/people/mandates`, `#/settings/learned?s=pending`) keeps resolving, unchanged or by alias, with a test over every route. `NATIVE_PAGES` continues to cover the older tab ids. A wide screen shows list | conversation | card agreement as three columns.

## 3. One tree

### 3.1 What carries "project" today, and how it resolves

| Today | Resolution |
|---|---|
| Effort node in the conversation graph (`src/core/conversationGraph.ts`) | This is the Project. |
| Chief of Staff project: a bound conversation plus `tree` parent records in `ChiefOfStaffStore.ts` | Bindings keep their existing conversation keys; changing an effort's front door never rekeys a binding. Stage 2 supplies a stable mapping from bound project conversations to efforts and imports `tree` placements idempotently, preserving owner corrections. Tree records also carry the app's Chief of Staff root and role identity, so all tree readers and writers switch together (`ChiefOfStaffLoop.ts` binding and root creation, `ChiefOfStaffStore` role discovery, mobile parent fields in `mobileConversationRoutes.ts`). Authoritative tree writes stop only once (a) the imported placements are committed on every machine, (b) every reader reads the graph instead, and (c) no installed machine runs a build that still writes `tree`. Until then both are written, the graph wins on disagreement, and pending or unaccepted mappings keep today's behaviour. |
| Initiative (`kind: project | task`) in the Initiative tracker | For a Chief of Staff-bound project, the binding and its lifecycle decide open or closed on every machine; Initiative status is a local mirror (`chief-of-staff-topic.md` §1.2). Other linked efforts keep the hierarchy's Initiative-status contract and report unavailable data honestly. The `primaryInitiativeId` link is specified in hierarchy v3 but not implemented in `conversationGraph.ts`; stage 2 implements `primaryInitiativeId`. |
| Card `projectKey` (a Chief of Staff conversation key) | The field keeps its meaning. The effort is found by looking up that conversation's placement. No effort id is added to cards. |

The Chief of Staff conversation stays first in the presentation with no containment edge (a conversation cannot contain an effort), exactly as `docs/specs/conversation-graph-suggestions.md` defines.

### 3.2 Where a card's conversation sits

A card's conversation is an ordinary conversation node, placed once:

1. Owner placement always wins (hierarchy v3 §3.2).
2. Otherwise, if the card names a project, its conversation is coordinated by that effort.
3. Otherwise, if a real delegation justifies it, it sits under its source conversation. Being made from a message is provenance (`made from`), not by itself a parent edge.
4. Otherwise it is unfiled: it shows on the board and under All, not in the default tree.

**This amends hierarchy v3 §3.2**, whose agent ingress may write only `delegates-to` (`conversationGraph.ts` drops any delegation-authority event with another relation). A new authority, `card-record`, with its own receipt kind, may write a `coordinates` placement for a card's own conversation only, outranked by any owner placement. It needs a graph schema version bump and is switched on only when every installed machine runs it, so old and new machines never build different trees. Until then, and for any card whose project the owner has not approved, the placement is a proposal shown from the card record, labelled as proposed, using v3's pending-placement view. Because graph changes commit only when every installed machine has them while card records merge at once, a new card always shows under its project immediately from the card record.

A done card's conversation leaves the default conversation list (it stays in the project, in search and under All), so five cards a day do not flood the list.

### 3.3 Decisions

Card questions remain authoritative for decisions on their cards. Non-card decisions keep their existing source identity, resolution and authorization contracts. Stages 1 and 2 neither implement nor cancel v3's separate attention increment. The agent may offer "Want this as a card?" when a conversation turns into finite work, but nothing requires converting a question into a card. A unified decision presentation, if built, is stage 3 work (CMT-1803) and reuses those sources without a second inbox.

## 4. The relationship foundation

### 4.1 Model

Most of it exists, spread across stores that already replicate: graph events (placement and cross-links), the card store (source, project, carrier, whose turn, evidence), the Chief of Staff store (goals, done checklists, bindings), commitments (`CommitmentTracker.ts`, `CommitmentsSync.ts`), people (`RelationshipManager.ts`). What is missing is one place to ask what is connected to a thing.

- **Node kinds:** conversation, project (effort), card, person, agent.
- **Attached references (typed pointers, not new stores):** commitment, decision, file or artifact, message, session, machine, initiative, pull request, using the hierarchy's typed citation format.
- **Link kinds:** inside (primary placement); made from (card → message); waits on (card → card or commitment, stage 3; stored in the card store because it changes the card's worked-out status, not as the graph's owner-only `depends-on`); involves (person or agent → card, as owner, carrier or whose turn); evidence (card → file, commit, test); related to / replaces (graph cross-links).

Identity is namespaced by agent and source store. Commitments join on `(originMachineId, id)`, never a bare CMT number or a title.

### 4.2 The index

- A derived index on each machine, rebuilt from the authoritative stores' durable changes. It holds pointers, never prose or private names (those stay in erasable payload stores, as the hierarchy already requires).
- It inherits each store's "this machine is behind" signal and shows it, never a false zero.
- It records the source version it consumed from each store and compares it with the source head through the existing health and reconciliation path. A missing or inconsistent projection is shown as incomplete and rebuilt from the retained source records; rebuilding never changes source authority.
- Limits (rules 55, 60, 61; Purpose "ordinary" floor): index storage, rebuild batch size, query fan-out, concurrent fleet requests and injected context each have a declared, enforced ceiling before activation. The ceilings are safety floors, not working sizes (Judgment Within Floors): storage, fan-out and fleet ceilings are derived from the measured resources of the host it runs on (so a larger machine serves a larger neighbourhood), and the injected-context ceiling from the consuming session's actual input capacity and what the index can produce, and recorded with that evidence; within them the agent judges how much to read or rebuild. Reaching a ceiling pages the rest and labels the result incomplete, and a long recovery continues in later bounded batches. When the omitted material is load-bearing for the decision being made, the agent does not decide on the partial view: it fetches the rest, or answers that it cannot decide yet and says what is missing (Never Silently Cut the Data a Decision Depends On). Excess results are paged and labelled incomplete. Only rebuildable data is ever evicted, never authoritative memory. Rebuild retries use the existing retry owners with backoff and a breaker after sustained failure; the breaker pauses retries, it never abandons recovery, which resumes on the existing scheduler however long the outage lasts; the need and the recovery status stay visible without repeated notifications.
- Links already present in authoritative records are derived, not copied. Graph events are added only for relationships a person or agent actually authors. Inferred links stay suggestions and never overwrite an owner correction.
- No new replication protocol and no global transaction across stores. The stores are replication-capable, not universally synchronized on every install; the index keeps the hierarchy brief's distinction between recorded here, copied elsewhere and committed (`conversation-effort-hierarchy-brief.md` takes precedence over the older standard-decision file).

### 4.3 Who reads it

- **The agent:** a scoped internal read path (not the owner's credential; `conversationGraphViewer.ts` stays owner-proof only) returns the neighbourhood visible to every current reader of that conversation (its least-privileged audience), never the owner's view by default, so a session in a shared conversation is never handed owner-private names (hierarchy v3 decision 8). It returns: its project, open cards and whose turn, related conversations, people involved, open commitments, with source versions and missing-data labels. It feeds the session-start context, the post-compaction recovery block (rule 47) and retrieval, through the existing context delivery path: "This conversation is in project X. Two open cards, one waiting on Justin. Related: Y." Sessions already running stay current too (rule 117): before answering about related work, a session refreshes its neighbourhood through the existing context and retrieval path (on a source-version change, or by a fresh scoped read). If current coverage cannot be established, the answer says so. Stage 2 proves a change made in one session is reflected in another already-running session.
- **The screens:** the project name on a card, card tiles in a conversation, the "From:" link, the card mark in the list.

### 4.4 Privacy

Team posture (rule 123): a card and its conversation are owned by the person the card record names, private to that owner by default, and shared only through the owner's signed team record. A `card-record` placement, a tile, a count or the index never widens who can see or act on either end. Members and guests see only what is shared with them.


Every neighbour is resolved through its own store's permission check for the person asking, before counts, search, summaries or notifications. Both ends of a link are checked. A link to something a person cannot see is omitted along with its count; a guest who may read a card does not learn a private project's name or child count. Sharing a source conversation does not share a card conversation made from it. Revocation invalidates client caches and derived summaries. The index never grants access.

### 4.5 Multi-machine posture

- Relationship index: unified by derivation. Every machine rebuilds it from its own replicas of the authoritative stores; no link is reachable only by asking a peer.
- Needs read: any one installed machine returns the person's full list from its own replicas, labelled "this machine is behind" where that applies. Stage 1 checks every `NEED_SOURCES` source for replication and names any that is machine-local, with its justification, before the strip replaces Home.
- Notification budget and quiet check-in records: unified, through the existing replicated stores.
- Phone taps: machine-local by design, `machine-local-justification: physical-credential-locality` (inherited from `work-board-asks.md`, §5).
- Primary agent and navigation position: client-device settings, not agent state.
- A one-machine install runs every function here with no peer.

## 5. Fleet

- **Primary agent:** a client setting in `AgentStore.swift` (and the Mac and web equivalents). The app opens into it. Syncing the primary agent across a person's devices is out of scope (§10).
- **Switcher:** one tap on the agent name; each agent keeps its own navigation position. A notification opens the agent it came from, regardless of the primary.
- **Fleet-wide Needs-you:** the client asks each paired agent for that person's list with that person's credentials, merges rows labelled by agent, and offers a filter by agent. The badge counts across the fleet. The phone's existing fleet rows (`FleetAsk`, `FleetAsksView`) move into the strip, and `othersNeedYou` becomes a count. Requests are bounded (a declared cap on concurrent agents and a per-agent timeout, with backoff and a breaker for an agent that keeps failing); an unreachable agent shows "could not check", never zero. Machines of one agent are deduplicated by verified agent identity, never by name.
- **Trust edges:** each agent's role applies to its own rows (owner on one agent, member on another). No agent ever receives another agent's needs; the combined list is never forwarded to the selected agent. Every action goes back to its source agent and machine (a phone tap is accepted only on the machine holding that phone's device record and presence key, inherited unchanged from `work-board-asks.md`, whose multi-machine posture declares `machine-local-justification: physical-credential-locality`: the presence key lives in the per-machine device registry and presence challenges are held in memory on the issuing machine. The conformance gate flagged this; it is a declared, justified exception, and the card screen already tells the person to tap from the console or retry once routed). A browser console hosted by one agent shows only that agent's needs; fleet aggregation in the browser is out of scope (§10). A peer agent's report is never a human's yes. Lock-screen text from a team-role agent stays neutral.
- **Fleet overview** (each agent's health, machines, sessions) lives under Agent → Fleet.

## 6. Luna's proven pieces (stage 3)

From the sagemind admin board (`projects/sagemind-admin/CARDS.md`, `public/cards.js`; `project_sandbox/admin-tasks/drafts-on-cards/design.md`):

- My board ordering: each item once, under its most pressing reason.
- Every agent card carries a recommendation, and a "why you" whenever it is put in front of a person (enforced fields).
- Closing a card needs a closeout note.
- "Not important" closes a card with a required reason; reasons become lessons the agent checks before raising a new card.
- Quiet check-ins: a check that finds nothing new is recorded, not sent. The wait grows with backoff; Luna's one-day ceiling is a starting default, and the agent may judge a longer or shorter wait within a declared floor and ceiling (Judgment Within Floors). Repeated failure stops automatic retries through the existing breaker.
- Drafts on cards: an email draft lives on its card and is shown as the recipient will see it. Sending follows the sender's standing grant: exact-text approval is asked only when a sign-off condition applies or the person has reserved that decision (rules 18, 104), unless Justin chooses B above. When approval is asked, it covers the exact text, and an edit after approval cancels it. Sending reuses the existing protected effect dispatcher and durable outbound queue, never a second mail sender: the exact send intent and its authorization are durably recorded before dispatch at the installation's accepted durability; a short undo window (two minutes as Luna's default, adjustable within declared bounds; it cannot recall a sent message) fences unsent work; a scheduled send stays pending, cancelled, confirmed sent or explicitly uncertain across restarts; and recovery never repeats a possibly sent message just because Sent shows no match. Sent is checked before the card closes.
- Dismissal lessons keep their source: each "Not important" reason stores who gave it and a pointer to the card and message, and is rechecked when reused (rule 121).

## 7. Build stages

### Stage 1: the front (days; no stored-data change)

- Server: one read route returning the viewer's needs from the `NEED_SOURCES` set, with its device-rule entry. Until a surface uses it, that surface keeps its Home.
- Web: `dashboard/console/nav-model.js` → Conversations, Work (opens on the board), Agent; every existing hash keeps resolving (test over every route). The needs read drawn as the strip above both doors. `conversations-model.js` keeps its hierarchy.
- Wording: the agent instructions and `NEED_EXEMPT` say needs belong "in Home's count"; update to "the Needs-you list" (Agent Awareness, Migration Parity).
- iPhone (Swift sources are on the app's local branch at ae666b4f, not yet on main; the build names the branch it lands on): `AgentFrame.swift` five tabs → three; `AgentStore.swift` primary agent; the pinned card strip on the conversation screen, joining `WorkBoardViews.swift` and the chat screen.
- Android: the same, following `apps/instar-android`.
- Feature-off behaviour preserved: an agent with the board off still gets Conversations and Agent with the strip; the Work door shows Promises and Plans until the board is on.
- Mac: the desktop session builds its v1 to this layout.
- Canary (rule 43): a recurring synthetic need travels the real needs read on each surface; a missed round trip raises one notice in the alerts topic.
- Agent briefing: the new needs read and primary agent are added to the capability index and agent instructions, with a migration for existing agents.
- Live proof before Justin is asked to try this stage (rules 62, 35): a user-role session drives it through the real console, both phone apps, and Telegram and Slack for decision 9's conversational equivalents, and records pass or fail per risk category. Member, guest and revocation scenarios run in throwaway agent homes; no test identity enters a real team record.

### Stage 2: one tree and the agent's connected view (one to two weeks)

- Card conversations enter the graph (`ConversationGraphDelegation.ts`, `WorkBoardService.ts`), with the proposed-placement label.
- "Make a card" from a message; card tiles (viewer-filtered) in the source conversation.
- The relationship index, its scoped agent read path, and the session-start awareness block.
- Chief of Staff `tree` import, then stop the double write (`ChiefOfStaffStore.ts`, `mobileConversationRoutes.ts`).
- "Project" label in `conversations-model.js` and `workBoardViews.ts`.
- Mobile hierarchy routes (hierarchy v3 §7.4), so the phone shows the tree, not only the flat list. CMT-1651 covers only the suggestion routes and review screen; this wider scope is CMT-1802 (owner Echo, review 2026-11-28).
- Fleet-wide Needs-you with rows.
- Flood protections move here from stage 3, because stage 2 adds new sources of needs ("Make a card", fleet rows): each item once under its most pressing reason, and a recommendation plus "why you" required on every agent card.
- The relationship read, "Make a card" and the awareness block are added to the capability index and agent instructions, with a migration. The awareness block is delivered as labelled reference data on every engine and says in its own text what it cut to fit.
- Proof: one ordinary journey across two machines including an offline peer, plus owner, member and guest visibility and revocation, including a member's Work door working with no tree and no project names, and a change in one running session reflected in another.
- Live proof before Justin is asked to try this stage (rules 62, 35): a user-role session drives it through the real console, both phone apps, and Telegram and Slack for decision 9's conversational equivalents, and records pass or fail per risk category. Member, guest and revocation scenarios run in throwaway agent homes; no test identity enters a real team record.

### Stage 3: depth (tracked as CMT-1803, owner Echo, review 2026-12-12)

- Luna's remaining pieces (§6): closeout notes, "Not important" with lessons, quiet check-ins, drafts on cards.
- Waits between cards.
- Member boards and member actions; fleet overview; agent-to-agent cards in "Waiting on others".
- Other needs shown read-only in the board's first lane.
- A unified decision presentation, if wanted.
- Live proof before Justin is asked to try this stage (rules 62, 35): a user-role session drives it through the real console, both phone apps, and Telegram and Slack for decision 9's conversational equivalents, and records pass or fail per risk category. Member, guest and revocation scenarios run in throwaway agent homes; no test identity enters a real team record.

## 8. Risks

- **Attention flooding** (the biggest product risk; it happened on Luna's board on 13 November): each item once, recommendation and why-you required, "Not important" with a reason, quiet check-ins, a notification budget that batches delivery but never hides an obligation, and the agent tries to recover on its own before raising a card. The bound (rules 52, 53): card conversations and need notifications are created only through the existing budgeted creation funnel; N new needs produce one summary notification; a burst test proves the bound in every stage that adds a source of needs. An agent-written card never creates a Telegram or Slack topic on its own; in chat it lives in its source conversation or the alerts topic.
- **Everything becoming a card:** no card without a done-when; promises, permissions and passwords never become cards.
- **A second tree or a second database** that disagrees with the first: the decisions in §3 and §4 exist to prevent it.
- **Privacy leaks through counts and tiles** in teams and across the fleet: §4.4 and §5.
- **Migration:** nothing is deleted; old pages and links keep working; the hierarchy is "in progress", so stage 1 does not depend on it.
- **Mistaking a simple screen for a simple memory:** the relationships stay rich underneath; only the presentation is simplified.

## 9. Constitution alignment

Rule numbers below are Instar 2.0 rule numbers unless marked as 1.x articles (#n).

| Check | Result |
|---|---|
| Standards-Conformance Gate (code, 1.x registry, 98 standards) | 2 possible violations, both resolved (§4.5 / §5 phone-tap exception; §6 timings as judgment within bounds). |
| 2.0 Purpose and every Rule (GPT 6 Astra) | 6 must-fix, all fixed: approval scope and decision for Justin (decision 8), no app required (decision 9), protected sends (§6), a live, self-checking connected view (§4.2, §4.3), resource bounds (§4.2, §5), measurement (§1), attributable sources (quotes carry message ids). 87 rules and Purpose articles aligned; 42 rules not relevant. |
| 1.x Standards Registry, every article (Fable 5.2) | 1 conflict (untracked deferrals <!-- tracked: CMT-1803 -->, now CMT-1802 / CMT-1803 or out of scope) and 9 gaps, all fixed: maturation plan (§11), multi-machine posture (§4.5), team posture (§4.4), notification bound (§8), live proof per stage (§7), canary (§7), empty versus failed reads (decision 2), parent principle (status), sourced statements. 47 articles aligned; 40 not relevant. |

Full tables: `conformance-gate.json`, `const-out-rules-astra.md`, `const-out-registry-fable.md` in this folder. The one decision the constitution leaves to Justin is the approval-policy choice (A or B). No fix needs a constitution change. Agent Awareness and Migration Parity apply to every stage.

## 10. Out of scope

Changing any approval policy other than through Justin's A/B decision; syncing the primary agent across a person's devices; fleet aggregation in the browser console; converting promises, permissions, passwords or blockers into cards; a fleet server; a new replication protocol; hiding Telegram or Slack topics (not attempted in this work).

## 11. Maturation plan (rule 72)

- **Test agent live:** each stage runs first on a supervised throwaway agent with the live proof in §7.
- **Echo live:** then on Echo, with Justin using it, measured against the baseline in §1.
- **Fleet:** on by default for every agent once the graduation criterion holds, unless Justin records otherwise.
- **Graduation criterion:** on Echo, the §1 measures are no worse than baseline and time-to-act improves, from the feature's own logs, with no lost need found by the canary.
- **Dark window:** at most two weeks per stage between Echo live and the fleet decision.
- **Owner:** Echo. Next-rung reviews ride on CMT-1802 and CMT-1803.

## Tracked carriers

> **CMT-1803** — "Review and schedule stage 3 after stage 2 ships; owner Echo"

Stage 2 rides on CMT-1802 (named in section 7).
