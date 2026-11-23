# Convergence Report — Approval Requests That Reach The Owner

## Convergence verdict

**Convergence failed at the six-round Tier 2 review cap. No convergence or approval tag has been written. No runtime source implementation, new tests, live approval delivery, commit or push has occurred.** Final reviewed spec SHA256: `16e195f1da986f0e253aaa1747215666922f30654033f0c1f83dbd3a36ac61f3`.

The skill requires an operator decision when safety, security or data-loss design findings remain at the cap. This report presents the actual unresolved findings and bounded corrections; it does not label them precision to force a pass.

## Cross-model review: codex-cli:gpt-6.2-astra

Actual external Codex CLI reviews ran each of six revisions, with full parent architecture, app approval and signal/authority context. Gemini was not authenticated. Claude remains paused and was not used. Internal reviewers are Codex subagents in the authoring family; their exact model names were not independently verified. Therefore this is independent review within the same model family, **not evidence of family diversity**. The tool's generic cross-model flag does not change that limitation. Constitutional checks used the real createSpecReviewRoutes and complete actual registry, with an explicit Codex provider, returning200/nondegraded in every round. Review evidence is in `.instar/n78-verification` and /tmp/n78-external-roundN.json.

## ELI10 Overview

An agent should say it is waiting for approval only when an actual request reached an owner approval surface. Otherwise it should explain the failed or uncertain delivery. Reading a pull request should also remain a read, while write permissions stay protected.

Review found that implementing this honestly crosses delivery, storage, timeouts and machine handover. A message can arrive while its acknowledgement is lost. A replacement machine may have the request but not its sending history. A slow storage write may finish after the caller stopped waiting. The design now handles many of those cases explicitly, but the final outside read found additional safety cases that still need a decision and correction before code.

## Original vs Converged

There is no converged spec yet. Compared with the initial draft, the current candidate specifies exact original tool-name matching (avoiding flattened-name collisions), durable requests before send, attempt evidence, shared owner serialization, truthful uncertain delivery, independent random presentation references, current-owner acceptance checks, installed-hook validation, real production initialization tests and bounded response timing. It deliberately preserves every existing write, receipt, proof and owner barrier.

## Iteration Summary

| Iteration | Actual review posture | Build-changing findings and synthesis | Standards-Conformance Gate |
|---|---|---|---|
|1|All six internal lenses, actual external CLI|Exact raw-name collisions; ambiguous delivery/anchor failure; principal-wide capacity and acceptance coordination; forward uncertainty; production initializer and finite wire contract. Source disproved external objection to actual accepted-device authority.|ran (7 flags), nondegraded|
|2|Security, adversarial and integration reviewed the old revision; material findings prompted an early revision before the remaining three lenses. This is an incomplete frozen-body round, not a six-lens pass.|Code-bearing identifiers; current-owner anchor checks; absent takeover-history fence. No convergence was claimed.|ran (3 flags), nondegraded|
|3|All six lenses reviewed SHA126b88e0; actual external CLI|Independent random reference instead of enumerable digest; trusted-origin custody; concrete sink health; shared acceptance target uncertainty; impossible acceptance continuation; accurate expiry/withdrawal recovery; bounded adapter waits.|ran (8 flags), nondegraded|
|4|All six lenses reviewed SHA0dbf7141; actual external CLI|Whole caller deadline; late Slack post prevention; unresolved delivered-slot reservations; terminal-state checks; strict safe reference encoding; condition-specific recovery.|ran (4 flags), nondegraded|
|5|All six lenses reviewed SHA12253965; actual external CLI|Pending initial-write reservations; independently verified initialization rather than ENOENT; durable pending-acceptance transition; physical-post boundary and cancellation; acceptance withdrawal; bounded settlement persistence.|ran (3 flags), nondegraded|
|6|All six lenses requested on final SHA16e195f1; actual external CLI; all six responses received|Internal security/adversarial/integration/performance/decision reviews found no further design changes; lessons found missing local refusal traces and external CLI raised four remaining design findings below. This is not a quiet round.|ran (5 flags), nondegraded|

## Remaining Design Findings At The Cap

1. **Safety: reserve a card slot before submitting the start-marker append.** The spec currently reserves pending initial requests and durable started attempts. A start-marker append itself can remain pending after the caller deadline. Another request could take that last slot before the marker commits. Proposed correction: reserve delivered capacity before submitting that append; retain it across lane release; convert it on commit; settle definite non-send when deadline prevented posting. Test one remaining slot and delayed marker commit.
2. **Recovery correctness: request expiry cannot clear shared acceptance uncertainty.** Acceptance attempts are scoped to principal/adapter/current owner, so a fresh request must not reset that history. Proposed correction: separate card recovery from prerequisite recovery. Use an existing authenticated surface to show the exact acceptance sentence if one exists; otherwise say plainly that no such recovery surface is available. Do not promise expiry repairs it or silently add a reset endpoint.
3. **Safety: forwarded remaining durations cannot establish the originating physical-send deadline.** Transit can consume the remaining duration before the holder starts its timer. Proposed correction needs an explicit originating-deadline/cancellation contract with honest clock-uncertainty handling, or conservative refusal where the deadline cannot be established. Test delayed forwarding past the origin deadline with zero platform posts. A standby abort alone does not stop holder work.
4. **Owner experience: failure notice in the originating work conversation needs actual verification.** Parent requires one notice per kind there after direct-send failure. Proposed correction: trace the actual existing delivery route and test two confirmed failures yielding one visible notice with a real recovery step; ambiguous delivery must have distinct wording. Hook stderr alone is not proof the owner saw that notice.

5. **Refusal conservation: write a safe local refusal trace before returning.** The actual binding registry standard requires the deciding machine to record its refusal, while trust admission currently returns before the ordinary operation logger. Proposed correction: one bounded local helper covering pre-request failures, history/custody, lease and deadline refusals; safe outcome/reason, machine, timestamp, presentation reference and forwarding disposition only. Trace failure never permits the action or hangs. Test actual local traces on holder and standby.

These include the external and lessons reviewers' actual DESIGN classifications. Findings1 and3 concern safety. The report therefore stops as convergence-failed under `.agents/skills/spec-converge/SKILL.md`, Phase3, cap rule.

## Experience fit

Chief messages b1dbd56b and2e0cb084 are the source of the requested outcome. Actual queue evidence found three undelivered requests for the exact nested GitHub fetch_pr tool; the reported create_worktree refusal's original transcript was not independently inspected. The design contrasts a genuinely delivered current-owner card or accepted-device request with an unconfirmed/no-request refusal. It forbids implying the owner has failed to answer when delivery or continuation is impossible. Controlled lifecycle tests do not constitute live owner proof.

Failover availability is a real tradeoff: a successor with incomplete history cannot blindly redeliver a foreign request. Withdrawal does not bypass existing expiry suppression. Returning to the original machine fixes only a custody barrier with positive safe-send evidence; it does not resolve an unknown physical send. Shared prerequisite uncertainty still needs the correction above.

## Fixed Limits And Decisions

Final decision reviewer:17 frontloaded decisions,1 aggregate documentation tag covering unchanged inherited limits,10 independently contested boundaries cleared. Five seconds is a selected operational response default inside actual forward6/hook8/installedCodex12-second bounds; only the requirement to refuse before outer deadlines is invariant.128bit independent random identity is selected security strength, not a uniquely required value or behavioral quota. Existing three-card/three-undelivered caps, summary3000/input2500/toolname120, expiry, withdrawal suppression, one-day reuse and owner-decision10/10min policy remain unchanged. No contextual permission bypass is introduced.

## Standards Dispositions

Across rounds the exact inherited-limit cutoffs were challenged; the bounded repair preserves current policy and exposes its actual refusal reasons rather than silently rewriting trust. Repeated Close-the-Loop flags do not justify an autonomous resend controller after ambiguous delivery. A synchronous honest refusal with actual recovery is the scoped outcome. An early alleged acceptance-link expiry issue was rejected from actual source: acceptance uses an exact sentence, not an expiring link. Weak parent-fit results were advisory; one-action owner delivery supports exclusive owner authority without requiring a standing-grant feature.

The final conformance flags require individual disposition before any future approval: selected deadline default; inherited limits; marker age versus deleted message; conservative creating-machine custody; and local refusal-trace conservation. Marker delivery evidence proves actual acknowledgement at delivery, not perpetual platform existence; claims and tests must retain that limit. Source-head startup completeness is a separate inspected foundation gap actually handed to Chief in message7196f945-3981-4525-ae3b-0d6e0c6978de; local folded records and lease ownership are not represented as remote-head proof.

## Proportion

Tier2 security-sensitive repair, six rounds used of six. The design grew substantially because the parent implementation lacks delivery-state and recovery evidence. No source implementation should begin by pretending this review is complete.

## Left behind

Precision: clarify the decision-table deadline row so the selected5-second default is distinguished from the outer-deadline invariant. Record exact internal reviewer model uncertainty. Per-row obsolete-read retirement remains conditional on stored identity verification; three queue summaries do not establish three freed slots. Actual authorized live delivery proof remains required before a deployment claim.
