# Side-effects review — Tier 2.C OrphanProcessReaper framework-agnostic process detection

**Version / slug:** `tier-2c-orphan-reaper-framework-signals`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (additive — Claude-only behavior preserved, single `egrep` adds Codex coverage without changing classification logic)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md` (general v1.0.0 portability mandate; orphan-reaper generalization audited overnight)

## Summary of the change

OrphanProcessReaper hardcoded Claude's binary patterns inline:

```
const claudeBinaryPattern = /(^|\/)claude(\s|$)/;
const claudeNodePattern = /@anthropic-ai\/claude-code|claude-code\/cli/;
```

and pre-filtered the ps output with `grep -i '[c]laude'`. That made
the reaper blind to Codex processes — they would have leaked forever,
defeating the reaper's purpose. The Telegram alert also referenced
"Claude processes" exclusively, which would be wrong for a Codex-only
operator.

This change introduces `src/monitoring/frameworkProcessSignals.ts` —
a per-framework signal carrying `psGrepNeedle`, `binaryPattern`,
`nodePattern`, `exclusionSubstrings`, and `displayName`. The reaper
now builds a single `ps … | egrep …` pipeline over every signal's
needle, then tags each parsed process with the matched framework via
`matchProcessSignal`. The Telegram alert groups the external-process
count by framework display name.

`ClaudeProcess` is preserved as a deprecated type alias for
`FrameworkProcess` (the new canonical type, with a `framework:
IntelligenceFramework` field). `findAllClaudeProcesses` and
`isClaudeCodeProcess` are deprecated shims delegating to the new
framework-generic methods — keeps internal call-site churn small,
clear deprecation path for v2.

Files touched:
- `src/monitoring/frameworkProcessSignals.ts` — new, ~140 LOC.
- `src/monitoring/OrphanProcessReaper.ts` — replaced inline patterns,
  added framework field to FrameworkProcess, refactored
  findAllClaudeProcesses → findAllFrameworkProcesses with multi-needle
  egrep, made external-alert text framework-aware.
- `tests/unit/frameworkProcessSignals.test.ts` — new, 24 tests
  (parallel Claude regression + Codex coverage + mutual-exclusion).
- `tests/unit/StallTriageNurse.test.ts` — rewrote one orphaned test
  (`falls back to direct API when no IntelligenceProvider`) that
  asserted on the now-removed Rule 2 direct-API fallback. The
  replacement test asserts the post-Rule-2 contract: missing
  intelligence → heuristic fallback layer, never an HTTP call.

## Decision-point inventory

- **One ps + multi-needle egrep vs N ps calls per framework** — `add`
  (single ps + egrep alternation). Keeps the hot-path single-syscall
  identical to the v0.x cost. Adding frameworks is a one-line addition
  to the signal map, not an N-fold runtime cost.
- **Rename `ClaudeProcess` vs alias it** — `add` (alias). `FrameworkProcess`
  is the new canonical name, but `ClaudeProcess` lives on as a
  deprecated alias. Routes consumers and `AgentServer` imports remain
  intact this release; cleanup can happen in v2 when the deprecation
  has had a release cycle to bite.
- **Keep `findAllClaudeProcesses` / `isClaudeCodeProcess` as shims** —
  `add` (shims). Private methods, but routes and reflection code may
  still reference them; deprecation comments make the migration
  obvious without breaking anything.
- **Group external-alert breakdown by framework vs flat count** — `add`
  (group by). When a user has both Claude AND Codex external processes,
  "5 agent-CLI processes (3 Claude, 2 Codex)" is dramatically more
  actionable than "5 processes". Cost: one Map allocation per alert.
- **Codex node-pattern guesses** — `defer` (best-effort). I covered
  `@openai/codex`, `codex-cli/cli`, `codex-cli/bin` based on the public
  npm shape; first observed Codex orphan will let us refine. False-
  negative cost is bounded (occasional leak) and recoverable by user-
  initiated cleanup. False positives are guarded by the helper-prefix
  check and per-signal exclusion list.

## Signal vs authority

The process signals are recognition data — they answer "does this
command line look like framework X's binary?" with deterministic
pattern matching. They have NO blocking authority over kills; the
existing classification logic (tracked / instar-orphan / external) is
authoritative for what gets touched, and per the long-standing safety
rule, EXTERNAL processes are never auto-killed. The signals' role is
to widen the recognition net to include Codex without changing the
authority hierarchy.

This satisfies [[feedback_signal_vs_authority]]: signals are
brittle/low-context pattern data, classification is high-context
authority.

## Over-block / under-block analysis

**Over-block:** None to existing Claude flow. The Claude binary
pattern, node pattern, and helper exclusions are byte-for-byte
preserved in `frameworkProcessSignals.ts`. The existing regression
tests in `OrphanProcessReaper.test.ts` still pass unchanged.

**Under-block:** A user with a Codex-specific binary naming
convention not yet covered (e.g., a custom wrapper script named
`my-codex`) could leak. Catastrophic case is unlikely on a
production install (`@openai/codex` is the canonical npm path).
The reaper poll runs every minute by default; one missed poll just
extends the orphan's lifetime by a minute.

## Level-of-abstraction fit

- Lives in `src/monitoring/` alongside the consumer (OrphanProcessReaper).
- Imports `IntelligenceFramework` from
  `src/core/intelligenceProviderFactory.js` — single source of
  framework-enum truth.
- Stays out of `src/providers/primitives/` for the same reason as
  Tier 2.B: process-recognition is a sentinel concern, not a control
  primitive.
- Exhaustiveness via `Record<IntelligenceFramework, FrameworkProcessSignal>` —
  extending IntelligenceFramework without adding a signal is a TS error.

## Interactions

- **`OrphanProcessReaper` (existing)** — `poll`,
  `findAllFrameworkProcesses` (new method), `findAllClaudeProcesses`
  (deprecated shim), `isClaudeCodeProcess` (deprecated shim),
  `classifyProcesses`, external-alert message text. Behavior preserved
  for Claude-only installs.
- **`routes.ts` and `AgentServer.ts`** — only consume the public
  `OrphanProcessReaper` class and `ReaperReport` shape; both
  unchanged. No downstream churn.
- **`commands/server.ts`** — only constructs the reaper; unchanged.
- **No new external surfaces** (no new endpoints, env vars, or config).

## External surfaces

- No new endpoints.
- No new environment variables.
- No new on-disk config keys.
- Telegram alert message text now mentions "agent-CLI processes" with
  per-framework breakdown instead of "Claude processes" — slight user-
  visible copy change to accommodate Codex/etc.

## Rollback cost

Trivial. `git revert` restores Claude-only inline patterns. No state-
shape changes, no migration.

## Tests / verification

- `npx tsc --noEmit` clean.
- New unit tests: `tests/unit/frameworkProcessSignals.test.ts` — 24
  tests covering:
  - Enumeration / lookup / display-name shape.
  - All 9 original Claude regression cases (cloudflared false-
    positive, MCP servers, demiclaude substring, etc.) preserved.
  - 7 Codex-equivalent cases (binary, path, @openai/codex node,
    codex-cli/cli, precodex substring, codex-mcp, vscode-codex).
  - 3 mutual-exclusion checks (Claude command must not match Codex
    framework and vice-versa; custom signal-scope restriction).
- Existing nurse + reaper tests: 200/200 pass after the orphaned
  Rule-2 test was rewritten to assert the post-Rule-2 fallback
  contract (no HTTP, heuristic-layer diagnosis). The rewrite is
  in the same commit because it was actively masking the suite's
  health and would have shown up as collateral noise during
  morning testing.
