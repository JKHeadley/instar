---
title: "Engine and model changes for every conversation (part 1 of 3)"
slug: "session-swap-any-conversation"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "session-swap-any-conversation.eli16.md"
status: "draft"
approved: true
review-convergence: "2026-11-06T23:55:00.000Z"
review-iterations: 6
review-completed-at: "2026-11-06T23:55:00.000Z"
review-report: "docs/specs/reports/session-swap-any-conversation-convergence.md"
approved-by: "echo, under its standing grant, for Justin's words in Telegram topic 134088, 2026-11-06 14:11 PST: \"Why are we restricting being able to set the machine and engine to sessions that have Telegram topics associated with them? By default a session should always have a native Instar conversation associated with it and that conversation should be able to swap machines and engines just like any other conversation.\""
---

## 1. Problem

Switching a session's engine (framework) and model works only for Telegram topics. The phone and dashboard say so: "Engine and machine can be changed for Telegram conversations. This session has no Telegram topic." Justin (topic 134088, 2026-11-06 14:11 PST) asked for every conversation to switch engines and machines. The work splits into three parts, each a separate PR:

1. **This spec: engine and model for every conversation**, on the machine it already runs on.
2. **A conversation for every session.** A session started with no chat gets a native app conversation. Spec `docs/specs/session-conversation-for-every-session.md`.
3. **App conversations move between machines.** App conversations join the session pool, and Slack's move gaps (drain, profile carrier) close. Spec `docs/specs/app-conversations-in-the-pool.md`, with its own convergence.

The reasons engine switching is Telegram-only today, from the code:

- **Profile keys.** `POST /topic-profile/:key` accepts a Telegram topic id or `slack:<channel>[:<thread>]`, never an app conversation (`routes.ts`, `TOPIC_PROFILE_KEY_RE`).
- **Spawns.** Only the Telegram spawn reads the conversation's profile (`server.ts` near 1591). The app spawn (`appInboundDispatch.ts`) and the three Slack spawns (inbound, recovery, respawner) pass no engine or model, so a Slack profile write is saved and never used.
- **Applying a write.**
  - `_profileLegacyRespawn` and `_profileDisclose` return early unless the key is a number.
  - The orchestrator's ports are Telegram-shaped: `sessionNameForTopic`/`listTopicSessions` use `telegram.getSessionForTopic`, and `spawn`, the resume ports, `disclose` and `canDiscloseReconciliation` use `Number(topicKey)`.
- **Authority.** A token write needs a bound operator (`topicProfileWriteSurface.ts` `authorize`), and only Telegram topics ever get one (`TopicOperatorStore.setOperator(Number(topicId))`). So app and Slack writes from the dashboard or phone are refused `no-bound-operator`, with Telegram wording ("Send one message in this topic first").

## 2. One reference for every conversation

A **conversation reference** names any conversation. It uses the grammar of `parseSessionConversationRef` (`mobileSessionRoutes.ts`), tightened:

- `telegram:<topicId>`: a positive integer.
- `app:<uuid>`: the app conversation key, strict lowercase RFC 4122 v4.
- `slack:<team>:<channel>[:<thread>]`: the canonical Slack key (`conversationIdentity.ts`).

`conversationKeys(ref)` maps each reference to its **profile key** and refuses anything else:

| Reference | Profile key |
|---|---|
| `telegram:N` | `N` (unchanged) |
| `app:U` | `app:U` (new) |
| `slack:T:C[:th]` | `slack:C[:th]` (unchanged form) |

`TOPIC_PROFILE_KEY_RE` adds `app:<uuid>`. Telegram and Slack keys are unchanged, so stored profiles stay valid.

## 3. Design

### 3.1 Every spawn uses its conversation's engine and model

The app spawn and the three Slack spawns call `topicProfileResolver.resolve(profileKey)` and pass `framework` and `model`, as the Telegram spawn does. `AppDispatchSessions.spawnInteractiveSession` gains `framework` and `model` options. With no profile, nothing changes: the agent default.

**A spawn reports that it landed.** Like the Telegram spawn, the app and Slack spawns call the orchestrator's `recordSpawnSuccess(profileKey, applied)` with what they launched on. They skip that call while the orchestrator's own start for that key is in flight, the way the Telegram spawn checks. This records the last applied profile, so the next change knows the old engine (otherwise every app and Slack key would read as claude-code), and it clears the suppression marker. The same in-flight marker makes an app message that arrives during a switch wait for the start under way rather than spawn a second session (3.3). When the marker clears, a held message goes through the normal inbound dispatch (`app-inbound-spawn`): into the new session if the start landed, or starting one if it was refused. So a refused start still ends with "the next message starts it", as the disclosure says.

**Slack resume records get the same guards as Telegram's.** A Slack resume record today holds only an id and a session name (`SlackAdapter.ts`). Three writers keep re-saving it: the kill hook, the resume heartbeat (`ResumeHeartbeat.ts`) and the shutdown save. So dropping it once wouldn't stick, and a spawn can't tell what changed. Telegram is protected by parking the entry, a suppression marker, and write gates on its savers (`claudeResumeWriteGate`/`codexResumeWriteGate`). Slack gets the same:

- **Each record stores** the `framework` it was made under and the `provenance` of its id. Today every Slack id is `hook` (`findUuidForSession` returns only the hook's id), but the field makes that a checked fact, not an assumption.
- **The three Slack writers ask the matching write gate** before saving, with the Slack profile key, as the Telegram savers do. The gate depends on the session's framework: `claudeResumeWriteGate` for claude-code, `codexResumeWriteGate` for codex-cli, and the suppression check alone for any other engine. While a switch is under way (the suppression marker set), the gate refuses every save, so the old session's kill-time save can't land. A save the gate allows replaces a parked entry, as Telegram's resume map does, so once the new session is up its id is the one kept. A parked entry older than a day is dropped like any other.
- **The Slack resume port offers both views the orchestrator calls, over its one record.**
  - The Claude view: `ready` (true only for a hook id from a claude-code record), `resumeId`, `park`, `unpark`.
  - The Codex view: `get` returns the id when the record's engine is codex-cli, and `captureAtKill` answers `{outcome:'none'}`, so `get` supplies the hook's id. Its `park` and `unpark` act on the same single record as the Claude view's. Both are idempotent, so a failed kill or a breaker revert unparks the record whichever view parked it.
  - `codexFence` answers null for `slack:` keys.
- **A Slack spawn resumes a record only** when its framework matches the one it is starting and the entry isn't parked.
- **Old records** written before this have no framework or provenance. They are read only for the agent default and never count as `ready`.

### 3.2 A write switches the live session for every kind

The orchestrator owns the sequence: it sets resume ids aside, kills, then calls `spawn`, which must return what it actually landed on (`TopicProfileOrchestrator.ts`). The legacy framework hook does kill-then-start in one call. Both get per-kind ports through one function, `conversationPorts(profileKey)`:

- `session()`: the live tmux session or null. Telegram uses `telegram.getSessionForTopic`; app uses the app channel registry's session for the conversation's local alias; Slack uses `slack.getSessionForChannel(routingKey)`.
- `start(resolved)`: start a session for the conversation on the resolved engine and model, and return the `{framework, model}` it landed on (or `null` if refused).
  - Telegram: today's `spawn` port.
  - App: `startApp(conversationKey, resolved)` (3.3).
  - Slack: the Slack respawner with the channel and thread, honouring the guarded record (3.1). The respawner returns a session name, so `start` reads that session's record for what it launched on.
- `resume`: the per-kind resume port the orchestrator parks and unparks.
  - Telegram: today's ports, unchanged.
  - Slack: the guarded record from 3.1, with `ready`, `resumeId`, `park` and `unpark`.
  - App: always "not ready", which means continue from history. App conversations keep no resume id.
- `disclose(text)`: one line in the conversation itself. Telegram sends to the topic, as today. App appends an agent message through the same store write `app-reply.sh` uses. Slack posts to the channel or thread.
- `listSessions()`: every running session with its profile key, so the orchestrator's sweeps see app and Slack sessions.
- **Escalation.** The escalation port's `clearMarkerAndReleaseLease`, `activeMarker` and `listMarkerTopics` find sessions through `session()` and `listSessions()`, not Telegram lookups. That way a kill releases the escalation lease for every kind.

The orchestrator's `spawn`, resume and disclose ports and `canDiscloseReconciliation` dispatch on the key's kind through these ports. `_profileLegacyRespawn` becomes `session()`, then kill through `killSessionByTmuxName`, then `start(resolved)`. Every Telegram port behaves exactly as today.

### 3.3 Starting an app conversation without a new message

`startApp(conversationKey, resolved)` lives on the app dispatch (`appInboundDispatch.ts`):

1. It runs only where the conversation is served (`isOwner()`). Anywhere else it answers `null` and changes nothing.
2. It expects no live session. The caller has already killed it through `killSessionByTmuxName`, the single name-to-id path; the orchestrator's comment records why a name passed as an id once failed to kill. The orchestrator's in-flight marker is set for the key, so the app inbound dispatch holds a new message for the start under way instead of spawning one (3.1). If a session is live anyway, and it was started on the resolved profile, `startApp` returns that as landed. Otherwise it answers `null`.
3. It builds the bootstrap the way a new message does (the conversation's recent history from the store, framed as a CONTINUATION). There is no new user text. The memory place is `app:<key>`. The person for the memory check is the conversation's owner person (or the owner).
4. It admits through `SpawnAdmission` with callsite `app-respawn`, which is added to the known callsites in `SpawnAdmission.ts` and `AppDispatchAdmission`. It spawns with the resolved `framework` and `model`, registers the session on the conversation's channel, and returns what the session record says it launched on.

If the respawn is refused (admission, relay not ready), the conversation keeps no session and the next message starts one on the new engine. The disclosure line says which happened.

### 3.4 Who may change a conversation's engine

`authorize` keeps its rule for writes from a chat principal: the bound operator only. A **token** write is the dashboard (Bearer) or the owner's phone (the Face ID route, which calls with the agent token). For those, `tokenMayWrite(profileKey)` answers:

- Telegram: a bound operator, unchanged.
- App: this machine serves the conversation (`isOwner()`), and the conversation has no `ownerPerson` or the owner person is the owner.
  - The store is copied to every machine, so "it exists here" alone would hold on a standby too. The write would land in that standby's profile store, which the serving machine never reads. A standby therefore refuses with words naming the machine that serves it.
  - A support person's (MSP) app conversation is refused: "This conversation belongs to <name>; it can be switched from their side." That way the owner's dashboard never silently changes someone else's conversation.
- Slack: the conversation is known to this machine's registry, and this machine holds its Slack connection (it minted the registry entry).

The refusal words are per kind; the Telegram sentence stays Telegram's.

### 3.5 Routes and surfaces

- **Phone.** `POST /mobile/sessions/door/:target` takes a conversation reference as its target, and a bare number still means `telegram:<n>`.
  - The action line carries the reference: `session-door <ref> <machine|here> <framework> <model|none>`.
  - `runSessionAction` converts the reference to its profile key with `conversationKeys(ref)` before calling `POST /topic-profile/<profile key>`. A `telegram:` or `slack:` reference is never itself a profile key.
  - The device allowlist matches on the lower-cased path, so its pattern is digits, `app:` with a UUID, or `slack:` with `[a-z0-9._:-]`, at most 200 characters, with no `%`.
  - `buildSessionAction` then validates the reference with its real case, through `parseSessionConversationRef` and, for Slack, `parseCanonicalKey`. Slack team and channel ids are uppercase (`^T[A-Z0-9]+$`, `^[CDG][A-Z0-9]+$`).
- **Controls.** `GET /sessions` rows gain `conversationRef` (app via the app channel registry, Slack via the registry, Telegram as today). `GET /mobile/sessions/controls` offers `door` for every row with a reference. `move` stays Telegram-only until part 3, and says so in words that name what is coming.
- **Dashboard.** `canSwitchDoor` checks for a conversation reference, not Telegram, and the door sheet posts to `POST /topic-profile/<profile key>`.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Reference grammar and key mapping | invariant | Exact parse to three fixed shapes; anything else refused |
| `tokenMayWrite` for app and Slack | invariant | Read from the conversation's own record and the registry; no inference |
| Allowlist widening to the reference grammar | invariant | Exact pattern, no `%`, owner phones only, existing Face ID |

## Verify the state, not its symbol

A switch is reported landed only when the session list shows a session for that conversation started after the switch, on the chosen model. That is the existing `switchLanded`, now matched on `conversationRef`. A refused respawn says the next message starts the new engine, never that the switch happened.

## Maturation plan

- **test-agent-live:** unit, integration and e2e below.
- **dev-agent-live:** Echo, on a throwaway app conversation and a throwaway Slack thread: switch to Codex and back from the simulator app. Never a real session.
- **fleet:** ships to all. A conversation with no profile set behaves exactly as today. What a switch changes follows the profile write regime that already governs Telegram (`topicProfile.enabled` and `topicProfile.dryRun`, dev-gated). The engine switch lands everywhere, as a framework write already does for Telegram. A model choice lands only where profile writes are fully live. Under dry-run it is recorded as intent, and with profiles turned off it is refused. The sheet already says both in words (`regimeWords`).
- **graduation criterion:** Justin switches one app conversation's engine from the phone.
- **ladder:** not applicable: no switch; the change only reaches conversations someone explicitly sets an engine for.

## Open questions

*(none)*

## Frontloaded decisions

1. App conversations' profiles are keyed `app:<uuid>`, the key the pool already uses. No stored key changes. Slack resume records gain `framework` and `provenance`. Older records without them are read only for the agent default and never count as ready.
2. A switch respawns at once on every kind, as Telegram does.
3. A support person's app conversation can't be switched from the owner's token path.
4. Moving between machines is part 3. It needs the pool's ownership for app conversations first, or two machines could both serve one conversation.

## 4. Security

- No new authority: switching was already the owner's from the dashboard and the phone (Face ID). This widens which conversations it applies to.
- Chat-principal writes keep the bound-operator rule.
- The widened allowlist keeps exact patterns and refuses `%`.

## 5. Multi-machine posture

- Profiles: the existing per-machine profile store with its transfer carrier (`TOPIC-PROFILE-SPEC` §5.3). App conversations are served by the lease holder until part 3, so their profile is read and written there.
- Moves: unchanged in this part (Telegram only).

## 6. Tests

- **Unit:**
  - `conversationKeys` for every kind, plus refusals.
  - The widened profile key pattern.
  - `conversationPorts` for each kind.
  - `tokenMayWrite`: an app conversation, including an MSP's, and Slack known and unknown.
  - App and Slack spawn options carrying the resolved engine, and `recordSpawnSuccess` called except while the orchestrator's start is in flight.
  - The Slack resume port's two views parking and unparking one record.
  - The escalation port releasing the lease for app and Slack keys.
  - `startApp`: not the owner, no session, a session already started on the resolved profile, refused admission.
  - Phone action lines with references, and the controls answer offering a door for app and Slack.
- **Integration:**
  - `POST /topic-profile/app:<uuid>` writes and respawns through a stub session manager.
  - The phone door route with an app reference, through the production device pipeline.
- **E2E:** production boot with native conversations. Create an app conversation and send a message so a session starts. Switch its engine from the phone with Face ID. The session is respawned with the new framework and a disclosure line lands in the conversation.
- **App and dashboard:** a door for every kind with a reference; no Telegram-only words left for engines.

## 7. Agent awareness and migration parity

The session controls CLAUDE.md bullet says engine switching works for every conversation. A migration rewrites the old Telegram-only sentence once, guarded by a content sniff. The capability entry is updated. No config change.

## 8. Rollback

Revert. Profiles written under `app:` keys stay in the store, unused.
