# Side-Effects Review — "Files are turned off" carries a one-tap turn-on

**Version / slug:** `files-off-turn-on`
**Date:** `2026-11-12`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Justin's iPhone app showed "Files are turned off on this agent." under a refused photo and voice note, with no way to act on it (fb-9b920619-b1a; every warning needs a direct path to act). The server's `media-off` refusal had no action, and no route let the owner turn files on from the phone.

The fix reuses the existing owner-only, Face ID-proven switch that People already uses to turn a setting on for the whole agent (`POST /mobile/team/switches/turn-on`, team-switches-agent-wide). It gains a third setting, `files`, which sets `mobilePairing.native.media.enabled` (plus pairing and native conversations, which files depend on) on every machine and asks each machine that changed for its supervised restart, exactly as the other two settings do.

- `src/core/TeamSwitches.ts`: `files` added to `TeamSwitchSetting`. It never gets a People line, because a team does not need it; the summary only reserves an empty bucket for it.
- `src/server/AgentServer.ts`: `applyTeamSwitchHere` handles `files`. `reportsOn` answers false for `files`, because a machine's standing has no files flag, so only a peer's own answer settles a pending files request.
- `src/server/mobileMediaOff.ts` (new): one `mediaOffBody()` carrying `action: {kind: 'team-switch-on', setting: 'files', label, method, path, configPath}`.
- Every `media-off` refusal uses it: `mobileMediaRoutes.ts` (uploads and downloads), `mobileConversationRoutes.ts` (app send), `mobileMediaHolderProxy.ts` (holder hop), and `routes.ts` `/app/session-reply`. The session-reply version also tells the agent how to act.
- The Telegram and Slack send routes keep their `media-target-unsupported` code. When files being off is the reason, they now say so ("Files are turned off on this agent.") and carry the same action; before, they said "not available yet", which was untrue.
- `machineRoutes.ts`: comment only. The peer route already accepts any `isTeamSwitchSetting` value.
- `CapabilityIndex.ts`: description sentence for the action.

The app change (instar-ios, separate repo) shows "Turn on files" on the refused bubble, runs the Face ID flow, and resends once the agent is back. It also fixes the second half of the report: the message box is rebuilt after each send, so text the old box still held cannot come back.

## Decision-point inventory

- `/mobile/team/switches/turn-on` → `team-switch-on` target validation: **modify**. It accepts one more named setting (`files`) and still only ever turns a setting on. The owner check, Face ID presence signature, and per-target signed line are unchanged and apply to `files` (a signature for `files` cannot be spent on another setting).
- `/api/team-access/switch-on` (machine-signed peer route): **pass-through**. It accepts `files` via the same `isTeamSwitchSetting`.
- `media-off` refusals: **pass-through**. Same status and code; the body gains `action`.

---

## 1. Over-block

No new refusals. Every route that refused before still refuses with the same status and error code. A phone that is not the owner's still cannot use the turn-on route: it gets the route's existing owner refusal, which the app shows.

## 2. Under-block

- A peer on an older build answers 400 to `files` (unknown setting). The applier records it as `refused`, not retried. The app reports that machine's outcome, and updating that machine is the path. This is the same posture the other settings had when they were introduced.
- Files are turned on for the whole agent, not for one machine. That is intended: conversations and their files replicate across machines, so files on only one machine would leave the next one to answer still refusing.

## 3. Level-of-abstraction fit

This reuses the existing authority: the owner's Face ID turn-on with per-machine application and restart. There is no new route and no new write path to config. The refusal body only names the action; it decides nothing.

## 4. Signal vs authority compliance

The `action` field is a signal: a pointer to the existing authority. The authority is the owner proven by Face ID, and it is unchanged. No brittle check gained blocking power. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

- `team-access` (the one-tap "everything a team needs") takes its settings from the People lines, which never include `files`, so it does not turn files on. Pinned by an integration test.
- `reportsOn` returns false for `files`. Without that, a machine with native conversations on would have read as "already on" for files, and its pending request would have been dropped.
- The restart that follows is the same supervised restart the other settings use. The app waits 5 s, and the resumable upload covers the rest.

## 6. External surfaces

- Phone-facing response bodies gain an optional `action` field. Older apps ignore unknown fields.
- The Telegram and Slack `media-target-unsupported` detail now names the true cause when files are off. The code is unchanged, so older apps behave the same.
- Nothing changes for agents with files already on.

## 7. Multi-machine posture (Cross-Machine Coherence)

Replicated by design. The switch reaches every machine over the existing machine-signed `/api/team-access/switch-on` route. Machines with no address right now are kept in `switch-requests.json` and retried on the team exchange tick. The `media-off` action is the same on every machine, including the holder-hop refusal, so the one tap fixes the machine that holds the conversation too.

## 8. Rollback cost

Revert the commit. A machine where files were turned on keeps `mobilePairing.native.media.enabled: true` in its config, which is the same state the operator would have set by hand. It can be turned off by editing the config. There is no data migration.

## Agent awareness

The agent meets this when it matters: `/app/session-reply` refusing files now says the owner can tap "Turn on files" or set the config key. The CapabilityIndex describes the action. The team-settings template line stays as is, because `files` is not a team requirement.
