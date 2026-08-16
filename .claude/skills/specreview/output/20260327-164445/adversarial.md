# Adversarial Review — Instar SlackAdapter Spec

**Review ID**: 20260327-164445 | **Round**: 1 | **Reviewer**: Red Team Specialist | **Date**: 2026-03-27

## Approval Status: CONDITIONAL APPROVAL

### Score: 6.5/10

---

## Research Findings

Known Slack bot abuse patterns: token theft via slash commands, OAuth token interception, channel flooding (20 channels/min rate limit), WebSocket URL replay, interaction payload spoofing, manifest scope injection via URL encoding, browser automation credential harvesting. All directly applicable.

---

## Critical Issues

### CRITICAL-1 (P0): AuthGate Default — Open Workspace
`authorizedUserIds` is optional. If empty, ANY workspace member can command the agent. Setup wizard has a code path where this list may never be populated. In shared workspace, exposes agent to all colleagues.
- **Likelihood**: High | **Impact**: High | **Priority**: P0
- **Fix**: Make required, fail closed if empty.

### CRITICAL-2 (P0): Bot Tokens Captured in Browser Screenshots
Wizard calls `browser_take_screenshot`/`browser_snapshot` for state verification. Screenshots near Steps 6 and 8 capture `xoxb-` and `xapp-` tokens in plaintext. May persist in `/tmp/`, session logs, or transcripts.
- **Likelihood**: High | **Impact**: Critical | **Priority**: P0
- **Fix**: Suppress screenshots on token extraction steps; validate token regex immediately; clear tmp artifacts.

### CRITICAL-3 (P1): Prompt Injection via Channel Name / SenderName
Injection tag `[slack:CHANNEL_ID "channel-name" from SenderName (uid:...)]` includes user-controlled fields. A display name containing `]` + text can break out of the tag and prepend arbitrary content to session prompt.
- **Likelihood**: Medium | **Impact**: High | **Priority**: P1
- **Fix**: Sanitize both fields; consider JSON-serialized injection format.

### CRITICAL-4 (P1): Acknowledgment Before Auth Check
Socket Mode events acknowledged before AuthGate validation. Malicious envelopes confirmed delivered before rejection. Other workspace bots can spoof `user_id` fields.
- **Likelihood**: Medium | **Impact**: Medium | **Priority**: P1
- **Fix**: Validate auth before acknowledgment, or at minimum log rejected-after-ack events.

---

## High Priority Issues

- **HIGH-1**: `wsUrl` may appear in error logs — add to redaction patterns
- **HIGH-2**: No channel creation cap — rapid spawning hits rate limits silently; consider max 10 active `sess-` channels
- **HIGH-3**: Race condition in reaction lifecycle — two rapid messages share cleanup path
- **HIGH-4**: Manifest URL injection — agent name with `"` or `}` can corrupt manifest JSON or inject scopes
- **HIGH-5**: Reconnection loop on token revocation — no distinction between transient and permanent failures

---

## Implementation Bugs Found

- `action.action_id.split('_')` in Block Kit handler — if `promptId` contains underscores, destructuring captures wrong values. Use `split('_', 2)` or different separator like `::`.
- `PORT="${INSTAR_PORT:-4040}"` in slack-reply.sh — wrong default, server runs on 4042.

---

## Edge Cases

- Archived channel receives new message → session registry miss → silent drop
- Workspace name collision during wizard creation
- Messages at exactly 4000-char boundary split at Unicode boundary
- Empty workspace state at first boot before channels created
- `ts`-based Prompt Gate replay: workspace members can post fake Block Kit messages

---

## Social Engineering

- **SE-1**: Wizard trains users to log into Slack in agent-opened browser windows — prime phishing window if session compromised. Always verify URL is `*.slack.com` via snapshot before login instruction.
- **SE-2**: Fake Prompt Gate buttons — bind prompt interactions to specific `ts` values issued by the bot; reject all others.

---

## Top 5 Recommended Fixes

1. Make `authorizedUserIds` required — fail closed if empty
2. Fix `slack-reply.sh` default port from 4040 → 4042
3. Suppress screenshots during token extraction steps
4. Fix `split('_')` in Block Kit action ID parser
5. Add `wsUrl` to redaction patterns
