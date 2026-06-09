<!-- bump: patch -->

## What Changed

Makes `SessionManager.getTopicBinding()` collision-aware so a session shared by two same-named topics no longer drops one topic's messages. The tmux session name is derived by slugifying the topic NAME, so two Telegram topics whose names differ only by case ("Initiatives and maturation check-ins" #21487 vs "initiatives and maturation check-ins" #21624) collapse to one session name. `getTopicBinding` did a single-match reverse lookup over `topicToSession` and returned the FIRST topic — so the InputGuard bound the shared session to the older topic (21487) and blocked every message from the live topic (21624) as cross-topic. The session looked alive but was silently unresponsive (messages showed "Delivered" but never reached it). The fix: `getTopicBinding` now collects ALL topics mapping to the session and takes an optional `preferTopicId`; the `injectMessage` call site parses the message's own `[telegram:N]` tag and passes it, so a colliding session binds to the topic the message actually names. Single-topic sessions and the no-tag path are unchanged (fall back to first match). Migration-free — no session renaming, no registry rewrite.

## What to Tell Your User

If a session ever goes silent — messages show "Delivered" but it never replies, and restarting it doesn't help — one cause was two topics with near-identical names (e.g. differing only in capitalization) colliding onto the same underlying session, where a safety guard then blocked one of them. That's fixed: the agent now routes each message to the right topic by the tag the message carries, so the collision no longer eats messages.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Message routing survives same-name (case-variant) topic collisions | automatic — messages bind to the topic named by their own tag |

## Evidence

Reproduction (live, 2026-06-09): topic 21624 was unresponsive across multiple user messages and a respawn. Server logs showed `[InputGuard] BLOCKED cross-topic injection … session "echo-initiatives-and-maturation-check-ins" is bound to topic 21487` on every inbound 21624 message; the registry confirmed both 21487 ("Initiatives…") and 21624 ("initiatives…") mapped to that one session, and `getTopicBinding`'s reverse lookup returned the first (21487). Immediate recovery was an operator-authorized `/unlink` of the stale 21487; this PR is the durable fix.

After the fix: `tests/unit/topic-collision-binding.test.ts` (6 cases) pins both sides — a tagged message binds to the topic it names (21624 and 21487 each resolve correctly), the no-tag and unknown-tag paths fall back to first match, single-topic sessions are unchanged, and an unknown session returns null. tsc + lint clean; 63 existing SessionManager + InputGuard tests green.
