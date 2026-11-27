---
title: "A native conversation for every session (part 2 of 3)"
slug: "session-conversation-for-every-session"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "session-conversation-for-every-session.eli16.md"
status: "draft"
approved: true
review-convergence: "2026-11-07T01:09:00.000Z"
review-iterations: 4
review-completed-at: "2026-11-07T01:09:00.000Z"
review-report: "docs/specs/reports/session-conversation-for-every-session-convergence.md"
approved-by: "echo, under its standing grant, for Justin's words in Telegram topic 134088, 2026-11-06 14:11 PST: \"By default a session should always have a native Instar conversation associated with it and that conversation should be able to swap machines and engines just like any other conversation.\""
---

# A native conversation for every session (part 2 of 3)

Part 1 (`docs/specs/session-swap-any-conversation.md`, PR #2889) lets any conversation (Telegram, app or Slack) switch engine and model. That only reaches sessions that have a conversation. Today, a session someone starts from the dashboard or the app with "No chat (terminal only)" has none. It can only be typed to in its terminal, and it can't switch engine, model or machine. On an agent with no Telegram and no Slack, every session started that way has none.

## 1. Problem

Justin, topic 134088, 2026-11-06 14:11 PST: "By default a session should always have a native Instar conversation associated with it and that conversation should be able to swap machines and engines just like any other conversation."

Three things stand in the way:

1. **Session creation.** `POST /sessions/create` (`src/server/routes.ts`) knows three choices: `telegram`, `slack` and `headless`. `headless` spawns with no conversation. The automatic choice falls back to `headless` when neither Telegram nor Slack is connected.
2. **New-session surfaces.** The dashboard's New session form (`dashboard/console/sessions-model.js` `PLATFORMS`) and the phone's `session-new` action (`src/server/mobileSessionControlsRoutes.ts` `createBody`) offer the same three choices.
3. **Engine at creation.** The engine and model picked at creation are refused for anything but Telegram (`preference-needs-telegram`), because only a Telegram topic had a profile key to seed.

## 2. Design

### 2.1 A fourth choice: `app`

`POST /sessions/create` accepts `platform: 'app'`. Its steps, in order:

1. **Check, before anything is created.** Each refusal has words:
   - **App conversations aren't wired here** (`ctx.appConversations` or the starter hook is null). 503 `app-conversations-unavailable`.
   - **The name isn't a valid conversation title.** It is cleaned with `cleanConversationTitle` (80 characters or fewer, with `"[]()` stripped), as the phone's create route does; nothing usable left gives 400 `bad-conversation-name`: "…must be 80 characters or fewer, and not only quotes or brackets." This also applies when Automatic resolves to `app`, so on an agent with no Telegram or Slack a name of 81 to 128 characters is refused where terminal-only used to take it. The words say so.
   - **An engine or model pick on a machine that doesn't serve app conversations.** 400 `engine-choice-needs-serving-machine`: "Pick the engine from the machine that runs your app conversations, or leave it on Automatic." A profile written on a standby lands in a store the serving machine never reads (part 1, §3.4).
   - **This machine serves app conversations but its reply relay isn't ready.** That is the same `relayReady()` the inbound dispatch checks. 503 `app-relay-not-ready`. It is checked here because a session can't start, and no later message could start one either.
   - **A door or model choice** is validated as for Telegram (`validateDashboardProfileChoice`). A machine choice is refused, as in 2.3.
2. **Repeat protection, durable.** The create goes through the phone's own durable request store (`MobileChatRequestStore`, device id `dashboard`), as `POST /mobile/conversations` does:
   - **The request id** has the phone's format, `<epoch ms>-<uuid v4>`, within the store's 24-hour window. The dashboard makes one per intended create when the New session sheet opens, keeps it across retries after a timeout or a server fault, and replaces it after a definite answer (2xx or 4xx). A body with no valid id gets a fresh one on the server.
   - **The reservation** names the new conversation key before anything is written. A create cut off between reservation and record is finished at boot by `AppConversationService.recoverStranded`, as a phone create is.
   - **A repeat**, even after a restart, finds the finished create and resumes it: the same conversation, a seed only if none was recorded (the seed writes only when absent), and the start finds the session already running (the starter's live-session check) or starts it. The request's identity is its name and engine pick, so the same id with either changed is refused (`request-id-reused`), as is a concurrent repeat with a different name.
   - **A refused create**, where nothing was written (recording off, alias refused), releases its request, so a retry with the same id runs again instead of replaying the refusal. A repeat that finds the create still in progress answers 202 with "still being created".
   - **A concurrent repeat** waits for the one in flight through an in-memory map that holds only the in-flight promise. It is settled in a `finally`, even on a throw, and then deleted, so nothing stale is cached.
   - **The phone's** `session-new` is a single-use Face ID action and can't repeat.
3. **Create the conversation.** Make a new key with `newAppConversationKey`, the phone's helper, and write it into the reservation first. Call `AppConversationService.applyCreate('dashboard', <requestId or a random id>, key, <cleaned name>, null)`, the call the phone's create route makes, with the owner as owner. The `created` event replicates. The serving machine binds the alias, as it does for a phone-created conversation. A refusal (recording off, alias refused) is answered with its words: `{ code: <its error>, error: <its detail> }`, never the bare code.
4. **Seed, only where the conversation is served.** With an explicit choice or a new-topic default, seed the profile key `app:<key>` with `seedTopicProfileAtCreation`, as the Telegram path does. Its disclosure is a no-op: the seed function's Telegram notice can't address an app key, and the session's own first line follows. A standby never seeds, and answers `pinRetained:false`.
5. **Start**, only on the machine that serves app conversations (`isOwner()`). The starter from part 1 gains the option `{ reason: 'new' }`. In order:
   - **Relay readiness.**
   - **The memory place.** It is recorded exactly as an inbound message records it: the same `memoryInbound.onInbound` call, private, with the owner as person and no live session. A session started earlier would run in the wrong memory scope, and the first message would retire it (`retireSessionUnlessAudience`). When the memory rule refuses a session (private memory isn't available here: no owner id, the sandbox not ready, or a scoped audience the agent's framework can't serve), nothing starts. The words are cause-neutral, as the inbound refusal's are: "it needs private memory, which isn't available on this agent yet." Part 1's engine-switch restart runs the same check.
   - **Admission.** Callsite `app-new-session`, added to `SpawnAdmission` and `AppDispatchAdmission`.
   - **The spawn,** on the conversation's profile (engine, model, thinking mode, effort), with `triggeredBy: 'dashboard-operator'` like the dashboard's other creates. The tmux session gets the session manager's own unique name, never the person's session name. A taken name would make `SessionManager` reuse that running session (it reuses by slug), and one session would then serve two conversations. The conversation carries the person's name as its title.
   - **Registration** on the conversation's channel, so the first message is injected into it. Then it records what it launched on with the orchestrator, as an inbound spawn does (`recordSpawnSuccess`).
   - **The opening line.** The bootstrap says the session was started for a new app conversation with that name and that there is no message yet. It points to the conversation's context file, which holds the app relay instructions (`app-reply.sh`), as part 1's restart does.
   - **Refusals.** A refused start reports why: `not-served`, `gone`, `other-session`, `relay`, `admission`, `memory` or `spawn-failed`. A start that lands with no session found registered is `spawn-failed`.
6. **Answer.** 201 `{ ok, started, name, platform: 'app', conversationKey, pinRetained }`, with `session` when started. When not started, it carries `refusal` and a message:
   - `memory`: "it needs private memory, which isn't available on this agent yet".
   - `relay`: "restart the agent, then send it a message".
   - Anything else: "its first message will start it", which holds, because the inbound dispatch starts a session for any message that admission and the relay allow.

   The conversation is never deleted.

### 2.2 The default becomes a native conversation, on every machine

The automatic choice (`platform` absent or `auto`) still picks Telegram when it is connected, then Slack, as today: those are conversations already. The fallback, which was `headless`, becomes `app` wherever app conversations run on this agent, on any machine. It stays `headless` only where they don't run at all, as before. "Run" means the app conversation service and the topic-profile bundle that carries the starter are both wired. The legacy body `headless: true` stays terminal-only. A machine pick with `app` is refused in words: "Choosing a machine works for Telegram topics today; an app conversation starts on the machine that runs your app conversations."

**On a machine that doesn't serve app conversations** (a standby), `app`, chosen or automatic, still creates the conversation, as the phone's own create route does on any machine. It answers `started: false`: "Another of your machines runs your app conversations; its first message starts the session there." It never falls back to terminal-only (*No Silent Degradation*).

On the dashboard and the phone, the choices become:
- Automatic
- Telegram topic
- Slack
- Instar app conversation (new)
- No conversation (terminal only)

The form doesn't need to know what's connected: Automatic resolves on the server. Terminal-only stays available as an explicit choice. Justin said "by default", and nothing he said removes the choice.

### 2.3 Engine, model and machine at creation

The engine and model pickers are enabled for `app` as for Telegram (`platformAllowsDoor` admits `app` on both surfaces). The machine picker gets its own rule, `platformAllowsMachine`: Automatic or Telegram only, on both surfaces. Placing an app conversation on another machine is part 3. On the phone's signed `session-new` action, `app` joins the platform list and the "no machine" rule, but not the "no engine" rule. The dashboard's engine hint reads "Engine and model apply to a Telegram topic or an Instar app conversation."

### 2.4 Which sessions get a conversation, and which don't

Only sessions a person starts from the New session form, on the dashboard or the phone.

- **Excluded: scheduled jobs and helper sessions** (`POST /sessions/spawn`, job runs, recovery helpers). They are machinery, not conversations. One app conversation per run would flood the operator's conversation list (*Bounded Notification Surface*: a code path that can create user-facing containers must be bounded).
- **Excluded: sessions already running with no conversation.** They keep working as they are. A running process can't be given a conversation identity after launch: its bind token and conversation id are set at spawn. They show "This session has none, so there is nothing to switch," as in part 1.

### 2.5 Words on every surface, and app sessions are never "internal"

- The session details' Chat line reads "an Instar app conversation" for an app session. Part 1 did this on the dashboard; the phone's controls route (`mobileSessionControlsRoutes.ts` chat words) gets the same.
- **The New session result:**
  - Started: dashboard "Started "<name>". Open it in the app's conversations to talk to it."; phone "… Open it in Conversations to talk to it."
  - Not started: the message from 2.1 step 6.
  - Neither surface reads an app result as "with no chat".
- **The session lists never hide an app conversation's session as internal.** The dashboard's `isInternalSession` and the app's `isInternal` hid any session with no chat platform that the dashboard didn't start, which is every app conversation's session today. Both now count a session with a `conversationRef` as a conversation. The dashboard's change is in this repository. The app's is in its own repository, on the app branch with the rest of the app side.

## Constitution check

- **An Instar Agent Is Always a Multi-Machine Entity (parent).** The conversation is a replicated app conversation, readable on every machine. Creation happens only on the machine that serves app conversations, so the record and the session agree. Running it elsewhere is part 3.
- **Ownership-Gated Side Effects.** The session starts only where `isOwner()` holds. A standby creates only the replicated conversation record, as the phone already may, and never a session.
- **Bounded Notification Surface.** One conversation per person-started session, never per job or helper (2.4).
- **The User Experience Is the Product / Mobile-Complete Operator Actions.** The phone's New session gets the same choice as the dashboard, behind the existing Face ID action.
- **Occam's Razor.** This reuses the phone's create call, part 1's starter and the Telegram seed function. The new code is the create branch, one callsite name and the choice lists. Simplest robust route: this one.
- **No Silent Degradation to Brittle Fallback.** An app create that can't proceed is refused with words; it never falls back to terminal-only silently. Only the automatic choice falls back, and only where app conversations don't run here, which is today's behaviour.
- **Migration Parity / Agent Awareness.** The session-controls awareness bullet gains one sentence, through the existing migration's marker-guarded insert.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Automatic choice falls back to `app` | invariant | A fixed order: Telegram, Slack, app where it serves here, else terminal-only |
| Create only where `isOwner()` | invariant | The existing lease check |
| Which sessions get a conversation | invariant | Only the New session create route; jobs and helpers never call it |

## Verify the state, not its symbol

The create answer says "started" only when the session it names is running and registered on the conversation's channel. A refused start says the conversation exists and its first message starts the session.

## Maturation plan

- **test-agent-live:** unit, integration and e2e below.
- **dev-agent-live:** Echo creates one throwaway "Instar app conversation" session from the simulator app, sends it a message, switches its engine, closes it, and deletes the conversation.
- **fleet:** ships to all. An agent with Telegram or Slack keeps its automatic choice. An agent with neither now gets an app conversation where it used to get terminal-only.
- **graduation criterion:** Justin starts a session from the phone and talks to it in the app.
- **ladder:** not applicable: a new choice and a changed fallback, no staged rollout behaviour.

## Open questions

*(none)*

## Frontloaded decisions

1. Terminal-only stays an explicit choice. Justin's words set the default, and a terminal-only session stays useful for quick work.
2. Running headless sessions are not converted (2.4).
3. Jobs and helpers never get a conversation (2.4).
4. A standby creates the conversation (it replicates) and leaves the session to the serving machine's first message. It never starts a session itself: that would need per-conversation ownership, which is part 3.

## 4. Security

- The create route is the existing dashboard route: Bearer token plus the intent header for a door or machine pick. The phone reaches it only through the existing Face ID `session-new` action, whose signed line already carries the platform word. `app` is added to the platform words it accepts.
- The new conversation is the owner's (`ownerPerson` null). A support person's phone can't use `session-new` (owner-only, as today).

## 5. Multi-machine posture

The conversation record replicates through the existing app conversation store. The session runs on the serving machine. A standby refuses and names the serving machine. Part 3 lets a conversation, and its session, live on another machine.

## 6. Tests

- **Unit:**
  - The automatic choice: Telegram, then Slack, then app where it serves here, else headless.
  - `createBody` on the dashboard and the phone for `app`, with and without an engine pick.
  - `platformAllowsDoor('app')`.
  - The starter's `reason: 'new'`: bootstrap, `app-new-session` callsite, session name and `triggeredBy`.
  - The memory place recorded before the spawn, and a `memory` refusal that starts nothing.
  - Each refusal reported.
  - `isInternalSession` and `isInternal` keep a session with a `conversationRef`.
  - The create answer's words for started and not started, on both surfaces.
  - The phone's signed line for `session-new` with `app`.
  - The Chat words.
- **Integration:**
  - `POST /sessions/create {platform:'app'}` creates a conversation, seeds `app:<key>` when a pick is given, starts and registers a session, and answers `conversationKey`.
  - A standby creates the conversation and answers `started: false` with words.
  - A repeated `requestId` returns the first answer, with one conversation.
  - A bad name, an unready relay, or app conversations off are each refused before anything is created.
- **E2E:** production boot with native conversations on: the phone starts an app session with a signed challenge from a test device key, the conversation appears in `GET /mobile/conversations`, and the session list shows a session whose `conversationRef` is that conversation.

## 7. Agent awareness and migration parity

A separate bullet, `MOBILE_SESSION_APP_NEW_LINE` (marker `"platform":"app"`), sits right after part 1's switch-any-conversation bullet in the Mobile app routes block. Existing agents get it through a marker-guarded insert in `migrateClaudeMd`, idempotently.

## 8. Rollback

Revert. Conversations already created stay in the store as ordinary app conversations, and their sessions keep running until closed. The automatic choice falls back to terminal-only again.
