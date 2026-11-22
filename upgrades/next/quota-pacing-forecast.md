# Quota forecast: will an account's quota go unused, will Claude or Codex run out

<!-- bump: patch -->

## What Changed

Instar now keeps the quota readings it already takes every 15 minutes, instead of keeping only the last two, and turns them into a forecast (`GET /quota-pacing`). For Claude and for Codex it says whether the group of accounts keeps weekly room all week, and for each account where it will land when its quota resets: on track, will leave some unused, will reach its limit, or at its limit. Each login is counted once even when several machines see it. A missing, stale or old reading shows as "can't tell" with the reason, never as empty or full. The forecast only reports; it changes nothing on its own. It is on for development agents and off for other agents for now.

## What to Tell Your User

- **Quota forecast**: "I can now see ahead on your subscription quota: whether any account will reset with a lot unused, and whether Claude or Codex as a group will run out before the next reset. Ask me any time."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Quota forecast per provider and account | Ask the agent; it reads `GET /quota-pacing` |

## Evidence

- Unit: `tests/unit/quota-pacing.test.ts` (includes a replay of a real account that reset with about half its week unused), `tests/unit/quota-history-ledger.test.ts`, poller wiring test; integration: `tests/integration/quota-pacing-routes.test.ts`; e2e: `tests/e2e/quota-pacing-alive.test.ts`.
