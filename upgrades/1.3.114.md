# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Multi-machine: a standby machine no longer steals your Telegram messages.**
Telegram allows exactly one connection per bot to receive messages. When you ran
one agent across two machines, BOTH machines tried to receive — so the messaging
service handed each message to one of them at random, and about half landed on
the machine you weren't watching (so the agent looked like it ignored you). A
standby machine can now be told "don't own the Telegram connection": it runs the
full server and stays a full member of the machine pool (so work can move to it),
but it never opens the receive connection — only the primary machine does. The
default is unchanged (every existing single-machine agent keeps receiving exactly
as before); only a machine explicitly set to standby stops receiving.

## What to Tell Your User

If you run on one machine, nothing changes. If you run one agent across two
machines, the second machine can now be a silent standby that helps with work but
never grabs your messages — no more "I messaged it and got no reply" from a
background machine. Nothing to configure on a single-machine setup.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Standby-no-poll Telegram guard | Set `multiMachine.telegramPolling: false` in a standby machine's config — it runs the full server + joins the pool but never owns the Telegram poll. Default (unset) = poll, so existing agents are unchanged. |

## Evidence

- Standby-no-poll guard: `tests/unit/lifeline/telegramPollOwnership.test.ts`
  (5 cases — both sides of the default-true boundary) +
  `tests/unit/lifeline/standby-no-poll-wiring.test.ts` (6 cases — the lifeline
  gate wraps flush+poll, the server supervisor and queue replay stay outside it,
  the suppressed branch sets polling=false and logs it). 11/11 green;
  `tsc --noEmit` clean.
- Side-effects: `upgrades/side-effects/standby-no-poll-guard.md`.
