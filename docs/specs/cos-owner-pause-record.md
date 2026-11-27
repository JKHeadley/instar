---
title: "Chief of Staff owner-pause record: the owner can pause a tracked project, and only the owner"
slug: cos-owner-pause-record
author: echo
parent-principle: "Signal vs. Authority"
eli16-overview: docs/specs/cos-owner-pause-record.eli16.md
origin: "fb-c35a437b-e9c; brief .instar/state/autonomous-briefs/cos-owner-pause-record.md from echo-chief-of-staff (maintainer), 2026-11-16 01:50 PST. Trigger: Justin paused Instar 2.0 in chat [source: telegram 102965/142745 2026-11-13] and nothing could record it."
tier: 2
approved: true
approved-by: echo-chief-of-staff (maintainer, not constitution text)
approved-at: "2026-11-16T17:30:00Z"
approval-source: "agent message 4788db0b-e484-4c57-8a7e-b527f6ea59a6 from session echo-chief-of-staff, 2026-11-16 09:30 PST: 'Approved as maintainer (not constitution text)', with the condition that unknown lifecycle events are counted and surfaced by name (now in Multi-machine posture)"
review-convergence: "2026-11-16T17:26:30.599Z"
review-iterations: 6
review-completed-at: "2026-11-16T17:26:30.599Z"
review-report: "docs/specs/reports/cos-owner-pause-record-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 11
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Chief of Staff owner-pause record

## 1. Problem

Justin wrote "lets pause the Instar 2.0 work again until we get our throughput issues solved" [source: telegram 102965/142745 2026-11-13]. The Chief of Staff tracks 102965 as a bound project, and its state has no way to record a pause. So the loop keeps checking it on cadence. When it reads `stalled` it restarts or redirects the project's session, which works against the owner's decision. The Projects view (work-front-doors stage 2a, PR 3231) already reads a pause (`ownerPause()` in `ChiefOfStaffLoop.ts`, both `BindingState.pausedBy` and `binding.pausedBy`) and shows "Paused", but nothing writes one.

`parked` is not a pause. `parked` means the loop gave up after restarts without progress, and the loop asks "Unpark?". A pause is the owner's own choice, and the loop must leave the project alone until the owner resumes it.

## 2. What already exists

- `ChiefOfStaffStore.ts`: immutable `binding-lifecycle` records (`closed`, `reopened`, `unpark`) with `by: 'owner-tap' | 'chief-of-staff'`. `foldBindingState` folds them by HLC. `reopened`/`unpark` count only when `by === 'owner-tap'`.
- `ChiefOfStaffLoop.ts`: `planDue` (which projects are checked this tick), `checkProject` (judge + restart/redirect), `derivedNeeds` (Needs-you items, including "parked … Unpark?"), `projectsSummary`, `projectsOverview` (already returns `pausedBy`), `ownerTap` (PIN tap for unpark / confirm-done).
- `routes.ts`: `POST /chief-of-staff/projects/:key/tap` (PIN-gated owner tap).
- Attribution paper trail (`src/core/attribution/`): `parseMarkers`, `SourceResolver.resolve` (outcomes `found | pinned-copy | not-found | unverifiable | unreachable | removed`, plus the ASP `authorship`), `checkEligibility` (Telegram: inbound, `provenance: 'user'`, not forwarded, not agent-authored), `quoteIsInRecord` (whitespace / curly-quote / case normalised), `AttributionIdentity` (owner uid from `resolveApprovalOwner`).

## 3. Design

The owner's pause is an owner **tap**: a Telegram button in the Chief of Staff conversation that only the verified owner can press (the same check the existing Unpark / Confirm-done buttons use: `query.from.id === getVerifiedOwner()` in `TelegramAdapter`). The agent may only *ask*, and only when it can cite the owner's own logged words asking for it. The tap is the authority; the cited message is the reason shown.

Why a tap and not "the cited message is enough" (round 1 of review): a cited message proves who wrote the words, not that they still mean this action on this project now. An older "pause" message can be re-cited after the owner said "go again" in chat; a model judge reading one message cannot see that, and a PIN path is reachable by any session that can read the config. One tap from the owner, in the conversation they already read, proves who, what and now, with no judge, no replay window and no clock comparison.

### 3.1 Store

Two new values in `COS_LIFECYCLE_EVENTS`: `owner-pause` and `owner-resume`, on the existing immutable `binding-lifecycle` record (key `lifecycle:<conversationKey>:<hlc>`). Extra fields `who`, `quote`, `messageRef` and `askId` (the ask's nonce) are added to `KNOWN_FIELDS` and to the validator's return object. The validator accepts `owner-pause`/`owner-resume` only with `by: 'owner-tap'` (never `chief-of-staff`) and non-empty `who`/`quote`/`messageRef` within §3.5's bounds. `bindingHlc` carries the current winning binding's HLC (the validator requires one); the fold ignores it for these two events.

`foldBindingState` adds `pausedBy: { who, at, quote, messageRef } | null` to `BindingState`: among valid `owner-pause`/`owner-resume` events the newest by record HLC wins; an event whose `askId` already appeared on an earlier event is ignored (one ask can decide once, even if a crash or a redelivered callback writes it twice) — the same ordering every lifecycle event in this store uses. A pause sets `pausedBy`; a resume clears it. A pause belongs to the conversation, not one binding version: it survives an owner edit of the binding.

### 3.2 The ask (agent → owner) and the tap (owner → record)

**Ask.** `POST /chief-of-staff/projects/:key/pause-ask`, bearer auth, body `{ action: 'pause' | 'resume', marker }`. Before anything is sent, a deterministic floor (exact logged facts, in code, `src/core/cosOwnerPauseSource.ts`) must hold, else 422 with the named reason and nothing sent:
- `marker` parses as exactly one attribution marker on channel `telegram` (`marker-malformed` / `channel-not-supported`). Owner messages sent from the Instar app are Telegram rows with `via: 'mobile-device'`; they pass only if their ASP verdict is `human`, otherwise `not-human`.
- `resolve(ref)` returns outcome `found` (any other outcome is refused under its own name).
- The resolved `authorship` is `human` (`not-human`).
- `String(row.telegramUserId) === String(<verified owner uid>)`, the same principal the `cos:` button check uses (`not-owner`; no owner: `owner-unknown`). This is the real owner gate (name matching alone would pass a team member who shares the owner's first name) and is tested with that case.
- `checkEligibility` passes for that row (its reasons pass through: `not-inbound`, `unproven-provenance`, `forwarded`, `agent-authored`, …).
- The key is a confirmed, open binding for a pause; for a resume, a confirmed binding that is paused, open or closed (a pause survives close, so it must be resumable after close) (`no-project` / `not-paused`).

`ownerText` is the full stored row text from the resolver (never a history reader that cuts text). There is no agent-chosen quote: the ask shows, and the record keeps, the owner's WHOLE message text (so a fragment can never be cut out of "don't pause 2.0 yet"). The cited message may be in any conversation; the ask names where it was written.

Order: make the nonce, send, take the chat and message id from the send, then write the ask record; a tap that arrives before the record is written (or after a failed write) finds no ask and answers "That action no longer applies." The route runs only on the machine that receives Telegram button presses (it polls Telegram itself, or its own lifeline polls and forwards the callbacks); anywhere else it returns 503 `not-callback-machine` (call it on the awake machine, which holds the agent's lease and receives the presses) (a standby has a send-only adapter, so an ask from it could never be answered). No verified owner → 503 `owner-unknown`. The route then writes an **ask record** on this machine (`state/cos-pause-asks.json`: a random nonce → `{ key, action, marker, ownerText, writtenIn, sentAt, chatId, askMessageId }`) and sends ONE message with a button through a send that returns the `{ chatId, messageId }` of the chat actually used (the forum group chat for a topic send, the owner's own id for a private-chat send; a held or unknown private-chat send refuses the ask with 503 `send-unconfirmed` and a failed topic send with 503 `send-failed`, and neither writes an ask record — a late copy of such a message answers "That action no longer applies.") (`sendOfferList` to the Chief of Staff topic, or `sendOwnerDMWithButton` when the Chief of Staff's notes go to the owner's private chat because the topic has more than one reader or the count is unknown); the ask record keeps that chat and message id, never the configured group id: `<project>: you wrote in <conversation name> on <date>: “<owner's message>” <marker>. Pause it? Until you resume it I won't check it, restart it or nudge it. A session already running keeps going until it ends, and runs you started yourself are not affected.` (plus, when any machine reports an older build, `Not enforced on <machine> until it updates.`) with one button `Pause: <short title>` → callback `cos:p:<nonce>` (resume: `Resume it?` / `cos:r:<nonce>`). The owner's whole message is always shown: when the ask would not fit Telegram's 4096-character limit, the owner's message is sent whole first as its own message, and the ask then says `you wrote (above)` instead of repeating it. The nonce keeps callback data far under Telegram's 64-byte limit for any key. At most one open ask per project, whichever action: a new ask replaces any open ask for that project (its buttons are removed, best-effort), and once the owner's decision is recorded every open ask for that project is removed, so an old button can never act later on a stale context. The ask record is machine-local by design: it lives where Telegram is polled, which is where the tap arrives. If Telegram polling moves to another machine before the owner taps, the open asks are lost (the tap answers "That action no longer applies.") and the agent asks again. The response lists, as a warning only, any machine whose reported build is older than this one (numeric version compare); see Multi-machine posture. Attribution not running → 503 `attribution-unavailable`.

**Tap.** The adapter's owner check is unchanged; the tap it hands on now also carries `query.message.chat.id` and `query.message.message_id` (the `onChiefOfStaffTap` signature grows by these two fields, including on the lifeline-forwarded path). `ownerTap` accepts `cos:p:<nonce>` / `cos:r:<nonce>`, loads the ask record, and requires the tapped message id and chat to equal the ask's `askMessageId` / `chatId` (so a button on any other message, even one carrying a real nonce, does nothing). Before writing, it checks the union for an event already carrying this ask's `askId`; if one exists, the tap returns that result and writes nothing (the check and the write run without an await between them, so two callbacks cannot both pass). It then writes the lifecycle event with `by: 'owner-tap'`, `askId` = the nonce, `at` = now, `who` = the owner's name (or "owner"), `quote` = the owner's whole message exactly as verified when the ask was written, `messageRef` = the cited marker, and deletes the ask record (a redelivered callback then finds no ask and does nothing) — only after the journal reports the write accepted AND durable (`awaitDurable` on its sequence, as the action protocol does before acting). When the write is refused, the ask is kept and the owner sees a plain failure line ("Couldn't save that; tap again in a minute."), never "Done." On success the owner sees "Paused. I won't start, restart or nudge it from here on; anything already under way may still finish." (or "Resumed."). Before writing, the tap re-runs the source floor on the ask's marker (attributed words are verified when they are enforced, not only when cited). A CONTRADICTION refuses: the message now resolves with different text (edited) or as removed, or no longer as the owner's own human-written message; nothing is written, the ask is kept, and the owner sees "Your original message changed or can't be confirmed as yours, so nothing changed; ask me again." UNAVAILABILITY does not refuse (the row rotated out, the resolver or a peer is unreachable): the words were verified when the ask was written and the tap proves who and now, so a degraded detector never strands a pause or a resume. After the re-check (the only await), the tap reloads the asks and requires this nonce to still be the project's current ask, so a replaced ask's slow tap cannot land after its replacement. Nothing is substituted: what is recorded is exactly what the owner was shown and tapped under. The tap applies the same binding rule as the ask (a resume works on a closed, paused project). No ask record or a mismatched message → `ignored` ("That action no longer applies."). A pause or resume is always recorded when the ask matches, even when the local fold already agrees, so a decision made before replication arrives is never lost. The tap also counts as a check-in, as every Chief of Staff tap does.

The dashboard PIN tap route stays limited to `unpark` and `confirm-done` (tested): the dashboard PIN, and the console operator session it unlocks, are readable by any session with the bearer token, so they cannot prove the owner chose a pause. A device-signed owner control in the Instar app would be a stronger proof and a path for agents without Telegram; it is tracked as fb-0ac4fffb-148, together with a review of the parent spec's console-session renewal proof, which rests on the same PIN.

Why not an owner command (`/pause <project>` in the Chief of Staff topic): it would prove who and now with one action, but the owner speaks in plain words in the project's own topic ("lets pause the Instar 2.0 work again until …"), and turning those words into a command needs either the owner learning a syntax or a model reading meaning; the ask turns the owner's own words into one button. Why an on-demand ask and not a standing Pause button on every project line: the note already carries up to eight buttons for things that need the owner, and a standing button needs the same per-message ask record to be safe; the ask appears only when the owner has asked for it.

The ask floor is a display-honesty check (a "you wrote" shown to the owner must be their own logged words), not approval: a cited "ok" passes it. Only the tap decides.

### 3.3 What a pause stops

- `planDue` skips a paused project: no gather, no judge spend, no restart, no redirect.
- **Execution fence:** `actionGate` gains `paused: boolean`; the action protocol re-checks it on the ownership machine inside the conversation lock, just before the durable `executing` record, and refuses with `owner-paused` (a new `CosRejectReason`, recorded, not a pre-auth reason). A restart/redirect claimed before the pause, or by a holder whose fold lagged, does not run. The cutoff is that in-lock check: an action that passes it before the pause has reached the ownership machine's own fold (the pause write does not take that machine's conversation lock; replication normally takes seconds) may start. Accepted: no acknowledgement barrier is added, because the pause stops every later check, restart and respawn, and the owner was told a running session keeps going.
- The Liveness Reconciler / silence backstop treat a `cosNoRespawn` run whose project is paused like an expired lease (`cos-owner-paused`): a run that ends is not respawned. Runs are keyed by Telegram topic id, mapped to `telegram:<topicId>`; Chief of Staff runs are Telegram-topic runs today. A pause does not kill a run already in progress.
- `derivedNeeds` skips a paused project (transient note lines are only created by checks, which a paused project no longer gets), and the dashboard's `chiefOfStaffNeedRows` (`dashboard/console/needs-model.js`) skips rows with `pausedBy`. The wording never says just "paused": it says "Paused by you" for a project (the lease state keeps its own "Your Chief of Staff is paused until you check in").
- Resurfacing: each note that is sent lists paused projects in one line ("Paused by you: <title> since <date>"); a paused project alone never triggers a note.
- `projectsSummary` and `projectDetail` gain `pausedBy`; `projectsOverview` already returns it.
- `ownerTap` unpark / confirm-done still work on a paused project.

### 3.4 Awareness

`src/data/awareness/chief-of-staff-owner-pause.md`: when the owner asks in chat to pause or resume a tracked project, call the ask with their message marker and words; the owner taps the button; never pause on your own judgement; before asking, find the owner's message yourself (`/attribution/find` or the conversation history) and cite it; on a 422 fix the citation yourself, and only if no owner message asks for this, tell the owner plainly that you need them to say so in chat. `CapabilityIndex` entry for the ask route.

### 3.5 Bounds

- `quote` ≤ 4096: Telegram's own message length limit, so any real owner message fits whole. The merged reader `ownerPause()` refuses fields over 2000 today; its `quote` bound rises to 4096 so a long quote never reads back as "no pause".
- `who`, `messageRef` are server-produced (owner name, parsed marker or tap reference); they keep the reader's 2000 bound.

### 3.6 Threat model

In scope: a session holding the bearer token, the dashboard PIN or the bot token, acting through the API or Telegram. It cannot pause or resume: the record is written only from an owner-verified callback that matches a server-written ask on the exact message the server sent, and the ask itself requires the owner's own logged message. Out of scope: a hostile process with shell access on a paired machine, which can write the journal or the ask file directly (true of every Chief of Staff record today).

## Multi-machine posture

Replicated (unified). Pause events ride the `chief-of-staff-record` store; the fold is order-independent (record HLC). The ask record is machine-local by design (machine-local-justification: physical-credential-locality — it is bound to the Telegram bot's polling machine, the only machine that receives the owner's callback for that message).

Mixed-version window (checked in `JournalSyncApplier`): an older build refuses the new event as `store-schema-rejected`, does not advance its pull cursor for that peer's Chief of Staff stream, and re-pulls and accepts it once it updates (unless the sender rotated the entry out first). Until then that older machine's view of Chief of Staff records from that peer is frozen. This is accepted, not blocked: the owner's decision outranks a temporary freeze on a machine that auto-updates; the ask response names any machine reported older so the agent can say so; and the execution fence stops a stale holder's action on an updated ownership machine. To keep this from recurring, **this build's validator stops rejecting unknown lifecycle events**: an event value it does not know (lower-case words joined by '-', within the store's usual 200-character short-field bound) with any short `by` is accepted and stored, and the fold ignores it. So every later addition, and a rollback from this build (§6), no longer stalls a stream. Such events are never silent: `GET /chief-of-staff` reports `unknownLifecycleEvents` (count per event name), so an older machine skipping a newer machine's events is visible (maintainer approval condition). It is not lossless: the store keeps only fields it knows, so a later event that needs new fields must be readable from the fields kept, or ship its reader first.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| Ask floor (may the agent ask the owner at all) | invariant; basis: external-constraint; evidence: the constitution's Attributed Statements Trace to Their Source — a "you wrote" shown to the owner must be their own logged words, which is a field fact of the record (hard-invariant validation), not a judgement | exact logged fields (`authorship`, `telegramUserId`, `provenance`, `forwarded`, conversation id) and normalised containment; it only gates whether the owner is asked, never the pause itself |
| Pause / resume itself | invariant; basis: external-constraint; evidence: Telegram's callback `from.id` equals the verified owner (the proof the existing Unpark / Confirm-done buttons and lease renewal use), on the exact message of a server-written ask | the owner's tap is the authority |
| Fold: newest owner decision wins | invariant; basis: enumerable-domain; evidence: two event values ordered by record HLC, as every lifecycle event in this store | order-independent merge |
| Loop skip, execution fence, no respawn | invariant; basis: irreversible-consequence; evidence: a restart, redirect or respawn of work the owner paused acts against the owner's recorded decision and cannot be taken back once it runs | the owner's record is the authority; nothing to judge |
| Field bounds (`quote` ≤ 4096; `who`/`messageRef` ≤ 2000; unknown event names within the store's 200-character short-field bound) | invariant; basis: external-constraint; evidence: Telegram's 4096-character message limit (a whole owner message always fits); the other two are server-produced values and the store's existing short-field bound, not new numbers | no caller input reaches `who`/`messageRef` |


## Frontloaded Decisions

1. The owner's Telegram tap is the only way to pause or resume; no PIN path, no message-only path.
2. The ask requires a cited owner message (any conversation) and shows and records the owner's whole message; at most one open ask per project, whichever action (a new one replaces the old).
3. Outcome `pinned-copy`, `UNRESOLVED` and app-sent rows without a `human` verdict are refused for the ask. Non-Telegram agents get no ask path in this change (the Chief of Staff's buttons are Telegram-only today); `not-callback-machine` says to call it on the awake machine.
4. Mixed-version machines are warned about, not blocked; the validator becomes tolerant of unknown lifecycle events.
5. The ask route does not enforce quiet hours; the agent's own no-requests-at-night rule applies.
6. A pause is per conversation; it survives a binding edit and a close / reopen.
7. A pause does not kill a running session; it stops the Chief of Staff from starting, restarting, redirecting or respawning it.
8. Rollback is the `chiefOfStaff.ownerPause.asks` switch (pause asks only), never a revert.
9. Unpark and confirm-done remain allowed on a paused project.
10. Who approves this spec: echo-chief-of-staff as maintainer (not a constitution change).

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** the live-user-channel proof in §5: a throwaway agent with its own bot and demo group, where a user-role session asks, taps Pause and Resume as the throwaway's owner, and a non-owner's tap is refused.
- **dev-agent-live:** live on the development agent (Echo) from the release that carries it, where the Chief of Staff already runs. First use: the Instar 2.0 pause from Justin's 13 November message, asked and tapped; then `GET /chief-of-staff` shows `pausedBy` and no check-event is written for that project while paused.
- **fleet:** follows `chiefOfStaff.enabled`, which is development-agent-gated today; the owner pause ships wherever the Chief of Staff runs, with no separate gate, because a Chief of Staff that cannot be paused by its owner is the defect.
- **graduation criterion:** on Echo, at least one real owner pause tapped and held for a full check cadence with zero check-events, restarts or redirects for that project, and one resume that brings the next check back. A zero count is not a pass.
- **dark-window:** none — live on release. If the criterion is not met within 14 days of the release, the reason and a new date are recorded on the Chief of Staff's own project for this work.
- **ladder:** not applicable: it rides the Chief of Staff gate (chiefOfStaff.enabled)

## 5. Tests

- Unit: store validation (owner-pause with `by: chief-of-staff` refused; missing/oversized fields refused; unknown event names accepted and ignored by the fold; old events unchanged); fold (pause → pausedBy; resume → null; newest HLC wins regardless of arrival order; survives a re-bind); `planDue` skips paused; `derivedNeeds` and the note drop a paused project and list it in the paused line; `actionGate.paused` → `owner-paused` inside the lock; `ownerTap` with `cos:p:` / `cos:r:`: matching ask writes the verified owner text and marker and deletes the ask, mismatched message id or chat ignored, unknown nonce ignored, redelivered callback ignored, a crash between write and ask-delete followed by a resume and a replayed pause callback does not re-pause (askId dedupe in the tap and the fold), `asks` switch off → pause asks 503 `asks-off`, resume asks still work and existing pauses still hold, a new ask of either action replaces the project's open ask and a recorded decision clears them, the ask is deleted and "Done." answered only after the write is durable, resume while locally unpaused still records; an owner message too long for one ask is sent whole first and the ask points to it; a tap whose re-check finds the message edited or no longer the owner's writes nothing and keeps the ask, while an unavailable resolver still records; an old ask's tap that finishes after a replacement ask was sent is ignored; source floor refusals (malformed, non-telegram, not-found, not-human, agent-authored, forwarded, other sender incl. same-first-name member, numeric uid matches, no project) and the success path writes one ask and sends one button message showing the whole owner message; reader accepts a 4096-char quote; `chiefOfStaffNeedRows` skips paused; the PIN tap route refuses `action: pause`.
- Integration: the ask route refuses on a non-callback machine (503 naming the poller); the ask to the owner's private chat records that chat's id and the tap matches it; a refused journal write keeps the ask and does not answer "Done."; the ask route through HTTP (422 sends nothing; success sends one message with the `cos:p:` button and returns the older-machine warning list); a simulated owner tap on that message pauses and `GET /chief-of-staff` shows `pausedBy`; a non-owner tap is refused by the adapter.
- E2E: the ask route is alive (not 404/503) on the production init path.
- Live-user-channel proof (Telegram; the Chief of Staff buttons exist only on Telegram, so Slack is n/a): on a throwaway agent with its own bot and demo group, a user-role session asks, taps Pause as the throwaway's owner, sees the project paused in `GET /chief-of-staff` and the Projects read, taps Resume, and a non-owner account's tap is refused; plus the Studio check: the ask for 102965 is refused for a forged and an agent-authored marker and accepted for Justin's message.

## 6. Rollback

Pause asks are switchable: `chiefOfStaff.ownerPause.asks` (default on). Rollback is turning it off in config, not a code revert: the ask route then refuses `action: pause` with 503 `asks-off`, while resume asks, taps, the fold, the loop skip and the fences keep working, so existing pauses hold and the owner can still resume any of them. A plain revert is not a rollback path, because older builds reject the pause events (stalling their Chief of Staff stream) and every paused project would silently restart against the owner's decision; a defect in the fold or fences is fixed forward.
