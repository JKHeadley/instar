# A message never goes unanswered without a word

<!-- bump: patch -->

## What Changed

Every message someone sends to a Telegram or Slack conversation is now recorded until it is answered. One still unanswered after two minutes is looked at by a judge that runs on a different AI engine from the stuck one (Jev first, then a Codex or Claude referee), using the screen since the message, Claude Code's own login check and the account list. Instar then posts a plain message in that conversation saying what went wrong, from fixed wording, even if the judge is down. When actions are switched on, an expired sign-in moves the conversation to another signed-in account or to the other engine and re-delivers the waiting message with a line saying why the reply is late; a conversation the operator set to an engine gets one message with a single "Move to …" button instead, and is never moved without that tap. Codex sessions now start with the agent's own folder already trusted, so they cannot stall at "Trust this folder?". A sign-in judged to have run out now moves the account to "needs sign-in" instead of leaving it "active". Read surface: `GET /never-silent/incidents`. Dev-gated (`monitoring.neverSilent.enabled`); `actions` and `frameworkFallback` stay off until the judge is measured. Spec: `docs/specs/never-silent-conversation.md`.

## What to Tell Your User

If a conversation can't answer you, for example because its AI sign-in ran out, you now get a short message there saying so and what is being done, instead of silence. If you chose the engine for that conversation yourself, the message offers one button to move it, and nothing moves unless you tap it.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| A plain notice whenever a conversation message goes unanswered | Automatic on development agents |
| See waiting messages, the reason and what was done | `GET /never-silent/incidents` (`?open=1`) |
| One-tap "Move to Codex" when a conversation you set to Claude can't answer | Tap the button in the notice |
| Codex sessions no longer stop at "Trust this folder?" | Automatic |

## Evidence

2026-11-13 Inspec (laptop): one Claude account's login ran out; Claude Code 2.1.323 said "Login reached its time limit", which no detector matched; three conversations sat silent up to 4.5 hours, the account stayed "active", and on the move to Codex all three stopped at "Trust this folder?". Phase 0 (spec §5): no watcher record in the window. Tests: 52 new unit tests, an integration file (one notice whether the judge throws, hangs or cannot tell) and an e2e file (expired login answered on Codex with the why-late line; pinned conversation's one-tap ask; referee down still told).
