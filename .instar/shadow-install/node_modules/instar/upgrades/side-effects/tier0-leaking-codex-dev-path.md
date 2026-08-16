# Side-effects review — Tier 0 release blocker: leaking dev path in openai-codex config

**Version / slug:** `tier0-leaking-codex-dev-path`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (the bug is a literal string default; the fix is a delegation to existing detection infrastructure with a regression-test gate)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md` (path-constraint-style discipline applied to Codex too)

## Summary of the change

A v1.0.0 audit caught a hardcoded developer-specific path baked into the Codex adapter default config:

```ts
codexPath: env['CODEX_PATH'] || '/Users/justin/.asdf/installs/nodejs/22.18.0/bin/codex',
```

This is a release blocker: any install that doesn't have asdf+nodejs-22.18.0+justin's username at that exact prefix would fail. Replaced with PATH-based detection delegating to a new framework-agnostic `detectFrameworkBinary(name)` helper in `src/core/Config.ts`.

While fixing the immediate bug, also generalized the binary detection (Tier 1.A from the audit plan) — `detectFrameworkBinary` accepts any framework name (`claude`, `codex`, `gemini`, `aider`, `goose`, `cursor-cli`, `opencode`, `plandex`) and searches: framework-specific install locations, system paths, npm-global bin, nvm-managed bin, then PATH lookup. Adds a `detectCodexPath()` convenience wrapper sibling to existing `detectClaudePath()`. Both wrappers delegate to the generic function.

Source-level regression test added: `tests/unit/detectFrameworkBinary.test.ts` scans config source files and fails if any literal `.asdf/installs/nodejs/<version>` path slug is hardcoded again.

Files touched:
- `src/core/Config.ts` — new `detectFrameworkBinary(name)` function; existing `detectClaudePath()` delegates to it; new `detectCodexPath()` sibling.
- `src/providers/adapters/openai-codex/config.ts` — `configFromEnv()` defaults switched from hardcoded path to `detectCodexPath() || 'codex'`; tmuxPath also routed through `detectTmuxPath()`.
- `tests/unit/detectFrameworkBinary.test.ts` — new, 6 cases including a source-level regression guard.

## Decision-point inventory

- **Binary path resolution** — `modify`. The decision point hasn't changed shape (input: framework name, output: path-or-null). The implementation now generalizes across frameworks rather than hardcoding per-framework.
- **Config-default fallback** — `modify`. When `CODEX_PATH` env var is unset, the fallback path is now dynamically detected rather than baked in.
- **Source-level regression test** — `add`. New deterministic guard ensures future PRs can't reintroduce the leak.

## Signal vs authority

Pure utility function. No authority surface.

## Over-block / under-block analysis

**Over-block:** None. The new `detectFrameworkBinary` covers every install location the prior `detectClaudePath` covered, plus framework-specific `~/.codex/bin/codex` etc. Strictly broader.

**Under-block:** On machines that have the binary installed in an unusual location (not in the candidate list AND not in PATH), detection returns null and the adapter's `codexPath` becomes the literal string `'codex'` — the spawn call would then fail with ENOENT at execution time. This is correct behavior: the failure surfaces at adapter-call time with a clear error rather than at module-load time with a silent default. Documented in the config doc-comment.

## Level-of-abstraction fit

- `detectFrameworkBinary` lives in `src/core/Config.ts` alongside the other detection helpers. Single source of truth.
- The adapter's `configFromEnv` is now a thin layer over the generic detection.
- Adding a new framework needs (a) a case branch for framework-specific install paths if it has one, (b) addition to the `FrameworkBinary` union type. No new code paths.

## Interactions

- **Existing `detectClaudePath()` callsites** — unchanged behavior. Function is now a one-line wrapper but the contract is identical.
- **`detectTmuxPath()`** — unchanged. Pre-existing tmux detection.
- **Tests** — passed before; pass after. No regressions.

## External surfaces

- New exports: `detectFrameworkBinary`, `detectCodexPath`, `FrameworkBinary` type.
- No new endpoint, no new CLI command, no new config field. The CODEX_PATH env var was already documented.

## Rollback cost

Trivial. `git revert` restores the hardcoded path — which would re-introduce the release blocker, so revert is itself an anti-action.

## Tests / verification

- `npx tsc --noEmit` clean.
- `vitest tests/unit/detectFrameworkBinary.test.ts tests/unit/Config.test.ts tests/unit/ConfigDefaults.test.ts` — 27/27 pass.
- Source-level regression guard added — covers all four config files (core Config + three provider adapter configs).
- Tested locally that `detectCodexPath()` returns the correct path on this machine via PATH lookup.
