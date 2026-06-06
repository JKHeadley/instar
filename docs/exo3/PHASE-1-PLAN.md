# EXO 3.0 — Phase 1 Implementation Plan (the two must-close gaps)

Scoped against the live instar codebase (`.dev/instar`) 2026-06-04. Each feature ships to the full 3-tier testing standard + migration parity + CLAUDE.md template update, then PR via the /instar-dev ceremony. Gate: both must land before pitching Salim.

## G1 — Package ORG-INTENT as the "MTP Protocol" (identity layer + endorsement/refusal test harness)

**Existing system (reuse, don't rebuild):**
- `src/core/OrgIntentManager.ts` — parses ORG-INTENT.md (constraints/goals/values/tradeoff hierarchy); `parse()`, `validateAgentIntent()`, `formatOrgIntentForSessionStart()`.
- `src/core/TradeoffResolver.ts` — `resolveTradeoff()` pure logic (= Salim's decision layer, already deterministic ✅).
- `src/commands/intent.ts` — `instar intent validate|reflect|drift`.
- `src/server/routes.ts` — GET /intent/org (~11272), /intent/org/session-context (~11290), POST /intent/tradeoff-resolve (~11645), GET /intent/validate (~11728).

**New work:**
1. `src/core/OrgIntentIdentityLayer.ts` — parse a new optional `## Identity` section (why high-judgment humans stay; identity disqualifiers / "what we're not for"). Extend `ParsedOrgIntent` with `identity?: OrgIdentity`.
2. `src/core/IntentTestHarness.ts` — `testEndorsement(action, context)` + `testRefusal(action)`. The two tests from Video 6: "can the MTP make an agent refuse?" / "would leadership endorse this?"
3. Extend `OrgIntentManager.parse()` + `formatOrgIntentForSessionStart()` (inject identity after constraints) + `validateAgentIntent()` (flag identity conflicts).
4. Wire into `instar intent validate` → add endorsement/refusal harness pass/fail output.
5. New route `POST /intent/org/test-action` `{action, context}` → `{endorsed, refused, reason}`.
6. Migration: `PostUpdateMigrator.migrateOrgIntentIdentity()` (idempotent; only adds `## Identity` if missing; no-op when no ORG-INTENT.md).
7. CLAUDE.md template (`src/scaffold/templates.ts → generateClaudeMd()`): document MTP Protocol + test-action endpoint.
8. Tests: `tests/unit/OrgIntentIdentityLayer.test.ts`, `tests/unit/IntentTestHarness.test.ts`, `tests/integration/org-intent-identity-routes.test.ts`, `tests/e2e/org-intent-identity-lifecycle.test.ts` (feature-is-alive: 200 not 503).

## G2 — Agent-readiness scoring diagnostic (coordination-vs-judgment ratio)

**New work:**
1. `src/core/AgentReadinessScorer.ts` — `score(task)` / `scoreWorkflow(wf)` → `{coordinationRatio, judgmentRatio, overallScore 0-100, recommendation}`. Pure logic + optional LLM semantic pass. (= Salim's "task decomposition matrix", score >4–5 → deploy an agent.)
2. New route `POST /agent-readiness/score` `{task}|{workflow}` (mirror the session-context route pattern; dynamic import; Bearer-auth via existing middleware).
3. New built-in skill `skills/agent-readiness/SKILL.md` + register in `src/commands/init.ts installBuiltinSkills()` (install-if-missing → no migration needed).
4. CLAUDE.md template: add to Capabilities + "when to use" proactive trigger.
5. Tests: `tests/unit/AgentReadinessScorer.test.ts`, `tests/integration/agent-readiness-routes.test.ts`, `tests/e2e/agent-readiness-lifecycle.test.ts`.

**Gotchas:** dynamic `import()` inside route handlers; E2E uses ephemeral ports (never hardcode 4040/4042); `pnpm test:all` green before push (Zero-Failure Standard); both features need the CLAUDE.md template update (Agent Awareness Standard).

**Order:** G1 first (lower effort, highest pitch payoff — it's Salim's flagship MTP framework and we already have 2 of its 3 layers). Then G2. Separate PRs, each with its `upgrades/next/<slug>.md` release fragment (else it merges but never publishes).

## Tier 4 — Live agent-drives-agent verification (MANDATORY for every EXO 3.0 feature)

Standing requirement from the operator, Justin (2026-06-04; originally miscredited to "Caroline" — identity-bleed artifact, scrubbed): unit/integration/e2e prove the *code* works; they do NOT prove the *agent behavior* works. Every EXO-3.0-derived feature must additionally pass a **Tier 4** verification before it's "done":

- Build on the existing `test-as-self` mechanism (deploy the dist into a throwaway agent home), then go further: **one agent drives another over the real Telegram surface** — one Echo instance plays the USER, the other is the TEST agent.
- The user-agent issues natural-language requests that should exercise the feature; the test-agent must actually *perform the behavior* through its normal conversational path (not a curl to the endpoint, not a 200 check) — e.g. for G1, the user-agent asks the test-agent to evaluate an action against its MTP and the test-agent must correctly refuse/endorse via the identity+constraint layers.
- Pass criteria: the test-agent demonstrably does the right thing end-to-end through conversation. A feature is NOT shippable on green unit tests alone.

This is the acceptance gate for BOTH G1 and G2 (and all future EXO 3.0 work). Design note: this needs a two-agent Telegram harness (spawn a second throwaway agent + a driver script that posts as the user and asserts on the test-agent's replies) — to be built as part of Phase 1 infra, since every feature depends on it.
