# Internal LLM Component Reliability — Plain-English Overview

> The one-line version: stop a healthy fleet-wide average from hiding a broken internal LLM component, and give known long-running observers enough time to finish without accidentally queueing the same work twice.

## The problem in one breath

Instar already counts every internal LLM call, but its health answer looked at broad process signals rather than the error rate of each component. One high-volume healthy gate could therefore dilute a component failing on most calls. Three affected call paths also shared timeout and retry shapes that did not match their work: a profile classifier spent its entire overall budget on the primary attempt, a completion observer entered a second deferrable queue despite already being admitted by two bounded queues, and the topic-intent extractor inherited a timeout wall shorter than its real prompt workload.

## What already exists

- **Per-feature metrics** — the ledger already records the component, outcome, latency, framework, model, and token use for internal LLM calls.
- **The health route** — it already reports process and recent degradation health, but did not derive a component-level LLM reliability answer.
- **Provider routing and bounded queues** — internal calls already have framework selection, failure swaps, circuit breakers, and admission limits.

## What this adds

Each feature rollup now carries its own LLM error rate and the exact real-call denominator. If a feature made no LLM calls, its error rate is `null`, not the perfect-looking value zero. A reliability summary evaluates components independently: at least 20 real LLM calls and a 20% error rate is degraded; 50% is failing. The fleet aggregate never participates in that decision. The same snapshot appears in the feature-metrics response and contributes to the health status, including a third `unavailable` outcome if the metrics query itself cannot run.

The effectiveness metric gets the same honesty rule. A completed LLM call with no verdict classifier is recorded as `unclassified`, not `noop`. Fire rate is computed only from classified `fired` and `noop` calls; when there are none it is `null` with an insufficient-evidence marker. A one-time conservative migration relabels legacy LLM noops as unclassified because the old rows cannot prove whether a classifier ran.

The timeout changes follow the workload rather than applying one number everywhere:

- The profile classifier gets a 15-second overall budget while keeping its primary provider attempt at four seconds, leaving time for the already-configured fallback chain.
- The completion observer gets a 60-second primary attempt and no longer marks its already-admitted work as deferrable, removing the nested queue and five-second fallback path.
- The topic-intent extractor gets a 60-second attempt because its prompt includes a message, rolling summary, and tracked references.

## The safeguards

**No new blocking rule.** The component thresholds affect the truthfulness of the health report; they do not reject a message, change an LLM verdict, delete work, reroute a provider, or actuate a recovery.

**No aggregate dilution.** Reliability is computed per component with a named denominator. A thousand successful calls elsewhere cannot make a component with 18 failures in 20 calls appear healthy.

**No false empty state.** A failed metrics read is reported as unavailable and degrades health. It is never rendered as an empty list of broken components or as a zero-percent error rate.

**No ideal value without evidence.** A missing denominator produces `null`. Raw unclassified counts remain visible so an operator can distinguish “measured and never acted” from “effectiveness was never measured.”

**Existing safety direction stays intact.** Profile classification still fails open, completion verification remains observe-only, and topic-intent extraction still degrades to a no-op. The change only gives those existing judgments a viable execution budget.

## What ships when

The metrics fields, health integration, and three call-site corrections ship together because each is needed to close the incident class: reduce the known avoidable failures and keep any residual component outage visible after rollout.

## What you actually need to decide

Review whether these per-component thresholds and workload-specific budgets are the right bounded correction for the open reliability incident.
