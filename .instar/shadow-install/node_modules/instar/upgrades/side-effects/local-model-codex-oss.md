# Side-effects review — Phase 6 local-model adapter via Codex CLI `--oss`

**Version / slug:** `local-model-codex-oss`
**Date:** `2026-05-18`
**Author:** Echo
**Second-pass reviewer:** self-review — empirically verified end-to-end with `codex exec --oss --local-provider ollama --model llama3.2:latest --json`; 35/35 launch-builder tests green.
**Driving spec:** `specs/provider-portability/08-model-fitness-catalog.md` (Phase 6 local-adapter scope); `specs/provider-portability/12-openai-path-constraints.md` (BASE_URL/local-provider compatibility carve-out).

## Summary of the change

Ships Phase 6 of provider-portability as a **passthrough**, not a new adapter. The Codex CLI's built-in `--oss --local-provider <p>` flags route to a locally-running Ollama or LM Studio backend. Empirically verified working: `codex exec --oss --local-provider ollama --model llama3.2:latest --json` produces the same `thread.started` → `turn.started` → `item.completed` → `turn.completed` event sequence that `agenticSessionHeadless` already normalizes. No event-normalizer change needed.

1. **`src/core/frameworkSessionLaunch.ts`** — `HeadlessLaunchOptions` and `InteractiveLaunchOptions` gain a `codexLocalProvider?: 'ollama' | 'lmstudio'` field. Both Codex builders detect it and emit `--oss --local-provider <p>` plus pass the model field verbatim (skipping the OpenAI tier resolver, since local models like `llama3.2:latest` don't share OpenAI's vocabulary).

2. **`src/core/SessionManager.ts`** — `spawnSession` and `spawnInteractiveSession` accept a `codexLocalProvider` option and forward it to the builders. Operators / per-topic routing can opt in without code changes elsewhere.

3. **`specs/provider-portability/08-model-fitness-catalog.md`** — new section "Local-model adapter via Codex CLI (Phase 6 path)" documents the verified backend, fitness ratings for `llama3.2:latest`, caveats (no cost-aware routing for local, Spec 12 Rule 1 still applies, sandbox modes work identically).

4. **`docs/local-model-recipe.md`** (new) — operator-facing setup guide. Prerequisites, per-topic config example, troubleshooting, common pitfalls, architectural note explaining the passthrough trade-off.

5. **`tests/unit/frameworkSessionLaunch.test.ts`** — 5 new tests covering the local-provider branch: `--oss` + `--local-provider` emitted; default model `llama3.2:latest` when omitted; `lmstudio` provider accepted; interactive launch also supports it; `claude-code` framework correctly ignores the codex-only flag.

## Decision-point inventory

- **Passthrough not adapter** — `add`. Codex CLI already speaks Ollama/LM Studio's API; building a separate Instar adapter would duplicate that translation logic without adding capability. Trade-off: limited to providers Codex supports; other backends need a dedicated adapter.
- **Per-topic config keys `topicCodexLocalProvider` / `topicCodexLocalModel`** — `add` (documented in recipe; runtime wiring deferred to a follow-up since config plumbing is mostly mechanical and not security-relevant).
- **Default model `llama3.2:latest`** — `add`. Smallest model that produces useful output; matches the recipe's "smallest path that works" advice.
- **Skip OpenAI tier resolver when local-provider set** — `change`. Tier names (`fast`/`balanced`/`capable`) only make sense for hosted models; local models use their own naming.

## Signal vs authority

- `codexLocalProvider` is a launch-options field — pure signal flowing into the builders.
- The builders are pure functions — no authority.
- Routing authority (which topic uses local vs hosted) is the operator's via config; future work could add `LocalProviderRoutingPolicy` for autonomous selection.

## Over-block / under-block analysis

**Over-block:** None. The change is additive — existing callers don't pass `codexLocalProvider` and get the hosted path unchanged.

**Under-block:** Spec 12 Rule 1 still fires when `OPENAI_API_KEY` is in env, even though local-provider mode never uses it. That's correct: the env var is a security signal regardless of which path consumes it. The recipe doc explicitly tells operators to `unset OPENAI_API_KEY` for a clean local-only profile.

## Level-of-abstraction fit

- `codexLocalProvider` lives on `HeadlessLaunchOptions` / `InteractiveLaunchOptions` next to `codexSandboxMode` and `defaultModel` — same level (per-launch overrides).
- The fitness-catalog section lives next to the other model entries with the same "what / when / when not / caveats" shape.
- The recipe doc lives in `docs/` not `specs/` — it's user-facing operations, not design.

## Interactions

- **Spec 12 Rule 1 enforcement** — preserved. The credential validator still inspects env + auth.json regardless of `--oss` mode; users who don't want the warning can `unset OPENAI_API_KEY`.
- **Spec 12 Rule 1a env-scrub** — preserved. The env-allowlist still strips `OPENAI_API_KEY` from child env. `--oss` mode doesn't need the key anyway; this just keeps the scrubbing universal.
- **`CostAwareRoutingPolicy`** — orthogonal. Local-provider sessions sidestep the policy (no credit pot involved). Future Phase 5d work could integrate.
- **`agenticSessionHeadless` event normalizer** — works as-is. The event stream from `codex exec --oss` is identical in shape to the hosted path.

## Rollback cost

Pure additive code. To roll back, remove the `codexLocalProvider` field from the launch options and the conditional branches in the two builders + the SessionManager passthrough. Existing tests would still pass; only the 5 new tests cover the removed surface.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/unit/frameworkSessionLaunch.test.ts` — 35/35 green (includes 5 new Phase 6 cases).
- Live smoke: `codex exec --oss --local-provider ollama --model llama3.2:latest --json --skip-git-repo-check -s read-only "Reply ONLY with: PONG"` returned `{"item":{"text":"PONG"}}` in ~3s. Verified at 2026-05-18T03:35Z on Echo's dev machine.
