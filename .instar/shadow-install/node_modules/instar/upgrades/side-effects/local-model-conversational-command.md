# Side-effects review — Conversational /local-model command

**Version / slug:** `local-model-conversational-command`
**Date:** `2026-05-18`
**Author:** Echo
**Second-pass reviewer:** self-review — net new conversational surface, no behavior change to topics that don't invoke it.
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md` (Codex local-model passthrough scope).

## Summary

Justin's rule: every config change must be reachable conversationally via Telegram. Local-model selection (Codex --oss --local-provider) was config-only — operator had to edit `.instar/config.json` and restart. This change adds `/local-model <provider> [model]` as a first-class Telegram command, mirroring the existing `/route` command.

End-to-end:
- `/local-model` → status (current binding + how to switch)
- `/local-model ollama llama3.2:latest` → switches the topic, validates the provider is reachable + the model is pulled, persists via TopicLocalModelStore, respawns the session
- `/local-model lmstudio mistral-7b` → same but for LM Studio
- `/local-model off` → revert to cloud Codex
- Requires the topic to be on codex-cli first (local-model goes through Codex --oss); surfaces a "/route codex-cli first" hint when not

## New files

- `src/core/TopicLocalModelStore.ts` — sibling of TopicFrameworksStore. Per-topic local-model binding with override + config-default layers, atomic persistence, defensive load.
- `src/providers/adapters/openai-codex/transport/checkLocalProvider.ts` — pre-flight reachability + model-existence check (Ollama /api/version + /api/tags; LM Studio /v1/models). Surfaces actionable errors before the user wonders why the session won't spawn.
- `tests/unit/TopicLocalModelStore.test.ts` — 10 tests covering get/set/clear/snapshot/load-validation/corrupt-file resilience.

## Modified files

- `src/messaging/TelegramAdapter.ts` — adds `onLocalModelCommand` callback declaration + the `/local-model` parser. Pattern is identical to `/route`: parse args, dispatch to handler, echo result message to topic.
- `src/commands/server.ts` — wires `_topicLocalModelStore` at boot (seeded from `topicCodexLocalProvider` + `topicCodexLocalModel` config maps), wires `telegram.onLocalModelCommand`, and threads the per-topic binding through `spawnSessionForTopic` → `spawnInteractiveSession`. Per-call `defaultModel` override now wins over config defaults so /local-model can target a specific model id.
- `src/core/SessionManager.ts` — adds `defaultModel?: string` to `spawnInteractiveSession` options. Mirrors the existing `codexLocalProvider` option; both flow to `buildInteractiveLaunch`.

## Decision-point inventory

- **Separate store from TopicFrameworksStore** — `add`. Reason: framework (claude vs codex) and provider (cloud-codex vs local-ollama) are independent dimensions. A single store couldn't express "Codex with cloud" vs "Codex with local".
- **Reachability pre-flight before flip** — `add`. Without it, a user typing `/local-model ollama` when Ollama isn't running gets a session that fails to spawn 90 seconds later. The pre-flight gives an actionable error in 3 seconds.
- **Require codex-cli framework first** — `change`. Local-model only routes through Codex --oss; flipping it on a claude-code topic would be silently inert. The command surfaces the requirement explicitly.

## Signal vs authority

- TopicLocalModelStore is authority for runtime local-model binding (it gates whether the spawn argv gets `--oss --local-provider`).
- checkLocalProviderReachable is signal: a "yes it's reachable" doesn't guarantee the spawn succeeds (Codex could still fail for other reasons), but a "no" is a definitive blocker that prevents wasted respawn cycles.
- /local-model is the conversational authority surface; the underlying mechanism stays the same (TopicLocalModelStore + frameworkSessionLaunch passthrough).

## Over-block / under-block analysis

**Over-block:** Pre-flight returns false if Ollama isn't running. That's correct — the spawn would fail anyway. The error message points the user at `ollama serve` so it's recoverable.

**Under-block:** Pre-flight skips model-list check on transient failures (the /api/tags request times out). The spawn will still attempt and fail loudly if the model genuinely isn't there. Acceptable: don't block the user on partial network flakiness.

## Interactions

- Coexists with `/route` — the two commands are orthogonal. A topic can be on (claude-code, no-local), (codex-cli, no-local = cloud), or (codex-cli, local). The (claude-code, local) state is rejected at the command level.
- Coexists with PostUpdateMigrator's `migrateProviderPortability` — that migration records the v1.0.0 marker; it doesn't touch TopicLocalModelStore. No conflict.
- The state file `.instar/state/topic-local-models.json` is a sibling of `topic-frameworks.json`. Both atomic-writes, both backed up by the standard agent backup.

## Rollback cost

- Revert is one commit. The state file persists (no schema migration); subsequent reverts leave it untouched but ignored.
- Operators using the old config-driven path keep working — `topicCodexLocalProvider` / `topicCodexLocalModel` in config.json still seed the store as defaults.

## Verification

- `npx tsc --noEmit` clean.
- `npm run lint` clean (Rule 1 drift gate green).
- 10 new unit tests for TopicLocalModelStore (10/10 pass).
- End-to-end on deep-signal (running v1.0.0 + this change):
  - `/local-model` → status returned correctly.
  - `/local-model ollama llama3.2:latest` → flip persisted, session respawned, Codex banner shows `model: llama3.2:latest`.
  - Test probe to topic — local Codex session received the message (output captured in pane), demonstrating the --oss passthrough is live.
  - `/local-model off` → revert persisted, session respawned, Codex banner shows `model: gpt-5.3-codex`.

## What this doesn't fix

Llama 3.2 (3B) doesn't reliably emit tool calls (telegram-reply.sh invocations) — small local models often can't follow the relay convention. This is a model-capability limit, not an Instar bug. Documented in `docs/local-model-recipe.md`. Operators using local models for chat should expect responses to land in the terminal pane rather than back through Telegram unless they switch to a larger local model (e.g., qwen2.5-coder:7b).
