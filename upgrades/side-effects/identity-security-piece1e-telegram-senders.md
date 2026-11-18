# Side-Effects Review — Telegram sender authority: one rule on every path, and an empty list is not everyone

**Version / slug:** `identity-security-piece1e-telegram-senders`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2. Spec `docs/specs/identity-security-piece1e-telegram-senders.md` (two rounds plus a delta check; both internal lenses converged; cross-model findings applied or ruled to later pieces).

- **One rule.** `telegramSenderStanding` (`src/messaging/telegramSenderAuthority.ts`) answers owner, authorized, stranger or unknown.
  - **stranger** needs positive evidence: a proven sender id that is neither the owner, on the list nor a registered person, on an agent whose owner is known.
  - **unknown** covers everything else, and is never refused for being unknown.
- **The action table.** `standingMay` sets what each standing may do:
  - whole-agent controls are owner-only;
  - one-session controls go to the owner or any authorized person;
  - `'*'` alone allows messages and media only.
- **Three paths.**
  - The adapter's polling path: `isAuthorized` → `senderMay`.
  - The forward route: the check runs before topic naming, media capture, pairing, the stop, the history log, delivery and commands.
  - The lifeline process: its `/lifeline restart|reset|doctor|queue`, `/restart` while the server is down, and photo and file downloads.
- **Bots and anonymous admins.** Bots, including Telegram's anonymous-admin bot, keep today's answer on every path.
- **Unknown senders.** An unknown sender keeps today's answer in both modes: the rule neither refuses them nor lets them past today's list.
- **Commands.** Commands follow the table on both paths. The emergency stop needs a standing that allows session controls, on both paths. A lifeline id counts as proven only when the ingress guard verified it, and app and phone messages are not judged here.
- **The way in.**
  - A refused stranger gets one reply, only in their own private chat, capped at 1 per sender and 20 per agent per day, and a join request goes to the owner.
  - The owner's `/approve <code>` registers the person in the user registry. `/decline <code>` and `/deny <code>` decline. Both are owner-only.
  - These answers skip the emergency-stop classifier, which otherwise read "decline" as a stop.
- **No one-person lists.** The legacy allowlist is written only when it already has entries. This now also applies to mini-onboarding, which used to write the first entry.
- **Dev-gated.** The switch is `security.telegramSenderAuthority.enabled`, with a `DEV_GATED_FEATURES` entry and a ladder entry.
  - **Off (the fleet):** today's answer stands. Each would-refuse is recorded in the evidence log, and one owner item is raised and refreshed (64 senders a day, then "64 or more").
  - **On with no owner known:** the owner item says the checks are not protecting the agent.

## Decision-point inventory

- `TelegramAdapter.isAuthorized` — modify — enforce the standing rule when the switch is on; today's answer plus an observe row otherwise.
- `/internal/telegram-forward` — add — refuse a proven stranger early (`refused: true`); gate the stop for session controls.
- `TelegramAdapter.handleCommand` — add — the action table for commands; `/approve`, `/decline` and `/deny` owner-only.
- `TelegramLifeline` — add — `senderMayHere` for its own commands and downloads.
- Mini-onboarding and approval — modify — never start a one-person allowlist.

---

## 1. Over-block

- **The owner is never refused.** The configured owner is always `owner`.
- **Unproven ids are never refused.** Unreadable registries, unproven ids, anonymous admins and agents with no owner configured are all `unknown`, and keep today's handling.
- **The fleet refuses nothing at merge,** since everything that refuses is behind the dev-gated switch.
- **On enforcing (development) agents,** a group member who is neither listed nor registered is refused until the owner approves them. That is the intended change.

## 2. Under-block

- **One-session controls are not tied to a session's own person.** They go to the owner or any authorized person, because the topic operator record is overwritable. A per-person session record comes with pieces 2 and 1f.
- **Approvals are per machine.** Replicated admission is piece 4.
- **Callback buttons are judged by their existing approver rule,** not by this one.

- **Allowlist writes are in memory.** On a fleet agent whose list already has entries, an approved person is added to that list in memory only. After a restart, observe mode refuses them again until the owner adds them, as mini-onboarding does today. They stay registered, and the rule admits registered people when it enforces.
- **Join requests are capped.** After 20 strangers in a day, no further join requests are created that day.

- **The owner item is upserted.** `createAttentionItem` would keep the first count, so a follow-up commit switched both wiring sites to `upsertAttentionItem`. They are marked `needsUser`, so the default hub filter posts them instead of holding them as automated status.

## 3. Level-of-abstraction fit

One pure module holds the rule and the table. The adapter owns the polling and command paths, the route calls the adapter, and the lifeline reuses the same pure functions with its own config reads. The join-request wiring is one function used by both adapter setups.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface for callers.
- [x] Yes — a deterministic evaluator over an enumerable domain (sender id against the configured owner, the explicit list and the user registry; an action from a fixed command table). `signal-vs-authority.md` permits a deterministic gate over an enumerable domain; nothing here judges free text. The join-request exemption from the stop classifier is an exact command-and-code match.
- [ ] ⚠️ Yes, with brittle logic — STOP.

## 4b. Judgment-point check

The caps are bounded deterministic rules with their basis in the spec:
- 1 reply per sender a day;
- 20 replies per agent a day;
- 64 observed senders a day;
- one evidence row per sender and action a minute.

## 5. Interactions

- **Agent-to-agent hook:** bots are not judged by this rule (`senderIsBot`), so the hook still decides other agents' messages.
- **Emergency stop:**
  - A stranger never reaches it, since the forward gate runs first.
  - A `'*'`-only sender cannot stop a session.
  - The owner's join-request answers skip it.
- **Topic operator auto-bind:** it runs after the gate, so a refused stranger is never bound.
- **Notification funnel:** the private stranger reply is a direct reply to the sender's own message, listed in the raw-send baseline like `handleCommand`'s replies.

## 6. Rollback

Set `security.telegramSenderAuthority.enabled: false` on a development agent. Behaviour then returns to today's, plus observe rows. Approving someone still registers them, which today's checks ignore when the list is empty.

## 7. Evidence

- **Unit:**
  - `tests/unit/telegram-sender-authority.test.ts`
  - `tests/unit/identity-piece1e-sender-wiring.test.ts`
  - the nearby adapter, operator-bind, desktop-approval, cold-start and team-boundary suites
  - the ladder, dev-gate, no-silent-fallback and awareness guards
- **Throwaway:** see `.instar/state/identity-build-144636/p1e-throwaway-proof.md` and the PR.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action` — **closure:** `n/a`.
- **Reason:** this is a one-shot, user-driven action, not a self-triggered loop.
  - The private stranger reply and the join-request notice each answer one inbound Telegram message, capped at 1 per sender and 20 per agent a day.
  - The owner item is raised once and refreshed per new sender, up to 64 a day.
  - The owner-unknown item is latched once per process.
