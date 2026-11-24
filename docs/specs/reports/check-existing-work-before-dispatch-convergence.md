# Convergence Report — A2, check existing work before starting or dispatching it

## Cross-model review: codex-cli:gpt-6.2-astra

The installed Codex reviewer returned an independent result on all six exact bodies. Gemini lacked authentication and the clean Anthropic review wrapper was unavailable. Internal security/adversarial, integration/performance, and lessons/decision reviews were distributed among three independent reviewers. Later rounds retested the findings reduced by the drafts. Five numbered frontloaded choices and zero cheap-to-change tags were verified on the final exact body.

## ELI10 Overview

A2 uses prior-work search when people ask what already exists, and before Instar starts work through a supported entry point. The lookup supplies evidence for the decision. It cannot grant access or permission. Replaying one authorized request points to the same operation.

An external service may accept an action and lose its reply. Instar records who may send before contacting it. A replacement worker needs positive proof that the old worker cannot send and that the action did not happen before it can try again.

## Original vs Reviewed

Review replaced generic duplicate responses with audience-specific admission proofs. It bound receipts to the exact operation and current audience, prevented an older request from discarding newer evidence, and required an authenticated single-use gateway for non-idempotent sends. It separated direct retrieval proof from the actual prior-work answer and assignment behavior.

## Iteration Summary

- Round 1, reviewable body `9cb0bea24d719da6f58ce2839ff684c17524ef5fb673c9fc333a2f8d9e805f4f`. Standards-Conformance Gate: ran (6 flags).
- Round 2, reviewable body `8a159b0336f3c1713a00db32a02d074185b1df636c23f066a686377854d060c0`. Standards-Conformance Gate: ran (4 flags).
- Round 3, reviewable body `ea7c98c926e52d603f9113582ce23e28a32b35724ee53d7db43b4a0ff7ab04a5`. Standards-Conformance Gate: ran (4 flags).
- Round 4, reviewable body `6b0903ac1d185ce8230358e96fc097aa81d5bf9607b406b8071679c6d9ea61e1`. Standards-Conformance Gate: ran (3 flags).
- Round 5, reviewable body `bae2ba3af421444c2fbc3c88f96884ebf8af45230e83f2733137b6a7b291fdaf`. Standards-Conformance Gate: ran (3 flags).
- Round 6, reviewable body `6861993d6f7b6fe31126cfedd3ae2730a59a1545477c7b747e95ef4e985022ec`. Standards-Conformance Gate: ran (2 flags).

## Proportion

Tier 2, six of six rounds. The proposal touches authorization, listener and dispatch routing, plus externally observable actions. No gate or connector can graduate solely because the design was reviewed.

## Experience fit

The normal private Chief of Staff replay needs a delivered citation to PR #3342 and an accurate distinction between approval, implementation and deployment. It must find work without priming or changing the owner's meaning. The shared-audience case checks the opposite boundary. Repeated authorized starts need one action, while authorized distinct work continues. Decision-completeness found five numbered choices and no cheap tags on the final exact body.

## Left behind

- External DESIGN. Recently completed overlapping starts may matter even after the discovery provider indexed them. The verified owner roster/disposition must prove it evaluated the required evidence. If a bounded query omitted eligible completed work, use a complete scoped lookup or pending disposition. Require the completed item on a later search page as proof before graduating the affected path. Exact-effect deduplication and the one-shot gateway remain independent of this positive recall.
- External DESIGN. The exact reviewed body requires final audience and source authorization at send, withholding unsupported or inaccessible drafts. The cited approval fixture belongs to a verified private destination. Where a forwarded origin leads to a shared or unknown destination, the acceptance test expects the existing neutral scoped pointer, with no private approval in prompt or response. The phrase requiring a sourced reply across the supported routes does not override that authorization invariant.
- External DESIGN. On a lost initial status response, authorized resubmission of the same canonical effect must recover its audience-bound opaque handle without creating another pending receipt or effect. Verify after a caller restart. The reviewed contract already binds the effect atomically to the canonical owner and retains pending results.
- Conformance. Route budgets calibrate admission backoff before activation. An uncertain admission holds the existing request and key. Slack stays advisory until an authorized normal-user replay passes, so a Telegram graduation does not establish cross-channel completion.

## Full Findings Catalog

### Round 1

**Verdict: SERIOUS ISSUES**

- **DESIGN — Fenced receiver and effect recovery.** A2 persists `dispatch-started` and blocks a successor from sending. It leaves retry behavior *inside the original claimant’s client* unspecified. The hierarchy’s §3 answer gateway permits one platform call and explicitly forbids retry after an ambiguous outcome. Require the same guarantee through the SDK and any forwarding proxy. Test a downstream that accepts the request and loses the response while the original worker stays alive. Count requests at the downstream and require exactly one.

- **DESIGN — Admission without disclosing hidden work.** A2 calls for a “generic existing-authority” result on a hidden exact-effect match, while requiring hidden-only changes to produce no distinguishable decision. Generic wording alone cannot reconcile those rules if a fresh start returns a new work ID and replay returns a different status or polling history. Define the caller-visible contract for submit and status lookup in both cases, including which result fields the caller may read. Test identical authorized inputs with and without a hidden exact match. The hidden-backlog test exercises a different case.

- **DESIGN — Admission without disclosing hidden work.** A2 allows “GET or POST discovery reads.” A1’s *One discovery query* specifies `POST /work/discover` and puts query text in the body specifically to keep it out of URL logs. Require that POST contract for searches and receipt issuance. If GET serves a separate resource, define it as an authorized lookup by opaque identifier.

- **DESIGN — Identify what the user authorized / Maturation plan.** A2 says to detect seeded known work, but its graduation criterion does not distinguish retrieval success from a correct ordinary answer. A1’s *Acceptance evidence* explicitly requires the unprimed permanent-address question to elicit a citation to PR #3342 and distinguish approval, review, and deployment. Carry that criterion into A2. Record classifier routing, retrieval, and the delivered answer separately so a correct lookup followed by a false novelty claim fails graduation.

### Round 2

**Verdict: SERIOUS ISSUES**

- **DESIGN — Fenced receiver and effect recovery.** A2 retains its own effect markers while the source can replay, but sets no corresponding retention requirement for downstream idempotency keys. If a downstream accepts a call, the response is lost, and its key expires before recovery, replaying the same key can cause a second effect. Require each connector to declare its guaranteed deduplication window. After that window, keep the operation unknown unless authoritative evidence resolves it or proves a retry safe. Test recovery after key expiry and count actual effects.

- **DESIGN — Admission without disclosing hidden work.** A2 puts judgment outside the owner transaction and requires the owner to read the current visible roster at acceptance. It leaves unspecified what happens to a *distinct-purpose* disposition when a relevant reservation first appears in that final read. Recording the earlier disposition against the newer revision would imply the reservation was considered. Bind the disposition to the roster revision actually evaluated. On a relevant visible change, repeat judgment outside the transaction within budget, then use the specified pending path. Test two distinct occurrence IDs proposing the same work and verify the second judgment receives the first reservation.

- **DESIGN — Admission without disclosing hidden work / Fenced receiver and effect recovery.** Receipts include the normalized search query, and A2 permits signed receipts. A signature establishes authenticity while leaving the query readable. Acceptance-time erasure checks can invalidate a receipt but cannot purge a copy already issued. A1 places derived search text under its source’s visibility, retention and deletion rules. Use the already-permitted opaque handle for client-held receipts, keep query text in an erasable owner-side record, and retain the minimal replay marker separately. Test forgetting the source after receipt issuance and before acceptance.

- **PRECISION — Maturation plan.** “The assignment log has no duplicate start” can pass with zero starts. For the assignment replay, state the expected initial condition and assert exactly one authorized assignment across the original request and its replays, with every replay resolving to that assignment.

### Round 3

**Verdict: SERIOUS ISSUES**

- **DESIGN — Fenced receiver and effect recovery.** A2 limits retries to the downstream’s guaranteed deduplication window, but gives no rule for a retry issued inside the window and received after expiry. Both calls could take effect. Require a receiver-enforced request expiry or a proven bound on arrival within the window. Otherwise use the one-shot dispatch path. Add a test that delays the retry across expiry and counts effects at the receiver. The existing lost-reply test covers recovery after expiry but does not require an in-flight retry.

- **DESIGN — Admission without disclosing hidden work; Fenced receiver and effect recovery.** A2 requires a same-key continuation to return its known status or result, while allowing terminal markers to compact into a contiguous watermark. A watermark proves closure across a range. By itself it cannot identify which of two closed occurrences succeeded or recover either result. Specify what an authorized caller receives after compaction. If exact-result replay is required, retain a scoped result reference and test replay of two compacted occurrences with different outcomes. If closure alone suffices, define the public “closed, result unavailable” outcome.

- **DESIGN — Maturation plan.** A2 says each seam graduates independently and schedules answer observation first, yet its graduation criterion requires *each* seam to pass both the answer and assignment incident proofs. Read literally, the answer seam cannot graduate until worker assignment is ready. Assign the unprompted #3342 citation and delivery-budget checks to the answer seam, the one-assignment replay proof to worker dispatch, and require both for the combined incident claim. This preserves A1’s distinction between demonstrating a read path and demonstrating its user-facing outcome.

### Round 4

**Verdict: SERIOUS ISSUES**

- **DESIGN — First assignment is untested (§ Maturation plan).** The replay fixture begins with one accepted assignment and passes when every delivery resolves to it. That proves reuse of existing work. A receiver that can retrieve assignments but cannot create one could pass this case. Keep the seeded replay and add an empty-start case through the normal router. Deliver the same authorized occurrence concurrently, then verify one assignment at the receiver and the same assignment ID on replay.

- **DESIGN — Admission can overlook completed work (§ Admission without disclosing hidden work).** A2 explicitly rechecks the active roster. A1 allows a source mutation to commit while discovery capture is pending. If a visible card is created and completed between lookup and acceptance, a fresh active roster can be empty while discovery still lacks the card. Even a detected revision change can lead back to the same empty roster. Retain an authorized delta for completed work until discovery confirms capture, or hold affected admissions pending. Test that sequence with distinct occurrences so exact-key deduplication cannot settle it.

- **DESIGN — Answer authorization needs a final delivery check (§ Identify what the user authorized).** A2 places observation after reauthorization and before a delivery receipt. Hierarchy §6.2 also requires the adapter to revalidate the audience immediately before sending. A grant or route can change while the answer is being generated. Make that existing check explicit for discovery-backed replies. Pause after lookup, revoke the grant or broaden the destination, then verify the adapter withholds the sourced draft and delivers only content authorized for the final audience.

- **DESIGN — Classifier measurements have no rollout consequence (§ Maturation plan).** The development trial compares classifier routing with bounded lookup on every annotated turn, but answer graduation names one required incident and sets no acceptable recall loss for other cases. A classifier could pass #3342 while routinely skipping recommendations. Before the trial, define the tolerated miss rate by turn type and the latency budget. If classifier routing misses the target and bounded lookup meets both targets, graduate bounded lookup for that route.

### Round 5

**Verdict: SERIOUS ISSUES**

1. **DESIGN — “Admission without disclosing hidden work.”** A2 lets the owner release a completed start from its admission index once the discovery provider proves application and completeness. A1’s “One discovery query” freezes each search snapshot. Consider this ordering: a second request searches, the first start completes, the provider indexes it, and the owner releases the completion record before the second request reaches acceptance. The second request’s snapshot still predates the first start. Require the owner to retain the delta for outstanding observations or demand a fresh search whose provider checkpoint covers the released record. Test this ordering with capture resumed before acceptance.

2. **DESIGN — “Identify what the user authorized.”** A2 derives effect identity partly from destination and rejects a changed payload only when operation keys collide. An edit that redirects an already dispatched occurrence can therefore produce a different key and skip that conflict. The requirement for explicit supersession leaves the disposition of the original dispatch unspecified. Bind each accepted occurrence to its original effect key and digest across edits. Test a destination edit after a lost dispatch reply. The original operation should remain available for reconciliation, and sending to the new destination should require a separately authorized occurrence.

3. **DESIGN — “Maturation plan,” dev-agent-live.** A2 selects classifier routing, unconditional lookup, or advisory operation by comparing recall and latency against targets. It identifies an existing latency budget, but the supplied text gives no recall threshold or denominator for that choice. A1’s seeded-case graduation rule measures findability through discovery, while A2 must also measure whether ordinary turns invoke discovery. Before running the comparison, have the route owner record which annotated turns require evidence, what counts as successful retrieval, and the minimum passing fraction. Keep the verbatim #3342 replay as its own required pass.

These are findings from the supplied contracts. The race and redirected dispatch are proposed regression cases, not observed production failures.

### Round 6

**Verdict: SERIOUS ISSUES**

- **DESIGN — Admission without disclosing hidden work.** A2 retains a completed start until its source is verifiably discoverable and older observations expire or refresh. A1’s *One discovery query* explicitly permits a bounded search to omit an indexed artifact. A fresh receipt can therefore postdate capture, miss the completed start, and encounter an empty active roster. Define which completed starts must reach adjudication. For those starts, require evidence that the candidate was evaluated, a complete scoped lookup, or a pending disposition. Test with a completed candidate just beyond the first page and a receipt issued after capture.

- **DESIGN — Maturation plan, `test-agent-live` and graduation criterion.** A2 requires the delivered answer to cite #3342 and distinguish approval, review, and deployment through each stated route, including forwarded input. The hierarchy’s §6.2 requires a neutral pointer for shared or unknown audiences, and A1 identifies the prior approval trail as audience-protected. Split the replay by destination. Require the sourced answer on an authorized private route. Forward the same question to a shared destination and require the neutral pointer, with the private approval evidence absent from both model input and delivered output. A correct privacy outcome should pass graduation.

- **DESIGN — Admission without disclosing hidden work, status recovery.** A2 requires an opaque submission handle for status and says retries reuse that handle. Its lost-response tests cover downstream dispatch, while the caller can also lose the response that first contains the submission handle. The stable occurrence and effect binding already give the owner a recovery key. Specify that authenticated resubmission of the original occurrence returns a usable audience-bound handle for the existing submission, including while admission is pending. Drop the first response after persistence, restart the caller, and verify it can recover status with one pending request and at most one effect.

## Convergence verdict

Converged at the six-round cap for the independently gated design, with explicit scope and release evidence conditions. The final security-related test wording follows the exact body's existing final send authorization invariant. No missing audience permission, incomplete evidence or uncertain external effect can be treated as safe release proof. Material recall and status-entry refinements are tracked above as immediate acceptance conditions. Implementation begins with read-only observation and commits no automatic authority expansion.

Implementation checkout editorial note. The orphan-deferral scanner read “follow-ups” as future work. The wording now says a later revocation can prevent subsequent operations and the accepted handoff remains irrevocable. The rule is unchanged. Round hashes above refer to the reviewed snapshots.
