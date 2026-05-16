# Side-effects review — Tier 2.B+ SessionWatchdog framework-aware PID resolution

**Version / slug:** `tier-2bplus-watchdog-framework-pid`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (matches the OrphanProcessReaper pattern shipped earlier in this session; reuses the framework signals it already created)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md`

## Summary of the change

After Tier 2.B/2.C/2.E and the Codex non-git fix shipped, a server
boot smoke test surfaced another framework-locked sentinel:
`SessionWatchdog.getClaudePid` resolved the in-pane CLI process by
matching `^claude$` / `/claude$` directly. For Codex installs, the
pane runs `codex` — the function returned null and the watchdog
silently no-opped on every Codex session.

Fix: generalize the resolution to walk every known framework signal
(claude-code + codex-cli today, gemini-cli etc. later) via the
`frameworkProcessSignals.ts` lookup the OrphanProcessReaper already
uses. The fallback `pgrep -P` call also now egrep-alternates over
every framework's bracket needle so child-process discovery works too.

Files touched:
- `src/monitoring/SessionWatchdog.ts` — `getClaudePid` becomes a
  deprecated shim that delegates to a new `getFrameworkPid`. The new
  method walks `listProcessSignals()` and matches both bare-name
  (`claude`, `codex`, `-claude`, `-codex`) and path-tail
  (`/usr/local/bin/codex`) forms, then falls back to a multi-needle
  egrep on the pane's child processes.

## Decision-point inventory

- **Generalize at the framework level vs add Codex-specific branch** —
  `add` (generalize). One framework-signal-driven loop scales to
  Gemini/Aider/etc. without further edits. Hand-rolling Codex-specific
  matches would diverge from the OrphanProcessReaper pattern shipped
  earlier this session.
- **Keep `getClaudePid` as a shim** — `add`. The watchdog has many
  internal call sites; renaming them all would inflate the diff for no
  gain. Shim delegates to the new method; deprecation comment makes
  the migration obvious.
- **Bare-name match for known frameworks (`claude` / `codex`)** —
  `add`. The framework signal's `binaryPattern` regex was authored for
  full command lines (`/usr/local/bin/codex exec …`), not bare comm
  names that `ps -o comm=` returns. Hardcoding two bare names keeps
  the runtime check fast and matches the existing Claude behavior.
- **`xargs -I@ ps … | egrep`** for child PID discovery — `add`. A
  single pgrep-then-ps pipeline gets us the child's command line so
  the framework-signal match can confirm it's a real framework process
  before returning the PID. The previous code grep'd raw `claude`
  which was wrong even for Claude-only installs that had unrelated
  `claude` substrings in child commands.

## Signal vs authority

The watchdog's PID resolution is a low-context signal — it answers
"which pid in this pane is the framework CLI?" with a deterministic
process-tree walk. The watchdog's restart authority is upstream
(`monitorSession`, `restartSession`). No authority boundaries shift.

## Over-block / under-block analysis

**Over-block:** None for Claude installs. The bare-name match
(`paneCmd === 'claude'`) is byte-equivalent to the previous
`/^(-?)claude$/` regex on the same string. Path-tail match
(`paneCmd.endsWith('/claude')`) preserved.

**Under-block:** A user with a custom-named wrapper script (e.g., a
shim named `my-claude`) would hit the same null-return the old code
hit. Worst case: watchdog no-op, no regression vs v0.x.

## Level-of-abstraction fit

- Stays inside SessionWatchdog. The framework-signal lookup is a
  lazy-require so the SessionWatchdog module stays cheap to import
  even when the framework abstraction grows.
- Reuses the `listProcessSignals()` table already created for
  OrphanProcessReaper — single source of truth for framework process
  identity.

## Interactions

- `monitorSession` / `restartSession` — consume the returned PID
  unchanged. No interface change.
- Tests: 65 existing SessionWatchdog tests all pass after the change
  (compaction, mcp-exclusion, notifications). No mock changes needed.

## External surfaces

- No new endpoints / env vars / config keys.
- Boot-log behavior unchanged.

## Rollback cost

Trivial.

## Tests / verification

- `npx tsc --noEmit` clean.
- 65 existing watchdog tests pass.
- Indirect coverage: the `frameworkProcessSignals` test suite (24
  cases shipped with Tier 2.C) verifies the matching logic the
  watchdog now consumes.
- No new tests authored specifically for this change: the resolution
  logic delegates entirely to `listProcessSignals()`, which is
  exhaustively tested in `tests/unit/frameworkProcessSignals.test.ts`.
  Adding a SessionWatchdog-specific test would duplicate that
  coverage.
