Q1. Is the narrowed Q1 conjunction now TRUE?

Partly in prose, no in the normative verdict computation.

The revised text now states the only defensible runtime-detection claim: for an enabled tick-loop guard, with a declared `expectedTickMs`, a registered counters row, and a process continuously eligible/awake for more than `5 x expectedTickMs`, `looked === 0` is strong evidence of no wrapped invocation (`/tmp/spec-v6.md:476-484`). It also correctly excludes funnels from this runtime detector and says funnel adoption must be established at conversion time (`/tmp/spec-v6.md:486-488`). That correction matches current source constraints: staleness today is cadence-based only when `expectedTickMs` exists (`src/monitoring/guardPostureView.ts:243-255`), and current `/guards` construction passes `now` but no uptime or eligibility-window input (`src/monitoring/guardPostureView.ts:361-369`; `src/server/routes.ts:8703-8708`).

But the schema table still maps `looked === 0` directly to `never-evaluated` for every `tick-loop` or `funnel` row with counters (`/tmp/spec-v6.md:525-530`), and the Stage 1 union still has `never-evaluated` but no `adoption-unknown` (`/tmp/spec-v6.md:613-619`). That contradicts the narrowed claim at `/tmp/spec-v6.md:482-484`. Under the actual table, a quiet FUNNEL guard becomes `never-evaluated`, even though the spec itself says funnel `looked === 0` can be legitimate idleness (`/tmp/spec-v6.md:486-488`), and an enabled tick-loop without a current uptime/awake-window input can still be overclassified.

`continuously eligible/awake` is not currently obtainable by the guard posture pipeline. The current code has eligibility conditions that affect whether a loop exists at all, e.g. the scheduler is only constructed when `config.scheduler.enabled && coordinator.isAwake` (`src/commands/server.ts:7031-7034`), standby logs "Scheduler skipped" (`src/commands/server.ts:7101-7102`), and some loops skip work while standby inside an interval (`src/commands/server.ts:10742-10746`). None of that is threaded into `buildGuardInventory`, whose inputs are snapshot, bootSnapshot, registry, now, and acceptedFallbacks (`src/monitoring/guardPostureView.ts:361-369`). The spec names uptime and eligibility as required new inputs, but the verdict table does not consume them.

Q2. Is the capability split real this time?

The intended split is real in the primary API sketch: guard code receives `GuardVerdictSink { wouldAct }`, side-effect seams receive `ActionSink { act }`, and the registry itself is not to be passed to guard code (`/tmp/spec-v6.md:395-407`). That is a real capability shape, not just "please do not call didAct".

It is not yet fully coherent as written. The comparison table still says the guard handle exposes "`wouldAct`/`didAct`" (`/tmp/spec-v6.md:425-430`), which directly contradicts the corrected `verdict(key)` sample exposing `wouldAct` only (`/tmp/spec-v6.md:365-369`) and the minted-handle interfaces (`/tmp/spec-v6.md:397-402`). This is exactly the prior trust-split defect resurfacing as stale text.

Given current source wiring, the spec also needs an explicit construction rule, not just interface names. Today a full `GuardRegistry` is constructed once (`src/commands/server.ts:6941-6945`) and threaded through `AgentServer` and route contexts (`src/server/AgentServer.ts:709-710`; `src/server/AgentServer.ts:3748-3756`; `src/server/routes.ts:1517-1521`). Several funnel guards live inside those broad contexts rather than isolated guard classes, e.g. completion-claim verification runs in a route that can already read `ctx.guardRegistry` (`src/server/routes.ts:24587-24599`), model-tier escalation is wired inside `AgentServer` (`src/server/AgentServer.ts:3105-3118`), and outbound self-violation observation lives in the route send funnel (`src/server/routes.ts:3174-3183`). If an implementation adds `ActionSink` to those same broad contexts, guard/funnel code can obtain it in practice. The spec must require minting handles at construction seams and must not add an action-capable object to `RouteContext` or `AgentServer` options wholesale.

Q3. Is async `act()` now correct, including the error path?

Yes, the sketched `act()` is await-correct for success and failure:

```ts
async act<T>(key: string, perform: () => T | Promise<T>): Promise<T> {
  const result = await perform();
  this.counters(key).didAct++;
  return result;
}
```

Because `await perform()` occurs before the increment, a synchronous throw or Promise rejection exits before `didAct++` (`/tmp/spec-v6.md:371-378`). This fixes the prior async bug. It also matches real async side-effect paths such as `TelegramAdapter.createForumTopic`, where the API call is awaited before local registry mutation and return (`src/messaging/TelegramAdapter.ts:1489-1547`), and `findOrCreateForumTopic` awaits that call (`src/messaging/TelegramAdapter.ts:1590-1603`).

One implementation caveat remains: the code sketch does not show `try/finally`, so it correctly counts nothing on failure. Do not "simplify" it into a `finally` or pre-increment form.

Q4. Previously addressed findings that regressed or remain open

- The stale lint failure-case sentence is fixed. The spec now says the earlier lint claim was stale and removed, and accurately describes the current lint as manifest-classification only (`/tmp/spec-v6.md:512-516`). Current lint source supports that: it regex-parses `GUARD_MANIFEST`/`NOT_A_GUARD` components and reasons (`scripts/lint-guard-manifest.js:104-150`) and asserts classification/reason/dual-list rules only (`scripts/lint-guard-manifest.js:202-250`). `node scripts/lint-guard-manifest.js` is clean.
- The top status block still regresses fixed state. It says "the schema itself is still undefined" and "the chokepoint survey is unstarted" (`/tmp/spec-v6.md:24-25`; `/tmp/spec-v6.md:42-43`), while the later spec says the schema is now closed and the survey produced the 28/44 split (`/tmp/spec-v6.md:340-345`; `.phase-b-census/chokepoint-survey.md:10-25`).
- The trust split regressed in the comparison table: it still says the guard handle exposes `wouldAct`/`didAct` (`/tmp/spec-v6.md:425-430`), contradicting the corrected handle design (`/tmp/spec-v6.md:365-369`; `/tmp/spec-v6.md:397-402`).
- The prior wire/consumer surface finding remains open. The spec still counts four implementation surfaces (`/tmp/spec-v6.md:555-568`), but `/guards` is a wire contract returned directly from routes (`src/server/routes.ts:8710-8718`) and forwarded directly in pool mode (`src/server/routes.ts:8780-8793`). The heartbeat posture is also a separate exported wire type (`src/core/types.ts:2311-2340`), and consumers hard-code the old `effective` posture vocabulary: CapabilityIndex documents `/guards` in `on-confirmed`/`on-unverified` terms (`src/server/CapabilityIndex.ts:123-131`), and `ApprenticeshipStallGate` reads `effective` and treats `on-confirmed`, `on-unverified`, and `on-stale` as live (`src/core/ApprenticeshipStallGate.ts:807-845`).
- The cited durable 44-reason artifact is still absent. The spec cites `docs/audits/phase-b/guard-verifiability-28-and-44.md` (`/tmp/spec-v6.md:16`; `/tmp/spec-v6.md:517-518`), but `test -f docs/audits/phase-b/guard-verifiability-28-and-44.md` returned `1`. The present local artifact is `.phase-b-census/chokepoint-survey.md`, which records counts and classes (`.phase-b-census/chokepoint-survey.md:123-126`).

Q5. New findings

1. The narrowed runtime claim is not reflected in the verdict type or table. This is new relative to v6's stated change: the prose now says outside the five-clause conjunction is `adoption-unknown`, but the type/table have no such state and still collapse `looked === 0` to `never-evaluated` (`/tmp/spec-v6.md:478-484`; `/tmp/spec-v6.md:525-530`; `/tmp/spec-v6.md:613-619`).

2. The spec says runtime reconciliation needs "none" new machinery in the comparison table (`/tmp/spec-v6.md:449-454`), but the corrected prose below says process uptime and eligibility-window are new required verdict inputs (`/tmp/spec-v6.md:482-484`). Current source confirms those inputs are not present in `buildGuardInventory` or the route call (`src/monitoring/guardPostureView.ts:361-369`; `src/server/routes.ts:8703-8708`). The "none" row is now stale and materially misleading.

3. The five-clause conjunction is only a detector for a subset of tick loops, not for all 28 adoptable guards. The spec itself narrows it to 11 of 72 (`/tmp/spec-v6.md:490-493`), while the survey says there are 28 adoptable TICK-LOOP/FUNNEL guards (`.phase-b-census/chokepoint-survey.md:21-25`). That is acceptable if the verdict table has `adoption-unknown`; it is false under the current `looked === 0 -> never-evaluated` rule.

MATERIAL

- MATERIAL: Q1 is fixed in prose but still wrong in the schema. The verdict computation lacks `adoption-unknown` and ignores the five-clause predicates, so `looked === 0` still becomes `never-evaluated` for cases the spec itself says are not runtime-provable. Grounding: `/tmp/spec-v6.md:478-488`, `/tmp/spec-v6.md:525-530`, `/tmp/spec-v6.md:613-619`; source inputs absent at `src/monitoring/guardPostureView.ts:361-369` and `src/server/routes.ts:8703-8708`.

- MATERIAL: `continuously eligible/awake` is a required verdict input but is not currently available from the posture pipeline. Current source has awake/standby gating that affects whether guard loops run (`src/commands/server.ts:7031-7034`, `src/commands/server.ts:7101-7102`, `src/commands/server.ts:10742-10746`), but no uptime or eligibility-window input is threaded into `/guards` (`src/monitoring/guardPostureView.ts:361-369`; `src/server/routes.ts:8703-8708`).

- MATERIAL: The capability split is undermined by a contradictory table row and underspecified wiring. The normative interfaces are good, but the spec still says the guard handle exposes `wouldAct`/`didAct` (`/tmp/spec-v6.md:425-430`) and does not forbid placing action-capable handles on the broad contexts where funnel guard code currently lives (`src/server/routes.ts:1517-1521`, `src/server/routes.ts:24587-24599`, `src/server/routes.ts:3174-3183`, `src/server/AgentServer.ts:709-710`, `src/server/AgentServer.ts:3105-3118`, `src/server/AgentServer.ts:3748-3756`).

- MATERIAL: The implementation-surface count is still incomplete. The spec says four surfaces (`/tmp/spec-v6.md:555-568`), but the new neutral observability verdict requires wire and consumer changes across `/guards`, pool forwarding, heartbeat posture, and existing consumers of `effective`. Grounding: `src/server/routes.ts:8710-8718`, `src/server/routes.ts:8780-8793`, `src/core/types.ts:2311-2340`, `src/server/CapabilityIndex.ts:123-131`, `src/core/ApprenticeshipStallGate.ts:807-845`.

- MATERIAL: The cited named-reason artifact for the 44 unverifiable guards is absent from this tree. Grounding: `/tmp/spec-v6.md:16`, `/tmp/spec-v6.md:517-518`; `.phase-b-census/chokepoint-survey.md:123-126`; control `test -f docs/audits/phase-b/guard-verifiability-28-and-44.md` returned `1`.

MINOR

- MINOR: Remove or update the stale top status block saying the schema is undefined and the chokepoint survey is unstarted. Grounding: `/tmp/spec-v6.md:24-25`, `/tmp/spec-v6.md:42-43` versus `/tmp/spec-v6.md:340-345` and `.phase-b-census/chokepoint-survey.md:10-25`.

- MINOR: The runtime-reconciliation comparison table still says the detector needs "none" new machinery, contradicting the later requirement for new uptime and eligibility inputs. Grounding: `/tmp/spec-v6.md:449-454` versus `/tmp/spec-v6.md:482-484`.

- MINOR: The `invoke<T>(key, run: () => T): T` sketch is sync-shaped. That is fine for current examples, but if any guard invocation wrapper later brackets async evaluation, the same Promise-created-versus-completed issue applies to `looked` semantics. Grounding: `/tmp/spec-v6.md:360-363`; async guard-like admission exists at `src/monitoring/selfaction/governor.ts:1672-1675`.

VERDICT

MATERIALLY-FLAWED. v6 genuinely fixes the `act()` async bug and states the right narrow Q1 claim in prose, but the actual verdict schema still implements the wider false claim, the new required uptime/eligibility inputs do not exist in the current posture pipeline, the capability split has a stale contradictory handle row plus broad-context wiring risk, and prior material wire/artifact findings remain open.
