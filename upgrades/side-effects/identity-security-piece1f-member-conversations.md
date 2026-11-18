# Side-Effects Review — Team members talk to the agent in a conversation of their own, with no tools

**Version / slug:** `identity-security-piece1f-member-conversations`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2. Spec: `docs/specs/identity-security-piece1f-member-conversations.md` (converged in 2 rounds). It is stacked on piece 1e (PR 3420).

- **Who is a member.** A member is a proven, authorized Telegram sender (not via `'*'` alone) on an agent whose owner is known, and who is not the owner.
- **One check, on both paths.** On the polling path it runs after 1e's sender check and the pin and topic-name hand-offs. On the forward route it runs after 1e's gate. A member's message then goes only to `MemberConversationService`: no media capture, commands, operator bind, profile ingress, prompt answers, observers, shared log or session.
- **The member turn.** One locked-down, no-tools call made directly (`memberTurnCaller`):
  - Claude with `reviewerHardening.noTools`, else Codex with `noLocalTools`;
  - on failure, the next such carrier;
  - never the router, and never a framework with tools.
- **The prompt.** It holds the member's own history for that chat and topic (30 turns, with a note of what isn't shown). It holds no memory, owner conversation or credential.
- **The reply.** It goes to the member's own chat and topic through `sendMemberReply`:
  - a raw send with the protected `member-reply` category: always delivered, never recorded in the owner's quiet feed;
  - it replies to their message, is split under 4096 characters, and stays out of the shared log;
  - a replay with no trusted chat information is answered in the member's private chat unless it came from a forum topic.
- **The private store.** Mode 0600, under `state/member-conversations/<id>/<chat>_<topic>.jsonl`. Past 500 rows it archives, never deletes.
- **Limits.** 30 turns per member an hour and 120 per agent; one turn at a time; redelivery is answered once; commands and media get fixed replies.
- **On by default,** per the umbrella (§10: a security fix that ships on).
  - Each member gets one notice, and the owner gets one item.
  - `security.memberConversations.enabled: false` is the owner's override.
- **The relay process.** It runs none of its own commands for a member and downloads none of their files. It forwards both to the server, which answers in the member's chat. The server answers a member forward as not handed to the session, so the relay posts no "✓ Delivered".
- **The carrier.** It is built once at boot, off the event loop.
- **Failed turns** are logged by member id, never with their text.
- **The owner** is the configured owner on both the server and the relay.

## Decision-point inventory

- Polling `processUpdateDelivered`: add. The member check diverts the message.
- `/internal/telegram-forward`: add. The member check diverts the message.
- `TelegramLifeline`: add. A member's `/lifeline` commands and files are refused.

---

## 1. Over-block

- **Members lose tool access through Telegram.** That is the intended fix. They keep conversation.
- **Unchanged:**
  - the owner, unknown senders, bots, app and phone messages, and `'*'`-only senders;
  - an agent with no owner configured.

## 2. Under-block

- **`'*'` agents.** Their public senders still reach sessions; that is the owner's decision in piece 5.
- **Owner selection cards.** They come later; for now the owner quotes or forwards a member's message by hand.

## 3. Level-of-abstraction fit

- **One check per path.** It runs once per entry path, before anything with authority.
- **One service.** It owns the turn, the store and the replies.
- **One carrier builder.** It reuses the ecosystem reviewer's locked-down per-framework calls.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface for callers.
- [x] Yes — a deterministic routing rule over an enumerable domain: a sender's standing against the configured owner, list and registry. Nothing judges free text. The member's words go to a no-tools model whose only output is a text reply.
- [ ] ⚠️ Yes, with brittle logic — STOP.

## 4b. Judgment-point check

The caps are bounded deterministic limits on a paid call against the owner's quota:
- 30 turns per member and 120 per agent each hour;
- 30 history turns, with an in-band note of what isn't shown;
- 500 live rows, after which older rows are archived.

## 5. Interactions

- **Prompt injection.** The turn has no tools, no MCP and a scrubbed environment, so a member's words can reach nothing with authority.
- **Origin layer and notification gate.** The reply carries the protected `member-reply` category, which the gate always delivers and never stores (its text would otherwise reach the owner's session through the quiet feed). It is listed in the raw-send baseline.
- **Session caps.** A member turn is a one-shot call, not a session, so it doesn't count against session caps.

## 6. Rollback

`security.memberConversations.enabled: false`, or revert.

## 7. Evidence

- **Unit:** `tests/unit/identity-piece1f-member-conversations.test.ts`, plus the 1e, adapter and stop suites and the guards.
- **Throwaway:** `.instar/state/identity-build-144636/p1f-throwaway-proof.md`:
  - a member answered without tools;
  - an injection refused;
  - commands and media answered with fixed replies;
  - no member row in the shared log.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** a one-shot user-driven action, not a self-triggered loop. Each member turn answers one inbound member message, capped at 30 per member and 120 per agent an hour, one at a time. The notices fire once each.
