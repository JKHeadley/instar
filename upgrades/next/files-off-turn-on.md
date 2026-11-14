<!-- bump: patch -->

## What Changed

When the agent refuses a file because files in app conversations are turned off, the refusal now carries an action: `{kind: "team-switch-on", setting: "files", label: "Turn on files", method: "POST", path: "/mobile/team/switches/turn-on", configPath: "mobilePairing.native.media.enabled"}`. The owner-only, Face ID-proven switch that turns team settings on for the whole agent accepts a third setting, `files`. It sets `mobilePairing.native.media.enabled` (with pairing and native conversations) on every machine and restarts each machine that changed. Telegram and Slack sends with files now say "Files are turned off on this agent." when that is the reason, instead of "not available yet", and carry the same action. The `/app/session-reply` files refusal also tells the agent how to turn files on. (fb-9b920619-b1a)

## What to Tell Your User

If the app says files are turned off, there is now a "Turn on files" button right under the refused message. One Face ID tap turns files on for the whole agent, and the app sends the files again once the agent is back.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Turn on files from the app | Tap "Turn on files" under a refused file (owner phone, Face ID); `POST /mobile/team/switches/turn-on {setting: "files"}` |

## Evidence

Before: Justin's screenshot (2026-11-12 20:28 PT, conversation "Dashboard feedback") shows "Files are turned off on this agent." under a photo and a voice note, and nothing to tap. The `media-off` body was `{error, detail}` only. After: tests/integration/mobile-native-media.test.ts asserts the upload 503 and the send 400 both carry the `files` action; tests/integration/mobile-media-to-platform.test.ts asserts the Telegram and Slack refusals name the true cause and carry it; tests/integration/team-access-routes.test.ts turns `files` on with Face ID (owner only, never via Bearer, never inside `team-access`); tests/e2e/team-switches-two-machines.test.ts turns files on in a second real server's own config over the signed peer route.
