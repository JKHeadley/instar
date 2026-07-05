---
title: "Nature-Axis Routing — resolve (door, model) by task nature + chain + door-availability"
slug: "nature-axis-routing"
author: "echo (spec-converge hand, 24h autonomous run, topic 29723)"
eli16-overview: "docs/specs/nature-axis-routing.eli16.md"
status: "draft — pre-convergence"
---

# Nature-Axis Routing (Task-4 S4)

## Problem statement

`IntelligenceRouter.resolveFramework(component, category, cfg)` today routes every
internal LLM call to a **framework/door** by the component's *category*
(`sentinel | gate | job | reflector | other`) only. The concrete **model** is a
separate axis — the caller's `options.model` size hint (`fast | balanced | capable`),
mapped to a model id per-adapter (`TIER_TO_MODEL`). Nature never enters the decision.

The INSTAR-Bench v3 corrected-battery re-rank (2026-07-03; `research/llm-pathway-bench/results/instar-bench-v2/MATRIX-RERANK.md`,
`FULL-REPORT-ELI16.md`) proved that the *right* route is a function of **task nature**,
not category and not model. The load-bearing evidence:

- **The door penalty.** Identical Opus 4.8 scores **99.1% via a clean API** but **81.7% via
  the Claude Code CLI** — a 17.4-pt penalty. On the completion judge: **100% API vs 35% CLI**.
  On emergency-stop: Opus-CLI **73%** (missed canonical STOP commands). The Claude Code
  harness wraps every prompt in ~20k tokens of "helpful coding agent" framing that turns a
  skeptical judge into a credulous assistant.
- **The paradox (ELI16 §7.12).** Opus-via-Claude-Code-CLI is *simultaneously* the **WORST**
  route for bounded verdicts (completion-judge 35%) and the **BEST** for open-ended writing
  (9.1/10 blind). Same route, opposite verdict — which is *why* routing must be per-nature.

Two prerequisite pieces are already **merged on `JKHeadley/main`** (PR #1352):

- **S1 — the nature map.** `src/data/llmBenchCoverage.ts` exports `TaskNature` (`A|B|D|E`),
  `RoutingChain` (`FAST|SORT|JUDGE|WRITE`), `RoutingNature`, and `LLM_ROUTING_NATURE` (a
  read-only, bench-cited component→`{nature,chain}` map), plus the
  `llm-routing-nature-ratchet.test.ts` guard (nature∈{A,B,D,E}, chain∈{FAST,SORT,JUDGE,WRITE},
  A→FAST|SORT, B→JUDGE, D→SORT|WRITE, E→JUDGE; every key exists in `COMPONENT_CATEGORY` and is
  bench-covered). It is **advisory metadata only** and deliberately **non-exhaustive** — it
  "changes NO routing today", explicitly leaving actuation to S4.
- **S2 — the safety clamp.** `clampClaudeCliSwapModel(target, requested)` in
  `src/core/IntelligenceRouter.ts` clamps a failure-swap that lands on `claude-code`
  requesting `capable` down to `balanced` (Sonnet CLI) — never Opus-via-CLI for a bounded/gating
  verdict (R1/R2). It is invoked **only** inside the failure-swap loop today.

**S4 is the actuation.** Make the router resolve a concrete **(door, model)** by
**nature → chain → door-availability**, apply the v3 chains as **config defaults**, and
compose with the merged S2 clamp — shipped **dark and reversible first** (fleet behavior
byte-identical when the nature-routing config is unset).

## Frontloaded Decisions

Every decision below is **resolved** (operator-authoritative where marked). None are parked
on the user; `## Open questions` is empty by construction.

### FD1 — Door taxonomy (operator-authoritative)
A **RoutingDoor** is a concrete access path to a model. Two classes:

- **CLI doors** — already `IntelligenceFramework`, already wired: `pi-cli`, `codex-cli`,
  `gemini-cli`, `claude-code`.
- **Metered-API doors** — NEW, backed by the existing bench metered funnel + its
  `$0-fail-closed` money gate; wired in **Increment B** (FD9). Each is keyed to a vault secret
  Echo already holds (verified via `secret-get.mjs --names`, 2026-07-04):
  - `gemini-api` → `metered_gemini_bench` — Gemini 3.1 Flash-Lite (CHAIN FAST winner) + Gemini 3.x.
    **Operator decision #2:** use the metered Gemini key for LIVE Gemini-tier routing; keep the
    existing $0-fail-closed money gate; never exceed the cap.
  - `openrouter-api` → `metered_openrouter_bench` — GPT-5.5 API + **Opus-4.8 clean API** (the
    JUDGE "never-CLI" reserve).
  - `groq-api` → `metered_groq_bench` — gpt-oss-120B (CHAIN WRITE, **non-injection only**).

**Operator decision #1 (authoritative):** GPT-5.5-tier work routes via **`pi-cli` as PRIMARY**
(the bench crowned pi-gpt-5.5 = 100% adversarial, 5.7s — the fastest GPT-5.5 door), with
`codex-cli` and `openrouter-api` as fallbacks. **There is NO OpenAI direct API key and one MUST
NOT be required** — any chain position that needs an OpenAI-direct key is treated as *unavailable*
and skipped by the door-availability walk (FD5). This is not a gap to close; it is a fixed
constraint of Echo's inventory.

### FD2 — Chain-position model
A **chain position** is `{ door, model, keyRef?, moneyGated?, injectionSafe? }` where `model` is a
tier (`fast|balanced|capable`) or a concrete id. A **chain** is an ordered
default→fallback ladder of positions. The four chains (ELI16 §11), authored as config defaults:

- **FAST** (latency-sensitive quick-sort): `gemini-api/flash-lite` → `openai-api/gpt-5.4` *(no key → skip)*
  → `openai-api/gpt-5.4-mini` *(no key → skip)* → `pi-cli/gpt-5.5`.
- **SORT** (background quick-sort): `codex-cli/gpt-5.4-mini` → `pi-cli/gpt-5.5` → `gemini-api/flash-lite`
  → `openai-api/gpt-5.4-mini` *(no key → skip)* → `claude-code/balanced` *(Sonnet-4.6 reserve)*.
- **JUDGE** (careful judgment): `pi-cli/gpt-5.5` → `codex-cli/gpt-5.5` → `openrouter-api/gpt-5.5`
  → `openrouter-api/opus-4.8` *(clean API, **NEVER CLI**)* → `claude-code/balanced` *(Sonnet-4.6 reserve)*.
- **WRITE** (open-ended writing): `codex-cli/gpt-5.4-mini` → `groq-api/gpt-oss-120B` *(non-injection only)*
  → `claude-code/fast` *(Haiku-4.5)* → `claude-code/capable` *(Opus-4.8 quality lane — allowed, see FD4)*.

The chain table lives at `sessions.natureRouting.chains` (config default = the four above);
an operator MAY override a chain wholesale. The model per position resolves through the existing
per-adapter maps (`resolveModelForFramework` / `TIER_TO_MODEL`); metered-door model ids resolve in
the metered adapter (Increment B).

### FD3 — Nature signal origin: **static per-component map** (design-decided; grounding-aligned)
Nature is resolved from `LLM_ROUTING_NATURE` (extended to be **exhaustive** over
`COMPONENT_CATEGORY` — FD7), NOT a per-call classifier and NOT bare caller-declaration.
Rationale: nature is a **stable property of the callsite**, not of the input; a classifier would
add an LLM call to route an LLM call (cost + recursion) and could be gamed by injected input; the
static map is deterministic, auditable, and already enforced by the cite-the-bench ratchet
(Structure > Willpower). **Opt-in override:** a caller MAY pass `attribution.nature` for a
genuinely multi-nature (A/B) callsite; the resolver takes the **stricter** of map-vs-declared
(B > D > A precedence for gates; the safe direction — a judgment call never silently downgrades to
a sorter). A component with **no** map entry falls through to **today's category routing**
(byte-identical safe default) — but the FD7 ratchet forbids that state for any benched component,
so the fall-through only ever covers genuinely un-benched/exempt callsites.

### FD4 — Composition with the harness-door ban (operator decision #3, R1/R2/S2)
**Judge / gate / any BOUNDED-JUDGING work routes through CLEAN doors ONLY, never the
`claude-code` agent-harness door.** The measured penalty is the **harness framing, not the
model**. Enforcement, composing with the merged S2 clamp (reused, not re-implemented):

1. **Reuse `clampClaudeCliSwapModel`** at BOTH the primary-route resolution AND every swap
   position (today it fires only in the swap loop). Any FAST/SORT/JUDGE position landing on
   `claude-code` with `capable`/opus is clamped to `balanced` (Sonnet-4.6 CLI reserve).
2. **Chain-validation lint** (`scripts/lint-nature-chains.mjs` + a ratchet test): the build
   FAILS if any **FAST/SORT/JUDGE** chain position is `(claude-code, capable|opus)`. This makes
   R1/R2 a structural guarantee at config-authoring time, not a runtime hope.
3. **WRITE is the sole exemption.** R1 scopes explicitly to *bounded verdicts*; open-ended
   writing is where Opus-via-CLI is the **best** route (9.1/10). WRITE's `claude-code/capable`
   (Opus quality lane) is therefore allowed — and the lint exempts WRITE by name.

Net effect: no bounded/gating call can ever resolve to Opus-via-Claude-CLI, at the primary
position OR any fallback landing — the banned 17.4-pt route is unreachable by construction for
nature A/B/D-sort work.

### FD5 — Door-availability / key-inventory walk
Resolution walks the nature's chain positions in order. A position is **available** iff: its door
binary/CLI is present (CLI doors) OR its vault key exists AND the door's money-gate has budget
(metered doors), AND the door's circuit breaker is closed. The **first available** position is the
PRIMARY `(door, model)`; the remaining available positions, in order, become the **failureSwap
tail** fed to the existing swap loop. An unavailable position is **skipped** (logged), never a
hard error. Concretely, with Echo's inventory (no OpenAI-direct key):

- FAST → `gemini-api/flash-lite` (Increment B) then `pi-cli/gpt-5.5`.
- SORT → `codex-cli/gpt-5.4-mini` → `pi-cli/gpt-5.5` → `gemini-api/flash-lite` → `claude-code/balanced`.
- JUDGE → `pi-cli/gpt-5.5` → `codex-cli/gpt-5.5` → `openrouter-api/gpt-5.5` → `openrouter-api/opus-4.8` → `claude-code/balanced`.
- WRITE → `codex-cli/gpt-5.4-mini` → `groq-api/gpt-oss-120B` → `claude-code/fast` → `claude-code/capable`.

The walk **can never** violate FD4: the only `claude-code` position in FAST/SORT/JUDGE is the
terminal `balanced` reserve, and the lint (FD4.2) guarantees no capable/opus position exists there.

### FD6 — Authority split: what auto-applies vs what the operator must review (operator decision #5)
- **LOW-STAKES (auto-apply).** Nature **A** (FAST/SORT bounded sorters) and nature **D**
  (background digests) that are **not** safety gates — e.g. `CommitmentSentinel`,
  `TemporalCoherenceChecker`, `PresenceProxy`, `TaskClassifier`, `TopicIntentExtractor`,
  `SessionActivitySentinel`, `SessionSummarySentinel`, `correction-learning`. Their bench-
  recommended chain is the config default and takes effect the moment nature-routing is enabled;
  a future S6 re-bench reslot for these MAY auto-apply.
- **CRITICAL-GATE (operator review, NEVER auto-ship).** Nature **B** JUDGE safety gates —
  `MessagingToneGate`, `CompletionEvaluator`, `ExternalOperationGate`, `LLMSanitizer`,
  `CoherenceReviewer`, `UnjustifiedStopGate`, `SessionWatchdog`, `StallTriageNurse`,
  `ProjectDriftChecker` — **plus** the emergency-stop classifier `MessageSentinel` (nature A but
  R2-critical). The chain-default table carries a per-component `autoApply: boolean`; critical-gate
  = `false`. ANY change to a critical-gate's resolved `(door, model)` — an operator config edit, a
  **durable** fallback landing, or an S6 reslot — raises **ONE deduped operator attention item** and
  is never auto-shipped. Because S4 ships dark, *enabling* nature-routing is itself a deliberate
  operator act, and the critical-gate defaults it activates are exactly the operator-reviewed v3
  chains; the attention item covers post-enable drift.

### FD7 — Exhaustive nature map + ratchet
`LLM_ROUTING_NATURE` is extended to cover **every** `COMPONENT_CATEGORY` key, resolving the
multi-nature (A/B, B/D) callsites S1 deferred (grounding lists them). A new ratchet
(`nature-routing-exhaustiveness`) asserts: every `COMPONENT_CATEGORY` key either has a nature
entry OR an explicit `{ chainExempt: <reason ≥40 chars> }` marker (mirrors the bench-coverage
shrink-only ratchet). This is the only structural guarantee that a component cannot *silently*
miss nature routing.

### FD8 — Fable reconciliation (operator decision #4)
No nature chain emits `claude-fable-5` (Fable is in no chain). A companion config change moves
`frameworkDefaultModels.claude-code` off `claude-fable-5` to the account default (Opus),
reconciling the Δ4 disagreement (spawned-session default `fable-5` vs escalation config
`opus-4-8`). A chain-validation lint assertion (FD4.2, extended) FAILS the build if any chain
position resolves to a Fable model. Fable stays reserved for deliberate escalation / high-level
consult (`models.tierEscalation`), never a routing default.

### FD9 — Increment split (dark, reversible, byte-identical when unset)
- **Increment A (first ship, DARK).** Exhaustive nature map + ratchet (FD7); the `chains` config
  schema + v3 defaults (FD2); the route resolver + S2 composition on the primary path (FD4);
  chains restricted to already-wired CLI doors — **metered-API positions are defined but resolve
  as unavailable (skipped)** until Increment B. Consequence stated honestly: CHAIN FAST's winner
  (Flash-Lite) is not reachable in A, so `MessageSentinel`'s latency lane stays on `pi-cli/gpt-5.5`
  (5.7s, 100%, subsidized) — the **Δ5 interim latency gap**, named, not hidden.
- **Increment B.** Wire the three metered-API doors (FD1) as first-class routing doors, reusing
  the bench metered funnel provider + the $0-fail-closed money gate. This makes the
  Flash-Lite / OpenRouter / Groq positions live.

Both increments are covered by THIS spec; the build sequences them. Each increment is independently
dark-shippable and byte-identical to today when `sessions.natureRouting` is unset.

### FD10 — Cheap-to-change-after (contested-and-cleared)
The **exact ordering of positions *within* a nature's chain** (e.g. whether SORT tries pi before
gemini-api) is `cheap-to-change-after`: it lives entirely behind the dark `sessions.natureRouting`
config gate, ships in `dryRun` first (FD11), touches **no** durable external side-effect / money /
identity / published interface, and a re-order is a one-line config edit reverted live. It is NOT
the door taxonomy, the safety composition, or the authority split — all of which touch safety-gate
routing and are frontloaded (FD1/FD4/FD6), never cheap-tagged.

### FD11 — Rollout & kill switch
- **Gate:** `sessions.natureRouting.enabled` (default false / omitted → byte-identical:
  `resolveFramework` returns today's category door, `options.model` unchanged).
- **dryRun:** `sessions.natureRouting.dryRun` (default **true** on first enable) — the resolver
  computes and LOGS the intended `(door, model)` + would-be swap tail to the routing audit, but
  passes through to today's behavior (no actual re-route). The observe-first canary.
- **Kill switch:** unset `sessions.natureRouting` → instant revert. Config is read **live per call**
  (reuse the existing hot-config `resolveConfig()` property — no restart, no session-start staleness).
- **Audit:** every resolved route, fallback landing, and S2 clamp is recorded through the existing
  `onDegrade` / `DegradationReporter` + `/metrics/features` surfaces, plus one append-only
  `logs/nature-routing.jsonl` (observability only — FD12).

## Proposed design (mechanics)

### Resolver
Introduce `resolveRoute(component, category, options, cfg): { door, model, swapTail }`, which
`evaluate()` calls when `cfg.natureRouting?.enabled`. Steps:

1. `nature = resolveNature(component, options.attribution?.nature)` (FD3).
2. `chain = chainForNature(nature)` (A→FAST unless the map row says SORT; B→JUDGE; D→SORT|WRITE;
   E→JUDGE — the exact chain is the map row's `chain`, already S1-validated).
3. `positions = cfg.natureRouting.chains[chain]` (config default = FD2).
4. `available = positions.filter(isAvailable)` (FD5: binary/key present, money-gate budget,
   circuit closed).
5. Apply FD4 clamp to each available position (primary + tail); WRITE exempt.
6. `primary = available[0]`, `swapTail = available[1..]`.
7. `dryRun` → log the plan, return today's route; else return `{ primary, swapTail }`.

`evaluate()` then sets `options.model = primary.model`, routes to `primary.door`, and — crucially —
**reuses the existing failure-swap loop verbatim** by feeding `swapTail` as the effective
`failureSwap` targets. The loop already applies `clampClaudeCliSwapModel`, per-target timeouts, the
total budget, and the degrade/resolve notes. S4 does **not** re-implement the swap loop; it only
supplies a nature-derived, per-position `(door, model)` sequence instead of the static
`cfg.failureSwap` framework list.

### Composition with the current signatures
`resolveFramework` keeps its signature and byte-identical unconfigured behavior. When
`natureRouting.enabled`, `evaluate()` delegates door+model selection to `resolveRoute`; when off,
the existing `resolveFramework` + caller `options.model` path is untouched. Metered doors introduce
a `RoutingDoor` superset of `IntelligenceFramework`; the swap loop's `resolveProvider` is extended
to build a metered-door provider (Increment B) exactly as it builds a CLI framework provider
(cached, never-throws, unavailable→skip).

### The money-gate for metered doors (Increment B)
Metered doors reuse the bench metered funnel's provider + its `$0-fail-closed` cap logic and its
durable `state/metered-ledger.*.jsonl`. A metered position is unavailable when the cap is reached
(fail-closed → the walk continues to the next door; a JUDGE call still lands on a CLI door, never
silently drops). The cap is enforced **per-machine** (matching the existing bench ledger); a
cross-machine spend aggregation is a NOTED follow-up (not S4 scope) — worst case is per-machine cap,
never unbounded, because each machine's gate independently fails closed at $0.

## Multi-machine posture

Default posture is **`unified`**; each surface is classified explicitly.

- **Route resolution (the feature itself): `unified`.** It is a **pure function** of
  `LLM_ROUTING_NATURE` (git-tracked code, identical on every machine) + `sessions.natureRouting.chains`
  (config, replicated by the operator like all config) + live door-availability. Same inputs → same
  `(door, model)` on any machine. No per-machine divergence by construction.
- **Metered-door key availability: `unified`** where the vault secret is present. Cross-machine
  secret sync (`multiMachine.secretSync`) already makes `metered_*` keys usable on every paired
  machine; a machine lacking the key simply skips that metered position (FD5) — graceful, not a
  coherence bug.
- **Money-gate spend ledger (`state/metered-ledger.*.jsonl`): machine-local, and it need not be
  unified.** Not a machine-local-justification-key case — a *cross-machine* posture would be
  *stricter* (shared cap), and its absence is a **documented, bounded follow-up**, not a silent
  single-machine assumption: each machine's gate fails closed at $0 independently, so the only cost
  of machine-local ledgers is that the *aggregate* cap can be up to N× the per-machine cap — a
  bounded over-spend, explicitly surfaced here, never an unbounded one.
- **Routing audit (`logs/nature-routing.jsonl`): machine-local observability, NOT a coherence
  surface.** It records `(door, model)` decisions that physically occurred *on that machine's
  process* — identical posture to `logs/server.log`, `logs/reaper-audit.jsonl`, and every existing
  `logs/*.jsonl`, which the multi-machine spec already treats as local-by-nature observability. It
  is append-only, has no cross-machine read, and strands nothing on topic transfer (a moved topic's
  future calls are audited on the new machine). No taxonomy key is required because it is **not a
  durable coherence-bearing state surface** — it is the established local-log pattern.

## Self-Heal Before Notify

The only operator-facing notice S4 adds is the **critical-gate routing-change** attention item
(FD6). It is placed strictly **downstream of self-heal**:

- **Self-heal is the fallback walk itself.** When a critical-gate's primary door fails, the walk
  lands on the next bench-sanctioned door and **serves the call correctly** — that IS the remediation
  (`remediation-actions`: re-resolve the chain onto the next available door; the call succeeds). The
  first-detection escalation path is **unreachable** — a single transient door blip never notifies.
- **Escalation only on durable degradation.** ONE deduped attention item surfaces only when a
  critical-gate route is degraded across **N=3** resolution ticks within a **10-minute** window
  (self-heal exhausted). `class: recoverable` (a door outage is recoverable — the call is still
  served). Brakes (P19, reusing the existing `DegradationReporter` + breaker primitives — NO new
  engine): `max-attempts: 3`, `backoff: exponential`, `dedupe-key: nature-route:<component>`,
  `breaker: 5-heals-in-30m → auto-reclassify critical → escalate immediately`,
  `max-notification-latency: 300s` (≤ `standards.selfHealBeforeNotify.recoverableLatencyCeiling`),
  `audit-location: logs/nature-routing.jsonl` (scrubbed, metadata-only — door ids + component names,
  never prompt content or secrets).
- **No irreversible/data-loss/security class here.** A routing degradation is recoverable by
  definition (a sanctioned fallback serves the call), so the recoverable heal-first path is correct,
  not a mislabel. `onResolved` (existing) auto-clears the degradation when the primary door recovers.
- **Reuses the `SelfHealGate` pattern** over Instar's existing in-process breaker primitives
  (`CrashLoopPauser` + the DegradationReporter breakers already threaded through the router), never a
  new external workflow engine.

## Testing plan (Testing Integrity Standard — all three tiers)

- **Unit** (`tests/unit/`): `resolveNature` (map hit / caller-override-stricter / unmapped
  fall-through); `resolveRoute` walk (skip-unavailable, primary+tail, FD4 clamp on primary AND tail,
  WRITE-exempt); the FD4 chain-validation lint (rejects `(claude-code, capable)` in FAST/SORT/JUDGE,
  accepts it in WRITE); FD7 exhaustiveness ratchet; FD8 no-Fable assertion; dark/dryRun pass-through
  (byte-identical when unset). Both sides of every boundary.
- **Integration** (`tests/integration/`): the `/intelligence/routing` surface reports the resolved
  `(door, model)` per component with nature-routing enabled; the money-gate skip (metered cap
  reached → walk continues to a CLI door) over the real HTTP pipeline.
- **E2E** (`tests/e2e/`): production init path — with `natureRouting.enabled`, a benched critical-gate
  component resolves its JUDGE chain end-to-end and NEVER lands opus-via-CLI; the critical-gate
  attention item fires only after durable degradation, never on a transient blip; unset config →
  the feature is inert (byte-identical), route returns today's behavior (alive, not 503).
- **Wiring integrity:** the resolver's deps (nature map, chain config, money-gate, DegradationReporter)
  are non-null and delegate to real implementations — not no-ops.

## Migration Parity

- **Config defaults** (`migrateConfig`): add `sessions.natureRouting` with `enabled:false` +
  `dryRun:true` + the FD2 default chains, only if missing (existence-checked, idempotent). Existing
  agents get the (dark) schema on update; behavior is byte-identical until an operator flips it.
- **CLAUDE.md template** (`generateClaudeMd` + `migrateClaudeMd`): add a "Nature-Axis Routing"
  capability blurb (what it is, the `GET /intelligence/routing` read, the enable/dryRun/kill knobs,
  the authority split) so the capability is discoverable — content-sniffed guard.
- **No hook/skill changes.** Pure `src/` + config + docs.

## Decision points touched
- **Adds** a route-resolution gate (nature → chain → `(door, model)`) — dark by default, reversible,
  byte-identical when unset.
- **Extends** the S2 clamp's reach (swap-loop-only → primary path too) — strictly narrows a
  dangerous fallback, never upgrades/blocks.
- **Adds** a critical-gate routing-change attention item — downstream of self-heal, deduped,
  recoverable-class.
- **Removes** nothing; the unconfigured path is untouched.

## Open questions
*(none — all operator decisions are frontloaded in FD1–FD11; there are no unresolved user-decisions.)*
