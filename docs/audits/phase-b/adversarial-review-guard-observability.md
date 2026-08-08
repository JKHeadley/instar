# Adversarial cross-model review — guard-effectiveness-observability

**Reviewer:** independent Codex (GPT-tier) lane, laptop, 2026-08-05 ~04:06-04:12Z
**Spec reviewed at:** commit `6ff237e28` (conformance gate CLEAN at round 8)
**Verdict: MATERIALLY-FLAWED**

> Retained verbatim. This review cost one Codex lane and stopped a flawed design from being
> put up for operator pre-approval. It is the single strongest argument in this window for why
> a clean deterministic gate is not a substitute for an adversarial reader.

```
Security / Authority: **not sound**. The PIN check primitive exists, but the spec does not define a scoped, non-replayable ratification artifact.

Adversarial / Gaming: **not sound**. The cheapest passing path is to declare existing positive counters or timestamps, not to instrument the guard honestly.

Integration / Migration: **not sound as written**. The migration scope is undercounted and the text-parser/lint path is much larger than described.

Foundation: **partly sound, but insufficient**. `GUARD_MANIFEST` is the right choke point for declared guards, but the existing lint and discovery boundary are too weak for the claims this spec builds on.

**MATERIAL findings**

1. **[Security / Authority] `ratificationRef` is not specified as a bound authority object, so it can be borrowed or replayed.**  
   The spec requires only a string `ratificationRef` that “resolves to a PIN-gated operator ratification” (`/tmp/spec-under-review.md:112`, `/tmp/spec-under-review.md:125`, `/tmp/spec-under-review.md:235`). Existing PIN machinery verifies `body.pin` at request time and then returns `true`; it does not mint a signed artifact (`src/server/routes.ts:11219`, `src/server/routes.ts:11236`, `src/server/routes.ts:11252`). The closest existing guard acceptance record stores only `{ reason, owner, acceptedAt }` (`src/monitoring/guardAcceptedFallbacks.ts:22`) and is keyed externally as `<machineId>:<guardKey>` (`src/monitoring/guardAcceptedFallbacks.ts:28`, `src/monitoring/guardAcceptedFallbacks.ts:44`). A `ratificationRef` pointing at a file, commit, or registry key is therefore not cryptographically or structurally bound to guard key, reason, evidenceRef, declaredAt, or ratifiedUntil.  
   Control: search found known `CrashLoopPauser` and `guard-accepted-fallbacks` symbols, but `ratificationRef`, `ratifiedUntil`, `GuardObservability`, and `ObservabilityExemption` are absent from source today.

2. **[Security / Authority] Expiry fails only future lint/build, not the live `/guards` surface, so installed agents can fail open after expiry.**  
   The spec says expired exemptions fail “the lint” and “the build” (`/tmp/spec-under-review.md:134`, `/tmp/spec-under-review.md:257`), while the inventory rule renders `kind: 'none'` as `exempt:<reason>` (`/tmp/spec-under-review.md:291`). Current `/guards` builds rows at request time (`src/server/routes.ts:8689`, `src/server/routes.ts:8703`) and already has runtime date logic for soak windows (`src/monitoring/guardPostureView.ts:170`, `src/monitoring/guardPostureView.ts:178`), but the spec does not require equivalent runtime expiry enforcement for observability exemptions. An old deployed build can keep serving an expired exemption as exempt until someone runs lint/build again.

3. **[Adversarial / Gaming] A lazy author can avoid instrumentation by pointing at unrelated existing positive fields.**  
   The schema makes `looked`, `wouldAct`, and `didAct` plain dotted-path strings (`/tmp/spec-under-review.md:89`, `/tmp/spec-under-review.md:95`), and Assertion E only says the route must exist (`/tmp/spec-under-review.md:231`). Existing surfaces expose many positive counters not semantically tied to a guard: `JobScheduler.guardStatus()` returns `jobCount` and `pausedJobCount` (`src/scheduler/JobScheduler.ts:2582`, `src/scheduler/JobScheduler.ts:2587`), and `/self-action-governor` returns per-class `counters.admits`, `wouldDeny`, `denies`, etc. (`src/monitoring/selfaction/types.ts:227`, `src/monitoring/selfaction/types.ts:235`). The spec admits a declared counter can be present while not proving evaluation (`/tmp/spec-under-review.md:171`), but the control list never requires a staged positive/negative increment for each declaration (`/tmp/spec-under-review.md:384`, `/tmp/spec-under-review.md:400`). Instrumenting is therefore not cheaper than exempting; declaring borrowed counters is cheaper than both.

4. **[Integration / Migration] The migration is not 72 declarations; with Assertion G it is roughly twice that and includes the incident-hiding list.**  
   The spec repeatedly frames migration as “72 entries” and “all 72 declarations” (`/tmp/spec-under-review.md:13`, `/tmp/spec-under-review.md:301`, `/tmp/spec-under-review.md:305`), but Assertion G moves `NOT_A_GUARD.reason` to the same ratified shape (`/tmp/spec-under-review.md:247`, `/tmp/spec-under-review.md:249`). In source, `GUARD_MANIFEST` spans the declared guard array (`src/monitoring/guardManifest.ts:67`, `src/monitoring/guardManifest.ts:1112`) and `NOT_A_GUARD` spans another large array (`src/monitoring/guardManifest.ts:1126`, `src/monitoring/guardManifest.ts:1209`), including `CrashLoopPauser` (`src/monitoring/guardManifest.ts:1149`). My read-only count found 73 manifest component lines and 81 `NOT_A_GUARD` component lines. That is a materially different migration and operator-ratification burden.

5. **[Foundation] The existing lint cannot support the proposed assertions without being substantially rewritten.**  
   Current parsing strips comments and extracts arrays by searching for the first literal `] as const` (`scripts/lint-guard-manifest.js:104`, `scripts/lint-guard-manifest.js:117`). It records only `manifestComponents: Set` and `notAGuard: [{component, reason}]` (`scripts/lint-guard-manifest.js:138`, `scripts/lint-guard-manifest.js:150`), and the `NOT_A_GUARD` regex only matches adjacent `component, reason` string literals (`scripts/lint-guard-manifest.js:142`, `scripts/lint-guard-manifest.js:145`). The proposed obligations need entry boundaries, keys, nested discriminated unions, dotted paths, dates, evidence refs, ratification refs, and useful line reporting. The base is not a small extension point.

**MINOR findings**

1. **[Foundation] The discovery boundary remains basename-pattern plus manual additions, so this does not cover all future guard-shaped code.**  
   The lint explicitly admits a guard class in a non-matching file can evade detection until manually added (`scripts/lint-guard-manifest.js:34`, `scripts/lint-guard-manifest.js:39`). That limitation is acceptable if stated as scope, but the spec leans on “future guard cannot be forgotten” too strongly (`/tmp/spec-under-review.md:64`, `/tmp/spec-under-review.md:66`).

2. **[Integration] `/guards` row projection is a closed allowlist today, so the inventory change is a contract change, not just manifest metadata.**  
   Current row fields and runtime fields are explicitly allowlisted (`src/monitoring/guardPostureView.ts:122`, `src/monitoring/guardPostureView.ts:134`). The new `observability` block (`/tmp/spec-under-review.md:266`) must be added to that projection and tests, or it will be silently dropped by the intended closed-shape discipline.

3. **[Security / Authority] The current PIN gate itself is reasonably implemented.**  
   It uses per-IP attempt limiting, optional durable attempt storage, SHA-256 hashing, and `timingSafeEqual` (`src/server/routes.ts:11224`, `src/server/routes.ts:11247`). The weakness is not PIN comparison; it is the absence of a ratification artifact format and verifier.

Overall verdict: **MATERIALLY-FLAWED**.
```
