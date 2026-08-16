# Side-effects review — Tier 1.A spawnInteractiveSession framework dispatch + per-topic override

**Version / slug:** `tier-1a-spawn-interactive-framework-dispatch`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (extracted hardcoded Claude args into a per-framework builder; existing Claude shape preserved byte-for-byte; new Codex path opt-in via topic config)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md`

## Summary of the change

Before this change, `SessionManager.spawnInteractiveSession` hardcoded the Claude CLI's argv inline:

```
tmuxArgs.push(this.config.claudePath, '--dangerously-skip-permissions');
if (options?.resumeSessionId) tmuxArgs.push('--resume', options.resumeSessionId);
```

That made every Telegram-driven session spawn a Claude session — even on a Codex-configured agent. Combined with the wrong CLI flags (`--dangerously-skip-permissions` is Claude-specific; Codex uses `--sandbox danger-full-access`), Codex installs couldn't spawn any session via the Telegram path. This was the foundational gap blocking Justin's "swap between modes in normal Telegram topics" workflow.

Fix (three parts):

1. **New `frameworkSessionLaunch.ts` module**: per-framework builders return `{ argv, envOverrides }` for an interactive launch. Claude builder preserves the v0.x shape exactly; Codex builder uses `--sandbox danger-full-access` (the agentic-equivalent permission grant) with optional `--resume <id>`.

2. **`spawnInteractiveSession` dispatch**: new optional `framework` parameter in the options bag. The function resolves a binary path from `SessionManagerConfig.frameworkBinaryPaths` (a new map populated from detection at `loadConfig` time), then calls the framework's builder, then merges env overrides into the tmux `-e` flags. Defaults to `claude-code` so unset callers behave identically to v0.x.

3. **Per-topic config override**: new `topicFrameworks?: Record<string, 'claude-code' | 'codex-cli'>` on `InstarConfig`. Maps a Telegram topic ID to the framework that should run sessions for that topic. `spawnSessionForTopic` and `respawnSessionForTopic` consult the map via `resolveTopicFramework(topicId)` (module-level helper in server.ts) and thread the resolved framework into `spawnInteractiveSession`. Lets Justin flip topic 9999 to Codex without changing the agent's overall framework.

Files touched:
- `src/core/frameworkSessionLaunch.ts` — new, ~125 LOC.
- `src/core/SessionManager.ts` — `spawnInteractiveSession` argv/env block now uses the builder. `framework` accepted in options.
- `src/core/types.ts` — `SessionManagerConfig.frameworkBinaryPaths` field added; `InstarConfig.topicFrameworks` field added.
- `src/core/Config.ts` — populates `frameworkBinaryPaths` from detection at load time.
- `src/commands/server.ts` — `_topicFrameworks` / `_defaultFramework` module state + `resolveTopicFramework()` helper; `spawnSessionForTopic` threads framework into `spawnInteractiveSession`.
- `tests/unit/frameworkSessionLaunch.test.ts` — new, 12 tests.

## Decision-point inventory

- **Per-framework builder vs inline if/else** — `add` (builder). One TypeScript `Record<IntelligenceFramework, Builder>` keeps additions one-line (Gemini, Aider, etc.); inline ifs would spread Codex flags across every spawn call site.
- **`framework` as spawnInteractiveSession option vs new method** — `add` (option). Adding a parameter keeps the diff small; new method would force every existing caller to either choose or migrate. Default of `'claude-code'` preserves v0.x exactly for callers that omit.
- **Per-topic map vs per-session config** — `add` (per-topic). The use case is "topic 9984 runs Claude subscription, topic 9985 runs Codex" — a stable mapping that survives session deaths and respawns. Per-session config would re-prompt every spawn.
- **Codex sandbox default `danger-full-access`** — `add`. Justin wants agentic Codex behavior (file edits, shell execution); Claude's `--dangerously-skip-permissions` is the precedent. Operators wanting tighter sandboxes can override via `codexSandboxMode` if/when we add that to the config.
- **Don't touch `spawnSession` (headless prompt) or the other interactive variant in this slice** — `defer`. Those paths are job-driven, not Telegram-driven; Justin's test goal is the topic flow. The same builder pattern can be applied incrementally without risking the Telegram path.
- **Don't add Agent SDK path in this slice** — `defer`. The Agent SDK is a programmatic SDK invocation, not a tmux'd CLI — it needs a different spawn pattern (Node process running an SDK driver) and a new env-credential flow ($200/mo Max 20x billing bucket per the June 2026 credit notice). Tracked as a follow-up.

## Signal vs authority

The launch builder is recognition data — given a framework + binary path, what CLI shape does it expect? It carries no authority over which framework spawns; that decision lives upstream in the per-topic config and the env-var default. Clean separation: config decides which framework, builder produces the right launch shape.

## Over-block / under-block analysis

**Over-block:** None. Claude builder is byte-equivalent to the v0.x inline code (`--dangerously-skip-permissions` plus optional `--resume <id>`). Existing Claude installs that don't set `topicFrameworks` behave identically.

**Under-block:** A user could set `topicFrameworks: { "9984": "codex-cli" }` without Codex installed; the binary-path lookup would fail and an explicit error message names the framework (`No binary path available for framework "codex-cli"`). No silent fallback to Claude, which is the right call — silent fallback would mislead the user.

## Level-of-abstraction fit

- `frameworkSessionLaunch.ts` lives next to other framework abstractions (`intelligenceProviderFactory.ts`).
- `SessionManagerConfig.frameworkBinaryPaths` is the right home for per-framework binary lookups — SessionManager already owns binary path resolution.
- `InstarConfig.topicFrameworks` is at the config root because per-topic override is a user-facing config feature, not an internal session-manager concern.
- Exhaustiveness on `Record<IntelligenceFramework, Builder>` forces every new framework to register a builder.

## Interactions

- `SessionManager.spawnSession` (headless one-shot) — NOT touched in this slice. Still Claude-only.
- `SessionManager.spawnInteractiveSession` (the Telegram path) — receives optional `framework`. Existing callers without the field get Claude (default).
- `spawnSessionForTopic` / `respawnSessionForTopic` (server.ts) — both threaded through `resolveTopicFramework(topicId)`.
- WhatsApp / iMessage / Slack auto-spawn paths — still use the legacy spawnInteractiveSession shape (no framework arg), so they default to Claude. Justin's stated scope is Telegram; non-Telegram channels can be migrated incrementally without urgency.
- All sentinels (Watchdog, OrphanReaper, StallTriageNurse) already framework-aware via Tiers 2.B/2.C/2.E.

## External surfaces

- New optional config field: `topicFrameworks` at the InstarConfig root. Schema:
  ```json
  {
    "topicFrameworks": {
      "9984": "claude-code",
      "9985": "codex-cli"
    }
  }
  ```
- No new endpoints / env vars.
- Boot-log behavior unchanged.

## Rollback cost

Trivial. The change is additive: omitting `framework` from spawnInteractiveSession options preserves Claude behavior exactly.

## Tests / verification

- `npx tsc --noEmit` clean.
- New tests: `tests/unit/frameworkSessionLaunch.test.ts` — 12 cases covering:
  - Claude argv shape regression (`--dangerously-skip-permissions` byte-for-byte).
  - Claude `--resume <id>` append.
  - Codex argv shape (`--sandbox danger-full-access` default).
  - Codex `codexSandboxMode` override.
  - Codex `--resume <id>` append.
  - `CLAUDECODE=` env-clear present for both frameworks.
  - `resolveInteractiveFramework` precedence: per-call > config > env > default.
- Existing 181 tests across touched-area suites all still pass (config-framework-routing, intelligenceProviderFactory, StallTriageNurse, OrphanProcessReaper, watchdog, sentinel-signal suites).
- Server-boot smoke verification:
  - With `topicFrameworks: { "9999": "codex-cli", "1111": "claude-code" }` in config, the server boots cleanly. `Intelligence: Claude CLI subscription` reflects the agent-level default; per-topic framework is consulted only when a session is actually spawned for those topic IDs.
- No real Codex tmux spawn smoke test in this commit: needs an actual Telegram topic round-trip to verify, which depends on Justin's morning testing. The pre-test invariants (clean boot, type checks, builder regression coverage) are the strongest signal we can produce without his Telegram fixture.
