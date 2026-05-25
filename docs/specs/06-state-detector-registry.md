# State-Detector Registry

A **state-detector** is any code that parses evolving external-system state
(message formats, sentinel/heartbeat templates, CLI output, third-party schemas)
to make a decision. Per `[[feedback_state_detection_robustness]]`, every
state-detector MUST ship with:

1. **An explicit deterministic-vs-LLM rationale** — why this parse is safe to do
   deterministically (or why it needs an LLM).
2. **A canary** — known-good samples asserting both sides of the decision
   boundary, run at startup AND on a schedule, so upstream-format drift is caught
   loudly BEFORE it silently corrupts behavior.
3. **An entry in this registry** — so the set of brittle parse points is auditable
   in one place.

This is the registry. Add a row whenever you add a detector.

| Detector | Location | Parses | Deterministic / LLM | Fail mode | Silent-failure guarded | Canary |
|---|---|---|---|---|---|---|
| Topic-intent capture pre-filter | `src/core/TopicIntentCapture.ts` → `isSubstantiveTurn` | Inbound message text + agent sentinel/heartbeat/proxy line formats | **Deterministic + fail-open** — a cheap, conservative skip of obviously-trivial turns to bound LLM spend; the real significance call is the LLM's. Fail-open because a missed skip costs one cheap extraction, while an over-skip drops a real capture. | Over-skip (drops a substantive turn) on sentinel/ack-format drift | Sentinel-format drift → real captures silently dropped → the original "no record for the topic" methodology-drift bug recurs | `runPreFilterCanary()` / `PRE_FILTER_CANARY_SAMPLES` — asserts known acks/sentinels skip and known substantive turns (incl. ack-prefixed) pass. Run as a unit test + invocable at startup. |
| Standards-registry parser | `src/core/StandardsRegistryParser.ts` → `parseStandardsRegistry` | The living constitution `docs/STANDARDS-REGISTRY.md` (family `##` headings + `### article` + `**Rule.**`/`**In practice.**`) | **Deterministic** — the registry has a stable, authored structure; no LLM needed to parse it. | Under-parse (silently drops articles) if registry heading/field format drifts | Registry-format drift → articles silently dropped → the conformance gate checks against a partial constitution and misses violations | `runRegistryCanary()` / `ANCHOR_ARTICLES` — asserts ≥ `MIN_EXPECTED_ARTICLES` parsed and that anchor articles (Structure beats Willpower, No Manual Work, Signal vs. Authority, Observability, Never-Waste Feedback) parse with a non-empty rule. Run as a unit test + on every `POST /spec/conformance-check`. |

## Adding a detector

1. Implement the detector with the deterministic-vs-LLM choice documented inline.
2. Export a `runXCanary()` + a `X_CANARY_SAMPLES` array covering BOTH sides of the
   boundary with realistic inputs (including the adversarial/near-miss cases).
3. Wire the canary into a unit test (always) and a startup/scheduled check where a
   live drift would matter.
4. Add a row here.
