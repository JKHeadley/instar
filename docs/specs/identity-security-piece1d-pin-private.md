---
title: "The dashboard PIN goes to the owner privately, never to a group"
slug: identity-security-piece1d-pin-private
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece1d-pin-private.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "Security Fixes Keep the Experience Whole; The Person Decides, the Agent Does the Rest; Signal vs. Authority; Migration Parity"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), §12 item 1 ('the PIN no longer posted or named in instructions')"
split-from: "identity-security-piece1 (round 5 reviewed this as section 5)"
lessons-engaged: "no-single-device-lockout, a-dark-guard-is-worse-than-no-guard, spec-reviews-not-falling-means-cut"
review-convergence: "2026-11-18T12:17:00Z"
review-iterations: 3
review-completed-at: "2026-11-18T12:17:00Z"
review-report: "reports/identity-security-piece1d-pin-private-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) rounds 1 and 2 (and round 5 of piece 1 as its section 5)"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST: \"great! approved, please enter a 24 hour autonomous session in gpt 6.2 astra to build this\") and Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here."
---
# The dashboard PIN goes to the owner privately, never to a group

## Problem statement

The dashboard PIN reaches places other people can read (code map at `16ce28155`):

1. **The pinned Dashboard message** in the Telegram group (`TelegramAdapter.ts:3054-3065`, `broadcastDashboardUrl`). It is written on every boot with a tunnel, on every tunnel restart and on `POST /telegram/dashboard-refresh`, and edited in place. Every member of the group can read it, and a newly sent copy is also logged to `telegram-messages.jsonl`. The code's own comment (`:2541`) says only the owner's private chat may carry URL + PIN; this broadcast contradicts it.
2. **The "fix dashboard" reply** posts the PIN in the Agent Attention group topic (`server.ts:603, 608`), and it is logged.
3. **The coherence report** writes a generated PIN in plain text to `state/coherence-report.json`, which `GET /health/coherence` serves (`CoherenceMonitor.ts:596-598, 679`).
4. **Agent instructions** tell every agent to "give them the tunnel URL + PIN. Read the PIN from your config.json" (`templates.ts:997, 1003, 1004, 855, 1028, 1036, 1092, 2887`; installed on existing agents by `PostUpdateMigrator.ts:15997-15999` and others). The agent answers wherever it was asked, which can be a group topic.
5. **The dormant upgrade prompt** says "Include… PINs" (`UpgradeNotifyManager.ts:224, 233`). Nothing constructs it today.

The pinned group message is also, on a regular agent with a tunnel and no paired phone, **the owner's only remote way to learn the PIN**. So it cannot simply be removed (Security Fixes Keep the Experience Whole).

## Proposed design

### 1. One server action sends the PIN privately

`POST /dashboard/pin/send-private` (bearer) asks the server to send this machine's current dashboard PIN to the owner's private chat with the bot. It returns only an outcome, never the PIN:

- `{ sent: true, machine }`
- `{ sent: false, reason }`, where reason is one of:
  - `no-owner` (no configured owner id);
  - `no-private-chat` (Telegram answered 403: the owner never opened a private chat with the bot);
  - `no-private-channel` (no Telegram on this agent, e.g. Slack only);
  - `held` (any other failure).

Agents call this route; they never read the PIN. The same action runs inside the server on four triggers: the owner's first private message to the bot (section 3), "fix dashboard", a new PIN (generated or rotated), and the Dashboard broadcast.

**The owner** is the configured Telegram owner id (`ownerUserId`, else the prompt gate's owner id). It is set at pairing, never inferred from group membership, a topic label or a session. Agents with no configured owner get `no-owner`, and nothing changes for them.

**The message** names its machine and link: "Your dashboard PIN for <agent> on <machine> is <PIN>. Keep it to yourself; I don't post it in the group. Ask me here if you need it again. (Sent <time> UTC.)" The send time makes every message distinct: the origin layer refuses identical content while an earlier send is unresolved. A request within 5 minutes of a delivery of the same PIN answers `{ sent: true, recent: true }` without sending again; the outbound dedup gate would refuse a near-identical message anyway.

### 2. A secret-carrying send is never stored or held

The private send uses a new notification category, `owner-secret`, which only the adapter's own secret send can stamp, like `owner-decision`:
- It is in the protected set: the quiet-by-default gate always delivers it and never records it.
- The gate delivers `owner-secret` only to the configured owner's private chat (a positive user id). Anything else stamped with it is refused, and a lint test keeps the stamp in one place.
- If the gate cannot decide (a gate error), the text is not stored. A placeholder ("a private message for the owner was not sent") is kept instead, and the send reports `held`.
- If the Telegram origin layer holds an `owner-secret` send for retry, the body stays only in that layer's retry store until it is sent or expires. That store is machine-local and outside backups and git. The same is already true of today's tunnel PIN messages. The send reports `held`. A discard operation for held secrets is left behind.
- No log line carries the digits. The claim is "never in a served or logged store": the quiet store, its fallback file, the coherence report and the message logs never carry the digits.

The tunnel notices that already carry the PIN (`TunnelNotifier.ts:340`, `server.ts:15626`) move to this send too, closing the same hole.

### 3. The agent carries the delivery

- **Pending delivery.** A pending delivery is kept in `state/dashboard-pin-private.json`, keyed by machine id and the PIN's existing generation id (`dashboardPinGeneration`, never a hash of the PIN). It holds `{ generation, delivered: boolean, deliveredAt?, lastReason? }`.
- **Resume.** When the configured owner sends any message in their private chat with the bot, a pending delivery runs at once. A message from anyone else never advances it.
- **Recording.** A delivery is recorded only when Telegram accepts the send.
- **No repeats.** One private message per machine and PIN generation, plus one each time the owner or an agent asks.
- **Retries.** A `held` outcome is retried at the next trigger. There are no timers and no loop.
- **Agent requests** through the route are capped at 3 per machine per PIN generation per hour. A looping session cannot flood the owner's chat.
- **Older configs.** An agent with no `dashboardPinGeneration` yet uses the generation `legacy-1` until its PIN next changes.
- **Ordering.** The owner's private message is handled before it is routed to any session. Private chats reach the server either from the server's own poller or from the lifeline's forward (`/internal/telegram-forward`, `sourceChatType: private`, lifeline-proven); both call the same resume.
- **Standbys** do not poll Telegram, so they never see the owner's private message. A standby resumes its own pending delivery at its next trigger (boot, broadcast or a request).

### 4. The group Dashboard message

The pinned message keeps the link and the quick links. Its PIN line:
- **Delivered privately** for this machine's current generation: "PIN: sent to you in your private chat with me."
- **No private route at all:** today's text, PIN included, so the owner is not locked out. This applies only on a definite answer (`no-owner`, or `no-private-chat` from Telegram's 403) and only when the owner has no paired phone app, which has its own way in. It adds a line with no secret: "To keep your PIN private, open a private chat with me (t.me/<bot>) and say hi. I'll send it there and take it off this message."
- **Otherwise** (`held`, or a paired phone): the PIN line says "PIN: ask me in your private chat." The digits are never added.

A boot or refresh never creates a new group copy with digits except in the "no private route at all" case, and then only by editing or replacing the one pinned message that already carried them. A machine that does not poll Telegram (a standby, `multiMachine.telegramPolling: false`) never shows digits: its message says "PIN: ask me in your private chat". Only the polling machine can fall back to digits, and it is the one that sees the owner's private message.

The private send runs first in the broadcast: before the group edit, and before its "unchanged" early return. It never throws out of the broadcast; a failure is an outcome. It also fits the wake path's 15-second limit.

### 5. "fix dashboard" answers privately

The handler runs the private send. The group topic gets either:
- "I've sent your PIN to your private chat with me." or
- "Open a private chat with me (t.me/<bot>) and say hi; I'll send your PIN there right away. I don't post it here."

In the second case the delivery stays pending (section 3).

### 6. No PIN digits in files that are served

The coherence check records that a PIN was generated, never the digits, and starts a private delivery. `GET /health/coherence` never returns the PIN. The dormant upgrade prompt no longer includes the PIN.

### 7. Instructions

- **New agents.** The template lines (`templates.ts`) say: "send them the dashboard link. For the PIN, call `POST /dashboard/pin/send-private`: it goes to the owner's private chat. Never read the PIN or post it anywhere. If it answers `no-private-chat`, give them the link to open a private chat with you."
- **Existing agents.** A migration replaces the known stock sentences (content-sniffed, idempotent; custom prose untouched) in:
  - `CLAUDE.md`;
  - the Codex and Gemini instruction copies (`AGENTS.md`, `GEMINI.md`), following the `stripRetiredJevCardFromShadows` precedent, since the update path otherwise only appends to them;
  - the reference files the migrator writes. The migrator's own appended text (`PostUpdateMigrator.ts:1364, 12395, 15427, 15997, 15999, 16688`) changes with `templates.ts`.
- **Awareness.** An awareness entry describes the route.

### 8. What stays

- The local terminal at install still shows the PIN, to the person at the machine.
- The phone app's Face ID reveal is unchanged.
- PINs already posted in history and logs stay where they are.
- A design with no PIN in any chat, private ones included, replaces the PIN with device credentials and a working local sign-in. That is the credential cutover (piece 4), after the local link (piece 1a).

## Decision points touched

- **The group keeps the PIN only on a definite "no private route" and no paired phone** — invariant; basis: irreversible-consequence (removing the owner's only remote way in is a lockout; a temporary failure is not that).
- **Delivered means Telegram accepted the send, keyed by machine and PIN generation** — invariant; basis: irreversible-consequence.
- **Only the configured owner's private message resumes a pending delivery** — invariant; basis: Know Your Principal.
- **One private message per machine and generation, plus on request** — invariant; basis: external-constraint (the owner already has it; repeating it widens exposure on a shared phone).
- **`owner-secret` always delivers and is never stored** — invariant; basis: irreversible-consequence (a held secret would sit in a served store).

## Frontloaded Decisions

1. No switch. Each change either moves the PIN to the channel the code already reserves for it, or removes digits from places that are served. The group copy stays until the replacement has worked.
2. The Basic reset and disputed-ownership claims are not in this piece. They need the owner record (piece 2) and are their own spec.
3. The PIN still reaches the owner's private chat. Removing it from every chat waits for device credentials and the local sign-in (pieces 1a and 4).

## Multi-machine posture

Every machine with a Telegram adapter broadcasts, standbys included (`server.ts:9566-9644`), and PINs can differ per machine. So the delivery record is keyed by machine id plus PIN generation (machine-local-justification: it describes this machine's PIN), and each private message names its machine and link. A takeover machine sends its PIN privately once. It never posts digits to the group unless the definite "no private route" rule holds on that machine.

## Verify the state, not its symbol

| Detector | Symbol | State | Corroboration | Unmeasurable |
| --- | --- | --- | --- | --- |
| PIN delivered privately | the recorded version | the owner has this PIN in the private chat | Telegram accepted the send (message id returned) | not recorded: the group copy stays |

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | Throwaway with the spare test bot, owner = a test account: before the owner's private chat exists the pinned message keeps the PIN plus the private-chat line; the owner's first private message delivers the PIN once and edits the group message; a second trigger sends nothing new; `POST /dashboard/pin/send-private` returns an outcome and no PIN; "fix dashboard" answers privately; a held send stores no digits; `/health/coherence` shows no digits. Where a real owner account cannot drive the private chat at night, the private side runs against the real server with Telegram's API answered by a fetch shim, and the real-account check is recorded as owed. | Discard. |
| dev-agent-live | Echo: the next boot moves the PIN off Justin's group Dashboard message into his private chat (he already has one with the bot). | Revert. |
| fleet | With the merge. | Patch release. |

## Tests and evidence

- **Unit:**
  - The send action's outcomes: sent, `no-owner`, `no-private-chat` (a 403), `no-private-channel`, and `held`. The outcome never carries the PIN.
  - Delivery is recorded only on an accepted send, keyed by machine and generation. A repeat trigger sends nothing; a new generation sends again.
  - Only the configured owner's private message resumes a pending delivery; another user's does not.
  - The group message for each PIN-line case. Digits appear only on a definite "no private route" with no paired phone.
  - `owner-secret` is always delivered, and a gate error stores no text.
  - "fix dashboard" never posts digits.
  - The coherence report has no digits.
  - The template text and the migration (idempotent; custom prose untouched).
  - A ratchet fails on any group or topic send whose text includes the dashboard PIN.
- **Integration:** `POST /dashboard/pin/send-private` on a mounted server with a fake Telegram API, for each outcome.
- **E2E alive:** a booted server with a fake Telegram API: the owner's first private message moves the PIN out of the group message.

## Review rulings (round 2, cross-model)

- **No PIN in any chat, piece 1a first, a switch per piece:** ruled in round 1 (frontloaded decision 3). This piece moves the PIN from a group to the configured owner's private chat and adds no way in or out.
- **A paired phone is not proof of a way in:** a paired owner phone opens the console with Face ID, without the PIN (the console ticket). That is the other way in this piece relies on.
- **Rollback:** an older build re-edits the pinned message with the digits on its next refresh. That is today's status quo, not a new exposure.
- **A crash between Telegram accepting the send and the record being written:** the next trigger sends once more. That is one extra private message, never a group post.

## Review rulings (round 1)

- **No PIN in any chat, private included** (cross-model): this moves the PIN from a group everyone reads to the configured owner's private chat, the channel the tunnel-resilience spec already reserves for it. Removing it from chat altogether needs the device credentials and local sign-in of pieces 1a and 4 (frontloaded decision 3).
- **The local link as a first-shipped dependency:** the local link is piece 1a (PR 3406). This piece removes no way in, so it does not depend on it.
- **Ownership and team roles:** the owner here is the configured id set at pairing, and nothing inferred advances anything. Disputed claims and team session controls are pieces 2, 1e and 1f.

## Maturation plan

- **ladder:** not applicable: no switch, the PIN moves to the channel already reserved for it and stays in the group until that works
- **test-agent-live:** the rollout row above.
- **dev-agent-live:** Echo's own Dashboard message.
- **fleet:** with the merge.
- **graduation criterion:** green Local Verify, merged commit, the throwaway proof, and Echo's own stage as the real private-chat proof (Justin already has a private chat with Echo's bot). A fresh-owner check — the first private message from an owner who never had a private chat — is tracked as a dated commitment and done in daytime with the spare test bot.
- **dark-window:** none.

## Open questions

*(none)*

## Left behind

- The Basic PIN reset and disputed-ownership claims: their own spec, after the owner record (piece 2).
- Rotating PINs that were already posted: piece 4.
- A discard operation for a held `owner-secret` send in the Telegram origin layer's retry store.
- A minimum PIN length.
