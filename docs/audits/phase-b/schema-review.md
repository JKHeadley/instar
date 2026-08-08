MATERIALLY-FLAWED

TREE PROVENANCE / CONTROL

- `git log -1 --format='%h %ci'`: `2197591 2026-08-05 02:19:20 +0000` (passes expected `2197591+`).
- `grep -rl CrashLoopPauser src | wc -l`: `4` (passes control; absence checks below are meaningful).
- `node scripts/lint-guard-manifest.js`: `lint-guard-manifest: clean`. This proves only the current manifest-classification lint is clean, not the new schema.

Q1. Is "forgotten callsite is impossible" true?

No. The spec's wording collapses two different properties.

The wrapper makes a forgotten `looked++` impossible only for callsites that have already been converted to `registry.invoke(key, () => guard.tick())` (/tmp/spec-v4.md:352-363). But a directly invoked guard is still a normal TS call. The current source has many direct guard calls with no wrapper, e.g. `topicReachabilityVerifier.tick()` in the server interval (src/commands/server.ts:10024-10027), `ropeProber.onTick()` on the lease-pull listener (src/commands/server.ts:5740), `reconciler.tick()` in the WS13 cadence function (src/commands/server.ts:20690-20694), `_singleMachineFailoverGap?.tick()` and `_missingLoginSession?.tick()` in the peer-presence tick (src/commands/server.ts:23727-23734), and `SelfActionHandle.admit()` delegates directly to `core.admitFor(...)` (src/monitoring/selfaction/governor.ts:1672-1679).

That is not "impossible"; it is "possible, unless a separate adoption rule catches it." The spec itself admits the direct-call case by saying "a guard still called directly is greppable" (/tmp/spec-v4.md:379-383). Greppable is detectability, not construction.

Q2. Is partial adoption detectable by the current text lint?

No. `scripts/lint-guard-manifest.js` cannot currently detect wrapper bypass.

The lint strips comments and regex-parses only `GUARD_MANIFEST`/`NOT_A_GUARD` array entries, extracting `component:` and `reason:` strings (scripts/lint-guard-manifest.js:104-150). Its assertions are: every candidate classified, real NOT_A_GUARD reasons, and exactly one list (scripts/lint-guard-manifest.js:202-250). Candidate discovery is filename suffix plus `ADDITIONAL_CANDIDATES` (scripts/lint-guard-manifest.js:73-100, 225-240). There is no parse of invocation fields, no search for `registry.invoke`, no mapping from manifest key to allowed call expression, and no rejection of direct `.tick()`, `.observe()`, `.onTick()`, `.admit()`, or `guardStoreWrite()` calls.

I ran the lint and it is clean while the source still contains direct calls like src/commands/server.ts:10024-10027, src/commands/server.ts:5740, src/commands/server.ts:20690-20694, and src/core/StateManager.ts:190-194. Therefore the claimed lint-findable failure case is not implemented in the named lint.

A future text lint could catch some direct calls, but it will need a real static convention: manifest key -> component/module -> allowed wrapper site(s), plus a closed allowlist for self-driven/event-driven classes. As written, `lint-guard-manifest.js` cannot import TS by design and only handles simple regex source shapes (scripts/lint-guard-manifest.js:34-46), so this is not a small extension to the existing three assertions.

Q3. Does the wrapper fit real callsites?

Partly yes. Several of the scoped callsites have a single invocation expression the registry can bracket:

- Server interval: `topicReachabilityVerifier.tick()` is one call inside one interval callback (src/commands/server.ts:10024-10027).
- MultiMachineCoordinator lease-pull rider: `coordinator.attachLeasePullTickListener(() => ropeProber.onTick())` is a single callback invocation (src/commands/server.ts:5740).
- WS13 reconciler: `runWs13Tick(...)` calls `reconciler.tick()` once per pass (src/commands/server.ts:20690-20694), and the cadence interval calls that function at src/commands/server.ts:20701.
- SelfActionGovernor: the public handle methods both delegate to one admission core call, `this.core.admitFor(...)` (src/monitoring/selfaction/governor.ts:1672-1679), and the core evaluation is centralized at `admitFor(...)` (src/monitoring/selfaction/governor.ts:510-529).
- StateManager write funnel: writes are already centralized through `guardWrite(...)`; the `WriteAdmission` call is a single `wa.guardStoreWrite(...)` expression (src/core/StateManager.ts:180-214). The code itself records why per-site wiring would drift: eleven `saveSession` callsites are handled by the single `saveSession` funnel (src/core/StateManager.ts:296-304).

But "fits" is not universal. The survey already classifies only 28 as current TICK-LOOP+FUNNEL candidates and leaves 44 as EVENT-DRIVEN/SELF-DRIVEN/UNKNOWN (.phase-b-census/chokepoint-survey.md:10-25, 64-121). That matches the post-ruling scope. For the 28, the wrapper mostly fits as a mechanical bracket around one existing chokepoint. For the other 44, the wrapper does not fit without new external scheduling/admission plumbing, and the spec correctly marks them unverifiable-by-construction.

Q4. Does it survive the v3 attack?

No, not by itself. The invariant catches arithmetic lies (`didAct <= wouldAct <= looked`) but not semantic lies.

The spec's stage-one verdict says any nonzero `looked` with consistent counters becomes `instrumented` (/tmp/spec-v4.md:413-419). A guard can still report no `wouldAct` forever while the registry increments `looked`, and the invariant remains healthy: `0 <= 0 <= looked`. The spec separately acknowledges the staged-violation harness is the only thing that proves honesty (/tmp/spec-v4.md:432-451). That is the right ceiling, but it means the wrapper schema alone does not kill the v3 attack; it only moves the false-health value from "effective" to "instrumented" if surfaced carefully.

This is especially dangerous because the current `/guards` row field is still named `effective` (src/monitoring/guardPostureView.ts:66-74), and the existing state union is health-colored (`on-confirmed`, `on-stale`, etc.) rather than `GuardObservabilityVerdict` (src/monitoring/guardPostureView.ts:27-37). The spec explicitly forbids rendering stage-one instrumentation under `effective` (/tmp/spec-v4.md:476-480), but the current source has no new field yet.

Q5. Verify/refute the "~25 conversions plus one registry change" cost claim.

Refute as stated.

The local survey supports the high-level denominator: 72 guards total, 28 with current caller-owned `looked` seams (`TICK-LOOP + FUNNEL` = 19 + 9), and 44 outside that construction (.phase-b-census/chokepoint-survey.md:10-25). It also identifies the examples named in the spec: WS13 interval, lease-pull tick, SelfActionGovernor, and StateManager (.phase-b-census/chokepoint-survey.md:33-62).

But "plus one registry change" is materially incomplete for the tree in front of me. The current `GuardRegistry` is getter-only: it has `register`, `has`, `registeredKeys`, and `read`, with no `invoke`, `verdict`, counters map, or observability read surface (src/monitoring/GuardRegistry.ts:40-71). `GuardManifestEntry` has no `invocation` or `lookedMeans` fields (src/monitoring/guardManifest.ts:24-65). The posture view has no `GuardObservabilityVerdict` and still projects `effective` (src/monitoring/guardPostureView.ts:27-37, 66-74). The lint has no wrapper adoption rule (scripts/lint-guard-manifest.js:202-250).

So the honest implementation cost is at least: registry counters/wrapper/handle, manifest schema and entries, posture derivation/output field, lint adoption enforcement, tests, and then the ~25/28 callsite conversions. It is not merely callsites plus one registry change.

Q6. New findings.

1. The new schema is not implemented in the inspected tree at all. The spec requires `invoke`, `verdict`, live counters, `invocation`, `lookedMeans`, `GuardObservabilityVerdict`, and a non-`effective` rendering field (/tmp/spec-v4.md:360-369, 391-399, 413-419, 463-480). None of those symbols or fields exist in the key source files: GuardRegistry is getter-only (src/monitoring/GuardRegistry.ts:40-71), GuardManifestEntry lacks the new fields (src/monitoring/guardManifest.ts:24-65), and guardPostureView still exposes `effective` (src/monitoring/guardPostureView.ts:66-74).

2. The spec cites a published `docs/audits/phase-b/guard-verifiability-28-and-44.md` rationale (/tmp/spec-v4.md:402-406), but that path does not exist in this tree. The closest local evidence is `.phase-b-census/chokepoint-survey.md`, which is useful but not the cited durable docs path. This matters because the schema asks reviewers and future maintainers to rely on named reasons for the 44 unverifiable guards.

MATERIAL

- MATERIAL: Wrapper bypass is still possible; the spec overclaims "impossible." Direct invocations exist today, and the wrapper only makes counting structural after adoption. Grounding: /tmp/spec-v4.md:376-383 versus src/commands/server.ts:10024-10027, src/commands/server.ts:5740, src/commands/server.ts:20690-20694, src/monitoring/selfaction/governor.ts:1672-1679.

- MATERIAL: The named lint cannot detect partial adoption. It classifies guard-shaped components; it does not enforce `registry.invoke` or reject direct guard calls. Grounding: scripts/lint-guard-manifest.js:104-150, 202-250; clean lint result despite direct calls at src/commands/server.ts:10024-10027 and src/core/StateManager.ts:190-194.

- MATERIAL: The schema is absent from the actual source. Grounding: missing registry wrapper/counters in src/monitoring/GuardRegistry.ts:40-71; missing manifest fields in src/monitoring/guardManifest.ts:24-65; old `/guards` `effective` projection in src/monitoring/guardPostureView.ts:66-74.

- MATERIAL: The v3 semantic gaming attack survives stage one. `looked > 0, wouldAct = 0, didAct = 0` is arithmetically consistent and becomes `instrumented` under the spec's own verdict table (/tmp/spec-v4.md:413-419). The spec's harness prerequisite acknowledges this (/tmp/spec-v4.md:432-451), so no consumer may treat `instrumented` as effectiveness.

- MATERIAL: The cost claim undercounts implementation surface. The survey supports the 28 scoped seams (.phase-b-census/chokepoint-survey.md:10-25), but source requires registry, manifest, posture output, lint, tests, and callsite edits; not "plus one registry change." Grounding: src/monitoring/GuardRegistry.ts:40-71, src/monitoring/guardManifest.ts:24-65, src/monitoring/guardPostureView.ts:27-37 and 66-74, scripts/lint-guard-manifest.js:202-250.

MINOR

- MINOR: The spec should stop saying direct bypass is "impossible." The precise claim is: "once a callsite is converted and a lint forbids the old direct call, forgotten `looked` increments become non-silent."

- MINOR: The cited `docs/audits/phase-b/guard-verifiability-28-and-44.md` file is absent. Either land it or update the citation to the actual `.phase-b-census/chokepoint-survey.md` artifact.

VERDICT

MATERIALLY-FLAWED. The narrowed wrapper direction is plausible for the 28 TICK-LOOP/FUNNEL guards and fits representative real callsites, but the current tree does not implement the schema, the named lint cannot enforce adoption, the "impossible" claim is false, and the stage-one counters still do not prove guard honesty.
