# Side-Effects Review — Codex tiers move to the GPT-6 family

**Version / slug:** `codex-gpt6-tiers`
**Date:** `2026-09-23`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Repoints the Codex model tiers: `fast` gpt-5.6-sol → gpt-6-luna, `balanced`
gpt-5.6-sol → gpt-6-sol, `capable` unchanged (gpt-6-astra). Files:
`src/providers/adapters/openai-codex/models.ts` (TIER_TO_MODEL, header record),
`src/core/frameworkSessionLaunch.ts` (session tier map; the two codex default
literals now resolve the `balanced` tier), `src/core/ModelTierEscalation.ts`
(KNOWN_CODEX_MODEL_IDS gains gpt-6-sol and gpt-6-luna),
`scripts/model-registry-freshness.manifest.json` (two new rows, gpt-5.6-sol
re-verified), and the tests that pin these ids. CODEX_CHATGPT_FALLBACK_MODEL stays
gpt-5.6-sol deliberately.

## Decision-point inventory

- Codex model selection per tier — modify — which model id a tier resolves to.
- Model-retirement self-heal in CodexCliIntelligenceProvider — pass-through — unchanged; now also the path that keeps old-CLI agents working.
- KNOWN_CODEX_MODEL_IDS (spawn route + pin validator acceptance) — modify — two ids added, none removed.

---

## 1. Over-block

No block/allow surface. The acceptance list only grows, so no previously accepted
model id or topic pin is newly rejected.

## 2. Under-block

Not applicable as a filter. The residual failure mode is operational: a Codex
SESSION (interactive or job) launched on the fast/balanced tier on codex CLI < 0.156
is refused by OpenAI and has no retry. Background one-shots are covered by the
self-heal; sessions are not. Stated in the release note with the upgrade command.

## 3. Level-of-abstraction fit

Correct layer: the tier map is the single source both resolvers read, and the
change also removes two duplicated default literals so they derive from it. The
old-CLI protection reuses the existing retirement self-heal rather than adding a
parallel version check.

## 4. Signal vs authority compliance

No new decision logic, detector or gate. Reference: docs/signal-vs-authority.md —
this is a configuration value change with no blocking authority added.

## 5. Interactions

- The self-heal retries once on gpt-5.6-sol when a GPT-6 id is refused; a new test
  asserts the real 0.153.4 refusal text classifies as `unsupported`. Per-call cost on
  an old CLI: one extra instant 400 before the retry.
- Topic profiles pinned to an explicit model id are unaffected; pins by tier follow.
- Model-tier escalation (claude-code only) is unaffected.
- Token accounting (`/metrics/features` byModel) will show the new ids.

## 6. External surfaces

Every Codex-routed agent in the fleet sends a different model id to OpenAI after
update. Depends on OpenAI keeping gpt-6-luna / gpt-6-sol on the ChatGPT surface; if
retired, the existing self-heal falls back to the floor. Sessions depend on the
installed Codex CLI version, which we do not control on user machines.

## 7. Multi-machine posture

Machine-local BY DESIGN: the tier map ships in the package, so each machine picks
it up on its own update; the only per-machine variable is the installed Codex CLI
version, handled by the self-heal for one-shots. No replicated state, no notices.

## 8. Rollback cost

Revert the commit and release a patch; no data, state or migration involved.
Operators can also pin a specific model per topic in the meantime.

## Second-pass review

Concur with the review. Independent reviewer confirmed every live one-shot path
resolving these tiers goes through CodexCliIntelligenceProvider's retirement
self-heal (crossModelReviewer included); the adapter transports without a
self-heal have no live importer outside a parity test. The uncovered case —
sessions launched via frameworkSessionLaunch on codex CLI < 0.156 — is stated in
§2/§6 and the release note. One stale comment in frameworkSessionLaunch.ts was
flagged and fixed.
