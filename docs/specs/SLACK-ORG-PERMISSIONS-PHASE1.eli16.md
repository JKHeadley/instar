# ELI16 — Slack Org Permissions, Phase 1

## What this is, in one breath

The Slack permission gate can now (a) keep a little roster of who's registered and what role they have, and (b) actually *act* on its verdicts — but that acting is switched **off** by default, so nothing changes for anyone yet.

## What already existed (Slice 0)

The gate already *watched* every Slack message and quietly wrote down a verdict ("this is fine" / "this needs a higher role" / "this is ambiguous") — but it never did anything with that verdict. It just logged it. That shipped in #1005, dark and observe-only.

## What's new in Phase 1

1. **Registration.** Admins can register a Slack user with a role ("Sarah is a contributor"), and someone who isn't registered can ask to join, which drops a *pending* request an admin approves or denies. This is the roster the gate reads to know who someone is.
2. **The enforce path.** *If* the gate is switched to "enforcing," then when a message gets a non-OK verdict, instead of just logging it, the agent replies in-thread ("I can't run a production deploy on a member's request") and stops the message from reaching the working session. A blocked message always gets a spoken-aloud reply — it's never silently dropped.

## The safeguards, in plain terms

- **It's off by default.** "Enforcing" is `false` everywhere. So Phase 1 *installs* the ability to block, but it stays inert — every existing agent behaves exactly as before (watch-only). Turning it on is a separate, later decision that first needs real data showing the gate's verdicts are accurate.
- **No silent drops.** When (eventually) enforcing, a blocked message always gets a conversational reply; an ambiguous one asks for clarification rather than guessing.
- **No new Slack connections.** The reply reuses the same Slack-send the agent already uses; nothing new talks to Slack's API.
- **Easy to undo.** It's additive — reverting changes nothing on any real install, because no one has it switched on.

## What you actually need to decide

Whether to merge Phase 1 as the dark foundation (registration + an inert enforce path). It does not turn enforcement on — that's a deliberate, data-gated step for a later phase. The build is done and tested (14 tests green) with an independent second-pass review because it's a block/allow change.
