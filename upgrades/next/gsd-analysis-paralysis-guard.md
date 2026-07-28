<!-- bump: patch -->

## What Changed

Adds `analysis-paralysis-guard.js`, a PostToolUse hook that notices when an agent has been reading
without acting. It tracks a sliding window of recent tool calls in a small state file; when read-only
tools (`Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`) fire five or more times in a row it injects an
"act or report blocked" checklist.

The failure it targets is an agent that keeps investigating and never either does the thing or says
plainly that it is stuck — which reads as progress from the outside while nothing moves.

This sits alongside the guards already on `main` rather than duplicating them: `self-stop-guard`
catches quitting with an excuse, `slopcheck-guard` checks package legitimacy on installs, and this one
catches the opposite failure from self-stop — not quitting, but never arriving. `main` has no
equivalent.

Originally cherry-pick #1 from the GSD-Instar integration spike (#332), opened 2026-05-23 and
refreshed against `main` now.

## What to Tell Your User

Nothing to configure. If a session has been reading in circles, it will get a nudge to either take the
next action or say what is blocking it — so the visible change is fewer sessions that look busy while
producing nothing.

## Summary of New Capabilities

- `hooks/instar/analysis-paralysis-guard.js` — installed by `PostUpdateMigrator` for existing agents
  and included in the settings template for new ones, so both paths get it (Migration Parity).
- Advisory only: it injects a checklist. It never blocks a tool call, never fails a session, and
  cannot stop work.

## Evidence

- Registered through the full hook path — install, filename list, `getHookContent` switch case, and
  the settings template — verified after the merge rather than assumed: each of the three hooks
  (`self-stop-guard`, `slopcheck-guard`, `analysis-paralysis-guard`) has exactly one install site, one
  switch case, and one list entry.
- The merge's fourth conflict was two versions of the same `getHookContent` signature; merging them
  into one declaration (rather than keeping both sides) is what kept the file compiling. Exactly one
  declaration remains.
- `tsc --noEmit` clean.
