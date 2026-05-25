# Side-effects review — standards-conformance gate

**Scope**: Make the living constitution enforceable — a code-backed reviewer that
reads `docs/STANDARDS-REGISTRY.md` and signals possible standard-violations in a
draft spec, turning the manual/prompt-driven conformance pass into structure. The
rung-3 normative slice; directly fixes `[[feedback_spec_review_against_standards]]`
(the North Star draft violated No-Manual-Work, review missed it, Justin caught it).
Spec: `docs/specs/standards-conformance-gate.md` (approved; Claude-authored +
manual review — see honest convergence note).

**Files touched**:
- `src/core/StandardsRegistryParser.ts` — NEW. Deterministic parse of the
  constitution into `{family,name,rule,inPractice}[]` (tracks the five standards
  `##` families so non-article `###` sections — Genesis etc. — are excluded);
  `runRegistryCanary` (state-detector: ≥15 articles + anchor articles present).
- `src/core/reviewers/standards-conformance.ts` — NEW. `StandardsConformanceReviewer`:
  injected `IntelligenceProvider` (subscription path), anti-injection prompt (spec
  fenced as untrusted data), degrade-safe (no provider/throw/unparseable → empty
  report), drops hallucinated standards not in the registry, `capable` tier.
- `src/server/specReviewRoutes.ts` — NEW. `POST /spec/conformance-check` (markdown
  or specPath, traversal-guarded) → report + registry canary; `GET
  /spec/conformance-metrics`; file-backed metrics (reloads on restart); 503-stub
  when disabled. Exports `runConformanceCheck` for the (deferred) CLI.
- `src/server/AgentServer.ts` — mount the routes; new optional `intelligence` in
  `AgentServerOptions`.
- `src/commands/server.ts` — pass `intelligence: sharedIntelligence` to AgentServer.
- `src/server/CapabilityIndex.ts` — `spec` → `INTERNAL_PREFIXES`.
- `src/config/ConfigDefaults.ts` + `src/core/types.ts` — `specReview.conformance.enabled`
  default true (auto init+migration).
- `docs/specs/06-state-detector-registry.md` — registry-parser row.
- Tests: unit/integration/e2e for the gate; updated `capabilities-discoverability`
  to scan `specReviewRoutes.ts` (so the `spec` INTERNAL prefix resolves).

**Under-block**: The gate SIGNALS only — it cannot block anything in v1 (no code
path grants it authority), so it cannot wrongly stop a spec. The registry canary
runs on every check; a drifted/partial registry surfaces in the response
(`registryCanary.ok=false`) rather than silently producing a clean report. The
traversal guard rejects specPath escaping specsDir.

**Over-block**: None possible — signal-only. A false-positive finding costs one
advisory line in a report the human reads, never a blocked commit.

**Level-of-abstraction fit**: The constitution stays the single source of truth
(the parser reads it; nothing duplicates the standards). The reviewer reuses the
established LLM-reviewer pattern (injected provider, anti-injection, fail-open)
rather than a bespoke LLM client. The route is a thin surface over parser +
reviewer. Signal-vs-authority is structural: the reviewer has no `block` path.

**Signal vs authority**: The whole feature is a signal producer. The human
ratification + the instar-dev `approved:true` gate retain all authority. Promotion
to a blocking/warn signal in the precommit gate is the tracked `scg-blocking-authority`
follow-up, gated on measured precision.

**Interactions**:
- Reads `docs/STANDARDS-REGISTRY.md` from `config.projectDir/docs`. For Echo (repo
  checkout) it's present; a deployed agent without the repo docs gets a clean 503
  ("constitution unreadable") — correct (the gate is a build-time tool, inert where
  there's no constitution).
- Adds one `capable`-tier LLM call per conformance check (per-spec, rare) through
  `sharedIntelligence` — degrade-safe, never blocks spec work if the provider is down.
- New `intelligence` option on AgentServer is additive (optional); existing
  construction unaffected.
- File-backed metrics at `stateDir/spec-conformance-metrics.json` (atomic
  temp+rename); corrupt → fresh.

**External surfaces**:
- `POST /spec/conformance-check`, `GET /spec/conformance-metrics` (INTERNAL prefix).
- New config `specReview.conformance.enabled` (default true).
- New exported `runConformanceCheck` (for the deferred CLI).

**Deferred (tracked)**: `instar spec conformance` CLI (`scg-cli`) — thin wrapper
over `runConformanceCheck`; the route delivers the capability. Auto-blocking
authority (`scg-blocking-authority`). Richer markdown parser (`scg-richer-parser`).

**Rollback cost**: Low, strictly additive. Remove the routes + reviewer + parser;
the constitution returns to being read only by the manual `/spec-converge` pass
(today's state). No existing runtime path is modified.

**Migration parity**: New server-side code + routes + config default (init +
`migrateConfig` via ConfigDefaults) + INTERNAL prefix. The parser reads a
repo-shipped doc (no per-agent state). No hook/template/skill-file change.

**Convergence honesty**: Claude-authored + manual review only; full
`/spec-converge` + `/crossreview` multi-model tooling absent on host. Ratified by
Justin with that caveat explicit. CI + the known-violating-spec e2e are the
strongest current evidence; a fuller multi-model review remains advisable —
fittingly, this is the tool that would make that conformance pass structural.
