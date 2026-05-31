---
title: scope-coherence-checkpoint Stop hook — codex stdout-safe (empty=allow)
slug: codex-scope-coherence-stdout-safe
date: 2026-05-31
author: echo
status: approved
review-convergence: internal-plus-second-pass-2026-05-31
approved: true
approved-by: echo (standing 12h autonomous deploy mandate, topic 13435)
approval-note: >
  Self-approved under the standing deploy mandate. LIVE-FOUND while driving Codey
  over Telegram (the mentorship loop): after Codey completed a single-turn task and
  sent its reply, its codex session reported "Stop hook (failed) — invalid stop
  hook JSON output". Root-caused to scope-coherence-checkpoint.js emitting
  {decision:'approve'} on its allow paths; codex's Stop-hook contract is empty=allow
  (only {decision:'block',...} is a valid emission). Byte-equivalent for Claude
  (empty == approve), so zero behavior change there; fixes codex. Sibling of #604.
second-pass-required: false
second-pass-status: n/a-codex-stdout-convention-mirrors-604
eli16-overview: codex-scope-coherence-stdout-safe.eli16.md
---

# scope-coherence-checkpoint — codex stdout-safe

## Background — found by the live mentorship drive

Driving Codey (a codex agent) over Telegram with a real task, Codey completed it
and **sent its reply successfully**, then its codex session printed: `Stop hook
(failed) error: hook returned invalid stop hook JSON output`. Codey's Stop chain is
five instar hooks. Auditing each: `stop-gate-router`, `response-review`, and
`claim-intercept-response` write to stdout **only on a block decision** (codex-safe);
the autonomous-stop-hook was already fixed in #604. The remaining culprit is
**`scope-coherence-checkpoint.js`**, which writes `{decision:'approve'}` to stdout
on *every allow path*.

## Root cause

codex's Stop-hook contract: **empty stdout = allow**; a recognized **`{decision:
'block',...}`** = block; anything else non-empty (including `{decision:'approve'}`)
is rejected as "invalid stop hook JSON output". Claude Code tolerates an explicit
`{decision:'approve'}` (treats it as allow, same as empty). So the hook worked on
Claude but tripped the error on every codex session completion. The reply itself is
sent *before* the Stop hook runs, so impact is cosmetic (no lost work) — but every
codex session completion emits the error. This is the exact convention #604
established for the autonomous-stop-hook (it moved approve-path output off stdout).

## Design

In `PostUpdateMigrator.getScopeCoherenceCheckpointHook()` (the source-of-truth that
generates `.instar/hooks/instar/scope-coherence-checkpoint.js`), change every allow
path to **emit nothing** (`process.exit(0)` with empty stdout) instead of
`process.stdout.write(JSON.stringify({decision:'approve'}))`. The BLOCK path
(`{decision:'block', reason}`) — the actual scope-checkpoint feature — is unchanged
(codex accepts block decisions). Five try-block allow paths + the catch-all error
path are emptied.

- **Claude:** byte-equivalent — empty stdout == approve. The re-entry guard
  (`stop_hook_active`) still allows immediately (never re-blocks a continuation);
  the headless/job, depth, cooldown, and min-age short-circuits all still allow.
- **codex:** empty stdout = allow, so no more invalid-JSON error.

## Migration parity

`scope-coherence-checkpoint.js` is in the **always-overwrite** built-in-hook list
(`PostUpdateMigrator` rewrites it on every update run). So fixing the generator
method auto-redeploys the corrected hook to every agent (incl. instar-codey) on its
next update — no marker or sniff needed.

## Scope note (not in this PR)

A separate hook just above `getScopeCoherenceCheckpointHook` also emits
`{decision:'approve'}` on stdout, and several other hooks emit `{decision:'approve',
additionalContext:...}` (signal hooks). Those need the same codex-stdout treatment
(the additionalContext ones require a codex-appropriate context-injection path, not
just emptying) — tracked under the #32 parity audit / ledger issue
`codex-stop-chain-multi-json-invalid`. This PR fixes the **confirmed Stop-chain
culprit** observed live on Codey.

## Test plan
- Unit (`tests/unit/scope-coherence-reentry.test.ts`, extended):
  - re-entry continuation (`stop_hook_active=true`) → exit 0 + **empty stdout**.
  - fresh Stop below depth threshold → exit 0 + **empty stdout**.
  - the generated hook source contains **no** `{decision:'approve'}` and **keeps**
    `{decision:'block'}` (codex contract: empty=allow, block-JSON=block).
- Regression: PostUpdateMigrator-buildStopHook + migration-parity-hooks +
  installCodexHooks suites stay green (28 tests).
- Verification (post-deploy): re-drive Codey once it's updated and confirm the
  "invalid stop hook JSON output" error is gone.
