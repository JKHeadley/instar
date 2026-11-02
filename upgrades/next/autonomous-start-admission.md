# An autonomous run now starts, or you are told it did not

## What Changed

On an agent where window-run liveness is enforcing (Echo), `POST /autonomous/register` put every new autonomous run in `preparing`. Only the liveness authority may promote a preparing run to `active`, but nothing hands an ordinary run to that authority, and it holds one window at a time. The W32 window it was built for closed on 2026-09-08, so from then on almost every run stayed `preparing` for its whole life. A preparing run is not held by its Stop hook, is skipped by the liveness reconciler (which revives only active runs), and nobody was told. Operators heard "the autonomous session never started" from four or five sessions; topic 9210's 24-hour run stopped at a boot purge on 2026-11-01 and nothing revived it.

Now:

- `POST /autonomous/register` returns `initialStatus: 'preparing'` only while a W32 window lifecycle is actually open (an admitting/active lifecycle state, not frozen, before its ceiling) and its single liveness slot is free or already held by this topic. Every other run starts `active`, so the existing liveness reconciler revives it if its session dies. Behavior off Echo, with liveness dark, or in dry-run is unchanged (`active`).
- A new preparing-run watchdog checks every minute. An open run still `preparing` 5 minutes after it registered (45 minutes if the liveness authority is evaluating it) gets ONE plain notice in its own topic saying it did not start and how to start it again. It is recorded on the run (`preparingNoticeAt`), so it is sent once; a failing send is retried at most 3 times per run (`preparingNoticeAttempts`). Off switch: `autonomousSessions.preparingWatchdog.enabled: false`.
- The CLAUDE.md template, and the update path for existing agents, tell the agent both facts.

## What to Tell Your User

When you ask me for a long autonomous run, it now actually starts, and if its session dies it gets brought back. If a run ever fails to start, you get a short message in that topic within a few minutes saying so, instead of finding out hours later.

## Summary of New Capabilities

- Autonomous runs on Echo start running straight away unless a window ritual is genuinely open and can take them.
- A run that is still waiting to start after a few minutes is reported once, in plain words, in its topic.

## Evidence

Unit tests: the start decision on both sides of every boundary (closed ledger from the real incident → active; open window with a free slot → preparing; slot held by another topic → active; past ceiling, dark, dry-run, non-Echo → active); the watchdog's thresholds, once-only notice, retry after a failed send, attempt cap, and expired-run skip. Integration test: the HTTP register route on an Echo config with an enforcing authority returns active with no open window, preparing with an open one, and active when another topic holds the slot. E2E: the production AgentServer builds Echo's enforcing authority from config, a fresh register returns active, and the wired watchdog delivers its notice through the Telegram send path once. Self-action ratchet: the watchdog settles at its attempt cap under an always-failing delivery path, across restart.
