# Side-Effects Review — Benchmark Application (S1/S2/S5): routing-registry freshness lint, Opus×claude-CLI gating clamp, bench-refresh job

**Version / slug:** `task4-bench-application`
**Date:** 2026-07-03
**Author:** Echo (build helper)
**Second-pass reviewer:** not required (Tier-1 dark/reversible increment)

## Summary of the change

INSTAR-Bench v3 established that routing must be per-task-NATURE and that one route is measured-banned for bounded verdicts: Opus-4.8 via the Claude Code CLI scores 99.1% via clean API but 81.7% via the CLI door (a 17.4-pt penalty; 73% on emergency-stop). This change lands the three low-risk, direct pieces of "apply the bench to routing" — S1, S2, S5 — all dark/reversible, none of which moves a live routing default:

- **S1 (cite-the-bench, extended):** a new registry-doc freshness lint (`scripts/lint-routing-registry-freshness.js`) that fails if any `COMPONENT_CATEGORY` key lacks a row in `docs/LLM-ROUTING-REGISTRY.md`, plus a new `LLM_ROUTING_NATURE` map in `src/data/llmBenchCoverage.ts` carrying each benched component's bench-cited task-nature (A/B/D/E) + production chain (FAST/SORT/JUDGE/WRITE). Read-only metadata; the actuating router (S4) is out of scope.
- **S2 (the safety guardrail):** a runtime clamp (`clampClaudeCliSwapModel` in `src/core/IntelligenceRouter.ts`) that narrows a bounded/gating failure-swap onto `claude-code` from the `capable` tier (=Opus) down to `balanced` (=Sonnet CLI reserve), plus a lint (`scripts/lint-no-opus-claude-cli-gating.js`) that keeps the clamp intact and refuses any config that routes a gating call to Opus×claude-CLI.
- **S5 (bench-refresh job):** a scaffolded, OFF-by-default, tier-1-supervised monthly job template (`src/scaffold/templates/jobs/instar/bench-refresh.md`) that runs the bench harness + parity-check and raises ONE operator-review attention diff — never auto-applies.

Files touched: `src/core/IntelligenceRouter.ts`, `src/data/llmBenchCoverage.ts`, `docs/LLM-ROUTING-REGISTRY.md`, `package.json`, `scripts/lint-routing-registry-freshness.js` (new), `scripts/lint-no-opus-claude-cli-gating.js` (new), `src/scaffold/templates/jobs/instar/bench-refresh.md` (new), + four new unit test files.

## Decision-point inventory

- `IntelligenceRouter` failure-swap model selection — **modify** — the swap loop now clamps `capable`→`balanced` when the swap target is `claude-code` (S2). This is the only behavioral decision-point change; it only ever NARROWS a fallback.
- `LLM_ROUTING_NATURE` (new read-only map) — **add** — advisory bench-cited nature/chain metadata; consumed by no live router yet.
- `bench-refresh` job — **add** — off by default; a cadence trigger, no config authority.

---

## 1. Over-block

The S2 clamp has no block/allow surface — it never rejects a call; it downgrades a model tier on one specific fallback door. Worst case it serves a bounded/gating gate on Sonnet-CLI (99.5%, 28/28 adversarial) instead of Opus-CLI (81.7%) — strictly an improvement, never an over-block. The two lints can "block" a build: the freshness lint fails a genuinely-missing registry row (correct — that IS the gap it exists to catch); the opus-gating lint fails only the exact banned combination or a removed guardrail. Both are seeded to pass on current main (verified green).

## 2. Under-block

The S2 clamp only covers the failure-SWAP path onto claude-code. It does NOT touch a call whose RESOLVED PRIMARY framework is claude-code requesting `capable` (the CHAIN WRITE open-ended-writing quality lane, where Opus-CLI is legitimately the best route) — correctly, since that is not a bounded verdict. The opus-gating lint's config scan is a static best-effort over committed JSON; the runtime `.instar/config.json` is not in the repo, so the load-bearing protection is the code clamp (prong A), not the config scan (prong B). This is acknowledged and correct: the clamp is the guarantee; the lint is the tripwire against the clamp's removal.

## 3. Level-of-abstraction fit

Correct layer. The clamp lives at the single failure-swap funnel in `IntelligenceRouter` (the one place every gating swap passes through), not scattered per-component. The nature map is data, not logic. The lints are pre-compile source scans (the house pattern). Nothing re-implements a primitive that already exists; S1's freshness lint deliberately mirrors the shrink-only shape of the existing bench-coverage ratchet.

## 4. Signal vs authority compliance

- [x] No — this change produces a signal / narrows a fallback; it holds no new brittle block authority.

The S2 clamp is a mechanical, deterministic narrowing (capable→balanced on one door) — not a judgment call, and it never blocks a message. The lints are CI signals. The nature map is advisory. None of this owns block authority over an outbound message or an action.

## 5. Interactions

- **Shadowing:** the clamp runs INSIDE the existing swap loop, just before `attemptOptions` is built. It composes with the per-target-swap-timeout cap (both now fold into the same `attemptOptions` object). Verified: the existing per-target-swap-timeout and provider-fallback-swap tests still pass (36 tests green) — the cap path is unchanged when no clamp fires.
- **Double-fire:** none — the clamp mutates a local options object for one attempt; no shared state.
- **Races:** none — pure per-call local computation.
- **Feedback loops:** none.

## 6. External surfaces

- Other agents / install base: the bench-refresh job template ships to every agent via `InstallBuiltinJobs` (directory-scanned), but is `enabled: false` and no-ops (exits silently) on any agent lacking the research harness — so it is inert on the fleet. The two new lints join `npm run lint` (CI) — they gate builds, not runtime.
- External systems: none. The job, when a maintainer enables it, only POSTs to the local `/attention` endpoint — never auto-applies a routing change.
- Persistent state: none. No new ledger, no migration.
- **Operator surface (Mobile-Complete):** no operator-facing action added. The bench-refresh diff lands on the existing `/attention` queue (already phone-complete). Not applicable otherwise.

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard renderer, approval page, or grant/secret form is touched.

## 7. Multi-machine posture

**machine-local BY DESIGN.** The S2 clamp is pure per-call routing logic — identical on every machine, no state to replicate. The bench-refresh job is machine-local by design: it only does real work on the machine that physically carries the bench harness under `research/llm-pathway-bench/` (a maintainer machine); every other machine's copy is a silent no-op. It holds no durable state, strands nothing on topic transfer, and generates no URLs. The nature map and lints are source, identical fleet-wide.

## 8. Rollback cost

Pure code + data + template change. Back-out = revert the commit and ship a patch. No persistent state, no migration, no user-visible regression during the rollback window. The S2 clamp only ever improved a fallback's model choice; reverting it restores the (latent, never-observed-in-the-wild) risk of an Opus-CLI gating swap — i.e. rollback is strictly safe.

## Framework generality

The S2 clamp is deliberately framework-SPECIFIC and correct: it targets `claude-code` because the banned door is the Claude Code CLI harness (its ~20k-token coding-agent framing is what credulity-poisons a bounded judge). `codex-cli`, `pi-cli`, and `gemini-cli` swap targets are untouched (`capable` passes through) — Opus/GPT-5.5 via a clean API/thin-wrapper door is fine. This is framework-optimizing, not a Claude-only blind spot: the clamp encodes a measured per-door finding, and the nature map's chains name the right door per nature for every framework.

## Conclusion

Three low-risk, dark/reversible pieces that lock in the benchmark discipline (S1), close the one measured safety hole in the current failure-swap config (S2), and scaffold the refresh cadence (S5) — without moving any live routing default (that is S4, spec-converge-gated, out of scope). The S2 clamp is the highest-value piece: it makes the banned Opus×claude-CLI bounded-verdict route structurally unreachable via a fallback swap, in the safe direction only. Clear to ship.

## Evidence pointers

- `tests/unit/opus-claude-cli-gating-guardrail.test.ts` — 14 tests: clamp narrows capable→balanced on claude-code only, never upgrades, never touches other doors; lint prong A/B predicates.
- `tests/unit/llm-routing-nature-ratchet.test.ts` — 6 tests: nature map cites only benched components, valid enums, nature→chain coherence, R2 regression pin.
- `tests/unit/routing-registry-freshness.test.ts` — 2 tests: every category key has a registry row; no stale allowlist.
- `tests/unit/bench-refresh-job-template.test.ts` — 8 tests: ships off, tier-1, monthly, harness-gated, never auto-applies.
- `npm run lint` green (both new lints pass); `tsc --noEmit` clean; the router/ratchet suites (98 tests) green.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This change adds guardrails/lints/metadata; it does not fix a defect in an LLM prompt, hook, config, skill, or standards text.
