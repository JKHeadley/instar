---
kind: "spec"
id: "slack-multi-machine-parity"
title: "Slack Multi-Machine Parity"
summary: "Promote Slack to a first-class multi-machine participant: durable conversation ids, topic/session lifecycle notifications, and transparent handoff across machines."
---

# Slack Multi-Machine Parity

**Status:** DRAFT
**Owner:** Echo  
**Created:** 2026-07-03  
**Goal Alignment:** Goal A (Premier AI Employee in Slack)

## Problem

Slack is currently a non-participant in multi-machine UX:
- Attention items (notice, topic creation) are **Telegram-only** 
- Session restart-all skips Slack
- No durable conversation IDs — Slack conversations are ephemeral per-machine
- Topic swap / session handoff are **invisible to Slack users**
- Slack contradicts Goal A: seamless multi-machine UX

The moment an agent spans multiple machines, a Slack user loses visibility into session lifecycle and workspace coordination.

## Design

### Layer 1: Durable Conversation Identity (already shipped in v1.3.737, but Slack integration missing)

Mint a stable negative `topicId` the moment a Slack conversation (channel + thread) receives its first message. Store in `ConversationIdentityStore`. 

- **Why:** Slack conversations outlive servers, machines, and configuration resets. A conversation identity that persists across restarts lets commitment/follow-through attach durably.

### Layer 2: Base Adapter Parity

Promote these notification types from TelegramAdapter's exclusive grip:

1. **Attention items** → base adapter interface (NotificationAdapter)
   - `createNotice(topic, title, body)` 
   - `notifySessionLifecycle(topic, event, detail)`
   - `notifyTopicSwap(topic, fromMachine, toMachine)`

2. **SlackAdapter implements** all three notification types using Slack's message/thread model

3. **Outbound gate covers Slack** in tone review (already does, by channel model)

### Layer 3: Session Lifecycle Notifications in Slack

When a session bound to a Slack topic:
- **Starts:** `"Session started on <machine>. Use Slack to message me."`
- **Restarts** (config change / model swap): `"Brief restart for <reason>. Back shortly."`
- **Swaps machines:** `"Moving this conversation to <machine-nickname> for load balance. No message loss."`
- **Dies** (reaper): `"Session ended. <reason>. To continue, send a message here."`

All routed through the base adapter so Slack users see the same lifecycle visibility as Telegram users.

### Layer 4: Topic-Swap UX for Slack

When a Slack topic's session moves to another machine:

```
[Slack message in thread]
"Seamlessly moved to <machine>. Reply here to continue."
```

The user continues in the same channel/thread. No topic creation, no Telegram detour.

## Implementation Strategy

### Phase 1: NotificationAdapter base class (1-2 specs)
- Abstract `createNotice`, `notifySessionLifecycle`, `notifyTopicSwap`
- TelegramAdapter implements existing behavior
- SlackAdapter implements real Slack behavior

### Phase 2: ConversationIdentity integration (existing, just wire Slack)
- SlackAdapter reads/writes conversation identity on every inbound message
- Slack conversations now have durable negative topicIds
- Commitment/follow-through works for Slack

### Phase 3: Enable Slack in config defaults
- Flip `slack.enabled: true` by default (ships dark first, dry-run second)
- Update CLAUDE.md template to document Slack as first-class

### Phase 4: Live-verify on real Slack workspace
- Send test messages to Slack → verify identity minting
- Trigger session restart → verify lifecycle notification lands in Slack
- Swap a topic → verify handoff message + session continuity

## Test Plan

**Tier 1 (Unit):** ConversationIdentity minting for Slack routing key  
**Tier 2 (Integration):** SlackAdapter notification methods with mocked Slack client  
**Tier 3 (E2E Lifecycle):** Real Slack workspace test channel
- Send message → conversation id mints
- Trigger config change → restart notification in Slack
- Operator moves topic via API → swap message appears
- Session ends → lifecycle notice in Slack

## Success Criteria

- [ ] SlackAdapter implements NotificationAdapter interface
- [ ] Slack conversations mint durable topicIds on first message
- [ ] Session lifecycle (start/restart/swap/end) visible in Slack threads
- [ ] Slack and Telegram users see feature parity in notifications
- [ ] Multi-machine topic swap is **transparent to Slack** (same conversation, continuous)
- [ ] Live-verified on real Slack workspace with real messages

## Breaking Changes

None — existing Telegram behavior unchanged. Slack added as new adapter.

## Slack-Specific Notes

- **Threading:** Use Slack's thread model for continuity (agent replies in the user's thread)
- **Reactions:** Consider emoji reactions for quick status (⏸ for paused, ▶️ for resumed)
- **Workspace context:** Slack workspaces are org-scoped, so the agent presence is inherently multi-user + multi-team awareness (unlike Telegram topics which are single-user)

---

**Related specs:** llm-seamlessness-orchestrator, intelligent-working-set-lazy-sync
