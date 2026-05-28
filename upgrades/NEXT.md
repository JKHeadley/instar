# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Mentor cycle round-trip — final fixes (verified live end-to-end).** Three
bugs that only surfaced when the full Echo↔Codey round-trip ran on real
servers:

1. **`mentor.menteeAgentName` config.** The mentor derived the mentee's agent
   name as `instar-${menteeFramework}` (e.g. `instar-codex-cli`), but the
   mentee registers under its real name (`instar-codey`). The mismatch broke
   same-machine peer lookup AND the reply allowlist. New optional
   `mentor.menteeAgentName` (defaults to `instar-${menteeFramework}`) carries
   the real registry name.

2. **botId string coercion.** `mentor.menteeBotId` is often stored as a JSON
   number, but the a2a marker's `senderBotId` is always a string. The
   allowlist compares with `===`, so a number/string mismatch silently
   dropped every reply as `agent-marker-unknown`. All botId allowlist entries
   are now `String()`-coerced.

3. **`senderBotId` = sender's own bot id.** The unified transport sent the
   *recipient's* bot id as the inbox `senderBotId`; the recipient's allowlist
   check (`knownAgents[from].botId === senderBotId`) therefore always failed.
   It now sends the *sender's* own bot id (`ownPrimaryBotId()` for replies,
   the mentor bot id for sends).

With these, the mentor cycle round-trips live: a mentor prompt reaches the
mentee, the mentee spawns a session + replies, and the reply lands in the
mentor's `mentor-replies.jsonl`.

## What to Tell Your User

The cross-agent mentor cycle now works fully end-to-end on the same machine —
verified with a real round-trip. These were the last three wiring bugs (an
agent-name assumption, a number-vs-string comparison, and a sender-identity
mixup). No config changes required unless your mentee's registry name differs
from `instar-<framework>`, in which case set `mentor.menteeAgentName`.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `mentor.menteeAgentName` | Set in `.instar/config.json` when the mentee's agent-registry name differs from `instar-<menteeFramework>` (e.g. `instar-codey`). Defaults to the framework-derived name. |
| Robust botId matching | botId allowlist entries are string-coerced; `senderBotId` is the sender's own bot id. No action needed — fixes silent reply drops. |

## Evidence

Extended `mentor-reply-via-inbox` E2E with a second case proving the
menteeAgentName override + numeric-configured botId (string senderBotId)
routes + persists. Both cases green; all prior mentor/mentee/inbox tests
green. `tsc --noEmit` clean. **Live-verified**: full Echo→Codey→Echo
round-trip persisted to `mentor-replies.jsonl`. Side-effects:
`upgrades/side-effects/mentee-agent-name-and-botid-coercion.md`.
