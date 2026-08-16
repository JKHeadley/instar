# DX & API Design Review — Instar SlackAdapter Spec

**Review ID**: 20260327-164445 | **Round**: 1 | **Reviewer**: DX & API Specialist | **Date**: 2026-03-27

## Approval Status: CONDITIONAL APPROVAL

### Score: 7.5/10

---

## Research Findings

- **Slack is the hardest platform to integrate with**: Telegram's BotFather (~60 seconds) is the benchmark. Slack requires two token types, scope config, event subscriptions, workspace installation, and Socket Mode enablement.
- **Socket Mode production reliability issues**: Slack's own docs say "we recommend HTTP for production." Real-world issues: pong timeout failures causing ~60-second silent outages, connections stopping after days without error signals, container recycling.
- **DIY app model is validated**: Developer community strongly prefers no shared token custody.
- **Browser automation of api.slack.com is high-risk**: React SPA with dynamic routing, no public automation contract.

---

## Critical Issues

### 1. Socket Mode is Not Production-Ready Without Hardening (HIGH)
The spec says "No Lifeline Needed" — this is incorrect per Slack's own docs and production reports. WebSocket can be silently dead while server process runs fine. Close-event reconnection doesn't catch silent stalls.

**Fix**: Either build a Slack Lifeline process in Phase 1 or implement active heartbeat that validates message flow — not just socket state.

### 2. Port Bug in slack-reply.sh (HIGH)
`PORT="${INSTAR_PORT:-4040}"` — Instar runs on 4042. Will silently fail for every user.

**Fix**: Change default to 4042.

---

## Recommendations

1. **Setup wizard error paths underspecified**: Workspace name collisions, URL length limits for manifest encoding, token dialog state after re-entry, partial wizard recovery all unaddressed. Track wizard progress in `.instar/slack-setup-state.json` for resumption.

2. **DM support should be default entry point**: For first-time Slack users, messaging the bot via DM is the natural instinct. Channel-only model will create confusion. Default to DMs routing to lifeline session.

3. **`instar add slack` CLI is underspecified**: Missing `--workspace-id`, no `--dry-run`, no description of post-token-receipt behavior.

4. **Rate limiting needs method tiering**: `reactions.add` (Tier 2), `conversations.create` (Tier 1 ~1/min), `chat.postMessage` (Tier 3) need different retry strategies. ACK pattern (3 reactions per message) compounds this.

5. **`authorizedUserIds: []` semantics are inverted**: Empty array = least restrictive. Counterintuitive — empty should mean deny-all.

6. **Use threads in channels**: Every AI-in-Slack integration (Claude for Slack, ChatGPT for Slack) uses threads. Without them, session channels become unreadable. Take a position on Open Question #4 now.

7. **Remove `voiceProvider` config or clarify**: Voice equivalence is "None" — including this field without comment is confusing.

8. **Document session channel name generation logic**: What produces the descriptor portion is undocumented.

---

## Observations

- Feature mapping table (Section 2.1) is excellent — keep this pattern
- Reaction-based ACK is a genuine UX upgrade over text ACKs
- Relay script pattern consistent with Telegram — learnable

---

## Scalability Assessment

Adequate for personal use. Watch: (1) channel proliferation — 7-day archive good but no purge policy; (2) single WebSocket is SPOF under high message volume with no backpressure; (3) multi-workspace correctly deferred.
