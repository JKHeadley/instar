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
`FULL-REPORT-ELI16.md`) proved the *right* route is a function of **task nature**, not category
and not model:

- **The door penalty.** Identical Opus 4.8 scores **99.1% via a clean API** but **81.7% via the
  Claude Code CLI** (17.4-pt penalty). On the completion judge: **100% API vs 35% CLI**. On
  emergency-stop: Opus-CLI **73%** (missed canonical STOP commands). The Claude Code harness wraps
  every prompt in ~20k tokens of "helpful coding agent" framing.
- **The paradox (ELI16 §7.12).** Opus-via-Claude-Code-CLI is *simultaneously* the **WORST** route
  for bounded verdicts (completion-judge 35%) and the **BEST** for open-ended writing (9.1/10) —
  which is *why* routing must be per-nature.

Two prerequisites are already **merged on `JKHeadley/main`** (PR #1352):

- **S1 — the nature map.** `src/data/llmBenchCoverage.ts` exports `TaskNature` (`A|B|D|E`),
  `RoutingChain` (`FAST|SORT|JUDGE|WRITE`), `RoutingNature`, `LLM_ROUTING_NATURE` (read-only,
  bench-cited component→`{nature,chain}` map), and `llm-routing-nature-ratchet.test.ts`. It is
  **advisory metadata only** and deliberately **non-exhaustive** — it "changes NO routing today",
  leaving actuation to S4.
- **S2 — the safety clamp.** `clampClaudeCliSwapModel(target, requested)` in `IntelligenceRouter.ts`
  clamps a failure-swap landing on `claude-code` requesting `capable` down to `balanced`
  (Sonnet CLI). It is invoked **only** inside the failure-swap loop today (see FD4 for the reach
  gaps this spec closes).

**S4 is the actuation.** Make the router resolve a concrete **(door, model)** by
**nature → chain → door-availability**, apply the v3 chains as **config defaults**, compose with
(and structurally harden) the merged S2 clamp, and ship **dark & reversible first** (fleet behavior
byte-identical when the nature-routing config is unset).

## Frontloaded Decisions

Every decision below is **resolved**; `## Open questions` is empty by construction.

### FD1 — Door taxonomy (operator-authoritative)
A **RoutingDoor** is a concrete access path to a model, in two classes:

- **CLI doors** — already `IntelligenceFramework`, already wired: `pi-cli`, `codex-cli`,
  `gemini-cli`, `claude-code`.
- **Metered-API doors** — NEW, backed by the existing bench metered funnel + its money gate; wired
  in **Increment B** (FD9), gated by an explicit operator go-live authorization (FD12). Each is keyed
  to a vault secret Echo already holds (verified `secret-get.mjs --names`, 2026-07-04):
  - `gemini-api` → `metered_gemini_bench` — Gemini 3.1 Flash-Lite (FAST winner) + Gemini 3.x.
    **Operator decision #2:** use the metered Gemini key for LIVE Gemini-tier routing; keep the
    existing money gate; never exceed the cap.
  - `openrouter-api` → `metered_openrouter_bench` — GPT-5.5 API + **Opus-4.8 clean API** (the JUDGE
    "never-CLI" reserve).
  - `groq-api` → `metered_groq_bench` — gpt-oss-120B (WRITE, **non-injection only** — enforced by
    FD5b, not a doc label).

**Operator decision #1 (authoritative):** GPT-5.5-tier work routes via **`pi-cli` as PRIMARY**
(bench: 100% adversarial, 5.7s — the fastest GPT-5.5 door), with `codex-cli` and `openrouter-api`
as fallbacks. **There is NO OpenAI direct-API key and one MUST NOT be required.** *Why pi-cli over a
direct `openai-api` door (gemini Ge3-1):* the bench measured pi's wrapper at ~1k tokens of framing vs
codex's ~10k — pi is the *cleanest* GPT-5.5 door short of a raw API key, and it rides the existing
ChatGPT subscription (no new billed key, no ToS-fenced backend). The **dependency risk** of a bespoke CLI
is real and acknowledged: it is mitigated by the two subscription fallbacks (`codex-cli`) and the clean
metered `openrouter-api` GPT-5.5 position immediately behind it in JUDGE, so a pi-cli outage degrades to a
measured-equivalent door, not a wall. Consequently
**there is no `openai-api` door** — every chain (FD2) is authored using only the doors above; a
position needing an OpenAI-direct key does not exist in any chain. (This removes the phantom
`openai-api/*` positions the seed draft carried.)

### FD2 — Chain-position model
A **chain position** = `{ door, model, keyRef?, moneyGated?, injectionSafe?, claudeBanned? }` where
`model` is a **benchmark label** that resolves to a concrete adapter model id (FD-LABEL). A **chain**
is an ordered default→fallback ladder. The four chains (ELI16 §11), authored as config defaults,
using ONLY Echo's real doors (no `openai-api`):

- **FAST** (latency-sensitive quick-sort): `gemini-api/flash-lite` → `pi-cli/gpt-5.5`.
- **SORT** (background quick-sort): `codex-cli/gpt-5.4-mini` → `pi-cli/gpt-5.5` → `gemini-api/flash-lite`
  → `claude-code/balanced` *(Sonnet-4.6 reserve)*.
- **JUDGE** (careful judgment): `pi-cli/gpt-5.5` → `codex-cli/gpt-5.5` → `openrouter-api/gpt-5.5`
  → `openrouter-api/opus-4.8` *(clean API, **NEVER CLI**)* → `claude-code/balanced` *(Sonnet-4.6 reserve)*.
- **WRITE** (open-ended writing): `codex-cli/gpt-5.4-mini` → `groq-api/gpt-oss-120B` *(non-injection only)*
  → `claude-code/fast` *(Haiku-4.5)* → `claude-code/capable` *(Opus-4.8 quality lane — allowed, FD4)*.

The chain table lives at `sessions.natureRouting.chains` (config default = the four above); an
operator MAY override a chain wholesale — subject to the **resolve-time validation** in FD4 (an
override is not exempt from the harness-door ban). Per-position models resolve through the existing
per-adapter maps (`resolveModelForFramework` / `TIER_TO_MODEL`); metered-door model ids resolve in
the metered adapter (Increment B).

### FD-LABEL — benchmark label vs resolved model id (codex C5)
A position's `model` is a **benchmark label** (`flash-lite`, `gpt-5.5`, `opus-4.8`, `balanced`), NOT
a raw provider id. Resolution to a concrete id goes through the per-adapter maps + the merged
model-registry-freshness manifest (`scripts/model-registry-freshness.manifest.json`, S6 substrate).
A lint (`lint-nature-chains.mjs`, FD4.2) validates that **every** chain position's label resolves to
an **adapter-supported id** (reusing `frontierSetForDoor()` / the freshness lint) — so a re-slot
(GPT-5.6 lands) is a manifest edit, never a chain rewrite, and a typo'd label fails the build.

### FD3 — Nature signal origin: **static per-component map**, with per-operation keys
Nature is resolved from `LLM_ROUTING_NATURE` (extended exhaustive over `COMPONENT_CATEGORY` — FD7),
NOT a per-call classifier and NOT bare caller-declaration. Rationale: nature is a **stable property
of the callsite**; a classifier would add an LLM call to route an LLM call (cost + recursion) and be
gameable by injected input; the static map is deterministic, auditable, ratchet-enforced
(Structure > Willpower).

- **Per-operation route keys (codex C3).** A multi-mode component keys nature on the already-supported
  `attribution.component` **"/segment" suffix** (`categoryForComponent` strips it today). E.g.
  `CompletionEvaluator/judge` = `{B,JUDGE}` while `CompletionEvaluator/classify` = `{A,SORT}`. A unit
  test asserts a critical operation **cannot inherit** a low-stakes sibling's default.
- **Precedence for a caller-declared `attribution.nature`** (opt-in, tightening-only): the resolver
  takes the **stricter** of map-vs-declared by the full ordering **`E, B ≥ D ≥ A`** (the safe direction —
  a judgment call never silently downgrades to a sorter). Nature `E` is explicitly included (closes Sec3).
  **E vs B are EQUIVALENT (both JUDGE-tier); a map-vs-declared tie between two same-tier natures resolves
  to the MAP value** (codex CR2-2) — the override can only *raise* the tier, never swap within a tier and
  never widen. **The override tightens the NATURE only; the CHAIN always follows the map row for the
  resolved nature** — a caller cannot declare a chain directly (E and B both map to JUDGE, so the
  resolved chain is JUDGE either way). A declared value outside `{A,B,D,E}` is ignored (map wins).
- **Trust boundary (Sec4).** `attribution.*` MUST originate from **callsite code**, never from a
  field derived from model/user content. A `nature` value **outside `{A,B,D,E}`** is ignored — the
  static map wins (fail-safe); an override can only ever *tighten*, never widen.
- A component with **no** map entry falls through to **today's category routing** (byte-identical safe
  default), but the FD7 ratchet forbids that state for any benched component.

### FD4 — The harness-door ban (operator decision #3, R1/R2/S2) — structurally unbreakable
**The measured-banned route is `(claude-code door, Opus/capable-FAMILY model)` for any bounded/gating
(FAST/SORT/JUDGE) call.** The penalty is the harness framing on a *credulous* model; it is severe for
Opus and negligible for Sonnet-4.6-CLI (bench: 99.5%, 28/28 traps — it *beats* Sonnet-5-API on bounded
gates). So the precise invariant — reconciling operator decision #3 ("clean doors, never the harness
door") with the merged S2 clamp (which clamps to Sonnet-CLI, not removal) — is:

> **INVARIANT:** No FAST/SORT/JUDGE call may resolve to an **Opus-family** model on the `claude-code`
> door, at ANY exit (primary, swap tail, OR degrade-to-default). The **only** permitted `claude-code`
> position in a bounded/gating chain is the terminal **`balanced` (Sonnet-4.6-CLI) last-resort
> reserve**, reached only when every cleaner door is simultaneously unavailable (failing a safety gate
> fully closed is worse than serving it on the sanctioned 99.5% reserve). **WRITE is exempt** — R1
> scopes to *bounded verdicts*; open-ended writing is where Opus-via-CLI is the *best* route.

Enforcement in **THREE** independent places (a single lint is insufficient — Sec1/Adv2/Adv3):

1. **Resolve model→concrete-id, then ALLOWLIST (deny-by-default), never a denylist.** Every position's
   label is resolved to a concrete id; on the `claude-code` door in FAST/SORT/JUDGE the resolved id must
   equal the **single sanctioned reserve id** (the Sonnet-4.6-CLI `balanced` id) — **anything else is
   rejected**. This is deliberately an allowlist, not "ban Opus-family": a denylist fails OPEN on a
   *future or unrecognized* capable Claude id the family-map hasn't seen (a new Opus rev, a renamed max
   tier) — the exact Adv3 class, just moved from tier-token to family-token (sec-r2-1). Deny-by-default
   closes it: an id is permitted on that door/chain only if it IS the sanctioned reserve. A
   `{door:'claude-code', model:'claude-opus-4-8'}` (or any non-reserve id) can no longer slip past. The
   merged `clampClaudeCliSwapModel` is **extended** to this allowlist predicate (clamp any non-reserve
   claude-code FAST/SORT/JUDGE selection to the reserve id).
2. **Build-time lint** (`lint-nature-chains.mjs` + ratchet test): the build FAILS if any FAST/SORT/JUDGE
   chain default carries an Opus-family `claude-code` position; WRITE exempt by name. Also encodes the
   R3–R8 bans (FD5c).
3. **Resolve-time assertion over LIVE/hot config** (Adv2/Sec1): because chains are read live per call
   and an operator may `PATCH /config` a chain wholesale, the same validator runs on **config load and
   on each hot-read** (cheaply, cached by config-hash). An invalid live chain is **rejected → falls back
   to the built-in defaults** and raises the FD6 attention item — a runtime chain edit can never open the
   banned route.

Plus the **runtime clamp is applied at every model-selection exit**, including the **degrade-to-default
path** (`evaluate()` lines 406–421) that the reused router currently leaves **UNCLAMPED** (LA4 —
a genuine fail-open in `main`: a binary-missing degrade with `defaultFramework==='claude-code'` +
`capable` lands Opus-via-CLI). **This degrade-path clamp is UNCONDITIONAL — it does NOT depend on
`natureRouting.enabled`** (LA4-r2). The fail-open exists in `main` independent of nature routing, and
nature routing ships **dark on the fleet**, so a clamp scoped behind the feature would leave the real
fail-open LIVE on the fleet in the default state. It is therefore shipped as a **standalone safety
narrowing in Increment A**, active even when nature-routing is unset. **Honest consequence:** the
unconfigured degrade path is NOT byte-identical (a binary-missing bounded/gating `capable` degrade to a
`claude-code` default changes Opus-CLI → Sonnet-4.6-CLI). This is the **one intentional deviation** from
"byte-identical when unset", it is strictly the safe direction (a measured-worse route → the sanctioned
reserve), and the byte-identical claim elsewhere in this spec is explicitly scoped to *exclude* this
safety clamp. A test asserts the degrade clamp fires with `natureRouting` UNSET, for BOTH
`defaultFramework` values.

- **Critical gates may never resolve chain WRITE / nature D (Adv1).** A ratchet asserts **no** FD6
  critical-gate component resolves **chain WRITE** — critical gates are nature **B (JUDGE)** OR nature **A
  (FAST/SORT)** (e.g. `MessageSentinel`, the R2 emergency-stop classifier, is nature A / injection-exposed
  / Flash-Lite-pinned — a legitimate FAST/SORT critical gate), but **never D/WRITE**. This is the precise
  invariant: WRITE is the sole Opus-CLI-exempt lane, so the hazard is a gate *authored* as `{D,WRITE}` to
  sneak onto it — not "a gate that isn't JUDGE." (An earlier draft over-stated this as "must be B/JUDGE",
  which would have wrongly failed on the nature-A `MessageSentinel`; the correct rule is chain ≠ WRITE.)
- **`chainExempt` is forbidden for FD6 critical gates (Adv5)** — a critical gate must carry a real
  nature entry, never a 40-char filler exemption.

### FD5 — Door-availability walk, injection-exposure gate, and the R-rules
**(a) Availability walk, with structured reason codes.** Resolution walks the nature's chain positions in
order. A position is **available** iff its door is reachable (CLI binary present / metered key present AND
money-gate budget > 0 — FD12) AND its circuit breaker is closed AND (FD5b) it is injection-eligible for
this call. The **first available** position is the PRIMARY `(door, model)`; the remaining available
positions become the ordered **failureSwap tail** fed to the existing swap loop. An unavailable position
is **skipped**, never a hard error — and every skip carries a **structured reason code** (codex CR2-4)
separating static capability from transient health: `unsupported` (no such door) / `notConfigured`
(binary/key absent) / `budgetClosed` (metered cap ≤ 0) / `breakerOpen` (circuit) / `policySkipped`
(R-rule/allowlist ban) / `injectionUnsafe` (FD5b). Reason codes appear in `logs/nature-routing.jsonl` and
`GET /intelligence/routing` so "why did this route change?" is answerable without guessing. Concrete Echo walks (no OpenAI key):

- FAST → `gemini-api/flash-lite` (Increment B) then `pi-cli/gpt-5.5`.
- SORT → `codex-cli/gpt-5.4-mini` → `pi-cli/gpt-5.5` → `gemini-api/flash-lite` → `claude-code/balanced`.
- JUDGE → `pi-cli/gpt-5.5` → `codex-cli/gpt-5.5` → `openrouter-api/gpt-5.5` → `openrouter-api/opus-4.8`
  → `claude-code/balanced`.
- WRITE → `codex-cli/gpt-5.4-mini` → `groq-api/gpt-oss-120B` → `claude-code/fast` → `claude-code/capable`.

**(b) Injection-exposure gate (Sec2/LA1/codex CR3-2 — `injectionSafe` is enforced STATICALLY, not a
per-call caller flag).** Injection exposure is a **static per-component / per-operation property** — a
parallel exhaustive map (`LLM_ROUTING_INJECTION_EXPOSURE`, ratchet-enforced over `COMPONENT_CATEGORY`
like the nature map) that **defaults to `exposed: true` (fail-safe)**; a component is `exposed: false`
ONLY when explicitly audited as carrying no untrusted content. This closes the exact failure class the
static-nature decision (FD3) closes: relying on a per-call `attribution.injectionExposed` flag means one
forgotten callsite silently enables a non-injection-safe door. A per-call `attribution.injectionExposed:
true` may only **tighten** (mark an otherwise-trusted call exposed), never relax a statically-exposed
component. `isAvailable` **skips** any position marked `injectionSafe: false` (e.g. `groq-api/gpt-oss-120B`)
whenever the component is exposed (static OR per-call), and treats **missing/unknown exposure as
exposed** (fail-closed skip). So an injection-exposed WRITE call can never land on the non-injection Groq
door — enforced by the exhaustive static map, not caller diligence.

**(c) The R-rule lints (LA2/LA3, R3–R8).** The FD4.2 lint additionally asserts, over the chain
defaults AND live config:
- **R6 (absolute):** doc-tree / cartographer components carry `claudeBanned: true` and **no chain
  position may route them to any `claude-code` door** — nature routing must NOT re-open the Claude route
  that `CartographerSweepEngine.probeRouting()` already forbids. Their WRITE chain uses off-Claude doors
  only (codex → groq); if all are down the call **fails closed to the caller's heuristic**, never Claude.
- **R8:** input-classifier-nature components (`InputClassifier`, `MessageSentinel`, `TaskClassifier`) are
  marked `injectionExposed` and **pinned off the `gemini-api/flash-lite` position** (Flash-Lite's one
  reproduced trap-fall is exactly the input-classifier slot) — their FAST/SORT walk skips Flash-Lite.
- **R4/R7:** `gemini-cli` (consumer Flash 2.5) and any DeepSeek door never take an injection-exposed
  JUDGE position. **R5:** gpt-oss-20B / Llama-4-Scout never take a gate (JUDGE) position. **R3:**
  Qwen-tier-on-Groq never takes a strict-format position. (The chains as authored already exclude these
  doors; the lint makes their exclusion *structural* so a future edit can't reintroduce them.)

### FD6 — Authority split + the critical-gate routing notice (operator decision #5)
- **LOW-STAKES (auto-apply).** Nature **A** (FAST/SORT bounded sorters) and nature **D** (background
  digests) that are **not** safety gates — `CommitmentSentinel`, `TemporalCoherenceChecker`,
  `PresenceProxy`, `TaskClassifier`, `TopicIntentExtractor`, `SessionActivitySentinel`,
  `SessionSummarySentinel`, `correction-learning`. Bench-recommended chain = config default, active the
  moment nature-routing is enabled; a future S6 reslot for these MAY auto-apply.
- **CRITICAL-GATE (operator review, NEVER auto-ship).** Nature **B** JUDGE safety gates —
  `MessagingToneGate`, `CompletionEvaluator`, `ExternalOperationGate`, `LLMSanitizer`,
  `CoherenceReviewer`, `UnjustifiedStopGate`, `SessionWatchdog`, `StallTriageNurse`,
  `ProjectDriftChecker` — **plus** `MessageSentinel` (nature A, R2-critical). `autoApply:false`.

**The routing notice — precise trigger (codex C2/Adv4/Adv6).** Two distinct events:
1. **Route-DRIFT** (not a call failure): a critical-gate's resolved **primary `(door, model)` differs
   from the operator-reviewed baseline** AND that divergence **persists ≥ N=3 resolution ticks within
   10 min** (self-heal exhausted — a transient blip that recovers before N ticks is silent). → **ONE
   AGGREGATED `HIGH` attention item PER MACHINE PER DRIFT EPISODE** — when several critical gates drift
   in the same window from a **common cause** (e.g. `pi-cli` down drifts every JUDGE gate at once), they
   collapse into **one** item that enumerates the affected gates + the shared cause + each new resolved
   route, NOT one item per gate (Bounded Notification Surface — a fleet-wide door outage must not fan out
   ~10 HIGH items). It is **HIGH so the topic-flood guard never coalesces it away** (Adv6) — aggregation,
   not suppression, is how HIGH visibility and the no-flood bound are both honored (the standard instar
   aggregate-per-collection pattern). Per-machine still (dedupe-key `nature-route-episode:<machineId>`);
   pool-level coalescing across machines remains the tracked follow-up (§Close-the-Loop, Int5) — bounded,
   because per-machine aggregation already caps it at one-per-machine.
2. **Critical-gate on the terminal `claude-code/balanced` reserve → IMMEDIATE escalation** (Adv4),
   bypassing the N=3 debounce: a safety gate running on the harness-penalized reserve door (even the
   sanctioned Sonnet reserve) in the CLI-miss regime must be surfaced at once, never silently for up to
   10 min. This is the notify-and-heal path (the reserve still serves the call).

A **call FAILURE** served by a fallback is *self-healed* (the fallback IS the remediation) and is **not**
a notice. Dedupe/audit are per-machine (consistent with the attention-queue local posture); **pool-level
coalescing** is a tracked follow-up (§Close-the-Loop, Int5).

**Baseline lifecycle (codex CR2-3).** The "operator-reviewed baseline" is a durable per-component record
`{ component, door, model, reviewedAt }` in `state/nature-routing-baseline.json` (machine-local
observability, versioned by `schemaVersion`). It is **initialized at first-enable** from the resolved
route the dryRun plan computes for each critical-gate component (the dryRun plan the operator reads
before flipping `dryRun:false` IS the proposed baseline). It **updates only on an explicit PIN-approved
operator acceptance** of a routing change (the same agent-proposes-operator-approves surface as FD12,
reused) — a fallback landing or an S6 reslot never mutates the baseline silently; it triggers the FD6
drift notice against the unchanged baseline. Migration carries the baseline forward; a component with no
baseline row yet (newly benched) is treated as "no drift" until its first review.

### FD7 — Exhaustive nature map + ratchet
`LLM_ROUTING_NATURE` is extended to cover **every** `COMPONENT_CATEGORY` key (resolving the multi-nature
A/B, B/D callsites S1 deferred, using per-operation keys — FD3). A ratchet
(`nature-routing-exhaustiveness`) asserts: every `COMPONENT_CATEGORY` key has a nature entry OR an
explicit `{ chainExempt: <reason ≥40 chars> }` marker — **except** FD6 critical gates, for which
`chainExempt` is forbidden (Adv5). Doc-tree/cartographer components carry `claudeBanned` (FD5c/R6).

### FD8 — Fable reconciliation (operator decision #4) — **requires a session restart**
No nature chain emits `claude-fable-5`; the FD4.2 lint FAILS the build if any chain position resolves to
a Fable model. A **companion config change** moves `frameworkDefaultModels.claude-code` off
`claude-fable-5` to the account default (Opus), reconciling the Δ4 disagreement (spawned-session default
`fable-5` vs escalation `opus-4-8`). **Honesty (LA6):** `frameworkDefaultModels` is read at **session
spawn (boot)**, NOT per-call like the routing config — so this companion change does **nothing to
running sessions until they restart** (`POST /sessions/restart-all`). It is therefore **scoped OUT of the
per-call hot-config / dark-toggle claim**: the per-call *routing* is hot and reversible; the spawned-
session default reconciliation is a boot-read change requiring a restart to take effect. Fable stays
reserved for deliberate escalation (`models.tierEscalation`), never a routing default.

### FD9 — Increment split (dark, reversible, byte-identical when unset)
- **Increment A (first ship).** Exhaustive nature map + ratchet (FD7); the `chains` config schema + v3
  defaults (FD2); the route resolver + the FD4 three-place ban enforcement (incl. the LA4 degrade-path
  clamp fix); the FD5 walk + injection gate + R-rule lints. **Metered-API positions are defined but
  resolve as unavailable (skipped)** until Increment B. Consequence stated honestly: FAST's winner
  (Flash-Lite) is unreachable in A, so `MessageSentinel`'s latency lane stays on `pi-cli/gpt-5.5` (5.7s,
  100%, subsidized) — the **Δ5 interim latency gap**, named.
- **Increment B.** Wire the three metered-API doors (FD1) reusing the bench metered funnel provider +
  money gate, behind the FD12 go-live authorization. This makes Flash-Lite / OpenRouter / Groq positions
  live.

Both increments are covered here; each is independently dark-shippable and byte-identical to today when
`sessions.natureRouting` is unset — **with the single, deliberate exception of the LA4 unconditional
degrade-path clamp** (FD4), which is a standalone safety narrowing (Opus-CLI → Sonnet-CLI on the
binary-missing bounded/gating degrade) that fires even when nature routing is off.

### FD10 — Cheap-to-change-after (narrowed after contest — DC1)
`cheap-to-change-after` applies **ONLY** to reordering **CLI-only positions within a nature-A/D,
non-critical-gate FAST or SORT chain** — no metered position (money) and no JUDGE/critical-gate position
(routing of a safety gate) is ever cheap. Reordering the position of a `gemini-api`/`openrouter-api`/
`groq-api` position (real spend) or any JUDGE position (the resolved door of `MessagingToneGate` et al.,
`autoApply:false` per FD6) is **NOT cheap** — it is frontloaded / critical-gate-reviewed. The
Decision-Completeness reviewer's contest is accepted and the tag is narrowed accordingly.

### FD11 — Rollout, maturation ladder, migration, kill switch
- **Maturation ladder (gate G1 — ships enabled on dev agents).** `sessions.natureRouting.enabled` is
  **omitted from the shipped config** so it rides the **`resolveDevAgentGate`** ladder: **LIVE (in
  `dryRun`) on a development agent, DARK on the fleet** — the standard instar maturation path, not a flat
  default-false. On the fleet an explicit operator enable is required.
- **dryRun** (default **true** on first enable): the resolver computes and LOGS the intended
  `(door, model)` + would-be swap tail + clamp landings, but passes through to today's behavior (no actual
  re-route). The observe-first canary.
- **Readable canary (Int4/Ge3).** `GET /intelligence/routing` exposes, per component, the **dryRun
  resolved plan** — primary `(door, model)`, available vs skipped positions (with skip reason), clamp
  landings, and a **diff against the current enforced routing** — so an operator can read the full impact
  before flipping `dryRun:false`. This is the read-surface that S6's routing-defaults-diff gate builds on.
- **Versioned migration (Int2).** `sessions.natureRouting` carries a `schemaVersion`. `migrateConfig`
  adds the block if missing AND **migrates chain defaults forward on a version bump** (existence-checked
  per-version, idempotent) — so a future v4 chain reslot reaches EXISTING agents, not just new ones. An
  operator who has hand-overridden a chain keeps their override (migration only touches un-overridden
  defaults).
- **Kill switch:** unset `sessions.natureRouting` → instant revert of all nature *routing*. Routing config
  is read **live per call** (`resolveConfig()`); no restart. Two deliberate carve-outs from "revert to
  exactly today": (i) the **LA4 unconditional degrade-path clamp** (FD4) is a standalone safety narrowing
  that stays active regardless — unsetting the feature does NOT restore the Opus-CLI degrade fail-open;
  (ii) FD8's session-default (Fable→Opus) is a boot-read companion, restart-gated. Everything else reverts
  live.
- **Audit:** every resolved route, fallback landing, and clamp is recorded via the existing `onDegrade` /
  `DegradationReporter` + `/metrics/features`, plus one append-only `logs/nature-routing.jsonl`
  (observability only — see Performance §).

### FD12 — Metered go-live authorization + money semantics (DC2/C6)
Metered doors (Increment B) are **money-spending on the hot path** (FAST's primary is a paid door
running continuously). Therefore:

- **PIN-gated go-live (agent proposes, operator approves — gate GR2-1/GR2-2, sec-r2-2).** Live paid
  routing is a money authorization, so it must clear the **operator PIN surface**, NOT a config bool the
  agent can flip via `PATCH /config` (a Bearer token is structurally insufficient — capability ≠
  authority). The flow: the **agent PRE-FILLS a structured proposal** (a suggested per-window cap derived
  from projected metered spend at current call volume) surfaced on the dashboard Subscriptions/Metered
  panel; the **operator approves it with the dashboard PIN**, which writes the cap into `metered-caps.json`
  and sets `metered.goLive:true` server-side. Until that PIN-approved authorization exists, Increment B is
  inert and the walk uses CLI doors only. The *authorization mechanism* is fully frontloaded (agent-
  proposes-operator-PIN-approves, mobile-complete); the specific cap *value* is the operator's approval-time
  choice (the agent proposes a default) — so no build-stop decision is parked.
- **Money semantics (C6).** "Fail-closed" means: a metered door is available **only while remaining budget
  > 0**; when the cap is exhausted (remaining ≤ $0) the door is skipped and the walk continues to a CLI
  door (a JUDGE call still lands on a CLI door, never silently drops). Caps are **USD**; an **unknown
  per-call price → refuse** (skip the position). This is the existing bench metered-funnel discipline,
  reused verbatim.
- **Multi-machine money safety (Int1/Ge2/gate-G2), with FAIL-CLOSED N-detection (M2/sec-r2-3).** The
  spend ledger must be **unified** to keep the cap meaningful across the fleet. Metered doors are
  **DISABLED (fail-closed) on any multi-machine deployment until a shared/replicated spend ledger exists**.
  The "is this a single machine?" test is keyed on whether **multi-machine is CONFIGURED** — the session
  pool is enabled OR any peer has EVER been registered (a durable fact) — **NOT on live peer
  reachability**. Keying on reachable peers would fail OPEN: a partitioned/transiently-dark machine reads
  N=1, enables paid routing, and both machines double-spend against their local counters when the peer
  returns (the exact $X→$X×N exposure). Under any uncertainty about pool membership (unknown / transient /
  degraded), the machine assumes **N>1 (metered OFF)** — fail-safe. Only a machine that is durably,
  configuredly single is metered-eligible (its ledger is then trivially unified and exact). The shared
  cross-machine ledger is a **same-PR-tracked Close-the-Loop prerequisite** (§Close-the-Loop) — a hard
  precondition, not a deferral: multi-machine metered routing is simply unavailable until it lands.

## Proposed design (mechanics)

### Resolver
Introduce `resolveRoute(component, category, options, cfg): { door, model, swapTail } | 'fall-through'`,
which `evaluate()` calls when `cfg.natureRouting?.enabled`. Steps:

1. `nature = resolveNature(component, options.attribution?.nature)` (FD3: map + per-op key + `E,B≥D≥A`
   tighten; non-enum ignored).
2. `chain = chainForNature(nature)` (the map row's `chain`, S1-validated).
3. `positions = validated(cfg.natureRouting.chains[chain])` — FD4.3 resolve-time assertion; an invalid
   live chain → built-in defaults + FD6 notice.
4. `available = positions.filter(p => isAvailable(p, options))` — FD5 (door reachable, breaker closed,
   metered budget>0, injection-eligible, R-rule-eligible). Verdicts cached behind a short TTL (Performance §).
5. **Empty `available` — nature-aware, NEVER a blanket legacy fall-through (codex CR3-1).** A blanket
   fall-through to today's category routing is unsafe for a mapped gate: legacy category routing does not
   respect the R-rules, the allowlist ban, the injection gate, the doc-tree Claude-ban, or the baseline —
   it could route a safety gate onto `claude-code`+opus, re-opening the banned route the whole spec closes.
   So the empty-set branch splits by whether the component carries static routing constraints:
   - **Unmapped / non-benched component** (no `LLM_ROUTING_NATURE` entry, no static bans) ⇒ return
     `'fall-through'` → today's category routing (the LA5 byte-identical safe default). This is the ONLY
     fall-through case.
   - **Mapped FD6 critical gate, or ANY component with a static ban** (`claudeBanned`/R6, injection-exposed,
     R-rule-constrained) ⇒ **FAIL CLOSED**: return no route so `evaluate()` uses the **caller's existing
     gating fail-closed semantics** (a safety gate fails closed, never open) — NEVER legacy category
     routing. (In practice a JUDGE gate's terminal `claude-code/balanced` reserve is a keyless CLI door,
     so "all unavailable" only occurs if even the `claude-code` binary is missing — the exact case where
     failing the gate closed is correct.) `never available[0]` on an empty array.
6. Apply the FD4 family clamp to each available position (primary + tail; WRITE exempt).
7. `primary = available[0]`, `swapTail = available[1..]`.
8. `dryRun` → log the plan (FD11 readable canary), return `'fall-through'`; else return
   `{ primary, swapTail }`.

`evaluate()` then sets `options.model = primary.model`, routes to `primary.door`, and **reuses the
existing failure-swap loop verbatim** by feeding `swapTail` as the effective swap targets — the loop
already applies the (now family-extended) clamp, per-target timeouts, the total budget, the rate-limit
backoff rung, and the degrade/resolve notes. S4 does **not** re-implement the swap loop.

### Routing policy model (codex C4) — reuse, don't reinvent
S4 does not invent a new health/retry/load-shed engine; it maps the nature walk onto the router's
**existing** primitives:
- **Eligibility predicate** = `isAvailable` (FD5).  **Priority** = chain order (FD2).
- **Health** = the existing per-framework **circuit breaker** state (a metered door gets its own breaker,
  built like a CLI framework) + a **short-TTL availability cache** (Performance §).
- **Retry budget** = the existing `gatingLadderBudgetMs` / `swapAttemptTimeoutMs` / `swapTotalBudgetMs`.
- **Never-silent** = the existing `onHeuristicFallthrough` / `DegradationReporter` (No-Silent-Degradation).
- **Herd control** = the existing per-target breakers PLUS the new sticky-primary / jittered admission
  (Performance §, S3) so a whole tier does not reslot off one transient blip.

**Evaluator boundary (codex CR2-5 — this is not a mini rule-engine).** `resolveRoute` is a **pure,
side-effect-free evaluator** over three declarative inputs — `{ chains, per-position availability,
static bans }` — returning `{ primary, swapTail } | 'fall-through'`. It owns NO stateful policy
machinery: retry, backoff, circuit-breaking, budget accounting, and the swap execution all remain in the
existing `IntelligenceRouter` primitives (unchanged). The only new *stateful* pieces are the in-memory
spend counter (Performance §S1) and the short-TTL availability cache (§S4), both read-through caches over
existing state, not a new engine. This bounded surface is the deliberate answer to "don't grow a service-
mesh policy layer": the schema is small (a chain is an ordered list of `{door,model,flags}`), the
evaluator is a fold, and everything durable/stateful is reused.

### Performance / hot-path (scalability S1–S5)
This resolver runs on **every** internal LLM call, so:
- **S1 — money-gate budget is an in-memory running counter** (single-writer: all metered `.evaluate()`
  calls run in the server process), updated on each metered call and reconciled from
  `state/metered-ledger.*.jsonl` at boot AND on a short cadence (M3 backstop — not boot-only, so a
  concurrent out-of-process metered writer cannot silently breach the USD cap between restarts).
  `isAvailable` reads the counter — **never** scans the growing JSONL per call.
- **S2 — the audit is async/buffered (or sampled), never a blocking `appendFileSync` in `evaluate`**; the
  dryRun log records the decision, not a re-serialized full chain per call.
- **S3 — sticky-primary + jittered admission:** when a primary door transitions to unavailable, the whole
  tier does not reslot instantly onto the next door; admission to the new primary is jittered/staggered so
  the fallback door isn't thundered. A transient blip within the sticky window keeps the current primary.
- **S4 — per-door `isAvailable` verdict cached behind a 1–2 s TTL** (breaker/budget freshness within a
  couple seconds is fine) so a hot funnel is a cache hit, not O(chain) recompute per call.
- **S5 — metered-door providers ride the SAME `this.cache.get(framework)` memoization** as CLI frameworks
  (build-once, non-blocking, never-throws) — a fallback landing never pays construction cost inside the
  awaited gate path.

### The money-gate for metered doors (Increment B)
Metered doors reuse the bench metered funnel's provider + its money-cap logic (FD12) + its durable
`state/metered-ledger.*.jsonl`. A metered position is unavailable when the cap is exhausted (fail-closed
→ walk continues to a CLI door) or the price is unknown (refuse). Enforced per FD12's unified-ledger
precondition.

## Multi-machine posture

Default posture is **`unified`**; each surface classified:

- **Route resolution (the feature): `unified`.** A **pure function** of `LLM_ROUTING_NATURE` (git-tracked
  code) + `sessions.natureRouting.chains` (config) + live door-availability. Same inputs → same
  `(door, model)` on any machine.
- **Metered-door key availability: `unified` *iff* secret-sync is enabled AND pushing (Int3).** A machine
  lacking the key skips that metered position (FD5, graceful). Stated conditionally, not as unconditional
  unification.
- **Money-gate spend ledger: `unified` (enforced by fail-closed precondition).** On a durably-single
  machine the ledger is trivially the whole fleet's spend. On any multi-machine (or membership-uncertain)
  deployment the metered doors that write it are **disabled** until a shared/replicated ledger exists
  (FD12, fail-closed N-detection) — so the ledger is **never** a divergent machine-local surface. No
  machine-local-justification key is required because the surface is never allowed to be machine-local
  while active. **Single-writer invariant (M3):** all metered internal `.evaluate()` calls run in the
  **server process** (the router funnel), so the in-memory spend counter (Performance §S1) is the sole
  writer on a machine; it reconciles from the durable ledger at boot AND on a short cadence (a backstop
  against any out-of-process metered writer) so a same-machine cap is honored between restarts.
- **Routing audit (`logs/nature-routing.jsonl`): machine-local observability, NOT a coherence surface.**
  Records `(door, model)` decisions that physically occurred on that machine's process — the established
  `logs/*.jsonl` local-by-nature pattern (append-only, no cross-machine read, strands nothing on transfer;
  a moved topic's future calls are audited on the new machine). Not a durable coherence-bearing state
  surface, so the closed taxonomy does not apply (integration reviewer confirmed this is defensible).

## Self-Heal Before Notify

The only operator-facing notice S4 adds is the FD6 critical-gate routing notice, placed **downstream of
self-heal**:
- **Self-heal is the fallback walk itself** (`remediation-actions`: re-resolve onto the next bench-
  sanctioned door; the call succeeds — the fallback IS the heal). First-detection escalation is
  **unreachable** for a transient blip.
- **Route-DRIFT escalation** only after N=3 ticks / 10 min of a critical gate's primary differing from its
  reviewed baseline (self-heal exhausted). `class: recoverable`. P19 brakes (reusing `DegradationReporter`
  + existing breaker primitives — **no new engine**): `max-attempts:3`, `backoff:exponential`,
  `dedupe-key: nature-route:<component>`, `breaker: 5-heals-in-30m → auto-reclassify → escalate`,
  `max-notification-latency: 300s` (≤ `standards.selfHealBeforeNotify.recoverableLatencyCeiling`),
  `audit-location: logs/nature-routing.jsonl` (scrubbed metadata: door ids + component names, never prompt
  content or secrets).
- **Reserve-landing escalation (Adv4) is the notify-and-heal exception:** a critical gate landing on the
  terminal `claude-code/balanced` reserve escalates on the SAME detection tick (the reserve serves the
  call concurrently — notify-and-heal), because a safety gate on the penalized door in the CLI-miss regime
  must not be silent for up to 10 min. It is treated as a same-tick surfaced event, not a `recoverable`
  heal-gate delay.
- **No irreversible/data-loss/security class** — a routing degradation is recoverable (a sanctioned
  fallback serves the call). `onResolved` (existing) auto-clears when the primary door recovers.
- **Reuses the `SelfHealGate` pattern** over Instar's in-process breaker primitives (`CrashLoopPauser` +
  the DegradationReporter breakers already threaded through the router).

## Testing plan (Testing Integrity Standard — all three tiers)

- **Unit** (`tests/unit/`): `resolveNature` (map hit / per-op key / `E,B≥D≥A` tighten / non-enum-ignored /
  unmapped fall-through; `E,B` tie → map value; non-enum ignored); `resolveRoute` walk (skip-unavailable
  with the correct reason code, injection-exposed skip + fail-closed-on-unknown, empty-set fall-through,
  primary+tail); the FD4 **allowlist** clamp on primary AND tail AND degrade-to-default — including the
  **LA4 unconditional degrade clamp firing with `natureRouting` UNSET, for BOTH `defaultFramework`
  values** (the standalone fleet-safety fix); a non-reserve concrete-id `claude-code` position rejected in
  FAST/SORT/JUDGE (allowlist, not denylist); the resolve-time live-chain validator (rejects a hot-config
  non-reserve `claude-code` JUDGE position → defaults + notice); fail-closed N-detection (membership-
  uncertain → metered off); the R6
  doc-tree Claude-ban; the R8 Flash-Lite pin; the FD4 critical-gate-never-WRITE ratchet (accepts nature-A
  `MessageSentinel`, rejects a `{D,WRITE}` gate); the static injection-exposure map exhaustiveness ratchet;
  the empty-set nature-aware branch (unmapped→fall-through, critical-gate/banned→fail-closed, NEVER legacy);
  the benchmark-label→adapter-id lint; FD7 exhaustiveness; FD8 no-Fable; dark/dryRun byte-identical (except
  the LA4 clamp). **Both sides of every boundary.**
- **Integration** (`tests/integration/`): `/intelligence/routing` reports the resolved `(door, model)` +
  the dryRun plan/diff per component; the money-gate skip (metered cap reached → walk continues to a CLI
  door) over the real HTTP pipeline; a runtime `PATCH /config` chain edit that violates the ban is rejected
  → defaults + a HIGH attention item.
- **E2E** (`tests/e2e/`): production init — with `natureRouting.enabled`, a benched critical-gate resolves
  its JUDGE chain end-to-end and NEVER lands Opus-via-CLI (primary, swap, OR degrade path); the route-drift
  notice fires only after durable degradation; the reserve-landing notice fires immediately; unset config →
  feature inert (byte-identical), route alive (200, not 503).
- **Wiring integrity:** resolver deps (nature map, chain config, money-gate counter, DegradationReporter)
  non-null, delegate to real implementations — not no-ops.

## Migration Parity

- **Config defaults** (`migrateConfig`): add versioned `sessions.natureRouting` (`schemaVersion`,
  `enabled` omitted for the dev-gate ladder, `dryRun:true`, the FD2 default chains, `metered.goLive:false`)
  if missing; **migrate chain defaults forward on version bump** (Int2) with a concrete **override
  discriminator (M4):** the migrator ships the **prior version's shipped default chains** and overwrites a
  live position **only if it is byte-equal to that prior default** — an operator-edited (divergent)
  position is left untouched. So a v4 reslot reaches un-overridden agents without ever clobbering a hand-
  tuned chain (and without needing to guess intent from the current value alone).
- **Fable→Opus reconciliation** (`migrateConfig`, FD8/M1/gate-GR2-3): a content-sniffed step — **if
  `frameworkDefaultModels.claude-code === 'claude-fable-5'` AND that equals the prior shipped default**,
  move it to the account default (unset / Opus). Idempotent, override-preserving (an operator who
  deliberately set Fable is not touched — only the stale shipped default is). Without this, the Fable→Opus
  change would reach only NEW agents via `init` (the Migration Parity violation the gate flagged).
- **CLAUDE.md template** (`generateClaudeMd` + `migrateClaudeMd`, content-sniffed): a "Nature-Axis Routing"
  capability blurb — what it is, `GET /intelligence/routing` (incl. dryRun plan/diff), the enable/dryRun/
  goLive/kill knobs, the authority split, the harness-door ban.
- **No hook/skill changes.** Pure `src/` + config + docs.

## Close the Loop — tracked follow-ups (registered same-PR, not deferred)

1. **Shared cross-machine spend ledger** — a HARD PRECONDITION for multi-machine metered doors (FD12);
   until it lands, multi-machine metered routing is disabled (fail-closed), so this is a gated capability
   expansion, not a safety deferral. Registered as a same-PR commitment; the build hand opens the tracking
   item and the code enforces the precondition.
2. **Pool-level coalescing of the FD6 critical-gate notice** (Int5) — per-machine dedupe today (consistent
   with attention-queue posture); a fleet-wide door outage multi-firing is the follow-up.
3. **Dynamic-adaptation / harness-penalty drift closure** (gemini Ge1/Ge3-2) — the static bench maps (and
   the whole harness-penalty premise the FD4 ban rests on) drift as the model landscape moves; a provider
   update could in principle alter the `(claude-code, Opus)` penalty. The primary closure is the S5
   `bench-refresh` cadence + the S6 reslot/diff gate (the designed mechanism). To make that less *reactive*
   (Ge3-2), a **lightweight continuous door-penalty canary** — a tiny periodic bounded-verdict probe of the
   `(claude-code, Opus)` route vs a clean door, reusing the merged `doorway-scan` substrate — is a tracked
   follow-up that would flag a penalty shift before the next full re-bench. Acknowledged as an explicit
   accepted tradeoff (S4 does not add an in-line bandit); tracked to S5/S6 + the canary.

## Decision points touched
- **Adds** a route-resolution gate (nature → chain → `(door, model)`) — dev-gated dark, dryRun-first,
  reversible, byte-identical when unset.
- **Extends & hardens** the S2 clamp: swap-loop-only → primary + swap + degrade-to-default, and
  tier-token → model-FAMILY (fixes the LA4 fail-open in `main`). Strictly narrows a dangerous fallback.
- **Adds** a critical-gate routing notice — downstream of self-heal, HIGH, deduped, with an immediate
  reserve-landing carve-out.
- **Unconfigured path** is byte-identical EXCEPT the LA4 unconditional degrade-path clamp (a standalone
  safety narrowing, Opus-CLI → Sonnet-CLI on the binary-missing bounded/gating degrade — the one
  intentional deviation, strictly the safe direction). Removes the phantom `openai-api` door.

## Open questions
*(none — every operator decision and reviewer-surfaced decision is frontloaded in FD1–FD12; no unresolved
user-decision remains.)*
