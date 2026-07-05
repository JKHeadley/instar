<!-- bump: patch -->

## What Changed

Builds FD5b of the (still-dark) nature-axis router (spec: docs/specs/nature-axis-routing.md): the injection-exposure classification and the route gate that keeps an injection-exposed internal check off a non-injection-safe model door.

- **`LLM_ROUTING_INJECTION_EXPOSURE`** (src/data/llmBenchCoverage.ts): a new exhaustive static map — one row per known LLM component, each declaring `exposed` (defaults true / fail-safe) plus an input-shape declaration (can user / model / tool content enter). A component is `exposed:false` only when explicitly audited as carrying no untrusted content, with a written reason. `resolveInjectionExposure()` returns EXPOSED for any unknown component (fail-closed).
- **The route gate** (src/core/IntelligenceRouter.ts): resolveRoute now skips any door marked `injectionSafe:false` when the component is exposed. A tightening-only per-call `attribution.injectionExposed` flag can raise exposure but can never relax a statically-exposed component.
- A new ratchet test enforces the map is exhaustive over the component registry (both directions), fail-safe, cross-checked against the reviewed untrusted-input classification, and pins the input-classifier components as exposed. A new resolver-test block covers the gate and the fresh-per-call injection-cache isolation.

NO-OP in this increment: the only non-injection door in the shipped chains is also a metered door, which is already skipped until the later paid-door increment — so over the real chains the gate changes nothing. Dev-gated / dark: the whole nature block runs only when sessions.natureRouting is enabled; unset/off is byte-identical to before (asserted). This is the classification + gate only — NOT the metered-door Increment B, and NOT the go-live flip.

## What to Tell Your User

This is internal plumbing for how I choose which model runs my own background checks — nothing to turn on, and nothing about our conversations changes. In plain terms: I gave each of my internal checks a label saying whether it reads content that could contain hidden instructions from an outside source, and I added a rule so a check that does can never be sent to a cheaper model that a test showed is easier to trick. The routing feature is still off by default, so today this is invisible — it just means the unsafe path is sealed shut in advance, and it defaults to the cautious choice whenever it isn't sure.

## Summary of New Capabilities

- **Injection-exposure map**: a build-enforced, exhaustive table classifying each internal AI check by whether it handles untrusted content, defaulting to the cautious "exposed" when unsure.
- **Route injection gate**: the model router refuses to place an untrusted-content check onto a model door proven easier to fool, evaluated fresh on every call.

## Evidence

- tests/unit/nature-routing-injection-exposure-ratchet.test.ts (11 tests) and the new FD5b block in tests/unit/nature-routing-resolver.test.ts — green, covering exhaustiveness both directions, fail-safe resolve, the pinned not-exposed set, input-shape coherence, the untrusted-input cross-check, R8, the gate (exposed skips / trusted keeps / critical-gate fail-closed), and injection-cache isolation.
- `npx tsc --noEmit` clean; the FD4 nature-chains build-lint clean; the sibling untrusted-input / bench-coverage / routing-nature ratchets green; the pre-existing byte-identical-when-off block and A1's degrade-clamp assertion untouched and green.
