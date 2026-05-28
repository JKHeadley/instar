# Instar Upgrade Guide — NEXT

<!-- bump: minor -->

## What Changed

**Mentor-cycle reply leg over same-machine /a2a/inbox — the round-trip closes.**
PRs #462/#464/#466 built the forward path (mentor→mentee) over the
bot-to-bot-block-immune HTTP transport. This PR closes the reply leg
(mentee→mentor) the same way, plus fixes two bugs found in live dogfood:

1. **Unified primary-adapter a2a hook.** `installMentorMessageHook` now wires
   BOTH roles onto the primary `TelegramAdapter`: the mentee side (`mentor`
   role, from `config.mentee`) AND the mentor side (`mentor-reply` role, from
   `config.mentor` when `menteeBotId` is set). Previously the mentor-reply
   handler lived only on the mentor-BOT adapter (Telegram polling), so a reply
   arriving via `/a2a/inbox` had nowhere to land. Now Echo's primary adapter
   persists mentee replies to `mentor-replies.jsonl` (finding-emission-only,
   capability-handle path per spec §250).

2. **`deliverA2aMessage` unified transport helper.** Both directions
   (mentor→mentee `deliverToMentee` and mentee→mentor reply) now route through
   one helper: same-machine peers get an HTTP POST to `/a2a/inbox`; cross-
   machine falls back to the Telegram bot path. Fixes the **`\n\n` marker bug**
   from #466 (`deliverToMentee` built the marker with a single `\n`; the parser
   requires `\n\n` between marker and body — single-newline markers were
   silently dropped as `agent-marker-malformed`).

3. **Mentee reply-capture race fix.** The mentee role-handler captured the
   tmux pane AFTER the session completed — but the reaper removes the pane
   first, so `captureOutput` returned empty ("mentee session produced empty
   reply"). Now it captures the last non-empty snapshot WHILE the session is
   alive, so a completed-then-reaped session still yields its output.

## What to Tell Your User

The cross-agent mentor cycle now round-trips end-to-end on the same machine:
a mentor agent sends a prompt, the mentee processes it and replies, and the
reply is captured back. The earlier releases built each half; this one closes
the loop and fixes the bugs that only showed up in live testing. No config
changes needed.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Unified primary-adapter a2a hook | `installMentorMessageHook` registers `mentor` and/or `mentor-reply` handlers on the primary adapter based on `config.mentee` / `config.mentor`. Reachable via `/a2a/inbox`. |
| `deliverA2aMessage` | One transport helper for both mentor→mentee and mentee→mentor: same-machine `/a2a/inbox`, Telegram fallback cross-machine. Correct `\n\n` marker framing. |
| Mentee reply capture-while-alive | Survives the session-reap race so the mentee's output is actually captured + replied. |

## Evidence

1 new E2E (`mentor-reply-via-inbox`) proving a `mentor-reply` marker POSTed to
`/a2a/inbox` routes + persists to `mentor-replies.jsonl` with
`transport: a2a-inbox-local`. All 22 prior mentor/mentee/inbox tests still
green. `tsc --noEmit` clean. Side-effects review:
`upgrades/side-effects/mentee-reply-leg.md`.
