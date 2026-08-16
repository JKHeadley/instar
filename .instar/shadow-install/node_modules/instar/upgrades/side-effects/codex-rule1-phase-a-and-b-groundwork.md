# Side-effects review — Codex Rule 1 Phase A + structural Phase B groundwork

**Version / slug:** `codex-rule1-phase-a-and-b-groundwork`
**Date:** `2026-05-18`
**Author:** Echo
**Second-pass reviewer:** self-review — 23 new unit tests green; typecheck clean; drift gate active and passing.
**Driving spec:** `specs/provider-portability/12-openai-path-constraints.md` (approved 2026-05-17)

## Summary of the change

Lands spec 12 Rule 1 enforcement for the openai-codex adapter. Phase A behavior is the **default** for v1.0.0 (warning + telemetry, no behavior change for existing installs); Phase B behavior is **opt-in via env** (`INSTAR_RULE1_ENFORCE=hard`) so deployments can elect to refuse early.

1. **`src/providers/adapters/openai-codex/config.ts`** — rewritten:
   - Stale "Agent SDK credit pot analog" comment block replaced with a reference to spec 12 Rule 1 (correct framing: API-key auth is FORBIDDEN, not "acceptable").
   - `configFromEnv` no longer reads `OPENAI_API_KEY` into config. The `apiKey: env['OPENAI_API_KEY']` line is gone.
   - `OpenAiCodexConfig.apiKey` field is now annotated `@deprecated` + `@internal` so external callers see TypeScript/IDE warnings while their code keeps compiling (Phase A back-compat).

2. **`src/providers/adapters/openai-codex/credentials.ts`** (new) — Rule 1 validator. Detects API-key auth via env var OR `~/.codex/auth.json` shape. Returns structured error codes:
   - `CODEX_AUTH_APIKEY_DETECTED` (security_violation class)
   - `CODEX_KILLSWITCH_EXPIRED` (security_violation; escape hatch past sunset)
   - plus FILE_MISSING / FILE_UNREADABLE / FILE_MALFORMED / OAUTH_REFRESH_FAILED / UNKNOWN_FAILURE codes per spec 12.
   
   Enforcement modes:
   - `warn` (default for v1.0.0 Phase A) — emit structured warning to stderr, write telemetry to `.instar/security.jsonl`, do not refuse.
   - `hard` (opt-in via `INSTAR_RULE1_ENFORCE=hard`) — adapter init throws `AuthError`.
   - `disabled` (escape hatch via `INSTAR_DISABLE_RULE1_OPENAI=1`) — suppresses warning entirely until sunset.
   
   Hard sunset constant `RULE1_KILLSWITCH_SUNSET_DATE = '2026-12-01'`. After that date the escape hatch is ignored.

3. **`src/providers/adapters/openai-codex/index.ts`** — wires `checkAndWarn` into `createOpenAiCodexAdapter`. Runs at adapter construction; in `hard` mode throws `AuthError`; in `warn` mode logs + appends telemetry and returns. Telemetry includes `stateDir` when caller provides `defaultWorkingDirectory` (the convention used by the rest of the adapter).

4. **`scripts/check-codex-rule1-drift.js`** (new) — CI drift-detection gate. Fails the build when `config.ts` regresses:
   - Forbidden string `"Agent SDK credit pot analog"` reappears.
   - `apiKey: env['OPENAI_API_KEY']` (or variants) reappears in `configFromEnv`.
   - `apiKey` field on `OpenAiCodexConfig` is missing `@deprecated` AND `@internal` tags (Phase A) AND isn't narrowed to `never` (Phase B+).
   
   Wired into `npm run lint` so every commit + push runs it.

5. **`tests/unit/providers/adapters/openai-codex/credentialsRule1.test.ts`** (new) — 23 cases covering: configFromEnv no-read; env detection; auth-file detection (api_key + apiKey field variants); enforcement mode resolution; killswitch sunset; checkAndWarn warn/silent/telemetry branches.

## Decision-point inventory

- **Phase A as default for v1.0.0** — `add`. Existing installs that have `OPENAI_API_KEY` set don't break the moment they upgrade — they get a visible warning and a telemetry event. The operator decides when to flip the env to `hard`.
- **`INSTAR_RULE1_ENFORCE=hard` opt-in** — `add`. Lets deployments that have ALREADY moved to subscription auth lock the rule down early, before v1.1's default flip.
- **`INSTAR_DISABLE_RULE1_OPENAI=1` escape hatch** — `add`. Required by spec 12 for the migration window. Sunsets on hardcoded date.
- **Drift gate at lint time, not just CI** — `extend`. Runs in `npm run lint` which fires on every pre-commit. Catches local regressions before push.
- **`apiKey` field stays as `string` in Phase A** — deliberate. Narrowing to `never` immediately would break the type for any third-party consumer (or test) that destructures the config. Phase A's `@deprecated` + `@internal` produces lint warnings without breaking compilation.

## Signal vs authority

- **`validateRule1` is signal-only** — it returns a structured result. Decision authority lives in the enforcement-mode resolver + the adapter's init code.
- **`checkAndWarn` is signal + side-effect** — it emits the warning and writes telemetry, but its decision to refuse is delegated to the caller (`createOpenAiCodexAdapter`).
- **`createOpenAiCodexAdapter` is the authority** — it reads the enforcement mode and either throws (`hard`) or proceeds (`warn`/`disabled`).
- **The drift gate is structural authority** — at lint time, refuses to let the source regress past Phase A guardrails.

## Over-block / under-block analysis

**Over-block:** A user who legitimately depends on API-key auth on Codex will see a warning at adapter init. They can suppress it with the escape hatch env var (which logs loudly itself). Without the hatch, behavior is unchanged for them in Phase A; no refusal happens. Mitigation: the warning is loud enough to be noticed but not so noisy as to break workflow.

**Under-block:** None — the validator covers the two attack surfaces spec 12 explicitly names (env var + auth.json shape). The drift gate prevents quietly re-adding the env read.

## Level-of-abstraction fit

- `credentials.ts` lives at the adapter root, sibling to `config.ts` (per spec 12). Future per-credential helpers belong there too.
- `check-codex-rule1-drift.js` lives in `scripts/` next to other lint helpers (`lint-no-direct-destructive.js`).
- Telemetry writes to the existing `.instar/security.jsonl` channel (per `feedback_signal_vs_authority` memory: telemetry events at this layer are signal; the security channel reader is authority).

## Interactions

- **`buildCodexChildEnv` (existing Spec 12 Rule 1a env-scrub)** — orthogonal. That helper strips `OPENAI_API_KEY` from spawn child env regardless of validator state. Both layers cooperate: validator detects auth shape; scrub ensures process trees never see the key.
- **`openaiKeyLeakageCanary` (existing)** — orthogonal. The canary asserts no spawn ever leaks the key; the validator asserts no adapter ever reads it.
- **`AuthCredentialInjection.validate` (existing)** — distinct concern. That validates a `ProviderCredential` shape passed by the caller; the new validator inspects the ambient env/auth.json at adapter init. Both can fail-fast independently.

## Rollback cost

Pure code change. To roll back, revert the four files (config.ts, credentials.ts, index.ts, lint script wiring) and the test file. The escape hatch + sunset constant make Phase A migration recoverable for users; rollback at the codebase level recovers the developer state too. The new tests would surface what's missing post-revert.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — green (includes the new drift check passing).
- `npx vitest run tests/unit/providers/adapters/openai-codex/credentialsRule1.test.ts` — 23/23 green.
- Manual: setting `OPENAI_API_KEY=sk-test` in the shell and constructing the adapter emits the expected warning + telemetry line.
