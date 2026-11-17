---
title: "Project apps: a project's own app, one tap from its Work row and its conversation"
slug: project-apps
author: echo
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: docs/specs/project-apps.eli16.md
origin: "Telegram topic 141385, Justin 2026-11-16: 14:12 idea (custom app or dashboard per project, the agent suggests it, Cloudflare/Tailnet hosting); 15:13 'stay away from using artifacts or ChatGPT sites since those are locked into a single provider'; 16:28 custom apps first-class, safeguards, the design spec process with a security pass for every custom app, the real risk is a hijacked agent; 16:34 'go!' answering the revised recommendation sent 16:30."
approved: true
approved-by: Justin
approval-source: "telegram 141385, 2026-11-16 16:34 PST ('go!'), answering the 16:30 revised recommendation whose seven points are §0 below. Brief: .instar/autonomous-briefs/143902-project-apps.md. Constitution check on that recommendation 2026-11-17T00:30:14Z: 100 standards, 0 findings."
lessons-engaged: "P2 Signal vs Authority (the agent proposes, the owner's tap attaches); P17 Bounded Notification Surface (one pin per attach, offers are not Needs-you rows); P20 Verify the State Not Its Symbol (the summary is the feature's own read with its as-of time, unreadable is named, never zeros); P21 Multi-Machine (offers, answers and pins replicate; one lease holder acts on platforms)"
companion-spec: "docs/specs/project-apps-sandbox.md (custom apps: the sealed frame, the narrow per-project key, storage, the owner's phone approving which code runs) — separate convergence"
review-convergence: "2026-11-17T01:31:59.684Z"
review-iterations: 6
review-completed-at: "2026-11-17T01:31:59.684Z"
review-report: "docs/specs/reports/project-apps-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 1
contested-then-cleared: 3
---

# Project apps

**Status:** draft for review, 2026-11-16. Effort topic: Telegram 143902 "🧩 Project apps".

**parent-principle:** The User Experience Is the Product. Fit: a project whose state changes over time (counts, stages) is easier to see on its own page than in walls of status text, and that page should be one tap from the places the person already looks.

## 0. What Justin approved (the 16:30 recommendation, answered "go!" at 16:34)

1. Custom apps are first-class for projects, any shape the project needs; attached to the project, shown one tap from the project row in Work and from a strip at the top of the project conversation (a pinned message on Telegram/Slack).
2. Every custom app goes through the instar design spec process (spec-converge) including its security pass before it ships.
3. Each app runs sealed off from the dashboard, with a narrow per-project key; never the dashboard's owner keys.
4. Each app publishes a small summary (headline, counts, as-of time) the Work page and phone apps draw natively and keep for offline.
5. Hosting on the agent's own server by default; Tailscale or the owner's own Cloudflare domain when already set up. No required paid or single-provider service.
6. The agent may suggest an app when a project would benefit: ask once with a preview, remember a no.
7. First step: attach the existing feature maturation board to its project (`telegram:128732`) and conversation.

**This spec covers 1, 4, 5, 6 and 7, and the attachment contract custom apps plug into.** Points 2 and 3 (custom apps) are the companion spec `docs/specs/project-apps-sandbox.md`, converged separately, because they carry most of the security surface and should not hold the first step. Until it ships, the only apps are builtin ones (Instar's own pages).

## 1. Problem

Projects live in Work (`GET /work/projects`, the Chief of Staff's bound conversations). The Feature maturation board shows its project far better than chat, but nothing links it from the project's row or conversation, so the person gets long status messages instead.

## 2. What exists (read from main 0184a9347)

- `src/server/workProjectsRoutes.ts` — `GET /work/projects`, `/mobile/work/projects`: owner-only rows (bindings + work-board cards), a synchronous build with a 10 s shared cache. Console: `dashboard/console/projects.js`, `projects-model.js`.
- `src/core/ChiefOfStaffStore.ts` — the `chief-of-staff-record` kind; `binding` is written only after the route verified the owner.
- Owner proof in the console: `operatorSession()` (`dashboard/console/ui.js`) holds the server's unlock proof in page memory; the server checks it with `ctx.verifyDashboardOperatorSession` (header `x-instar-operator-session`) and `verifyDesktopOperatorSession` for the desktop/embedded console. A plain Bearer is not owner proof (the agent holds it).
- The maturation board (`src/server/maturationBoardRoutes.ts`): async, a 60 s cache inside its route closure, pool scope rate-limited to 12 builds a minute; the console board page reads `scope=pool`.
- Telegram adapter: `setTopicMessagePin` (quiet, throws a reason). Slack: `chat.postMessage`, `chat.update`, `pins.add`, `pins.remove`.
- The lease: `ctx.coordinator.holdsLease()` names the one machine that serves Telegram.

## 3. Design

### 3.1 Apps and app refs

An app is named by an **app ref**:
- `builtin:<id>` — a page Instar ships. A closed list in code; each entry fixes its title, page, native screen and summary function: `builtin:maturation-board` → title "Feature maturation board", console route `#/work/maturation`, native screen `maturation`, summary `maturationSummary`. Unknown ids are refused. A builtin title comes from code, never from the agent.
- `custom:<appId>` — reserved for the companion spec; refused here until it ships.

Records never carry URLs; every address is derived in code.

### 3.2 Records: a new replicated journal kind `project-app-record`

The records ride a **new kind**, not `chief-of-staff-record`: `JournalSyncApplier` stops a peer's batch at the first record `validate` refuses (~line 512), so new types on the existing kind would hold back every later binding and check-in on a machine still on an older build. An unknown kind is skipped: `applyStream` returns early for a kind not in `JOURNAL_KINDS` (~line 451).

| Record type | Key | Written by | Fields |
|---|---|---|---|
| `project-app-offer` | `appoffer:<conversationKey>:<appRef>` | the agent (Bearer route, lease holder only) | conversationKey, appRef, why (the agent's reason, within the record's 8 KiB budget; the row shows its first line and expands), at |
| `project-app-answer` | `appanswer:<conversationKey>:<appRef>:<hlc>` (immutable) | the answer route | conversationKey, appRef, answer (`attach`\|`decline`\|`detach` with `by: owner`; `withdraw` with `by: agent`), via `console`\|`desktop`\|`phone`\|`bearer`, principal, at |
| `project-app-pin` | `apppin:<conversationKey>:<appRef>:<hlc>` (immutable) | `act` steps: the answer route and the pin-retry route; other steps: the acting machine (§3.6) | conversationKey, appRef, platform, state `act`\|`pending`\|`posted`\|`pinned`\|`edited`\|`unpinned`\|`failed`, act? (`attach`\|`detach`\|`retry`\|`update-link`\|`post-again`, on `act` steps), answerRef?, opId, messageId?, replacesMessageId?, baseUrl?, reason?, at |

The attachment state of a (project, app ref) pair is **folded** from the **owner's** answers, newest HLC first: `attach` → attached; `decline` or `detach` → not attached and not re-offerable. The agent's only answer is `withdraw`, which marks an unanswered offer withdrawn and can never change an owner's answer, whatever its HLC. An owner `attach` with no offer is valid (Add app, §3.5). Answers are immutable, so history stays and concurrent taps on two machines cannot lose one.

**Forward compatibility (amended 2026-11-17 from the companion spec's review):** a `project-app-*` record type, or a `custom:pa_<16 hex>` app ref, that this build does not know is **accepted as an inert stub** and ignored by every fold — refusing it would mark the peer's stream suspect and stall replication on a machine still on this build when part 2 ships. Anything else unknown is refused.

**Validation:** `appRef` must match `^builtin:[a-z0-9-]{1,40}$` for a record this build folds; owner answers are only `attach`/`decline`/`detach` and never `via: bearer`; agent answers are only `withdraw`; `posted`/`pinned`/`edited`/`unpinned` steps carry a `messageId`; `baseUrl` is a bare http(s) origin; text fields are bounded plain strings. The schema checks shape only; who really tapped is the route's job (§4, §8).

### 3.3 Routes

- `POST /work/projects/:key/app-offers` (Bearer) `{appRef, why}`. Served **only on the lease holder**; elsewhere 409 `not-lease-holder` naming the holder, so two machines cannot both accept and announce an offer. Refused: `unknown-project`, `unknown-app`, `app-unavailable` (the feature behind the app is off), `custom-apps-not-available`, `already-offered` (any offer exists for the pair, answered or not), `already-attached`, `owner-declined` (newest answer is decline or detach). An unanswered offer is not a no: it stays offered, is never re-sent, and the owner can attach any time. On success the agent posts one message in the project conversation pointing at the Work row; that message is best-effort — the Work row is where the offer lives, so a lost announcement loses nothing.
- `POST /work/projects/:key/apps/:appRef/answer` `{answer, requestId}` (`requestId` from the client, so a retry after a lost response is the same request: the answer and its act are written once, in one journal batch). `attach` needs owner proof: a valid operator session (dashboard or desktop console), or (stage 2) an owner-device signature. A plain Bearer `attach`, `decline` or `detach` → 403 `owner-proof-required`. A Bearer `{answer: 'withdraw'}` is accepted (`by: 'agent'`) only while the pair is `offered`; otherwise 409 `not-an-open-offer` — the agent can withdraw its own open suggestion, never undo an owner's answer. The route sets `by`, `via` and `principal` from the proof it verified, never from the body.
- `POST /work/projects/:key/apps/:appRef/pin-retry` `{action: 'retry'|'update-link'|'post-again'}` (owner proof, or Bearer for the agent; any machine) — writes a replicated `act` step with that act; the acting machine consumes it once (§3.6).
- `GET /work/projects` rows gain:
  - `apps: [{ appRef, title, openHref, nativeScreen?, summary: { headline, counts: [{label, value, tone?}], asOf } | null, summaryState: 'ok'|'pending'|'unreadable', summaryWhy?, summaryAction?: {label, href}, pin?: {platform, state, reason?} }]`, newest attach first;
  - `offers: [{ appRef, title, why, at }]` (open offers only);
  - `answers: [{ appRef, answer, by, via, at }]` (the most recent, so the owner can see who answered and how).
- `GET /work/projects/apps/stats` (Bearer or owner; counts only) — the §10a measures.
- `POST /work/projects/:key/apps/:appRef/opened` (any console or phone session; app ref only) — records an Open tap for §10a.

### 3.4 Summaries for builtin apps

- **Derived, never stored.** The maturation board gets an in-process accessor, late-bound the way the work board's `exposeBoardRead` → `boardFor` is: `exposeMaturationSummary(() => {value, at, state})`, with one in-flight refresh reading the board **at pool scope** (what the console board page shows, so the row and the board agree), started only when a Work read finds the value older than the board's own 60 s cache window (no standing timer), with the board's response cache lifted out of its route closure into that accessor (the board route and the summary share it) — at most one of the board's 12 pool builds a minute. The Work read never awaits it. A rate-limited (429) refresh keeps the last value and its as-of time. When a refresh lands, the `/work/projects` cache is invalidated through a new `invalidate()` on its deps so the row updates on its next read. Before the first refresh: `summaryState: 'pending'`, "Reading the board…".
- **Maturation summary:** headline "`<features>` features: `<live>` live, `<stalledRegressedBlind>` stalled, regressed or blind"; counts Live (ok), Stalled/regressed/blind (attn), Past their date (attn); `asOf` = the board's `generatedAt`.
- **Never zeros for a failure:** a failed read, or a board with no readable reviews anywhere (`reviewMachine: null`), gives `summaryState: 'unreadable'` and a plain `summaryWhy`. A board switched off gives "The board is switched off on this agent." with `summaryAction` ("Turn it on" → the settings page holding the switch). A summary older than the board's own review cadence says "last updated <when>".
- Phones keep their last `/mobile/work/projects` answer for offline through the weak-network effort's saved copy (§3.7).

### 3.5 Console

- **Work row:** each attached app gets an **Open <title>** button on the collapsed line (up to three, then "More apps"), and the first app's headline is the second line with "as of <time>". An unreadable summary shows its reason and action link instead.
- **Open offers:** "Your agent suggests: <title>", the agent's reason under it (labelled as the agent's), **Attach** / **No thanks**. Without a live operator session the console first asks for the dashboard unlock (the path conversation suggestions use).
- **Add app** (row details): every builtin app not attached to this project, declined, removed or withdrawn ones included, labelled from the answer's `by` ("you said no on <date>" / "your agent withdrew this on <date>"). **Remove** sends `detach`. The owner is never stuck after a no.
- **Answers:** the row details list recent answers with how each was made, so an answer the owner did not make is visible.
- **Pin state:** a failed pin shows "Couldn't pin the link in Telegram: <reason>" with **Try again**.
- **Conversation view** (`dashboard/console/chats.js`, `openView`): when the conversation has an attached app, a slim strip between the chat bar and the messages: headline + **Open**, fixed while messages scroll. The pin bar leaves out a pin whose message id is an app pin if such a pin reaches the pin store; otherwise there is nothing to hide.
- **Needs-you:** an offer is optional, not a need, so it is not a Needs-you row; it appears on the Work row and in its one conversation message, and is listed in `NEED_EXEMPT` with that reason.
- **Open taps** are reported (app ref only) for the §10a measures.

### 3.6 Telegram and Slack: steps from acts, never a send from a loop

The pin is a convenience next to the Work row, which stays the source of truth. The rule: **a new message is only ever sent because of one deliberate act**; steps that send nothing new (pinning a message already posted, editing a pinned link in place, unpinning) run on their own.

- **Acts** are replicated `project-app-pin` records with `state: 'act'` and an `act` field: `attach` (written with the owner's attach answer, carrying its `answerRef`), `detach` (likewise), `retry`, `update-link`, `post-again` (from the pin-retry route: owner proof, or the agent's Bearer — the agent can already post and pin messages, so this adds no power). Each act has an `opId` and carries the lease epoch it was written under. **Fencing:** a machine runs a step only while it is still the acting machine for that conversation under that epoch, checked immediately before every platform call (lease epoch from the coordinator, conversation owner from the ownership registry). When the lease epoch changes, the new holder re-issues every act not yet consumed as a fresh act under its own epoch (automatic; no one has to press anything), and treats any act of the old epoch that reached `pending` without an outcome as `uncertain` rather than sending again. An old holder that resumes finds its epoch stale and stops before its next platform call.
- **Who acts:** the Chief of Staff's routing rule (`ChiefOfStaffActionProtocol`): the lease holder decides; it acts itself when the conversation's owner is null or itself, otherwise it sends the step to the owning machine over the same path. Slack goes to the machine holding the conversation. The offer's conversation message (§3.3) follows the same rule. Triggers: the commit observers for this kind (own writes and peers', as `work-card-record` attaches both), boot, and a change of the public address.
- **One pair at a time:** the acting machine runs the steps of one (project, app) pair strictly one after another (an in-process queue per pair), consumes acts in HLC order, and **re-reads the attachment fold before every platform call**. So if a Detach arrives while an Attach's send is in flight, the send finishes, its `posted` step is written, and the next step (seeing "not attached") unpins and records it; nothing is pinned for a detached pair.
- **Steps, each recorded before the next:** `pending` → send the link message → `posted` with its `messageId` → pin it → `pinned`. Telegram: the adapter's ordinary topic send (in topic history; a server notice, exempt from outbound review like other server notices), then `setTopicMessagePin`. Slack: `chat.postMessage`, then `pins.add` (needs `pins:write`; a missing scope is the reason).
- **Automatic, sends nothing new:** an attached pair with a `posted` message not yet pinned is pinned by its id; a detached pair's live link messages are unpinned; when the public address changes, a pinned link is edited in place (`chat.update` / `editMessageText`, `edited`, no notification), once per address, using the adapter's existing edit-rejection rules (as `broadcastDashboardUrl` does): `not-modified` counts as `edited`; only `message-missing` makes the next Update link post a replacement; any other failure stays `failed` with Try again.
- **Uncertain delivery:** a `pending` with no outcome means the send may or may not have reached the platform (a crash, a lost response). Nothing re-sends on its own: the row says "I may have posted the link already; check the conversation" with **Post the link again** (an act, so duplicates are bounded by acts).
- **Failures** are recorded with the reason and shown with **Try again**. No public address: `failed: no-public-address`.
- **Link repair, one table:** edit result `edited` or `not-modified` → done; `message-missing` (the message is gone) → the row says "The pinned link is gone" and **Update link** posts and pins a replacement (`replacesMessageId`); any other edit failure → `failed`, the row says "The pinned link is out of date" and **Update link** tries the edit again; an uncertain send → only **Post the link again** sends.
- **Idempotency:** an `attach` for a pair already attached, or a `detach` for one already detached, writes the answer (history) but no act, so it causes no platform step.
- **Detach** unpins every link message this kind left pinned for the pair. Switching the feature off never unpins. The message is never edited for summary changes.
- **Supervision:** tier0 (deterministic steps), each step in the replicated record and `logs/project-apps.jsonl`.

### 3.7 Phones

- Stage 2: the iPhone app's Work row and conversation header draw `apps[].summary` with Open (builtin maturation → its native board), and offers with Attach / No thanks as owner-device-signed answers on `POST /mobile/work/projects/:key/apps/:appRef/answer`, added to the phone route allow-list as owner-only with its own rate bucket; a member or guest phone is refused (tested). This follows Work's existing audience rule — projects are owner-only until Work projects get team sharing (`docs/specs/work-front-doors.md` §4.4); project apps inherit whatever sharing projects get then, rather than inventing their own.
- Offline: the app keeps its last answer through the saved copy the weak-network effort (topic 143836, session echo-echo-app-weak-network) is building. If that has not landed when stage 2 builds, stage 2 ships online-only. Handoff: confirm that session is running, send it a brief, and record a tracked commitment to check it landed.

### 3.8 The agent's suggest-once judgment

- The agent may offer an app when it judges a project would read better as a page: it keeps sending same-shaped status, the project tracks counts or stages that change, or the owner keeps asking "where are we?". These are inputs to judgment, never a counter.
- "Once" is structural: a second offer for the pair is refused, a no is replicated, and offers are accepted on one machine only.
- If the owner asks in chat for an app, the agent offers it; if an offer already exists for that pair (answered, withdrawn or open), it points the owner to Add app on the row instead.

### 3.9 Agent awareness

`src/data/awareness/project-apps.md`: what project apps are; offer with `POST /work/projects/:key/app-offers`; only the owner attaches; for a project with an app, status messages say what changed plus the link; read `GET /work/projects` before saying what app a project has.

## 4. Security

The threat is a hijacked or prompt-injected agent (Justin, 16:28). This spec adds no agent-written code to any page.

**What the owner proof does and does not prove.** The operator session comes from the dashboard unlock with the PIN. The agent can read its own PIN, so on such an agent the operator session is **not** proof against a hijacked agent: it stops a plain Bearer call and an accidental agent action. That is accepted here because a builtin attach gives a hijacked agent nothing it lacks: the page is Instar's own code, and the agent's Bearer can already post and pin a message. Where an attach makes agent-written code run (the companion spec), the owner's phone must approve it (a Face ID-signed owner-presence approval the host cannot forge).

| Attack | Defence |
|---|---|
| The agent attaches through a plain Bearer call | 403 `owner-proof-required`; `by`/`via` set by the route |
| The agent re-offers after a no, or spams offers | One offer per (project, app ref) ever; a no blocks re-offer; lease holder only |
| An answer the owner did not make | The row lists recent answers and how each was made |
| A record sends the owner to a fake page | No URLs in records; addresses from code and the server's own public address |
| The agent labels a builtin app as a lure | Builtin titles from code; the agent's reason labelled as the agent's |
| A dead or rewritten pinned link | Edited in place when the public address changes; if the edit fails, the row offers Update link; the address used is recorded |
| Markup or links in summary text | `textContent` / native text only; builtin summaries are computed by Instar |
| A record written straight into the journal file, or by another machine | Shape-validated only; authority rests on the writing route, as for `binding`. Accepted here (no new power); the companion spec adds the phone approval for code |

## 5. Multi-machine posture

- `project-app-record` (offers, answers, pins): **unified**, replicated by journal sync. Touch points: `JournalKind`/`JOURNAL_KINDS` and every per-kind map in `CoherenceJournal` (`nextSeq`, retention/rotate table with `rotateKeep: 0`, rate-cap buckets, seq and seen sets); `STATE_SYNC_FEATURE_BY_KIND` in `JournalSyncApplier` with emission flag `multiMachine.stateSync.projectApps`, forced on whenever `projectApps.enabled` is (as the Chief of Staff does); the store schema registered with `ReplicatedKindRegistry` next to `CHIEF_OF_STAFF_KIND_REGISTRATION` in `src/commands/server.ts`; `WriteDomainRegistry` entries for the kind and the `/work/projects/` POST routes; backup and `GET /coherence/journal` pick it up like the other kinds.
- Older machines skip the kind (verified in code); they show rows without apps until they update. A test proves an older-shaped applier marks nothing suspect.
- In-memory attachment fold: built by one journal scan (own tail + peer streams) at boot, then kept current through the committed-records hooks, never re-folded per Work read.
- Builtin summaries: no stored state; each machine derives them from the feature's pool-scope read.
- Platform actions: decided by the lease holder, carried out on the conversation's owning machine (§3.6); only on a deliberate act.

## 6. Decision points touched

| Decision | Class | Floor / basis |
|---|---|---|
| Builtin app ref → page, title, summary | invariant; basis: enumerable-domain; evidence: the closed list of Instar-shipped pages in code | unknown ref refused |
| `attach`/`detach` need owner proof, Bearer refused | invariant; basis: external-constraint; evidence: approved point 6 makes the owner's yes the decision, and only owner-proof paths carry it | 403 `owner-proof-required` |
| One offer per pair; no re-offer after a no | invariant; basis: external-constraint; evidence: approved point 6 "ask once … remember a no" | `already-offered` / `owner-declined` |
| Offers only on the lease holder | invariant; basis: irreversible-consequence; evidence: an announced offer is a sent message that cannot be unsent | 409 `not-lease-holder` |
| When the agent offers | judgment-candidate; floor: once per pair, never after a no, the owner can attach directly; arbiter: the agent's judgment from §3.8 | no offer |
| Offer record ≤ 8 KiB serialized | invariant; basis: external-constraint; evidence: the journal's 80 KiB entry bound with room for the envelope and many records per batch page; the row shows the first line of `why` and expands | 400 with the limit |
| Up to three app buttons per row | judgment-candidate; floor: every attached app stays reachable under "More apps"; arbiter: the layout (a display choice, cheap to change) | — |
| A new message only from an act | invariant; basis: irreversible-consequence; evidence: a sent Telegram message cannot be unsent; steps that send nothing new run on their own | `failed`/`uncertain` shown with the act that recovers it |
| Withdraw only while offered | invariant; basis: external-constraint; evidence: attach/detach are the owner's decision (approved point 6); the agent may only take back its own open suggestion | 409 `not-an-open-offer` |

## 7. Frontloaded decisions

- Builtin apps open their existing page (Instar code; no wrapper).
- Builtin summaries are computed at pool scope, not stored.
- The pin is a static link message; only its address is ever edited (in place), and only a deliberate act sends a new one.
- Offers are once per pair with no expiry; an unanswered offer is not a no.
- Owner proof for builtin apps is the operator session; custom code needs the phone (companion).
- `post-again` and `retry` from the agent are bounded by deliberate calls, not by taps: no power beyond posting a message, which the agent already has.
- Offers are not Needs-you rows.
- Slack is built and tested with stubs and proven live on the Sagemindai test workspace, channel #dcproof-test.
- Stage 1 ends at "offer made on Echo and the whole flow proven live on a throwaway agent"; the Echo pin in topic 128732 follows Justin's Attach tap, asked once with a direct link.

## 8. Known limits

- On an agent holding its own PIN, the operator session does not prove a human (§4); accepted for builtin apps.
- Records are shape-validated by readers; authority rests on the writing route, the same foundation as `binding`. Signing owner answers so every reader can check them is queued as feedback for both.
- Two machines can show different counts until both refresh; each shows its as-of time.
- Telegram cannot tell a bot what it sent or pinned in a topic, so after a crash or lost response mid-send the pair reads `uncertain`; re-posting is then a deliberate tap, and each such tap can add one link message.
- If stage 1 finishes between 23:00 and 07:30 Pacific, the ask for Justin's Attach tap waits until morning.
- The address edit runs when this machine sees its public address change; on an agent whose quick tunnel changes on every restart, a link can be stale for a while after a restart. Echo uses a named tunnel. Reviewed before the fleet decision (§12).

## 9. Tests

- Unit: the three record schemas (good, each bad field, unknown builtin refused, a later build's record type or custom ref accepted as an inert stub and not folded); the fold (orderings, concurrent answers, attach after decline, Bearer decline); maturation summary fixtures (ok, pending, unreadable, no reviews, switched off); the pin step machine (posted → pin by id, pending → uncertain, address change → edit in place, edit `message-missing` → Update link posts a replacement, other edit failure → Update link edits again, detach → unpin all live, attach on an attached pair → no act, a stale lease epoch stops before the platform call).
- Integration: each offer refusal; **Bearer `attach`/`decline`/`detach` → 403 `owner-proof-required`; operator-session `attach` → attached; Bearer `withdraw` while offered → accepted, after an answer → 409**; `/work/projects` carries `apps`, `offers`, `answers`; the pin steps with stubbed Telegram and Slack adapters (posted, pinned, failure recorded; a crash after `posted` pins the recorded message instead of sending again; a crash before `posted` reads `uncertain` and sends nothing on its own; an act written on another machine is consumed once; Attach and Detach racing leaves nothing pinned for a detached pair; an address change edits in place).
- E2E: alive on the production init path (a dev agent's row carries `offers` after an offer and `apps` after an owner-proof answer); an older-shaped applier skips the new kind.
- Console model tests (node): buttons, headline line, offers, Add app with declined entries, strip, pin failure line, the Needs-you exemption.
- **Live proof as the user, before Justin is asked:** a throwaway agent with a test Telegram group and the Slack test workspace: offer → Attach in the real console at 390x844 and 1280x728 → button, headline, strip, Telegram and Slack pins → detach → unpin. Then on Echo: the offer for `telegram:128732`, Justin's Attach, and the same checks on the real Work page, conversation and topic.

## 10. Switch and rollback

- **Switch:** `projectApps.enabled`, dev-gated like the Chief of Staff (live on a development agent, dark on the fleet; absent means default, so no config migration). With the Chief of Staff off there are no projects, so nothing shows. Off: offer/answer/pin-retry routes answer 503 `project-apps-off`, `/work/projects` omits the new fields, the console draws nothing new, no pin step is acted on.
- **Rollback:** records stay inert in their own kind; pins already made stay as ordinary pinned messages.
- **Migration parity:** the awareness entry needs no migrator step; a `CapabilityIndex` line lists the routes; no hook, skill or config-default changes.

## 10a. Observability

- `logs/project-apps.jsonl`: offers (with the reason), answers (how made), Open taps (app ref only), pin outcomes.
- Measures: offer acceptance rate; Opens per attached app per week; for a project with an app, the median length of the agent's status messages in its conversation before and after attach.
- Served at `GET /work/projects/apps/stats`; read by the maturation ladder.

## 11. Build stages

1. The kind, routes, builtin summary, console (row, offers, Add app, strip, pin state), the pin steps, the awareness entry, the stats. Live proof on a throwaway; then the agent offers the maturation board for `telegram:128732` and Justin taps Attach.
2. iPhone: native summary, Open, offer answers (with the iPhone app session; the saved copy with the weak-network session).
3. The companion spec: custom apps.

## Maturation plan

- **test-agent-live:** the §9 user-role live proof on a throwaway agent (test Telegram group, Slack test workspace): offer, Attach, button, headline, strip, both pins, Detach, unpin — each observed on the real surfaces before Justin is asked.
- **dev-agent-live:** on Echo with `projectApps.enabled` on (dev-gated): the maturation board offered for `telegram:128732`, attached by Justin's tap, used by him.
- **fleet:** dark on the fleet; the fleet decision is a recorded review in topic 143902, made only after the graduation criterion holds and the Chief of Staff (without which there are no projects) has graduated.
- **graduation criterion:** from `GET /work/projects/apps/stats` over at least two weeks on Echo: the attached app is opened in at least five of those days, the median length of the agent's status messages in that project's conversation is lower after attach than in the two weeks before, and no attach, answer or pin defect is found by Justin. A zero count is not a pass.
- **dark-window:** at most 28 days from merge to the fleet decision; if the criterion is not met by then, the reason and a new date are recorded on the tracking action, never left dark silently.
- **ladder:** projectApps.builtin

## Open questions

*(none)*
