---
title: "Telegram sender authority: one rule on every path, and an empty list is not everyone"
slug: identity-security-piece1e-telegram-senders
author: Echo
tier: 2
status: approved
eli16-overview: identity-security-piece1e-telegram-senders.eli16.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
sibling-principles: "Security Fixes Keep the Experience Whole; Signal vs. Authority; An Instar Agent Always Serves a Team; The Person Decides, the Agent Does the Rest"
parent-spec: "identity-security-levels.md (approved 2026-11-17 19:34 PST, Justin, topic 144636), §12 item 1 (the filed bugs, incl. fb-dc055df7-545; session controls limited to the owner or the session's person) and §10 (observe first per agent; the owner decides)"
split-from: "identity-security-piece1 (round 5 reviewed this as section 3 and the fb-dc055df7-545 row)"
lessons-engaged: "fix-the-class-not-the-instance, a-dark-guard-is-worse-than-no-guard, no-single-device-lockout"
review-convergence: "2026-11-18T12:47:00Z"
review-iterations: 3
review-completed-at: "2026-11-18T12:47:00Z"
review-report: "reports/identity-security-piece1e-telegram-senders-convergence.md"
cross-model-review: "codex-cli gpt-6.2-astra (headley.justin) rounds 1 and 2 (and round 5 of piece 1 as its section 3)"
approved: true
approved-by: "Under the approved umbrella identity-security-levels.md (Justin, topic 144636, 2026-11-17 19:34 PST: \"great! approved, please enter a 24 hour autonomous session in gpt 6.2 astra to build this\") and Justin's standing guidance that only constitution changes need his approval (2026-10-22). No constitution text changes here."
---
# Telegram sender authority: one rule on every path, and an empty list is not everyone

## Problem statement

Who may talk to a Telegram agent is decided by `authorizedUserIds`. A code map at `ef26cc788` found four gaps:

1. **An empty list means everyone** (fb-dc055df7-545).
   - `TelegramAdapter.isAuthorized` returns true when the list is empty or missing (`TelegramAdapter.ts:3247`), and so does `isAuthorizedSender` (`:3360`).
   - No install path writes the list, so on a fresh agent every Telegram sender is authorized.
   - The shared `AuthGate`, which denies by default, is switched off for Telegram.
2. **On the lifeline path the list is never applied.** Most agents poll Telegram through the lifeline process. That path forwards every sender.
   - The server's forward route uses `isAuthorizedSender` only to label an acknowledgement and to bind the topic operator (`routes.ts:31078, 31569`).
   - Commands run with no check (`server.ts:3115-3117`).
   - The natural-language emergency stop kills a topic's session with no sender check (`routes.ts:31300-31390`).
3. **The lifeline process runs its own commands and downloads with no sender check.** Its commands are `/lifeline restart`, `reset`, `doctor` and `queue`, plus `/restart` while the server is down, and it downloads photos and documents.
4. **Session controls have no role check on either path.** These are `/interrupt`, `/restart`, `/route`, `/topic`, `/local-model`, `/switch-account`, `/claim`, `/link` and `/unlink`.

In addition, the unknown-user reply posts a stranger's chosen name into the group. Its "/approve <code>" instruction is never handled (`JoinRequestManager.resolveRequest` has no caller).

## Proposed design

### 1. One sender rule, four answers

`telegramSenderStanding(userId)` (new, `src/messaging/telegramSenderAuthority.ts`) answers one of four standings.

- **`owner`**: the configured owner id (`ownerUserId`, else the prompt gate's owner id). Nobody becomes owner by writing first. The adapter has a hook for a verified-operator fallback, but nothing wires it today. Owner candidates and their confirmation come with the owner record (piece 2).
- **`authorized`**: listed in `authorizedUserIds`, or a registered person (`users`) with this Telegram id. `'*'` means everyone may talk (messages and media), but it grants no commands or controls (section 3).
- **`stranger`**: only on positive evidence. That means a proven Telegram sender id that is none of the above, on an agent whose owner is known.

  A sender id counts as **proven** only when it comes from:
  - the server's own poller (Telegram's API directly);
  - or a lifeline forward the ingress guard **verified** (`ingressDecision.verified === true`).

  A request accepted on a compatibility or rollback path (`senderTrusted` without `verified`) gives no proven id.
- **`unknown`**: anything else.
  - It covers: no proven sender id (an unproven lifeline forward clears it), an unreadable list or registry, no owner known at all, and an anonymous group admin.
  - `unknown` is never refused for being unknown. It keeps today's handling, and those messages already carry no sender trust.

Messages that do not come from a Telegram sender are not judged by this rule:
- app and phone messages signed by a device;
- other agents' bot posts, which the agent-to-agent hook claims. That hook (`dispatchAgentMessageHook`) runs first, against its own known-agents list.

Those keep their own checks.

### 2. Applied on all three paths

The same rule runs:
- in the adapter's polling path (`isAuthorized` and its callers);
- in the server's forward route (`/internal/telegram-forward`), after the lifeline-ingress check and the agent-to-agent hook, and before delivery, commands or the emergency stop;
- in the lifeline process itself, which reads the same config and user registry, for its own commands and its photo and document downloads.

### 3. What a standing may do

| Action | owner | authorized | stranger | unknown |
| --- | --- | --- | --- | --- |
| Message reaches a session | yes | yes | no | as today |
| Ordinary commands (`/sessions`, `/flush`) | yes | yes | no | as today |
| One-session controls (`/interrupt`, `/restart`, `/topic`, `/claim`, `/link`, `/unlink`, the emergency stop) | yes | yes (not via `'*'` alone) | no | as today |
| Whole-agent controls (`/switch-account`, `/local-model`, `/route`, lifeline `restart`/`reset`/`doctor`/`queue`) | yes | no | no | as today |
| Lifeline media download | yes | yes | no | as today |

With `'*'`, everyone is `authorized` for talking only (messages and media); commands and controls need a list entry or a registered person.
- A sender authorized only by `'*'` gets no one-session controls.
- One-session controls go to the owner or any authorized person, not only the session's own person. The topic's operator record is overwritten by whoever authorized spoke last, so it is no record of who owns a session. A per-person session record comes with the owner record (piece 2) and members' own conversations (1f).
- An anonymous group admin (sender hidden by Telegram) is `unknown` and keeps today's handling. Telegram allows that only for the group's admins.
- On an agent with no configured owner, the owner is not known and senders are `unknown`, never strangers. In that case the owner item says plainly: "Your agent can't tell who its owner is on Telegram, so sender checks are not protecting it. Pair your Telegram account as the owner." The guard never switches off unseen.

### 4. A stranger's way in

- **The reply.** A stranger gets the existing unknown-user reply, but only in their own private chat with the bot, never in a group. It is capped at one per sender per day and 20 per agent per day. A stranger who writes only in a group gets no reply, since a bot cannot open a chat with someone who never started one. The owner item is where they show up.
- **The owner item.** Join requests are folded into one owner item, raised once and refreshed with the count. It names senders as untrusted text ("calls themselves …").
- **The approval.** The owner approves or declines in Telegram with `/approve <code>` or `/decline <code>`. The reply already names that command, and this piece wires it to `JoinRequestManager.resolveRequest`. Only the `owner` standing may use it. Approving registers the person in the user registry (`users`, with their Telegram id), which this rule counts as `authorized`.

It writes `authorizedUserIds` only when that list already has entries, so today's checks admit the person in observe mode too. An empty list is never given a first entry: today's checks read that list alone, so a one-person list would turn away the owner and everyone else. Mini-onboarding follows the same rule; today it writes the first entry. An approval applies on the machine that received it. This piece does not copy it to the agent's other machines; replicated admission is piece 4. After a lease move, the person may need approving again there. The lifeline re-reads the user registry on each check, keyed on the file's modification time, so an approval reaches it without a restart.

### 5. Enforce on development agents, observe on the fleet

- **The switch.** Everything above that refuses is behind one dev-gated switch, `security.telegramSenderAuthority.enabled`, with a `DEV_GATED_FEATURES` entry and a `feature-ladders.json` entry. It is omitted from config so `resolveDevAgentGate` decides: on for development agents, off for the fleet until the owner's per-agent card (piece 5). Nothing refuses fleet-wide at merge.
- **With it off (observe).** Behaviour is as today, plus:
  - Each would-refuse is recorded with its sender id, chat, path and action. A would-refuse is a proven stranger, or an authorized person reaching for a control the table refuses. Rows are capped at one per sender and action a minute, and 64 senders a day. The lifeline process, which has no evidence log of its own, writes a would-refuse as a log line.
  - The owner gets one item per agent, refreshed with the count: "N Telegram accounts wrote to your agent today, or used a control, without permission for it; with sender checks on, those would be refused." Past the daily cap it says "64 or more". It names them by id and carries the approve command.
- **With it on (enforce).** Sections 3 and 4 apply.

## Decision points touched

- **Stranger only on positive evidence; unknown never refused for being unknown** — invariant; basis: irreversible-consequence (a missing or unproven id is not proof of a stranger).
- **One rule on all three paths** — invariant; basis: external-constraint (a stranger picks the path that does not check).
- **Whole-agent controls owner-only; one-session controls the owner or any authorized person (strangers never)** — invariant; basis: irreversible-consequence.
- **Everything that refuses is dev-gated; the fleet observes until the owner's card** — invariant; basis: external-constraint (umbrella section 10).
- **Caps** (one reply per sender a day, 20 per agent a day; observe rows one per sender and action a minute, 64 senders a day) — judgment-candidate; floor: a stranger cannot make the agent spam the owner or a group; arbiter: Echo.

## Frontloaded Decisions

1. Nothing refuses fleet-wide at merge. The switch decides everything that refuses.
2. "Only the session's own person" waits for a real per-person session record (pieces 2 and 1f). Until then, one-session controls go to the owner or any authorized person, and never to strangers.

## Multi-machine posture

The rule reads each machine's own config and user registry, which are synced where configured (machine-local-justification: the check runs where the message arrives). An approval writes this machine's list. Observe rows are per machine, and the owner item merges with `?scope=pool`.

## Verify the state, not its symbol

| Detector | Symbol | State | Corroboration | Unmeasurable |
| --- | --- | --- | --- | --- |
| Sender standing | a proven Telegram user id | this person may use the agent | the configured owner id or the verified operator, the explicit list, or a registered person | `unknown`: today's handling, never refused for being unknown |

## Rollout

| Stage | What happens | Fallback |
| --- | --- | --- |
| test-agent-live | Throwaway with the switch on (Telegram via the shim; the polling path and the lifeline-forward path):<br>- The owner's message, command and stop work.<br>- A registered person's message and a one-session control work, and a whole-agent control is refused.<br>- A stranger's message, command and stop are refused. The stranger gets one private reply and none in the group.<br>- The owner's `/approve <code>` admits them.<br>- An unproven (no-sender) message keeps today's handling.<br>With the switch off, everything works as today, plus one would-refuse row per sender and action, and one owner item. | Discard. |
| dev-agent-live | Echo (development agent, enforcing): Justin is the configured owner; his messages, commands and stops work first try. | Revert. |
| fleet | Observe and the owner item ship with the merge; enforcement waits for the owner's card (piece 5). | Patch release. |

## Tests and evidence

- **Unit:**
  - The standing rule, for each of the four answers. That includes the verified-operator fallback, `'*'`, an unreadable list or registry, and no proven id.
  - The action table, and that all three paths call the same rule.
  - The agent-to-agent hook runs first.
  - Replies are private only and capped.
  - `/approve` from the owner admits; from anyone else it does nothing.
  - Observe rows and the owner item.
- **Integration:** the forward route on a mounted server, with a stranger and with the owner, in both modes.
- **E2E alive:** a booted dev agent refuses a stranger's forwarded message and delivers the owner's.

## Maturation plan

- **ladder:** security.telegramSenderAuthority
- **test-agent-live:** the rollout row above.
- **dev-agent-live:** Echo, enforcing.
- **fleet:** observe at merge; enforcement by the owner's card (piece 5).
- **graduation criterion:** green Local Verify, merged commit, throwaway proof, Echo's owner path unaffected.
- **dark-window:** fleet enforcement waits for the owner's card.

## Review rulings (round 1)

- **The fleet-wide stop refusal** is dropped (both reviewers). Everything that refuses is behind the switch.
- **`unknown` is separate from `stranger`**, and an unknown sender is never refused for being unknown (both reviewers).
- **The lifeline process's own commands and downloads** use the same rule (security).
- **The stranger reply** goes only to a private chat and is capped. Join requests are folded into the owner item, and names are shown as untrusted text (security).
- **Whole-agent controls are owner-only.** One-session controls go to the owner or the topic's verified operator, and `'*'` grants talking only (security).
- **A working way in.** `/approve` and `/decline` are wired to the join-request manager, owner only (integration).
- **The agent-to-agent hook runs before the sender rule** (integration).
- **Device-signed app and phone messages** are outside this rule (integration).
- **Cross-model round 1:**
  - **Proven ids** are only those from the server's poller or a verified lifeline forward (above).
  - **Session ownership** uses the topic's verified operator now; binding every new session to its person is piece 2 and 1f.
  - **Owner provenance, local access first, replicated admission state:** pieces 2, 1a and 4.
  - **Wildcard precedence:** `'*'` grants talking (messages and media) only, and an explicit list entry or a registered person is the only way to `authorized` controls. There is no revocation record today, so removing someone from the list or the registry removes them.

## Review rulings (round 2)

- **Security and integration lenses:** converged after the delta. Approvals register people rather than starting a one-person list; one-session controls go to the owner or any authorized person, stated plainly; an enforcing agent with no owner known says so to the owner.
- **Cross-model round 2, applied:** `'*'` gives no commands; the owner item says when its cap was hit and no longer calls a member denied a control "not on your list"; the owner is the configured id only, so nobody becomes owner by writing.
- **Cross-model round 2, ruled to later pieces (same rulings as round 1):** unknown senders keep today's handling (refusing them risks locking the owner out; their identity claims are already dropped); per-session person binding (pieces 2 and 1f); owner candidates and migration (piece 2); replicated admission and serialized decisions (piece 4); relay ingress graduation (its own existing rule); fleet enforcement by the owner's card (piece 5).

## Open questions

*(none)*

## Left behind

- SMS rows on iMessage, which arrive with a spoofable sender id (1e-b).
- A finer per-person session tie than the topic's verified operator (the owner record, piece 2, and 1f).
- The lifeline ingress guard's own graduation: it already enforces after 24 quiet hours or 7 days.
