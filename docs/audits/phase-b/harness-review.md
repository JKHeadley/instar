## Tree Provenance

Source tree verified first:

- `git log -1 --format='%h %ci'` returned `2197591 2026-08-05 02:19:20 +0000`.
- Search control: `grep -rl CrashLoopPauser src | wc -l` returned `4`, so source search was live.

## Q1 - Is The Premise Sound?

Mostly yes. A staged violation is strictly stronger than self-reported counters because it observes the guard's decision path under a condition that should trigger it. That directly addresses the prior failure mode where a guard could report "nothing found" forever.

But the spec is right that this moves, not eliminates, the trust problem. The new load-bearing judgment is whether the staged condition is a faithful instance of the protected failure. The spec acknowledges that as decision point 3: faithfulness is a "judgment-candidate", not an invariant, and a crafted input can trip a guard for the wrong reason (`/tmp/harness-spec.md:156`-`/tmp/harness-spec.md:159`). That is honest, but the harness must record the reviewed faithfulness basis as first-class data, not just the A/B inputs.

The premise is sound only if the verdict is scoped to "this mechanism, this build, this config, this staged condition." The current record includes `configFingerprint` but no build/source fingerprint (`/tmp/harness-spec.md:120`-`/tmp/harness-spec.md:126`), which is not enough for a mechanism verdict after code changes.

## Q2 - The FUNNEL Nine

The "function you can call" classification is directionally useful, but the spec undersells the fixture surface. I checked more than three of the nine.

`messaging.attentionTopicGuard` is the cleanest case only if the harness calls `AttentionTopicGuard.decide()` directly. The guard is pure, clock-injectable, and decides from config plus in-memory event windows (`src/messaging/AttentionTopicGuard.ts:102`-`src/messaging/AttentionTopicGuard.ts:176`). But the listed funnel is `TelegramAdapter.ts:3995`, and the adapter reaches that line only in legacy per-item routing. Default single-topic routing returns before the guard (`src/messaging/TelegramAdapter.ts:3975`-`src/messaging/TelegramAdapter.ts:3987`), so an adapter-level harness must configure `attentionRouting.mode = 'per-item'` or it will not exercise the listed guard.

`messaging.topicCreationBudget` is callable, but not cheap in the way stated. The listed funnel, `createForumTopic`, first fails if the chat is not a forum (`src/messaging/TelegramAdapter.ts:1489`-`src/messaging/TelegramAdapter.ts:1496`), then runs the budget decision only for non-exempt origins (`src/messaging/TelegramAdapter.ts:1498`-`src/messaging/TelegramAdapter.ts:1525`), then calls the Telegram API and saves registry state (`src/messaging/TelegramAdapter.ts:1536`-`src/messaging/TelegramAdapter.ts:1544`). A faithful harness either calls the underlying `topicCreationGuard.decide()` seam or stubs forum/API/registry side effects while proving the adapter wiring.

`writeAdmission` is not just "call StateManager". `StateManager.guardWrite` consults `WriteAdmission` only after an instance has been attached (`src/core/StateManager.ts:180`-`src/core/StateManager.ts:197`). The new typed-refusal authority is live only when `dryRun:false` and the inventory latch is complete (`src/core/WriteAdmission.ts:271`-`src/core/WriteAdmission.ts:276`), while the production latch is currently `WRITE_SURFACE_INVENTORY_COMPLETE = false` (`src/core/WriteDomainRegistry.ts:91`-`src/core/WriteDomainRegistry.ts:99`). In dry-run, `guardStoreWrite` returns `legacy` and the caller falls through to the old blanket standby verdict (`src/core/WriteAdmission.ts:421`-`src/core/WriteAdmission.ts:438`). A staged A-case that merely observes a throw can accidentally credit the legacy guard, not WriteAdmission.

`intelligence.selfActionGovernor.enabled` requires substantial harness state. `admitFor` unconditionally allows when the core is not initialized or emergencyDisable is on (`src/monitoring/selfaction/governor.ts:510`-`src/monitoring/selfaction/governor.ts:515`). Even when policy denies, observe/demoted mode records `wouldDeny` and still allows (`src/monitoring/selfaction/governor.ts:661`-`src/monitoring/selfaction/governor.ts:684`). Pool-shared enforcing classes can auto-demote based on registered machine count (`src/monitoring/selfaction/governor.ts:408`-`src/monitoring/selfaction/governor.ts:435`). The harness therefore must set deps, class policy/mode, clock, counters, target identity, and sometimes machine-count/projection state; simply calling `SelfActionHandle.admit()` (`src/monitoring/selfaction/governor.ts:1672`-`src/monitoring/selfaction/governor.ts:1679`) is not sufficient.

`apprenticeship.stallCoverageGate.enabled` is reachable through `transition()`, but that call only reaches the guard if the program has a `stallGate` instance (`src/core/ApprenticeshipProgram.ts:643`-`src/core/ApprenticeshipProgram.ts:657`). The gate live-reads config (`src/core/ApprenticeshipStallGate.ts:548`-`src/core/ApprenticeshipStallGate.ts:562`), passes when disabled (`src/core/ApprenticeshipStallGate.ts:590`-`src/core/ApprenticeshipStallGate.ts:593`), and suppresses refusals under dry-run (`src/core/ApprenticeshipStallGate.ts:613`-`src/core/ApprenticeshipStallGate.ts:624`). Full evaluation needs install provenance, source files, worker validation, loopback `/guards`, commitment/evolution ledgers, and acceptance records (`src/core/ApprenticeshipStallGate.ts:633`-`src/core/ApprenticeshipStallGate.ts:680`, `src/core/ApprenticeshipStallGate.ts:790`-`src/core/ApprenticeshipStallGate.ts:904`). This is stageable, but not a cheap single function input.

`models.tierEscalation.enabled` is always constructed in `AgentServer` so wiring is present (`src/server/AgentServer.ts:3105`-`src/server/AgentServer.ts:3174`), but the actual decision is in `EscalationGovernor.admitEscalation`. That decision depends on live config, instance id, leases, hourly budget, cached quota snapshots, daily token ledger, and liveness reclamation (`src/core/EscalationGovernor.ts:137`-`src/core/EscalationGovernor.ts:260`). The manifest description "Model-tier escalation policy (COST-INCREASING enable)" is not enough to derive a faithful A-case (`src/monitoring/guardManifest.ts:992`-`src/monitoring/guardManifest.ts:1000`).

## Q3 - The Two-Sided Rule

The two-sided rule is necessary and genuinely sound as a floor. It catches the trivial broken guard that rejects everything, which the spec calls out (`/tmp/harness-spec.md:85`-`/tmp/harness-spec.md:96`).

It is not sufficient. A guard can pass one A-case and one B-case while still being broken in untested branches:

- `AttentionTopicGuard` has per-source and global ceilings plus a critical-priority bypass (`src/messaging/AttentionTopicGuard.ts:141`-`src/messaging/AttentionTopicGuard.ts:170`). An A-case for per-source coalescing and a B-case under budget would not prove the global ceiling, critical handling, window expiry, or source-key eviction.
- `WriteAdmission` has separate machine-local, cluster-shared, session-scoped, topic-scoped, unbound, absent, malformed, released, owner, and read-only paths (`src/core/WriteAdmission.ts:293`-`src/core/WriteAdmission.ts:358`). One A/B pair can prove only one table row.
- `EscalationGovernor` has independent refusal arms for disabled, missing instance id, lease capacity, hourly budget, quota unavailable/capped, and daily cap (`src/core/EscalationGovernor.ts:147`-`src/core/EscalationGovernor.ts:228`). A quota A-case plus a clean B-case would not prove lease or budget enforcement.

A broken guard that special-cases the canned A input and allows the canned B input passes both. Less maliciously, a guard with an off-by-one threshold can pass if the A and B are not placed on both sides of the exact boundary. The spec needs per-guard branch/obligation matrices, not just one A and one B.

## Q4 - Throwaway-Agent Limitation

The limitation is real, and the proposed composition is only partly sound.

The spec correctly says a throwaway verdict proves the mechanism, not the operator's live machine (`/tmp/harness-spec.md:98`-`/tmp/harness-spec.md:116`). Combining that with live posture is reasonable in principle (`/tmp/harness-spec.md:223`-`/tmp/harness-spec.md:229`), but the current composition is underspecified and can overstate coverage.

First, the verdict record carries `configFingerprint` but not the source/build fingerprint (`/tmp/harness-spec.md:120`-`/tmp/harness-spec.md:126`). A guard mechanism can change while config stays identical. The current reviewed source is commit `2197591`; a verdict from another commit should not automatically apply.

Second, live posture often does not prove live mechanism wiring for these funnel guards. The manifest explicitly declares `expectRuntime:false` for `writeAdmission` (`src/monitoring/guardManifest.ts:110`-`src/monitoring/guardManifest.ts:120`), `subscriptionPool.proactiveSwap.antiThrash.enabled` (`src/monitoring/guardManifest.ts:283`-`src/monitoring/guardManifest.ts:297`), `models.tierEscalation.enabled` (`src/monitoring/guardManifest.ts:992`-`src/monitoring/guardManifest.ts:1000`), `messaging.attentionTopicGuard` (`src/monitoring/guardManifest.ts:1073`-`src/monitoring/guardManifest.ts:1079`), `messaging.topicCreationBudget` (`src/monitoring/guardManifest.ts:1082`-`src/monitoring/guardManifest.ts:1088`), and `apprenticeship.stallCoverageGate.enabled` (`src/monitoring/guardManifest.ts:1092`-`src/monitoring/guardManifest.ts:1103`). The runtime getter interface itself is only enabled/dryRun/lastTick/job counters (`src/monitoring/GuardRegistry.ts:19`-`src/monitoring/GuardRegistry.ts:31`). For `expectRuntime:false` guards, `/guards` can say "configured on" without proving the live operator path is wired like the throwaway path.

So: mechanism verdict plus live posture is a useful display, but it is not coverage unless it also requires source/build identity, harness definition identity, config equivalence, and a per-guard statement of what live posture can and cannot confirm.

## Q5 - Specification-Derived A-Cases

Not fatal, but too weak as written.

Some manifest descriptions are specific enough to seed an A-case. `writeAdmission` says it classifies every write into a domain and admits or typed-refuses instead of the blanket standby boolean, with dry-run and legacy authority caveats (`src/monitoring/guardManifest.ts:110`-`src/monitoring/guardManifest.ts:120`). `messaging.attentionTopicGuard` names a per-source attention-topic circuit breaker (`src/monitoring/guardManifest.ts:1073`-`src/monitoring/guardManifest.ts:1079`). `apprenticeship.stallCoverageGate.enabled` names provisional and full transition checks and the dry-run rollout (`src/monitoring/guardManifest.ts:1092`-`src/monitoring/guardManifest.ts:1103`).

Others are too vague to be load-bearing on their own. `monitoring.completionClaimVerification.enabled` is only "Observe-only completion-claim corroboration against structural TurnEvidence" (`src/monitoring/guardManifest.ts:881`-`src/monitoring/guardManifest.ts:889`). `monitoring.correctionLearning.selfViolationSignal` is only "Self-violation observe-only signal inside correction learning" (`src/monitoring/guardManifest.ts:894`-`src/monitoring/guardManifest.ts:901`). `models.tierEscalation.enabled` is only "Model-tier escalation policy (COST-INCREASING enable)" (`src/monitoring/guardManifest.ts:992`-`src/monitoring/guardManifest.ts:1000`), while the actual admission behavior has multiple cost-guard branches (`src/core/EscalationGovernor.ts:147`-`src/core/EscalationGovernor.ts:228`).

Therefore description-derived A-cases are acceptable only if the harness definition also cites the exact code branch/decision table and the reviewer-approved protected failure. A description alone is not a spec.

## Q6 - New Findings

Fresh findings are below in MATERIAL and MINOR. The premise is not the problem; the implementation spec is under-scoped.

## MATERIAL Findings

1. The verdict identity model contradicts itself and is missing source/build applicability.

The record shape removes `agentId` and `machineId` and stores only `configFingerprint` as applicability data (`/tmp/harness-spec.md:120`-`/tmp/harness-spec.md:126`). The prose then says identities are removed and the verdict is keyed by `(guard, configFingerprint)` (`/tmp/harness-spec.md:129`-`/tmp/harness-spec.md:140`). Later the multi-machine posture says verdicts replicate keyed by `(guard, machineId, configFingerprint)` (`/tmp/harness-spec.md:161`-`/tmp/harness-spec.md:166`). Those cannot both be true.

Even after resolving that contradiction, config is not enough. A mechanism verdict depends on the guard code and harness definitions. The current tree is commit `2197591`; a verdict produced against another commit can be wrong under the same config. Required change: verdict applicability key must include source/build fingerprint and harness-definition fingerprint, and the spec must decide whether machine id is forbidden, stored as a non-throwaway owner of the verdict, or replaced by an environment class.

2. The FUNNEL plan is materially under-specified; several "cheap" funnels require state that can cause false credits.

For `writeAdmission`, the production live latch is false (`src/core/WriteDomainRegistry.ts:91`-`src/core/WriteDomainRegistry.ts:99`), and dry-run returns the legacy path (`src/core/WriteAdmission.ts:421`-`src/core/WriteAdmission.ts:438`). A harness that observes a thrown write through `StateManager.guardWrite` can credit the old standby guard instead of the new typed admission layer (`src/core/StateManager.ts:187`-`src/core/StateManager.ts:213`). For `SelfActionGovernor`, observe mode allows even a would-deny (`src/monitoring/selfaction/governor.ts:661`-`src/monitoring/selfaction/governor.ts:684`), so "pass/fail" is not enough without defining whether would-deny counts as action. For `ApprenticeshipStallGate`, dry-run suppresses refusal (`src/core/ApprenticeshipStallGate.ts:613`-`src/core/ApprenticeshipStallGate.ts:624`) and full evaluation requires provenance, source files, loopback, and acceptance (`src/core/ApprenticeshipStallGate.ts:633`-`src/core/ApprenticeshipStallGate.ts:904`).

Required change: each funnel entry needs a harness contract listing prerequisites, fixtures, exact decision seam, expected observable side effect, and which bypass/dry-run/legacy paths must be excluded.

3. A single A/B pair per guard is not a proof of the guard; it is a proof of one obligation.

The spec's two-sided rule is a good minimum (`/tmp/harness-spec.md:85`-`/tmp/harness-spec.md:96`), but source shows multiple independent branches in the sampled guards. `AttentionTopicGuard` has per-source, global, critical-priority, and rolling-window behavior (`src/messaging/AttentionTopicGuard.ts:141`-`src/messaging/AttentionTopicGuard.ts:176`). `WriteAdmission` has a multi-domain decision table (`src/core/WriteAdmission.ts:293`-`src/core/WriteAdmission.ts:358`). `EscalationGovernor` has independent admission refusals (`src/core/EscalationGovernor.ts:147`-`src/core/EscalationGovernor.ts:228`).

Required change: record verdicts at the obligation/branch level, then roll up to guard-level only when the manifest-declared obligations are covered. A guard with one passed A/B pair should be `partially-verified`, not `catches`.

4. The throwaway-agent composition can imply live coverage that `/guards` cannot supply.

The spec says the deliverable is mechanism verdict plus live posture (`/tmp/harness-spec.md:223`-`/tmp/harness-spec.md:229`). But most funnel entries I checked are `expectRuntime:false`, including `writeAdmission`, anti-thrash, model tier escalation, both Telegram guards, and the apprenticeship stall gate (`src/monitoring/guardManifest.ts:110`-`src/monitoring/guardManifest.ts:120`, `src/monitoring/guardManifest.ts:283`-`src/monitoring/guardManifest.ts:297`, `src/monitoring/guardManifest.ts:992`-`src/monitoring/guardManifest.ts:1103`). For those, live posture is largely config/static posture, not a runtime proof of the operator-machine decision path. GuardRegistry runtime status, when present, is only a small status object (`src/monitoring/GuardRegistry.ts:19`-`src/monitoring/GuardRegistry.ts:31`).

Required change: display composition as "mechanism verified elsewhere; local posture appears applicable" unless the guard has a live-path confirmation. For `expectRuntime:false` guards, require either a local non-mutating canary, a wiring hash, or explicit "not live-path-confirmed" wording.

5. Several specification-derived A-cases cannot be faithfully derived from manifest descriptions alone.

The spec now relies on manifest description, criticalPath, and code branch (`/tmp/harness-spec.md:206`-`/tmp/harness-spec.md:209`), but some descriptions are too vague: completion claim verification (`src/monitoring/guardManifest.ts:881`-`src/monitoring/guardManifest.ts:889`), self-violation signal (`src/monitoring/guardManifest.ts:894`-`src/monitoring/guardManifest.ts:901`), and model-tier escalation (`src/monitoring/guardManifest.ts:992`-`src/monitoring/guardManifest.ts:1000`). Code branches provide the missing substance, but the spec does not require a reviewer-approved branch map before accepting a verdict.

Required change: A-case definitions must cite the manifest text and the exact source branch/decision table. If the description is vague, the harness definition should be `needs-spec` until a sharper guard contract is written.

## MINOR

1. The spec should distinguish "guard acted" outcomes for observe-only guards. For example, SelfActionGovernor observe mode returns `allow` with reason `observe-would-deny` (`src/monitoring/selfaction/governor.ts:671`-`src/monitoring/selfaction/governor.ts:676`), and ApprenticeshipStallGate dry-run returns `allow` with `dryRunSuppressed:true` (`src/core/ApprenticeshipStallGate.ts:613`-`src/core/ApprenticeshipStallGate.ts:624`). The record shape's `expected`/`observed` fields should model "would-act" separately from "blocked".

2. The spec should separate mechanism tests from adapter integration tests. `AttentionTopicGuard.decide()` is pure (`src/messaging/AttentionTopicGuard.ts:141`-`src/messaging/AttentionTopicGuard.ts:176`), while `TelegramAdapter.createForumTopic()` includes API and registry side effects (`src/messaging/TelegramAdapter.ts:1536`-`src/messaging/TelegramAdapter.ts:1544`). Both are useful, but they prove different claims.

3. The spec says teardown is not tracked because there is nothing durable to tear down (`/tmp/harness-spec.md:138`-`/tmp/harness-spec.md:142`). That is true for the verdict identity, but not necessarily for harness execution. Some sampled guards write logs, leases, ledgers, registry state, or decision rows. The throwaway agent may make cleanup less dangerous, but the harness still needs bounded state directories and post-run deletion of the throwaway workspace.

## Verdict

SOUND-WITH-CHANGES

The central premise is sound: staged violations are the right way to falsify dead guards. The current spec is not yet a sound harness spec because it underspecifies applicability identity, fixture requirements, branch coverage, and the limits of combining throwaway verdicts with local posture.
