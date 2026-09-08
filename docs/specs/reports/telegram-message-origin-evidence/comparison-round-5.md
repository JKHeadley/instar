# Independent comparison — Round 5 external reviews

Inputs: `cross-model-round-5.json`, `claude-round-5.json`, both round-4 external outputs, the round-4/5 performance-and-decisions reports, and the current complete specification. No source/spec edits performed.

Compared full specification file SHA-256 (including frontmatter): `836f4a4fae0b0ef0f0852444326e6dbe0c1d30c75dbdb11e1e23d80f72e47669`. The runner's separately computed reviewable-body hash is `8092a1111a377014bd4573e879f79114c57c23a4d65bf891b160ea56d30d11a9`.

Exact grounding excerpts from `docs/specs/telegram-message-origin.md`:

- **Line 147, browser prerequisite:** “Require a feasibility spike against concrete upstream Web client code before implementation, then a version-drift capability canary before each broker activation.” The same paragraph requires “delayed/duplicate updates and concurrent same-text sends” and names “an explicitly enrolled TDLib/MTProto transport as the preferred alternative”.
- **Line 93, display boundary:** “The display toggle never removes ASP.” **Line 153:** “enabled:false or all three field switches false yields no cosmetic footer, while recording continues.”
- **Line 103, availability:** “Hold as audit-unavailable if no durable evidence sink acknowledges; independently hold if the sole execution outbox cannot admit/claim.”
- **Line 219, health consumer:** “Expose held work plus notificationAttempted and notificationOutcome in live health/dashboard state and broadcast the state change.”
- **Line 133, diagnostic job:** “to examine discrepant browser/transport evidence and produce a diagnosis or request a read-only receipt probe.” **Line 151, consumer:** “its structured diagnosis and requested read-only probes are recorded on the existing delivery failure record for the recovery worker/operator inspection.”

## Counting rule and conclusion

The applicable spec-converge Phase 3 explicitly says the comparator consumes each finding's **declared** class and **must not re-classify from wording**. Accordingly, the external round-5 record contains **5 declared DESIGN findings and 3 declared PRECISION findings**. Internal performance/decision review has zero/zero, but cannot cancel those external declarations.

**`converged: false` under the currently recorded reviewer outputs.** Round 5 cannot be counted as quiet by this comparator. Several declared DESIGN findings appear already satisfied by text the reviewers themselves received; evidence-based disposition is documented below. Ask the originating reviewers to withdraw/correct those findings against the exact cited contracts, or obtain the next complete quiet review rounds. Do not silently relabel them as PRECISION or erase their declared counts to get convergence.

This procedural conclusion is distinct from the substantive result: I identify **no demonstrated newly missing architecture/behavior requirement** among these five external DESIGN items. Three retained documentation requests can be addressed without changing behavior. Browser feasibility remains unproven until its mandated spike actually runs; a quiet design review would not prove that capability exists.

## Finding-by-finding adjudication

### GPT-5.5 #1 — DESIGN: browser feasibility is an activation dependency

**Disposition: requirement already explicit; retain declared class pending author correction.**

Current `User-account alternative` requires a concrete upstream Web-code feasibility spike before implementation, a version-drift canary before every broker activation, correlation of client random_id/server message identity/full destination, and negative controls for delayed/duplicate updates and concurrent identical prose. Failure cannot be labeled delivered. It also names explicitly enrolled TDLib/MTProto as the preferred alternative if Web cannot supply correlated receipts. Rolling activation and acceptance tests refuse claims of complete transport coverage without those controls.

This directly implements round-4 GPT #1's requested spike/canary/fallback. Moving those requirements from an alternative paragraph into a more visible prerequisite summary would improve navigation, but does not add an absent gate. There is no unresolved operator choice about whether to fabricate a browser receipt: refusal/unknown and the enrolled alternative are already specified.

### GPT-5.5 #2 — DESIGN: hidden cosmetic display does not hide ASP

**Disposition: behavior already explicit; retain declared class pending author correction.**

`Presentation and ASP` says the display toggle never removes ASP. The displayed fields are machine/harness/model, and the closing presentation paragraph says disabling them produces no **cosmetic** footer. The overview independently says hiding the cosmetic footer does not remove the operator-account authorship marker. Contract 16 requires same-message proof regardless of cosmetic settings, and Frontloaded Decision 9 repeats the same-message authorship requirement.

The distinction the reviewer requests already governs implementation and has been disclosed to the operator. UI help text such as “Show machine, harness and model; required agent-authorship proof remains” would restate that contract, not establish new behavior. Preserve mandatory ASP; do not broaden a cosmetic preference into authorship suppression.

### GPT-5.5 #3 — PRECISION: dense implementation handoff

**Disposition: accept documentation improvement; no implementation change.**

An implementation task map can index the existing identity, outbox, broker, audit, ASP and notification contracts without duplicating or changing their authority. Do not turn this request into a new project architecture or unnecessary large rewrite. It repeats round-4 documentation-density feedback.

### Claude Fable #1 — DESIGN: availability coupling and held-send health

**Disposition: failure behavior and observability already explicit; retain declared class pending author correction.**

The durability section independently requires holding when all evidence sinks fail or when the sole execution outbox cannot admit/claim. Justin approved that policy. `Recording-outage notification` requires exposing held work, notificationAttempted and notificationOutcome in live health/dashboard state, broadcasting changes and persisting events upon recovery. The overview states the same execution-queue dependency.

An explicit sentence naming this as messaging availability's dependency on durable admission is useful clarification. A wholly new metric stack is not missing when the held-work state is already mandatory. If a counter is specified, derive it from that existing held-state authority rather than inventing a competing monitor. The reviewer's statement that an audit-store outage necessarily halts messaging “fleet-wide” also overgeneralizes: the spec has bounded alternate evidence sinks, physical execution authorities and explicit unavailable-peer coverage.

### Claude Fable #2 — DESIGN: make TDLib primary

**Disposition: contest as alternative preference, not a demonstrated missing requirement; retain declared class pending author correction.**

The spec recognizes TDLib/MTProto as the preferred alternative when Web receipt correlation fails and prohibits assuming that browser cookies constitute enrollment. Moving TDLib ahead of Web would change the selected transport plan and authorization/enrollment work; that genuinely would change what gets built, so it must not be relabeled as PRECISION. However, the reviewer supplies no feasibility evidence proving the already-gated Web path cannot satisfy the contract. Claims that the canary “will fail routinely” are predictions, not a measured blocker.

TDLib-first is not inherently forbidden by the operator's intent; both are user-account transports. It is also not automatically authorized/enrolled merely because technically attractive. Perform the already-required Web spike and use its evidence to select the specified alternative when warranted. Do not manufacture an additional login assumption to make the review quiet.

### Claude Fable #3 — DESIGN: diagnostic consult lacks a measurable job

**Disposition: named work/consumer already explicit; retain declared class pending author correction.**

Contract 9 gives the consult discrepant browser/transport evidence, requests diagnosis or a read-only receipt probe, and limits it to one per originId/30 seconds. The subsequent diagnostic-consumer paragraph says its structured diagnosis and requested probes go onto the delivery failure record for the recovery worker/operator, and validated probe evidence alone can update deterministic receipt state. The reviewer’s proposed probe-selection job is therefore already within the declared behavior.

This is not evidence that the consult has no consumer. Its cost/benefit should be measured during implementation, but removing it for Tier 0 conflicts with the stated project requirement for at least Tier 1 on critical pipelines absent a separately justified standards change. Giving it receipt or retry authority would undermine the immutable evidence floors. Neither expansion is necessary to resolve this review.

### Claude Fable #4 — PRECISION: “Open questions: None” versus technical uncertainty

**Disposition: accept scope clarification; no unresolved user decision identified.**

Keep the required Open questions none-marker for unresolved operator decisions, but add a nearby `Implementation prerequisites` sentence naming the Web spike, enrollment verification and activation tests as outstanding work. This avoids implying zero empirical uncertainty while preserving the skill's explicit distinction between design decisions and implementation verification. The same documentation request appeared in both round-4 external outputs.

### Claude Fable #5 — PRECISION: glossary placement

**Disposition: accept documentation improvement; no behavior change.**

Move/extend the short existing definitions before first use, covering lifeline, mesh, redrive, stampede, companion and ASP. Do not add a second set of conflicting normative definitions.

## Round-4 resolution audit

- Browser feasibility/canary/enrolled fallback: now explicitly required.
- Outage notification authority: pre-claim by the sole outbox, one named process incarnation, authenticated bounded IPC without timeout takeover, immutable single attempt.
- Notification capacity: separate 1,000-conversation/8-MiB/8-KiB bounds with incomplete-coverage reporting.
- `lessons-engaged` frontmatter: present.
- Capacity derivation/tunability: present, explicitly engineering ceilings rather than fabricated measurements.
- Document density/glossary and “no unresolved decisions” caveat: still reasonable PRECISION requests.

## Recorded counts

| Measure | Count |
| --- | ---: |
| Round-5 external declared DESIGN | 5 |
| Round-5 external declared PRECISION | 3 |
| Additional newly demonstrated behavior omission found by this comparison | 0 |
| Unresolved operator policy decisions identified | 0 |

Do not substitute the third row for the first in the convergence counter. Originating-reviewer clarification is the appropriate next step for disputed or already-covered DESIGN findings.
