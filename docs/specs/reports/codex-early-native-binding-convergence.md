# Design Review — Early Codex Native Binding

**Status:** Draft; not converged; implementation not approved.  
**Review rounds completed:** 1 of the Tier 2 maximum of 6.  
**Full convergence:** false.  
**Reviewed spec SHA256:** 3c2746fa82b02bd467a2a94510c5cc0228074ceb971a3b57ac7a4f0d67cbd0d6.  
**Reviewable body SHA256:** 9cf4575305f2a0e45e0a0fed615959cdad3e1f0c58709fa654ae00e36ce367e2.

## What Was Actually Reviewed

This is the first standalone N80 design round. It is not an additional round of the capped N79 scanner or N82 capacity designs. All six required internal lenses ran across three independent Codex agents: security and adversarial; integration and performance; decision completeness and lessons. Each produced separate lens findings. They read the draft, the actual conformance report, relevant implementation and subsystem principles. The lessons reviewer found no feedback_*.md files in the specified Echo root memory directory and disclosed that limit.

A real external review ran through the installed Codex CLI using gpt-6.2-astra. It returned status ok, verdict SERIOUS ISSUES and promptTruncated false. The helper returns crossFamily true because its historic default assumes a Claude author; the author and internal reviewers here are also Codex. This round therefore does not establish cross-family diversity. Gemini was detected but unauthenticated. No Claude reviewer ran during the operator's Claude-usage pause. These are actual disclosure limits, not invented reviews.

The standards-conformance gate ran against all 102 articles through the verified Codex-backed StandardsConformanceReviewer route. It returned nine advisory flags. The earlier absolute worktree-path attempts were rejected with HTTP400, specPath escapes specsDir, before grading. The supported inline-markdown request then supplied the exact draft and completed. No path guard was bypassed or reconfigured.

## Round 1 Findings

The round is not clean. The raw reviewer counts include overlapping findings: security/adversarial reported three DESIGN and one PRECISION; integration/performance reported two DESIGN and four PRECISION; decisions/lessons reported seven DESIGN and one PRECISION; the external reviewer reported three DESIGN and one PRECISION. The list below groups the actual issues without presenting a duplicated sum as unique defects.

- **Native ownership claim:** scoped authentication pins the Instar session, but the existing native-ID setter accepts a safe caller-supplied reference and replaces the binding. A real rollout's existence is not independent proof that its process owns it. The spec must explicitly select a trusted-hook assumption or add a real corroboration contract; it must not claim cryptographic ownership from receiver acceptance.
- **False delivered result after known failure:** Telegram deduplication inserts the source identity before the missing-baseline guard. The first call can refuse without effects; a repeated forwarding of that same message then returns true from deduplication. The ingress can say Delivered despite zero injection. A known-unsent outcome needs a precise deduplication contract; deleting every false-result entry would incorrectly reopen uncertain effects.
- **Original attempt versus redelivery:** a pre-effect refusal proves only this invocation did not type. It does not prove an earlier attempt of the same source was unsent. Resend advice must not be justified from that tag alone, especially for reinjectStuck/redelivery metadata.
- **Stored event versus native binding:** the existing hook receiver can return HTTP200 after storing an event even when no matching running session was bound. Identity-mode results/readback must distinguish storage, binding, unchanged identity, unknown session and unavailable rollout.
- **Final failure visibility:** if attention persistence and the ordinary failure response both fail, a log is not owner-visible custody. Define which existing outbound store accepted the notice and how combined failure remains an explicit unresolved state. No fictional queued or saved claim is allowed.
- **Agent-carried recovery:** the draft leaves the person remembering to resend after a notice. The design must name the agent-owned obligation for a current proven-unsent message, its evidence, next step and ending condition. A broader automatic custody/handover would need a separate stable source-ID and incarnation/epoch design; the existing random-ID prepare and global-holder queue do not supply it for free.
- **Input envelope:** bounded stdin lacks a complete-frame and overflow contract. A valid large irrelevant field must not be silently truncated before extracting identity. Choose and disclose a real input policy or preserve whole-frame parsing; do not invent a safety invariant from an arbitrary byte cap.
- **Receipt policy:** the inherited two-second process limit is a policy choice, not a proof that a valid response at 2.1 seconds is unsafe. Acknowledge its tradeoff and measure the chosen path without increasing a deadline by inference.
- **Repeated idle cost:** appending a reporter to Stop runs it on later turns and blocked-stop attempts too. Define repeated reporting/receipt behavior and native-ID rotation, rather than claiming an unimplemented first-idle-only optimization.
- **Outcome observability:** record content-free eligibility, reporting, binding, real baseline readiness, later dispatch and refusal, including unknown/unavailable. Event counts do not prove that the ordinary owner journey works. Measure latency and repeated/concurrent behavior without inventing an unsupported success threshold.
- **Real user-role acceptance:** actual native startup and HTTP/attention readback are insufficient to show the follow-up reaches the idle session or the refusal reaches the originating Telegram topic. Add a supported isolated real-user-role proof, preserving exact allocation and no live owner-channel mutation.
- **Pool read failure accounting:** the existing attention fan-out iterates resolvable peers. Specify evidence for reachable, offline, missing-URL and unmappable owners and remote acknowledgement, rather than treating an omitted owner as an empty successful read.
- **Authority and parent standards:** cite or qualify the attributed post-mortem program approval and name the constitutional parents. The Chief request is real authority for the assignment; it is not a substitute for an unstated historical approval artifact.
- **Standalone explanation:** open the technical spec with the person's problem and define native identity and rollout baseline before internal audit labels.
- **Bootstrap exception:** the existing pending first-prompt bootstrap has a narrow pre-rollout exception. It must remain intact and must not acquire the new refusal tag.

## Experience Fit

The originating request is Chief message8b040a6a: capture the baseline before idle delivery and never silently drop the owner message. A normal tool-less session that captures its genuine identity before the next message is the positive journey. Missing identity with an honest durable failure is a materially different outcome; it does not establish eventual recovery. A notice that tells the person to retry after an uncertain earlier effect can cause duplicate action. The design must weigh that contrast explicitly. Twenty historical effect-unknown rows remain uncertain and do not authorize replay.

The security reviewer independently concluded that an explicit durable refusal can satisfy a narrower no-silent-loss contract without automatic replay. The decision/lessons reviewer required an agent-owned current-message recovery loop. That scope distinction has been sent to Chief with concrete bounded-core versus new-custody alternatives; no broader replay architecture is inferred while the decision is pending.

## Decision Completeness and Fixed Limits

The draft frontloads D1 through D6 and uses zero cheap-to-change tags. Identity, durable notices and user-facing outcomes must not be tagged cheap merely to avoid design. Four implementation-shaping choices remain: recovery ownership, input envelope, receipt policy and measurable outcome states. The exact Throughput allocation and private Node24 requirement are operator coordination constraints and remain intact; reviewers correctly rejected the advisory flag that suggested weakening them.

## Evidence and Current Boundary

Private retained inputs are under `.instar/n80-preparation/`: r1-spec.md, r1-spec-body-hash.json, r1-conformance.json, review-source-context.md and r1-external-codex.json. Internal findings are retained in the originating review messages named above and summarized here. No production source, test, native hook registration, live delivery row or historical tombstone changed in this round. No test or native runtime proof has started for N80. This report is not a convergence or approval tag.


## Corrected bounded-core round 2 — not clean

Chief of Staff message `985daa2a-92a1-4b0c-b27f-718ab78eb903` selected the bounded core and one corrected review round: “No new automatic custody or replay design. Disclose plainly that the core does not guarantee eventual delivery.” Reviewed technical SHA256: `27d5bdac58dcbf60da58b85208c24bbb252a028f7a1ea2e8085a112610f9b4c8`. Snapshot and raw reports are retained in `.instar/n80-preparation/r2-*`. No source or test implementation exists. Approval and full convergence remain false.

Standards-Conformance Gate: ran, 102 articles and six flags. A preliminary conformance report was preserved separately before final pre-review clarifications; the reviewers received the final report. Six internal lenses ran across the same three actual Codex reviewers. Security/adversarial: one DESIGN. Integration/performance: one DESIGN and one PRECISION. Decisions/lessons: one DESIGN and three PRECISION. These counts overlap on the same notice defect; they are not three distinct source-history defects. External supported CLI review actually ran using Codex gpt-6.2-astra, returned SERIOUS ISSUES, three DESIGN and one PRECISION; promptTruncated false. The helper crossFamily flag is not real family diversity because the author and internal reviewers also use Codex. No Claude calls were used. An initial unsupported --round argument failed before any model invocation; the actual supported invocation omitted it.

The shared remaining DESIGN defect is unconditional source-wide “not delivered” wording from invocation-local refusal evidence. An earlier uncertain attempt requires attempt-qualified wording and an explicit unknown original outcome. The external binding finding requires an identity-specific conditional empty-or-same binding before the generic last-writer-wins bridge, preserving conflicts with zero binding effects; generic respawn/resume rotation remains unchanged. The external duplicate-obligation concern is dispositioned using actual CommitmentTracker.record lines839–847: its synchronous keyed creation already returns a nonterminal externalKey match. The corrected draft will require that existing single-process contract and a concurrent-handler regression, without claiming new cross-process uniqueness.

Integration source evidence confirms commitments scope=mesh merges local records and stored replicas and can return local-only HTTP200 with a dark replica layer. This is replicated-read posture, not owner-proxied read; absent replicas cannot prove no obligation exists. That actual limitation overrides a contrary internal interpretation. The remaining precision corrections concern inherited deadline policy versus safety floors, standalone explanation and source attribution, and the narrow preRolloutBootstrap exception. No skipped requirement or extra review round is silently treated as clean. Chief was sent the actual result and a request for an explicitly bounded closure check after preparing these exact corrections.


## Authorized bounded closure — stopped, not clean

Authority: Chief message `3ef62b40-4f95-49d3-bdf6-5195b754d10b`; exact spec SHA256 `7ed6ccdb2d31231f1921284e1a5b02dd47bfd758f7ea514e709c9d3a224cd441`. One internal reviewer found the four scoped corrections CLEAN. The actual supported external Codex gpt-6.2-astra check returned SERIOUS ISSUES, promptTruncated false. It identified a safety-relevant empty-slot ordering gap: the design requires the exact running incarnation, but the cited payload/context and lookup do not establish how a delayed predecessor report is distinguished before a successor has recorded its first native ID. An old report might win the empty slot and then cause the genuine report to be rejected. This is a proposed failure scenario, not a reproduced incident or a demonstrated shared-ID lifecycle. The reviewer requires existing incarnation evidence or a lifecycle proof that the ordering cannot occur, plus the delayed-predecessor-before-first-bind boundary test. The other three correction areas were accepted.

Per the explicit stop condition, no implementation, further review round, new incarnation token or authority expansion was started. Approval remains false, operator-delegated bounded closure is not recorded as successful, and full convergence remains false. Chief received the exact finding and its evidence limits.
