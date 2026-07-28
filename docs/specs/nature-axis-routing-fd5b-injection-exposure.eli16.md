# FD5b — Injection-Exposure Map + Route Gate (Plain-English Overview)

> The one-line version: give every one of my internal AI checks a static "does this handle untrusted content?" label, and make the router refuse to send a check that DOES onto a model door that a bench proved can be fooled by planted instructions.

## The problem in one breath

The nature-axis router (shipping dark) picks which model answers each of my background checks. Some model doors are cheap but NOT safe to feed content that a stranger controls — a bench found one door (a Groq-hosted model) follows instructions hidden inside the text it's told to judge. A check that reads untrusted content (an inbound message, a transcript, a file, another agent's data) must never be routed onto such a door. But deciding "is THIS check exposed to untrusted content?" per call is fragile: forget one callsite and you've silently opened the unsafe route. The spec (FD5b) says the answer must be a STATIC, exhaustive table — decided once at build time, never left to caller diligence.

## What already exists

- **The nature/chain map + the door taxonomy** — `LLM_ROUTING_NATURE` and the chain tables in `src/data/llmBenchCoverage.ts`, including a per-door `injectionSafe` flag (only `groq-api/gpt-oss-120B` is `injectionSafe: false` today, and it is a metered door already skipped in this increment).
- **`LLM_UNTRUSTED_INPUT`** — a sibling exhaustive table already saying, for every component, whether it judges untrusted content. Injection exposure is the SAME question, so the new map is authored to match it and a test cross-checks the two so they can never drift apart.
- **`resolveRoute`** — the router's per-call "walk the chain, pick the first available door" function. It runs only when the feature is switched on.

## What this adds

- **`LLM_ROUTING_INJECTION_EXPOSURE`** — a new exhaustive table (one row per known component). Each row says `exposed: true/false` and declares its input-shape (can user / model / tool content enter this call?). The default is `exposed: true` (fail-safe): a component is `false` ONLY when explicitly audited as carrying no untrusted content, with a written reason. A ratchet test fails the build if any component is missing a row, if a row names an unknown component, or if the exposed flag disagrees with the reviewed untrusted-input table.
- **`resolveInjectionExposure(component)`** — a pure lookup that returns EXPOSED for any unknown/unlabeled component (fail-closed, the safe direction).
- **The route gate** — inside `resolveRoute`, an injection-exposed component now SKIPS any `injectionSafe: false` door. A tightening-only per-call flag (`attribution.injectionExposed`) can mark a normally-trusted call as exposed, but can never relax a statically-exposed one.

## The safeguards

- **Fail-safe by default** — unknown or unlabeled ⇒ treated as exposed ⇒ never routed onto the unsafe door.
- **No-op in this increment** — the only unsafe door is also a metered door, which is already skipped until the later paid-door increment. So over the real shipped chains the gate changes NOTHING; a test asserts the exposed and trusted routes are byte-identical.
- **Byte-identical when off** — the gate lives inside `resolveRoute`, which only runs when `sessions.natureRouting` is enabled. With the feature unset/off, routing is bit-for-bit today's behavior. The pre-existing "byte-identical when off" test and A1's degrade-clamp test are untouched and green.
- **Fresh, never cached** — exposure is evaluated per call, so the SAME cached door-health verdict still yields a different eligibility for a trusted vs an exposed call (an isolation test proves this).
- **Can't silently diverge** — the ratchet cross-checks the new map against the reviewed untrusted-input table; a callsite that starts handling untrusted content must flip both, or CI fails.

## What this deliberately does NOT do

No metered-API doors, no money caps, no PIN go-live (that is the paid-door Increment B, deferred + PIN-gated). No flip to enforcing/live (operator-gated). The prompt-anchor fingerprint lint (the FD7 semantic-drift guard that re-checks a row when its prompt source changes) and the FD4.2 R-rule lints (R4/R5/R7/R8 as lints) are the tracked next increments — not built here. The spec is NOT marked approved by this change (the operator's step).
