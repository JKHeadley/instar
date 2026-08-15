# INSTAR-Bench v2 — Comprehensive Task-Limit Benchmark & Prompt-Improvement Loop

**Status:** draft for operator review · **Author:** Echo · **Date:** 2026-07-02
**Parent:** INSTAR-Bench v1 (`instar-bench/`, results in `results/INSTAR-BENCH-PROFILES.md`), LLM Routing Registry (`docs/LLM-ROUTING-REGISTRY.md`)
**Operator directives incorporated (Justin, topic 29723, 2026-07-01):** fully automated (no human-anchored review) · comprehensive coverage of every INSTAR LLM task · root-cause EVERY failure (not just cross-model ones) for prompt/context improvability, then A/B · periodic re-run process · structural enforcement that new LLM tasks join the registry AND the benchmark · routing defaults prefer subsidized non-Claude subscriptions with tiered, benchmark-driven fallback chains.

---

## 1. What v2 is

v1 answered "which models are competent at which task *families*?" v2 answers three sharper questions, per **individual task**:

1. **Where exactly does each model break** on each real INSTAR task, when pushed to the task's limits?
2. **Was each failure the model's fault or ours?** (Would a better-structured prompt / better context have prevented it?)
3. **What is the optimal routing default + fallback chain** for each task, under the constraint that defaults should live on subsidized non-Claude subscriptions?

The benchmark becomes a **periodic quality-assessment and improvement process**, not a one-shot leaderboard.

## 2. Task universe: the registry IS the inventory

Coverage target = every row of `docs/LLM-ROUTING-REGISTRY.md` (every component that hands a decision to an LLM). No hand-picked subset as the end state.

- **Wave 1 (signal first):** the ~10 highest-leverage tasks — the always-on gates and sentinels whose failure is user-visible or safety-relevant (tone gate B-rules, completion judge, coherence gate, external-op gate, MessageSentinel, injection sanitizer, WarrantsReply, InputClassifier, Usher, correction-learning distiller).
- **Wave 2:** remaining sentinels/gates/extractors.
- **Wave 3:** reflectors + background/job tasks (cartographer summaries, tree synthesis, briefs).

Each registry row gains a `benchmark` field: `covered (task-id)` | `wave-N-pending` | `exempt (reason)`. Exemptions must be argued (e.g. a task whose input is unmockable), not defaulted.

## 3. Test-case generation (Fable-5-authored, limit-seeking)

For each task, I author 8–15 cases spanning five stress axes:

| Axis | What it probes | Example (MessageSentinel) |
|---|---|---|
| **Canonical** | the everyday case — must be near-free | "stop everything" mid-run |
| **Boundary** | the decision line itself | "stop… actually no, keep going" |
| **Adversarial** | injection / misdirection / content that argues with the classifier | a message QUOTING an emergency stop it doesn't want |
| **Degenerate input** | empty / truncated / wrong-language / mixed-format | emoji-only message |
| **Context pressure** | long context, buried signal, conflicting history | stop order buried in 3k tokens of chatter |

Ground truth rules (this replaces human anchoring — Justin: fully automated):

- **Deterministic tasks** (verdict/extraction): every case carries a machine-checkable expected output. Ambiguous cases are ALLOWED but must declare `acceptable: [a, b]` — a model choosing either passes; the *distribution* across models is still recorded as signal.
- **Judged tasks** (prose/synthesis): blind in-session Fable-5 judging as in v1 (shuffled, deanonymization key held out), PLUS two automated calibration guards:
  - **Self-consistency probe:** every judged cell is scored twice in independent judge passes; cells where the two scores diverge >2 points are flagged `low-confidence` and re-judged with rationale required.
  - **Consensus tripwire:** if the judge ranks an output bottom-quartile that ≥3 diverse models produced near-identically, the CASE is suspect (bad prompt/ground-truth), not the models — auto-flagged for case revision.

## 4. Failure forensics (every failure, not just cross-model)

Every failing sample — even one model, one case — gets a forensic record:

```json
{
  "task": "...", "case": "...", "model": "...",
  "rawOutput": "...", "reasoningVisible": "...",
  "failureClass": "wrong-verdict | format-break | truncation | refusal | injection-followed | hallucinated-field | timeout",
  "promptFault": { "verdict": "model-limit | prompt-improvable | context-missing | case-defect", "rationale": "...", "proposedEdit": "..." }
}
```

The `promptFault` judgment is the heart of Justin's nuance: I read the model's actual output/reasoning and ask *"is there any indication a better-structured prompt or better context would have prevented this?"* — per failure, not per pattern. Cross-model failure clusters are still computed (they're the strongest prompt-defect signal) but are a *prioritization* layer, not the trigger.

**Output artifacts per run:**
1. **Failure map** — task × model × failureClass matrix.
2. **Prompt-improvement queue** — every `prompt-improvable`/`context-missing` finding with its proposed edit, ranked by (task criticality × failure frequency).
3. **A/B queue** — each accepted edit becomes an A/B cell: old prompt vs new prompt, same cases, same models, same seeds/pacing. An edit ships to the real component ONLY on a statistically clean win (no regression on any previously-passing case — ratchet semantics).

## 5. Routing output: subsidized-first defaults + tiered fallback chains

For each task, the run emits a routing recommendation record:

```json
{
  "task": "...", "nature": "A|B|C|D|E",
  "default": { "model": "...", "door": "codex-cli | pi-cli | gemini-cli | groq | openrouter-metered | claude-code", "subsidized": true },
  "fallbacks": [ { "model": "...", "door": "...", "subsidized": true }, { "model": "...", "door": "openrouter-metered", "subsidized": false } ],
  "floor": "minimum acceptable bench score for this task; a fallback below floor is refused, task degrades to its heuristic"
}
```

Selection rule (Justin's directive, operationalized):
1. Among models clearing the task's quality floor, prefer **subsidized non-Claude doors** (codex/GPT sub, pi, gemini sub, Groq free) over metered API over Claude subscription.
2. Break ties by task nature: bounded verdicts → fastest/cheapest clearing the floor; nuanced/critical (nature B) → reasoning-capable model even at token cost; Claude remains in chains as a *late* fallback, never the resting default for background work.
3. Every chain is derived from bench data — the registry cites the run ID that justified each default (no vibes routing).

This section's output feeds `sessions.componentFrameworks` + the fallback-chain config as a **proposed diff** for operator review — critical-gate model changes never ship unilaterally.

## 6. Structural enforcement (new LLM tasks can't dodge)

Two ratchets, extending the existing `llm-attribution-ratchet` pattern (Structure > Willpower):

1. **Registry ratchet (exists, shipped):** every `.evaluate()` `attribution.component` must be categorized or explicitly-categorized — PR #1319 cleared the backlog; CI fails on new unregistered callsites.
2. **Benchmark-coverage ratchet (new):** CI test asserting every registered LLM component maps to either a benchmark task id or a pinned, argued exemption. Adding an LLM callsite without bench coverage fails the build with instructions. Pinned-exemption list has ratchet semantics: it may only shrink.

Plus a **registry-doc freshness check**: the registry's component list is generated/verified from the same scan the ratchet uses, so the doc can't drift from code.

## 7. Periodicity & operations

- **Cadence:** monthly full run + on-demand after any prompt edit ships or a new model/door is enrolled. New-model enrollment auto-triggers Wave-1 only (cheap smoke) before full inclusion.
- **Budget:** same metered-funnel discipline as v1 (vault-only keys, reserve-then-settle, per-key caps, prepaid, unknown-price = refuse). Wave-1 full-matrix ≈ $3–5 at v1 prices; full universe estimated $12–20/run — each run states its cap up front.
- **State:** runs are stamped + append-only under `results/`; the improvement queue and A/B history are durable so the process survives sessions (Close the Loop).
- **Ownership:** runs are autonomous (scheduled job candidate once stable); the only operator touchpoints are (a) reviewing proposed prompt edits before they ship to real components, (b) reviewing routing-default diffs.

## 8. Open questions for Justin

1. **Prompt-edit shipping authority:** may clean A/B wins on *non-critical* components (reflectors/background) ship without per-edit review, with critical gates always operator-reviewed — or all edits reviewed initially?
2. **Coverage of hardcoded-model callsites:** the registry found callsites that bypass the router with hardcoded models (dispatch→haiku, mentor→opus, setup wizard). Bench them as-is, or first migrate them onto the router (separate PR) so routing recommendations are actionable?
3. **Wave-1 scope check:** is the ~10-task Wave-1 list above the right "most critical" set, or do you want any swaps before I author cases?

## 9. Reproducibility & provenance (v3 hardening, 2026-07-02)

Built for external credibility: any result table must be re-derivable from what's on disk.

- **Run manifests, structural:** `run2.mjs` writes `run-manifest.json` into the run's results dir AT RUN START (fail-soft) — provenance can't be forgotten because it isn't a step. Schema `instar-bench/run-manifest@1` captures: bench-code git SHA + dirty flag, SHA256 of every task battery (prompt provenance), SHA256 of the price + caps tables, the door→model resolution actually observed in `raw.jsonl`, **door versions** (CLI binary path + `--version` for subscription doors; endpoint kind for metered doors), and a `reproduce` command line.
- **Versioned task batteries:** batteries live in `instar-bench-v2/tasks/` and are content-addressed by SHA256 in every manifest. `parity-check.mjs` verifies each battery against the PRODUCTION prompt text (and against `upstream/main`) — a stale battery is a named, failing verdict, never a silent under-score (the 2026-07-02 instrument bug can't recur silently).
- **Infra-noise policy (honest exclusion):** environmental failures (`rate-limit`, `auth`, `binary-missing`, `spawn-throw`, `spawn-error`, `no-invocation`) are excluded from pass/total and re-run on `--resume`, reported as `infra` counts in `summary.json`; `budget-refused`/`vendor-wall` rows are never recorded (the run aborts after 3 wall hits). Route-behavior failures (`timeout`, `refusal`, `cli-error`, `model-error`, `empty-output`) STAY scored — a router must care about them. The exact sets live in `run2.mjs` (`INFRA_CLASSES`) and are restated in every manifest.
- **Scoring provenance:** deterministic tasks score inline (`score2.mjs`, unit-tested); judged tasks emit a blind packet (`judge-blind.json` — outputs shuffled, route labels stripped) so the judge can't see which model produced what. Judged runs record consistency probes (duplicate cells re-judged; disagreement = a flagged judging defect, not silently averaged).
- **Append-only results:** runs are stamped dirs under `results/instar-bench-v2/`; `raw.jsonl` is append-only (resume re-runs write fresh rows; the audit trail keeps both). Cost is booked from vendor-reported truth via the metered funnel's reserve-then-settle ledger, never estimated-only.
