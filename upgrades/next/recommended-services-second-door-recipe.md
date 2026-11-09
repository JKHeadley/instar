# Upgrade Guide — recommended-services-second-door-recipe

## What Changed

The sixth recommended-services setup recipe, `second-door-v1` (service `second-ai-door`), available on every agent after its live proof. A second "door" is a provider other than the agent's main one (Claude Code or Codex CLI). The check passes when one is installed and signed in on this machine (one free call, `src/install/doors.ts`), which is what lets the agent move a conversation onto it. The server's step, `POST /recommended-services/second-ai-door/sync`, adds that door to this agent's `enabledFrameworks` when the agent lists providers (dashboard at once; internal fallback chain from the next restart), remembering it as setup's (`src/recommended/aiDoors.ts`, wiring in `routes.ts`). Sign-in is the person's own tap on the provider's link; nothing here signs a door in or out. A switch-off takes back only a door setup listed, for this agent only. A switch-off of any service now also clears the last-refresh record, so a later yes refreshes promptly. The catalog's benefit text now says what a second provider gives: the person can move a conversation onto it when the main one is down or out of quota.

## What to Tell Your User

I can set up a second AI provider for myself, so when my main one is down or out of quota you can ask me to move a conversation over and the work doesn't stop. If you already have a ChatGPT or Claude subscription, it's one sign-in tap; if not, I'll tell you the price and wait for your yes.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Second AI subscription recipe | The person asks, or the offer list; yes on `/dashboard/service-yes?service=second-ai-door` with the PIN |
| Server step | `POST /recommended-services/second-ai-door/sync` from the setup session, after the person's sign-in |

## Evidence

`tests/unit/recommended-services-second-door-recipe.test.ts` (door lists, check, server step, switch-off, brief), `tests/integration/recommended-services-second-door.test.ts` (yes → setup → sign-in → switch on → pass → switch-off; a pre-existing second door left alone), e2e availability, wiring. Live proof 2026-11-08 00:49–00:52Z on throwaway `recsvc-bw-agent` (the sign-in tap not exercised: Codex was already signed in on the machine; switch-off proven on the fixed build). Evidence: `.instar/lanes/bitwarden-recipe-1107/door-*`.
