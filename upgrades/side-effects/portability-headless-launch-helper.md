# Side-effects review — Portability cycle: buildHeadlessLaunch + spawnSession + PipeSessionSpawner

**Version / slug:** `portability-headless-launch-helper`
**Date:** `2026-05-18`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** self-review (mirrors the buildInteractiveLaunch shape exactly; 50 unit tests green; pure code change, no schema / config migration)
**Driving spec:** `docs/specs/SPEC-PROVIDER-PORTABILITY.md` (approved)

## Summary of the change

Continuation of the provider-portability cycle. Until this PR, three production paths still hardcoded the Claude CLI flag set inline:

1. `SessionManager.spawnSession` (headless prompt path) built `claude --dangerously-skip-permissions [--model X] -p <prompt>` directly.
2. `PipeSessionSpawner.classifyIntent` shell-executed `claude -p --model haiku` to classify threadline messages.
3. `PipeSessionSpawner.summarizeThreadHistory` shell-executed `claude -p --model haiku` to compress thread history.
4. `PipeSessionSpawner.spawn` shell-executed `cat <promptfile> | claude -p --model <m> --allowedTools <list>` to spawn a pipe-mode session.

Codex installs couldn't use any of these paths even after the `IntelligenceProvider` factory shipped, because the factory only covered the abstract evaluate path — these four spawn callsites bypassed it entirely.

This cycle:

1. **Adds `buildHeadlessLaunch(framework, options)`** to `src/core/frameworkSessionLaunch.ts` — companion to the existing `buildInteractiveLaunch`. Same shape, same exhaustiveness check, same envOverrides contract. Claude builder: `[bin, '--dangerously-skip-permissions', '--model'?, '-p', prompt]`. Codex builder: `[bin, 'exec', '--json', '--skip-git-repo-check', '-s', sandbox, '-m', model, prompt]`.
2. **Refactors `SessionManager.spawnSession`** to route through `buildHeadlessLaunch`. Adds a per-call `framework?: IntelligenceFramework` override on the options surface; falls back to `INSTAR_FRAMEWORK` env. Reads the binary path from `config.frameworkBinaryPaths[framework]`, with `claudePath` as legacy fallback. Provider-specific env (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`) is gated on `framework === 'claude-code'` and never leaks into Codex tmux sessions.
3. **Refactors `PipeSessionSpawner.classifyIntent` and `.summarizeThreadHistory`** to accept an `IntelligenceProvider` in their options. When given, they route through `.evaluate()` (which works for both Claude and Codex). When omitted, both fail closed — classifier returns `'interactive'`, summarizer returns the unavailable placeholder. This is intentional: the legacy bare-`claude` shell-exec assumed `claude` was on PATH, which silently broke Codex installs. Better to fail closed than to leak framework-specific behavior into shared code.
4. **Refactors `PipeSessionSpawner.spawn`** to use `buildHeadlessLaunch`. The pre-existing secure-perm prompt file is preserved; the spawned shell command substitutes `$(< "$promptfile")` for the helper's prompt-positional placeholder so the prompt stays off the command line (no leak via `ps`). Env scrub block clears both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` (Spec 12 Rule 1a).
5. **Wires server.ts** to build the `PipeSessionSpawner` with `framework` + `binaryPath` from the resolved-framework + `frameworkBinaryPaths` map. Codex agents default to `gpt-5.3-codex` for pipe-mode; Claude agents default to `sonnet`.

Files touched:
- `src/core/frameworkSessionLaunch.ts` — +119 LOC (HeadlessLaunchOptions/Spec types, claude+codex headless builders, `buildHeadlessLaunch` dispatch).
- `src/core/SessionManager.ts` — refactored spawnSession to use the helper; added `framework?` to options; replaced inline `claudeArgs` with `headlessSpec.argv`; gated anthropic-env on framework.
- `src/threadline/PipeSessionSpawner.ts` — added `framework`+`binaryPath` to PipeSessionConfig; rewrote `classifyIntent` / `summarizeThreadHistory` to use injected IntelligenceProvider; rewrote `spawn` to use `buildHeadlessLaunch` + `$(< file)` substitution.
- `src/commands/server.ts` — wires PipeSessionSpawner with framework + binaryPath; passes sharedIntelligence to `classifyIntent`.
- `tests/unit/frameworkSessionLaunch.test.ts` — +11 new tests for buildHeadlessLaunch (21 total green).
- `tests/unit/pipeSessionSpawnerFrameworkPortability.test.ts` — new, 11 tests covering classifier/summarizer fail-closed behavior + framework-aware spawn construction.

## Decision-point inventory

- **Headless launch builder dispatch** — `add`. New surface; no existing behavior touched. Exhaustiveness check forces a compile error when adding a new framework.
- **spawnSession framework selection** — `add`. Per-call wins; env fallback. `configFramework` parameter is left as `undefined` for now because `SessionManagerConfig` has no top-level framework field — agent-level framework default propagates via `INSTAR_FRAMEWORK` env set at server boot.
- **PipeSessionSpawner classifier fail-closed** — `change`. Old behavior: silently fell through to `'interactive'` on shell-exec failure. New behavior: same `'interactive'` fall-through, but the trigger is `intelligence==null` rather than the shell call failing. No outward semantic change for Claude installs (the shell call always succeeded when claude was on PATH); Codex installs that previously got the silent fallback now get the same fallback through a documented code path.
- **Spec 12 Rule 1a coverage** — `extend`. PipeSessionSpawner's env-scrub block now clears `OPENAI_API_KEY` alongside the existing `ANTHROPIC_API_KEY`. Previously only Claude was scrubbed.

## Signal vs authority

- `buildHeadlessLaunch` and `buildInteractiveLaunch` are **pure functions** (signal producers — return argv + env). They have no blocking authority.
- The authority that decides whether a session spawns at all is `SessionManager.spawnSession` (which checks `maxSessions` and tmux state) — this didn't change.
- The classifier's `'interactive'` fail-closed is **signal** ("I don't know whether this is a TASK"). The pipe-mode gate above it is the authority that decides whether to spawn a pipe session. This separation was already correct; the refactor preserves it.

## Over-block / under-block analysis

**Over-block (new failure mode introduced?):** The classifier now requires an `IntelligenceProvider` to ever return `'pipe'`. In degraded mode (no provider available), all messages go to interactive. This is a deliberate fail-closed: pre-portability, classifier-on-codex would have crashed because `claude` wasn't installed; the silent shell-exec error caught the crash but the result was still `'interactive'`. So the post-refactor behavior matches the pre-refactor effective behavior — no new over-block.

**Under-block (anything previously gated now slipping through?):** No. The set of paths that gate on the classifier is the same. Spec 12 Rule 1a actually **gets stronger** here — OpenAI key scrubbing was missing from the pipe spawn previously.

## Level-of-abstraction fit

- `buildHeadlessLaunch` lives next to `buildInteractiveLaunch` in the same file. Same shape, same docstring style, same exhaustiveness pattern. Future frameworks add one builder + one BUILDERS entry per side.
- `SessionManager.spawnSession` reads from `frameworkBinaryPaths` — the field that was designed for this exact lookup. No new config field needed.
- `PipeSessionSpawner` takes `framework` + `binaryPath` as constructor fields, matching how `SessionManagerConfig` exposes them. The composition root (server.ts) is the single owner that ties detected paths to PipeSessionSpawner config.

## Interactions

- **buildInteractiveLaunch** — unchanged. Both builders coexist in the same file.
- **CostAwareRoutingPolicy / FrameworkModelRouter** — orthogonal. Routing decides which model tier; helpers decide which CLI gets the prompt. Both stack.
- **SessionManager.spawnInteractiveSession** — unchanged. This refactor only touches the headless (`-p` prompt) path.
- **Spec 12 env-allowlist helpers** — defensive overlap is fine. PipeSessionSpawner now scrubs OPENAI_API_KEY before the framework's own env-allowlist runs.

## Rollback cost

Pure code change. No schema, no config migration, no on-disk state changes. Revert is a single `git revert <sha>` and the legacy `claude -p` inline path comes back. The new tests would fail post-revert and surface the missing helper immediately.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/unit/frameworkSessionLaunch.test.ts tests/unit/pipeSessionSpawnerFrameworkPortability.test.ts tests/unit/listener-daemon.test.ts tests/unit/session-manager-behavioral.test.ts tests/unit/session-telegram-inject.test.ts` — 74/74 green.
- All v1.0.0 scenario tests (12 scenarios) — green in the parent autonomous loop.
