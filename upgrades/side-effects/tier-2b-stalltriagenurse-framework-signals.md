# Side-effects review — Tier 2.B StallTriageNurse per-framework activity signals

**Version / slug:** `tier-2b-stalltriagenurse-framework-signals`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (additive abstraction with claude-code as the structural default; existing behavior preserved when framework is unset)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md` (general v1.0.0 portability mandate; sentinel generalization audited overnight)

## Summary of the change

`StallTriageNurse.heuristicDiagnose` previously hardcoded Claude Code's
tool-name regex and Braille spinner glyphs:

```
const claudeActivityPattern = /claude|Read\(|Write\(|Edit\(|Bash\(|Grep\(|Glob\(|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/;
```

This left Codex sessions invisible to the nurse — the shell-prompt restart heuristic would have fired incorrectly on a healthy Codex pane (no Claude tokens present → "framework wrapper has exited"), and the LLM system prompt referenced "Claude Code sessions running in tmux" exclusively, biasing diagnoses for any non-Claude framework.

This change introduces `src/monitoring/frameworkActivitySignals.ts` — a per-framework lookup of `{ toolCallOrSpinner, escapeToInterrupt, runningIndicator, promptSignaturesLine, displayName }`. The nurse reads the active framework from `config.framework` (defaulting to `claude-code` for backwards-compat) and resolves the right signal at diagnose time.

`buildSystemPrompt(signal)` replaces the static `SYSTEM_PROMPT` constant; the bullet describing status-update signatures and the bullet describing shell-prompt-on-exit are both parameterized by the active framework's display name and signature line.

Files touched:
- `src/monitoring/frameworkActivitySignals.ts` — new, ~110 LOC.
- `src/monitoring/StallTriageNurse.types.ts` — added optional `framework: IntelligenceFramework` to `StallTriageConfig`.
- `src/monitoring/StallTriageNurse.ts` — replaced 3 hardcoded patterns + the static SYSTEM_PROMPT; +1 import; +1 default-config entry.
- `src/commands/server.ts` — hoisted `resolvedFramework` to outer scope and threaded it into the nurse's config (1 new var, 1 modified construction site).
- `tests/unit/frameworkActivitySignals.test.ts` — new, 16 tests.
- `tests/unit/StallTriageNurse.test.ts` — added 6 framework-aware heuristic tests.

## Decision-point inventory

- **Adapter capability vs new module** — `add` (new module). Activity-signal data is recognition-pattern data, not a control/observability surface. The existing provider-primitives layer (`src/providers/primitives/*`) abstracts spawn/interrupt/capture-pane — those are framework adapters' control plane. Activity recognition is a sentinel concern; it lives in `src/monitoring/`. Keeping it here avoids inflating the primitives surface for one consumer.
- **Where to source the framework value** — `add`. The nurse already takes a `StallTriageConfig`; threading a new optional field there is the lightest-touch extension and parallels how `model` is configured. Alternative (reading `INSTAR_FRAMEWORK` env directly inside the nurse) would have made the nurse non-deterministic in tests.
- **Default behavior when framework is unset** — `add` (default to `claude-code`). Preserves v0.x boot exactly. Anything else would silently change diagnoses for every existing agent on this release.
- **Codex pattern specificity** — `defer` (best-effort). I don't have empirical Codex tmux captures to validate against; the regex covers known Codex display tokens (`exec(`, `shell(`, `patch(`, `apply_patch(`) and generic verbs (`generating`, `working`). The Braille spinner is shared with Claude (terminal escape sequences are common). A `TODO: refine empirically` is implied by the module's doc-comment but not blocking — wrong diagnoses are recoverable (the LLM-backed second layer can still classify correctly).
- **System-prompt parameterization** — `add`. The previous static prompt explicitly named "Claude Code"; leaving that hardcoded would bias the LLM's diagnosis for Codex sessions. Function-builder avoids stringly-typed prompt assembly at every diagnose call (one allocation per `triage()` invocation, not per token).

## Signal vs authority

The activity signal carries deterministic-pattern *signals* — what does a healthy framework's tmux pane look like? It has NO blocking authority over the nurse's decisions. The nurse's `heuristicDiagnose` is a fast pre-filter; the LLM (or process-tree fallback) remains the authority for ambiguous cases. The signal's role is to keep the pre-filter from misfiring on the wrong framework's signatures.

This is the correct level of separation per [[feedback_signal_vs_authority]]: brittle/low-context pattern data is the signal, high-context intelligence is the authority.

## Over-block / under-block analysis

**Over-block:** None. The new code only widens what the heuristic recognizes (it now matches Codex tokens that it would have ignored before, and conversely doesn't false-fire the shell-prompt restart on a healthy Codex pane). Failing-open behavior is preserved — when no heuristic pattern matches, the path falls through to LLM diagnosis exactly as before.

**Under-block:** A Codex-only operator could see the nurse miss a stall signature that's specific to Codex but not covered by my best-effort regex (e.g., a Codex-specific error format I haven't seen). Worst case: the fast heuristic doesn't fire, but the LLM-backed layer still runs and produces a diagnosis. No new failure modes introduced.

## Level-of-abstraction fit

- Lives in `src/monitoring/` alongside the consumer (`StallTriageNurse.ts`).
- Imports `IntelligenceFramework` from `src/core/intelligenceProviderFactory.js` — a stable single source of truth for the framework enum.
- Does NOT live in `src/providers/primitives/` — that layer is for *control* primitives (spawn, interrupt, kill, capture). Activity-recognition patterns are a different concern.
- Exhaustiveness via `Record<IntelligenceFramework, FrameworkActivitySignal>` — adding a new framework to the enum is a compile error until the signal is added.

## Interactions

- **`StallTriageNurse` (existing)** — modified call sites: `heuristicDiagnose` (3 pattern lookups), `buildDiagnosisPrompt` (system-prompt assembly). Behavior preserved for `framework === 'claude-code'`.
- **`server.ts` boot** — new `resolvedFramework` variable hoisted to outer scope so the nurse's config can reference it. Single new line in the try-block.
- **TriageOrchestrator** — NOT modified. It's a separate next-gen recovery class; its activity patterns are tracked separately and will be migrated in a follow-up if/when it adopts framework-aware heuristics.
- **No new external surfaces** (no new endpoints, no new env vars, no new config field on disk — the new field is internal to `StallTriageConfig`).

## External surfaces

- No new endpoints.
- No new environment variables.
- No new on-disk config keys (the new field is composed in-memory in `server.ts` from `resolvedFramework`, which is already derived from `INSTAR_FRAMEWORK`).
- Side-effect on `framework-model-preferences.db`: none.

## Rollback cost

Trivial. `git revert` restores the pre-Tier-2.B nurse. No state-shape changes, no migration, no new persisted data.

## Tests / verification

- `npx tsc --noEmit` clean.
- New unit tests:
  - `tests/unit/frameworkActivitySignals.test.ts` — 16 tests covering signal lookup, default-on-unknown, both signal shapes, listActivitySignals enumeration.
  - `tests/unit/StallTriageNurse.test.ts` (framework-aware block) — 6 tests verifying the nurse honors `config.framework` in heuristicDiagnose: shell-prompt + Claude/Codex tool tokens, interrupt-hint matching, default-framework path.
- Existing nurse suite: 60/61 still pass (the one failure — `falls back to direct API when no IntelligenceProvider` — was orphaned by Rule 2's direct-API removal; tracked separately as task #43, not caused by this change; verified pre-existing via `git stash` parity run).
- `tests/unit/StallTriageNurse-enhancements.test.ts` — 90/90 pass.
