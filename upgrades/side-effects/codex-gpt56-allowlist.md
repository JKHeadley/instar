# Side-Effects Review — Add the GPT-5.6 family to the codex model allowlists

**Change:** additive model-id allowlist extension for the `codex-cli` framework. **Tier 1** (small, low-risk, fail-closed design unchanged). **Parent principle:** Structure > Willpower (the closed model-id enumeration is a code-enforced gate; this widens the allowed set, it does not weaken the gate).

**Files changed:**
- `src/core/ModelTierEscalation.ts` — `KNOWN_CODEX_MODEL_IDS` gains `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.
- `src/server/routes.ts` — `CODEX_MODELS_SUBSCRIPTION` (the `POST /sessions/spawn` codex model validator) gains the same three ids, keeping the two lists identical (the comment pins them as mirrors).
- `scripts/model-registry-freshness.manifest.json` — the Doorway/Model Knowledge Registry's `codex-cli.topModels` gains the three ids as recognized entries (`frontier: false`, pricing populated) + the door note / `$flaggedStaleNote` prose corrected to reflect the 2026-07-09 GA (the earlier "gpt-5.6-sol is preview-only/unreachable" line was now false).
- `tests/unit/modelTierEscalation-resolver.test.ts`, `tests/unit/route-validation-edge.test.ts`, `tests/unit/topicProfileValidation.test.ts` — allowlist + resolver + spawn + validation coverage.
- `docs/specs/codex-gpt56-allowlist.eli16.md`, `upgrades/next/codex-gpt56-allowlist.md` — the ELI16 + release fragment.

## What changed

The GPT-5.6 family (sol/terra/luna) went GA on the codex subscription on 2026-07-09 and was live-verified working (codex CLI >= 0.144.0 required; older CLIs 400 with "requires a newer version"). instar fails closed on model ids outside its closed per-framework enums, so these ids were rejected everywhere. This change adds the three ids to the two mirrored acceptance lists (`KNOWN_CODEX_MODEL_IDS` + `CODEX_MODELS_SUBSCRIPTION`). The `-pro` variants are deliberately excluded (plan-gated + pricier — tracked follow-up).

## Lists touched vs deliberately left

**Touched (acceptance / validation lists):**
- `KNOWN_CODEX_MODEL_IDS` (`src/core/ModelTierEscalation.ts`) — the escalation resolver's closed enum, and (via `KNOWN_MODEL_IDS`) the source for `topicProfileValidation.validateModelId`. One edit flows to both surfaces.
- `CODEX_MODELS_SUBSCRIPTION` (`src/server/routes.ts`) — the `/sessions/spawn` codex-cli model validator. Kept byte-identical in membership to the enum above (they are documented mirrors).
- `scripts/model-registry-freshness.manifest.json` → `doors.codex-cli.topModels` — the Doorway/Model Knowledge registry, added the three ids with `frontier: false` + pricing so `GET /doorways` knows they exist and their cost.

**Deliberately LEFT (routing/selection — a model earns a lane via benchmarks, not by GA date):**
- `src/providers/adapters/openai-codex/models.ts` `TIER_MODEL` (capable → gpt-5.5, fast/balanced → gpt-5.4-mini) — model CHOICES per tier, not an acceptance list.
- `src/core/frameworkSessionLaunch.ts` tier→model resolution — same reason.
- `src/data/llmBenchCoverage.ts` (`ROUTING_LABEL_TO_MODEL_ID`, bench coverage, nature-routing chains) — the routing chains that pick models for lanes; models earn these via benchmarks.
- The doorway manifest's `codex-capable-tier` PIN and the `frontier: true` flag — left at `gpt-5.5`. Promoting `gpt-5.6-sol` to the capable pin / frontier is a benchmark-driven follow-up, not this acceptance PR.

## Blast radius

- **Purely additive.** No id removed, no existing id's behavior changed. A caller not asking for a GPT-5.6 id is entirely unaffected.
- **Fail-closed preserved.** A well-shaped id outside the enum is still rejected (`id-not-in-closed-enum`); a made-up `gpt-9.9-fake` still 400s at spawn and resolves to null in escalation — both covered by new tests.
- **No new route, no new config default, no schema change.** No dark-gate line shift (no `enabled:` line added to `ConfigDefaults.ts`).

## Risk + mitigation

- **Risk:** the two mirror lists drift apart. **Mitigation:** both edited in the same commit with a cross-referencing comment on each; new tests assert acceptance through both the resolver and the spawn route.
- **Risk:** the doorway manifest edit trips the CI-gating model-registry-freshness lint. **Mitigation:** the new entries are `frontier: false`, so the codex-cli derived frontier set stays `['gpt-5.5']` and the `codex-capable-tier` pin (still `gpt-5.5`) remains a member — the drift tooth is unaffected. Staleness is unchanged (`lastReviewedAt` untouched, well within the 45-day window). Verified: `node scripts/lint-model-registry-freshness.mjs` → PASS.
- **Risk:** a user on an old codex CLI selects a GPT-5.6 id and gets an opaque failure. **Mitigation:** the ELI16 + release fragment both call out the codex CLI >= 0.144.0 requirement explicitly.

## Framework generality

The change is scoped to the `codex-cli` framework's own acceptance surfaces and routes through the existing per-framework `KNOWN_MODEL_IDS` / spawn-validator abstraction — it does not touch the session-launch/inject abstraction and makes no Claude-specific assumption. Other frameworks (claude-code, gemini-cli, pi-cli) are untouched.

## Migration parity

- No agent-installed file changes (no `.claude/settings.json`, no `.instar/config.json` default, no CLAUDE.md template section, no hook/skill). The allowlists are shipped code read at runtime, so existing agents pick up the new ids on the normal server/dist update — no `PostUpdateMigrator` entry needed. The operator's already-set `models.tierEscalation.frameworks.codex-cli.escalated = "gpt-5.6-sol"` becomes live purely by deploying this code.

## Tests

- `tests/unit/modelTierEscalation-resolver.test.ts` — codex-cli escalated tier accepts each of gpt-5.6-sol/terra/luna; a made-up id fails closed (`id-not-in-closed-enum`); the `-pro` variants are asserted absent.
- `tests/unit/route-validation-edge.test.ts` — `POST /sessions/spawn` with framework `codex-cli` accepts the three GPT-5.6 ids (not 400) and rejects `gpt-9.9-fake` (400, error names "model").
- `tests/unit/topicProfileValidation.test.ts` — `validateModelId(..., 'codex-cli')` returns null for the three ids (the KNOWN_MODEL_IDS mirror path).
- Adjacent suites re-run green: `model-registry-freshness`, `codex-model-tier-resolution`, `frameworkSessionLaunch`, `model-tier-swap-route`, `model-tier-escalation-lifecycle`. `npx tsc --noEmit` clean.

## Follow-ups

- Add the `-pro` GPT-5.6 variants once their plan-gating + pricing are confirmed.
- Benchmark GPT-5.6-sol and, if it wins the lane, promote it to the codex capable tier pin (`TIER_MODEL.capable` + the manifest `frontier: true` + `lastReviewedAt` bump) and into the routing chains — a routing decision, not an acceptance change.
- Populate real per-token pricing across the doorway registry if/when the metered doorway-scan scopes consume it.
