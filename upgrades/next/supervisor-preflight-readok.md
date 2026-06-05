---
bump: patch
---

## What Changed

The server supervisor's recovery preflight no longer aborts on dogfooding agents (agents whose project directory is the Instar source tree). Its read-only `git status` check now declares `sourceTreeReadOk: true`, so the SourceTreeGuard — which rightly blocks destructive git operations against source trees — no longer rejects a look-only call and takes the whole recovery preflight down with it. Destructive operations remain fully guarded; non-dogfooding agents are unaffected (the guard never activates for them).

## What to Tell Your User

Nothing — this is internal recovery robustness for development agents. No user-visible behavior changes.

## Summary of New Capabilities

- Recovery preflight completes on dogfooding agents instead of aborting at the source-tree guard, shortening outage windows during restart churn.

## Evidence

Live incident, echo, 2026-06-05: during the day's restart cascade, echo's recovery preflight threw `SourceTreeGuardError` on its own source checkout and aborted, prolonging the outage; Codey diagnosed it live and hot-patched the installed runtime to restore service (his report + feedback entry fb-f3bf0ed0-7e9). Hot-patches do not survive auto-updates, hence this durable fix. Regression test `tests/unit/server-supervisor-preflight.test.ts` ("allows read-only git status against an agent dogfooding the Instar source tree") pins the declaration; full file 11/11 green. Same fix class as #450/#455/#550 (read-only callers wrapped by the guard migration #99 without the opt-in).
