---
title: Evidence required for managed maturation moves
slug: measurement-evidence-floor
author: Echo
tier: 2
---

# Evidence required for managed maturation moves

## Problem statement

Topic139374 requires missing evidence to hold promotion and unsupported improvement claims while ordinary services continue. The recurring feature review already withholds recommendations under that instruction. The existing /maturation/moves authority still accepts a threshold/soak-ready feature without a recorded outcome baseline. Generic measurement readiness now checks baseline proof, but legacy feature readiness intentionally retains its old policy. This is the remaining managed-move enforcement gap, not permission to create a second promotion authority or an outbound text censor.

## Proposed design

Extend the existing MaturationLadderService.applyMove floor, using D7.maturationOutcomeForContract on the exact current ladder-owned target contract. Re-read live configuration and derive the target from the registry snapshot loaded by this service at boot at the start of each move; do not authorize from the 30-second view cache, a previous D7 pass's contract, a request-supplied boolean, a peer's proof or a parent/component's evidence. Preserve the existing hash/soak, development-agent, sensitive/coherence-critical, expected-old-config and verified-write floors. No new scheduler, database, registry, generic activation path, config flag or bypass switch.

An advance of a running feature requires a valid declared outcome contract, exact locally corroborated baseline and current observations for every metric, sufficient samples, current freshness, no future timestamps/source ambiguity, exact declared-contract/source/descriptor identity and criterion.met === true for every metric, including every quality safeguard. evidence.state verified establishes comparisons, not passing criteria; null/false criteria refuse. A first start uses the distinct baseline-only precondition below because current outcome criteria cannot be met before anything runs. The owner reads the raw ledger using the existing exact indexed observation reader, with at most16metrics and32observation lookups (one exact baseline and one latest observation per metric). Missing D7, owner collision, unreadable evidence or thrown reads returns an explicit evidence-unavailable refusal before a move-intent audit or config write. Record a separate bounded move-refused audit row with time, origin, feature id, enumerated reason and exact contract hash when available; no raw values or request context. A failed audit cannot turn a refusal into permission. No evidence is synthesized or backdated. Unknown remains unknown. The request's reason/opinions retain the accountable model's semantic decision; numeric proof never certifies causation or semantic improvement. Observation corroboration proves exact source/ref/descriptor identity; a free-text method/version label alone is not evidence of which code produced a row. Require the current immutable contract archive/hash for move proof, preserve history boundaries, and disclose that method semantics remain accountable review. Reusing identical source descriptors across a semantic method change cannot itself certify methodological equivalence.

Resolve the canonical current subject owner through the existing independent owner collector. The supplied contract must match the exact current ladder-owned target hash, with no generic/ladder owner collision, duplicate owner or absent subject. Generic declarations reserve their owner id before validating optional target metadata; malformed generic metadata cannot be overwritten by ladder precedence. This collector repair is reproduced by three failing-then-passing integration cases on runtime PR2847. Duplicate ladder subjects are already rejected by parseLadderRegistry (subject-collides), tested in MaturationLadder.test.ts “checks composed parents and colliding subjects”; never construct a usable owner map from a registry rejected by that parser. D7.maturationOutcomeForContract alone proves observations against a supplied definition and is not an ownership certificate. Unknown owner resolution refuses a move. Initiative-tracker and ladder-owner are required owner sources; missing unrelated job/capability inventory does not veto an otherwise resolved ladder owner. AgentServer injects this dependency from the same independent measurement owner collector used by the board; the monitoring service never imports a route or treats D7 subjectKnown from its cached pass list as ownership. Resolve once per move/list snapshot, not per metric. This is one local O(inventory-size) census walk in addition to at most 32 indexed proof lookups; there is no peer/network call and no claim that the full census costs only32reads.

Use the already-shipped MaturationOutcome projection for proof. Add a bounded evidence read dependency to the ladder rather than importing the ledger or crossing the HTTP boundary. The production AgentServer wires the same D7 instance; tests must exercise that actual wiring. The registry snapshot and its hash remain fixed for this running instance, matching its board. A deployed registry edit requires the normal server reload/restart; an arbitrary file edit is not a new owner until then. Reconfirm the exact loaded target/contract and expected live config immediately before writes; all proof and mutation remain synchronous, without network awaits between check and act. A write failure preserves the existing verified-write behavior. Synchronous execution prevents interleaving on this event loop only; existing expected-old-config checks do not establish cross-process transaction serialization, and this increment does not promise a new configuration transaction engine.

Preserve the existing threshold/soak state for DTO compatibility. Add separate promotionEligibility:{state:eligible|held|unknown|not-applicable,reason,checkedAtMs}, with explicit counts separate from historical threshold states. Missing fields from an older peer are unknown, never eligible. Expose a plain reason in the move refusal. A feature may still show numeric thresholds and soak passing while its managed move is evidence-held; headline counts and recurring-review consumers must use promotionEligibility, never infer eligibility from the old state alone. Render the existing owner-selected method/history detail to explain what is missing. Do not relabel historical D7 evaluations, reset soak, migrate records or rewrite old conclusions. Historical threshold-ready is explicitly distinct from present promotion eligibility.

The eligibility mapping is explicit:

| Case | Eligibility |
|---|---|
| Composed/retired/final feature, or no supported config move | not-applicable |
| Existing sensitivity/development/coherence/threshold/expected-config floor fails | held with that reason |
| Owner/config/evidence reader unavailable, or list proof budget omitted | unknown with that reason |
| First start with absent/foreign/invalid baseline | held with the distinct baseline reason |
| Running-feature advance with any unverified proof or criterion false/null | held with the proof/criterion reason |
| All applicable existing floors and the relevant start/advance proof floor pass | eligible for the existing model's decision, never an automatic move |

## First-start precondition

A not-started feature uses the existing model-decided start path only when it has a valid outcome contract, independently resolved exact owner, current immutable contract archive and a locally corroborated baseline for every metric, with sufficient baseline samples, finite values and no future timestamps/ambiguity. Current observations and current success criteria are not required for this start: they describe the intended effect after it runs. Never use projectMaturationOutcome.state verified as the start predicate; check each baseline.state verified directly while preserving all existing sensitivity/development/coherence/target/config floors. The baseline may fail the future success threshold; that is an honest starting point. No dry-run exemption, fabricated zero, empty baseline, new activation authority or new safe-start label.

A dark subject may not yet be admitted to D7 cadence and therefore may have no archived definition. On an explicit managed-start request only, after canonical owner validation, the same D7 owner may archive the exact validated immutable contract through its existing archive method. This creates method metadata and corroborated pins only, never metric observations or grades. Its existing transactional capacity/size bounds apply; failure refuses. List/detail GETs remain read-only and never create proof or refresh pins. An archive record alone does not supply a baseline.

A start with no meaningful recorded baseline stays held. Do not keep raising an undischargable request to call that endpoint: the existing recurring raise/review creates or updates the single maturation:<id> commitment as a baseline-acquisition task naming its method, owner and next check, with ordinary cadence/deduplication. Separately authorized drills or existing measurement producers may establish a real baseline; this increment grants no authority to run them or write raw proof by assertion. The contract must measure the intended outcome before/after; activity-only metrics that cannot provide a meaningful before-state require an authored method correction, not a sample-floor exception.

After an authorized first start, existing safeguards still apply and any later advance requires the full baseline/current/criteria floor. No start is labelled proven improvement. Existing revertMove is unchanged and never requires baseline proof; loss/expiry of evidence cannot prevent a valid conditional revert. No new downward-move API is introduced.


## Decision points touched

1. **invariant** — existing managed-move evidence precondition: exact typed contract, local corroborated observations, freshness, finite values/sample floors and declared numerical criteria. These establish whether proof exists for this exact subject/method; they do not judge semantic improvement. The existing /maturation/moves authority alone applies the floor.
2. **judgment-candidate** — whether the feature should advance when evidence exists remains the existing accountable recurring-review model with reason and opinions, within current sensitivity/development/coherence/soak/config floors. Conservative default is no move; unavailable or conflicting evidence ends at the deterministic no-write rung. The proof reader cannot create a recommendation.
3. **judgment-candidate** — improvement claims remain the existing conversational/review authority with baseline/method/sample/freshness signals and the explicit no-unsupported-claims instruction. No regex/text blocker, new outbound authority or universal semantic-enforcement claim. The review writes its reasons and corrective work to the existing report/commitment records.

## Multi-machine posture

Unified operator view through the existing selected-origin pool board. Eligibility is per executing machine, not a portable fleet permission. If the serving/executing machine changes and only the former machine has baseline proof, the new machine is held until a meaningful local baseline is recorded or the legitimate move is executed by its original authorized owner. Preserve other origins' readable history, do not re-author or copy proof automatically, and do not turn off running features. Report foreign-baseline separately from missing-baseline, naming the existing origin where known in the details and recurring review. Each managed configuration move must read the executing machine's own current contract and ledger; another machine's ready state cannot authorize it. Historical observations retain origin identity and are proxied on read through existing authenticated peer routes, never copied or treated as local proof. No new notices; the existing lease-held recurring reviewer remains the one report source. Credentials and physical process control remain with the existing owners, with no new replication or locality exception.

List views share a64-observation-read total budget, memoized by exact origin/subject/contract for that read, and evaluate proof only for threshold-ready or startable candidates. Count all candidates before admission; omitted candidates have unknown eligibility with an explicit budget reason and cannot inflate eligible counts. The move path always performs its own fresh bounded proof read and never authorizes from that list admission/cache. No list-view omission disables ordinary services.

## Frontloaded Decisions

- Every managed start requires real baseline proof, but not future current outcomes; no implied safe-start exemption. Missing-baseline start raises become deduplicated baseline-acquisition tasks.
- Preserve threshold state; add separate promotion eligibility and conservative old-peer handling.
- Canonical owner resolution precedes proof; supplied-contract corroboration alone is insufficient.
- Whole-view proof budget64observation reads; omitted candidates remain unknown. Per-move exact read remains at most32lookups, plus one inventory census.
- Eligibility is machine-specific; foreign-baseline and missing-baseline are distinct holds, with ordinary services preserved.
- Registry means the service's boot snapshot plus live config; restart/reload is required for a deployed registry change.
- Refusals have a separate minimal audit row; reverts retain their existing floors only.
- Baseline pins retain existing bounds:90-day ordinary observations and180-day unseen-pin expiry. Admission gaps can exhaust retention; reads never recreate proof. After expiry, hold explicitly and acquire a new real baseline under a new version. Test this boundary, do not claim indefinite retention.

## Acceptance and test plan

- Unit: threshold/soak-ready without an outcome baseline, mismatched/foreign/future/stale/ambiguous/insufficient proof and throwing/missing reader all refuse with zero config writes and zero move-intent rows.
- Unit: valid exact baseline/current proof permits only the existing model-decided standard development-agent config move; it does not bypass sensitivity, coherence, soak or expected-old-config floors. Different parent/component/target proof fails.
- Unit: changing live config or reloading a new registry snapshot after a cached view cannot authorize a stale decision. Separate startable tests prove baseline-only start eligibility with unmet future criteria, refusal with no baseline and no sample-floor/sensitive/development bypass. Test the baseline-acquisition raise instead of an impossible start demand.
- Unit: verified comparison with one criterion false/null refuses an advance with no writes; a valid conditional revert still applies after baseline expiry. Refusals create only the bounded refusal audit, never move-intent.
- Integration: missing/mismatched immutable archive on an advance and unavailable required owner-census sources refuse; first start can archive its validated definition through the existing owner, but an archive without real baseline observations still refuses. Capacity failure refuses with no activation; unrelated optional inventory failure alone does not veto a resolved feature owner.
- Integration: actual authenticated POST /maturation/moves carries the new explicit refusal and plain explanation. GET ladder distinguishes numeric readiness from move eligibility; peer origin stays selected.
- E2E: production AgentServer, actual D7 raw observations and exact registry-owned method flow through both a missing-evidence refusal and a legitimate managed move with readback; ordinary representative services remain reachable during a hold. Controlled fixtures are labelled test evidence, never deployed activity.
- Retention: expire a pin after180days outside admitted archive passes, prune unpinned old observations, and verify an explicit unavailable hold; only a new real baseline can restore proof. No read renews or fabricates a deleted observation.
- Deployment: run required verification before release; replay real feature evidence through deployed read and inspect the phone view. Preserve explicit missing baselines rather than inventing a clean fleet.

## Rollback and limits

Revert restores the prior managed-move floor without data migration or changing running features. No automatic disabling, restarting, retiring or reverting ordinary services. Previously approved moves remain running. The new refusal is intentionally stricter and can hold every feature whose old contract lacks baseline metadata; report that count honestly and use existing corrective work to author meaningful contracts. Direct raw configuration writes and source-code promotion remain governed by their existing review authorities and are not certified as covered by this endpoint floor. Whole-effort readiness and component proof do not inherit a feature's outcome.

## Maturation plan

- **test-agent-live:** controlled production-AgentServer tests exercise exact raw proof, missing proof, owner collision, archive failure and zero-write refusals before release.
- **dev-agent-live:** after this Tier2 design is explicitly approved and required verification passes, exercise the existing development-agent ladder endpoint and inspect its truthful holds; do not activate a feature solely for the drill.
- **fleet:** retain the existing maturation.ladder deployment gate and development-agent write restriction. No separate default-on feature, new flag or fleet activation is introduced; where that existing endpoint is enabled, its approved evidence precondition applies.
- **graduation criterion:** existing maturation.ladder owns graduation; this increment additionally requires the full acceptance matrix, zero unsupported managed moves, ordinary-service availability during holds and verified human-readable eligibility before its delivery claim.
- **dark-window:** 0 days of a separate dark feature; this is an approved precondition on an existing gated endpoint, not a new background capability. Its release still waits for required verification and review.
- **ladder:** maturation.ladder

## Open questions

*(none — revised first-start and per-machine policies require round4 review before convergence)*

## Original-run carrier

> **CMT-001** — Complete topic139374: independent coverage for features, decisions, jobs, efforts and components; enforce missing-baseline claim/promotion holds; preserve versioned history; deploy parent/component trend views; verify real activity and understandable visuals; recurring review reports here with bounded corrective work. Report any remaining gap by the original November6 22:44Z ceiling.

This spec prepares the remaining enforcement increment within that existing run. It does not certify completion or extend the deadline. <!-- tracked: CMT-001 -->
