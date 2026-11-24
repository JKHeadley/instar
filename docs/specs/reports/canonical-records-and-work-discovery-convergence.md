# Convergence Report — A1 — Canonical records and read-only work discovery

## Cross-model review: codex-cli:gpt-6.2-astra

The installed Codex reviewer ran on six exact bodies. Gemini was unavailable without authentication and the clean Anthropic wrapper was unavailable. Three independent internal reviewers covered the six security, adversarial, deployment, performance, lessons and decision lenses. They counted five frontloaded decisions and zero cheap-to-change tags. Final internal lenses cleared their material findings. The final external conclusions and the cap disposition remain explicit.

## ELI10 Overview

Each enrolled record has one accountable owner. The read-only work search groups authorized evidence and reports covered sources. The first test checks the prior permanent-links design and the difference between approved, in review and deployed.

## Original vs Reviewed

Review added destination-bound authorization, query-safe egress, independent provider coverage, stable paging, verified provenance, replay over retention gaps and fenced ownership migration.

## Iteration Summary

- Round 1, reviewable body `6088c107d89df5a2409f5da65c957673456f7dec5362ce3ddbd8f17efb6d4fe7`. Standards-Conformance Gate: ran (3 flags).
- Round 2, reviewable body `1df9e772329e26ab0cb05f2514760998eadf3084328b822441d2927c09d0d362`. Standards-Conformance Gate: ran (4 flags).
- Round 3, reviewable body `c37a6a06979c531ce13b1308edf1ae7d4a11ec8b9b82e972607889df3f9e9d41`. Standards-Conformance Gate: ran (4 flags).
- Round 4, reviewable body `8dbd29e687f69d649793eefc856e3a73736317ecaafcef1b998e84a4a9abd170`. Standards-Conformance Gate: ran (2 flags).
- Round 5, reviewable body `b59d6d223df6ebe3cd7121c6ba4b1ce5d4ac9b0fa1e5f9e5cfe6bd7ff857dfe1`. Standards-Conformance Gate: ran (2 flags).
- Round 6, reviewable body `eca45f66851fa77c0937c271f5576c632e2df467e30dd1e29c71e98affc4d36e`. Standards-Conformance Gate: ran (2 flags).

## Proportion

Tier 2, six of six rounds. The design introduces cross-source or cross-machine contracts. Independent lenses and external review repeatedly narrowed concrete failure modes.

## Experience fit

The explicit owner lookup and private Work view need to find the known work without supplying the PR number. The ordinary Chief of Staff replay reports invocation, retrieval and delivered citation separately. A skipped advisory invocation is evidence for A2.

## Left behind

- External DESIGN: the exact body requires live authorization of both grouping edges and relevant-access restart at each page. Treat observed link revocation as relevant access and require a test that restarts only the dependent visible continuation. An owner-private link change must leave a member page usable. No implementation may expose a revoked link.
- External DESIGN: historical hydrated PR text may change. Cold-rebuild tests remove the distinctive phrase as well as the local index. Evidence must come from retained versioned spec or verified source-owned aliases. Where it does not survive, report a coverage gap. This bounds the historical recall claim.
- External DESIGN: a temporarily excluded item keeps the relevant coverage partial. An epoch-scoped processed exclusion is a potential efficiency improvement. The strict reviewed behavior retains the gap until re-evaluation, so it cannot report false completeness.
- External PRECISION: report invocation, retrieval and citation independently, and mark retrieval unobserved when the advisory agent skipped lookup.
- Retention and grouping flags: the initial merged window describes the current provider, not whether work exists. Related effort links are allowed and one canonical artifact is counted once.

## Full Findings Catalog

### Round 1

**Verdict: SERIOUS ISSUES**

- **DESIGN — Migration and reconciliation.** A1 requires one serialization point per kind. The registry (§5) says `jobs.json` mixes shared definitions with machine-local bookkeeping and requires a field or store split before sync. A per-kind fence can still leave two writers replacing the same file from different snapshots. Make the split, or one atomic writer for the entire physical file, a cutover prerequisite. Test a scheduler bookkeeping update racing a definition edit and verify that both survive.

- **DESIGN — One discovery query.** A1 freezes a result snapshot but also says a changed authorized generation restarts pagination. The hierarchy (§§7.3–7.4) explicitly preserves a cursor across unrelated edits. A1 does not distinguish an ordinary edit to visible content from a change that invalidates permission to serve the snapshot. Separate content revisions from authorization and erasure generations. Test that inserting an unrelated visible PR between pages preserves the cursor and original ordering, while revoking access to a snapshotted result prevents its return.

- **DESIGN — One discovery query; Acceptance evidence.** A1’s sensitive-provider rule addresses hidden rows affecting a provider’s scan budget. It also requires stable observable behavior after hidden-only mutations, yet defers hidden-backlog isolation to A2. Even with perfect row filtering, private capture work sharing a constrained resource with interactive search could make a public PR provider miss the aggregate deadline. This is a possible failure, not an observed incident. Define whether A1 guarantees stable results under hidden traffic. If so, reserve interactive capacity and test concurrent private backfill. Otherwise, narrow the acceptance claim to the isolation A1 actually provides.

- **PRECISION — Acceptance evidence.** “Repeat the earlier mesh query” has no fixture identifier or expected result in the supplied material. The introduction identifies the permanent-address replay and PR #3342, but gives no corresponding locator for the mesh case. Name the authorized fixture, required retained source IDs, and what the empty machine may recover from. That makes the test reproducible without publishing private query text.

### Round 2

**Verdict: SERIOUS ISSUES**

- **DESIGN — One discovery query / Acceptance evidence.** A1 protects private results and omits raw queries from routine logs. It also sends searches through a public GitHub PR provider. The spec never says whether that provider may forward the owner’s question to GitHub. Permission to read public PRs does not establish permission to disclose private search terms. Have the provider refresh the allowlisted PR corpus independently and search it locally. Test a cold lookup with a unique private phrase and inspect outbound requests as well as logs.

- **DESIGN — Capture and link work / Read-time integration.** The hierarchy (§§4.1, 6.2) tags generated reports and excludes them from later verification. A1 retains discovery replies in conversation history and searches that history, but leaves the treatment of those replies unspecified. A second lookup could cite the first answer as evidence of approval after the original approval becomes unavailable. Preserve source-dependency tags on discovery replies and resolve factual citations to their underlying evidence. Repeat the lookup after removing the approval source and verify that the old reply cannot substantiate approval.

- **DESIGN — Capture and link work / Multi-machine posture.** A1 retries capture by source ID, revision and purpose, yet measures completeness by contiguous offset. The hierarchy (§3.2) explicitly holds events whose causal parents are missing. A1 specifies gap tracking but leaves the replay starting point undefined when a provider’s retained lower bound has advanced past the consumer’s checkpoint. Require a verified snapshot covering the missing interval before resuming a claim of complete coverage. Test a transfer across that retention boundary, including an item deleted during the missing interval. If only current state can be recovered, report historical coverage as partial.

- **PRECISION — One discovery query / Acceptance evidence.** Acceptance says “check … no caching,” while pagination explicitly requires retained result snapshots. Scope the check to HTTP responses and intermediaries using `Cache-Control: no-store`. Test server-side snapshot retention, byte limits and invalidation separately.

### Round 3

**Verdict: SERIOUS ISSUES**

- **DESIGN — § One discovery query.** A1 requires hidden-only changes to leave authorized pages and continuations stable. It also allows a provider to become unavailable when hidden rows consume its scan budget. If availability is decided per query, inserting private rows can change a visible match into an outage. Hierarchy §7.4 documents an existing route whose cursor advances over hidden rows. Decide provider eligibility per audience before searching. Test the same authorized match with enough hidden rows to cross the scan limit and require identical results, coverage status, and continuation behavior.

- **DESIGN — § Capture and link work.** A1 enforces one primary effort per origin and counts related efforts once, but leaves the identity of an unlinked hit unspecified across providers. The initial PR and versioned-spec providers can both return the same PR-backed document. Native hit IDs alone cannot tell discovery whether it found two artifacts or two representations of one artifact. Define the result unit and the source-owned identity used to coalesce representations. Test one document reached through two providers alongside two distinct documents in the same PR.

- **DESIGN — § One discovery query and § Acceptance evidence.** A1 scopes the PR corpus to open and “recent-merged” PRs, then requires the incident PR to remain findable with partial local history. Placing #3342 beyond the first hundred tests pagination. It leaves the age boundary untested. Once a merged PR ages out, a healthy provider can miss it and still satisfy its coverage contract. Define the retention window and test the incident after it expires. If recall must survive that boundary, retain a searchable public PR reference and enough authorized metadata to match the original question without a supplied PR number.

- **PRECISION — § Authority contracts.** A1 describes the machine-readable registry and census as installed. Registry §6 describes the JSON and CI sweep as P1 deliverables. The supplied documents establish the intended seam but leave current installation status unverified. Cite the implementing revision or state the dependency explicitly.

### Round 4

**Verdict: SERIOUS ISSUES**

1. **DESIGN — A private effort can change a member’s result count.** § One discovery query groups hits by work ID and requires hidden-only changes to leave counts and continuations stable. Hierarchy §7.4 permits a member to read individual conversations while reserving effort membership for the owner. If two member-visible hits become linked to one owner-only effort, grouping them before checking link visibility turns two results into one. Hiding the effort title still reveals the relationship. Group only on links visible to the destination. Test the member’s count, page contents and continuation before and after the owner links both hits. The owner should see one group and the member should still see two hits.

2. **DESIGN — The migration compare-and-set lacks a defined transaction boundary.** § Migration and reconciliation requires one atomic comparison of the fence, source head and target head when publishing the authority pointer. The registry (§§3, 5) identifies job data in both `jobs.json` and Markdown manifests. An atomic pointer update alone cannot compare independently writable files. Require each kind’s cutover proof to name the serialization mechanism that keeps both verified heads immutable through publication. Test a write that passes admission before fencing, pauses, and resumes after validation. It must either appear in the verified target or be rejected before it changes storage.

3. **DESIGN — The incident replay can pass while ordinary questions still miss prior work.** The introduction describes a permanent-address question. § Read-time integration guarantees lookup for an *explicit prior-work request*, while § Acceptance evidence rules out priming with a PR number but does not explicitly rule out priming the request as a historical lookup. Those are different tests. Run the preserved question verbatim through normal Chief of Staff routing with no prior-work hint or forced tool call. Record separately whether the agent invoked discovery and whether discovery retrieved #3342. This tests the original failure without introducing A2’s mandatory work-admission gate.

### Round 5

**Verdict: SERIOUS ISSUES**

- **DESIGN — Aged-out PR recovery (§ One discovery query, § Capture and link work).** A1 promises that a verified linked PR remains searchable by its public title and aliases after the live provider’s 30-day window closes. The graph contract keeps user-authored text out of immutable events (Hierarchy §7.6). A1 assigns ownership of the link, but leaves unclear which durable record restores the searchable words. Specify the retained source for those fields or require query-independent rehydration by verified repo/number. Test both conditions together: age out #3342, discard the discovery index and local transcript, rebuild, then run the original question without supplying the PR number.

- **DESIGN — Grouping across provider pages (§ One discovery query).** A1 defines a result unit as one authorized work group and permits separately paged providers when a global ranking is unavailable. If a later provider page yields a second artifact for a group already returned, the contract leaves its count, placement, and delivery unspecified. Define whether later evidence appends to the existing group or provider pages enumerate artifacts with explicitly provider-local counts. Test two distinct artifacts linked to one visible effort, with the second first appearing on a continuation.

- **DESIGN — Ordinary-question acceptance (§ Read-time integration, § Maturation plan, § Acceptance evidence).** The specified chat entry point is an *explicit prior-work request*. The incident replay deliberately asks an ordinary question and records whether the agent consulted discovery. “Positive live owner-channel proof” leaves the release decision ambiguous if explicit lookup succeeds but the original question still gets a new-work answer. Set separate pass criteria for direct retrieval and the ordinary reply. Require the latter to cite #3342 and distinguish approval, review, and deployment through the normal route. That tests the incident outcome while preserving agent discretion about when to search.

### Round 6

**Verdict: SERIOUS ISSUES**

- **DESIGN — One discovery query; Capture and link work.** The query contract preserves frozen results across ordinary edits. The capture contract serves a grouping only while both the source attestation and the graph link remain authorized. An owner can revoke the attestation between pages while every artifact remains readable and every audience grant stays unchanged. The spec leaves that continuation’s behavior unresolved. Bind snapshots to revocations of the relationships they actually expose. Test that revoking a visible attestation restarts the affected continuation and that revoking an owner-private link leaves the member’s continuation usable.

- **DESIGN — One discovery query; Acceptance evidence.** The spec requires an old linked PR to remain findable after the transcript and index are lost. It guarantees recovery of the PR number and hydration of its *current* title and description. Those fields can change while the number stays valid. If the only matching phrase disappears, lookup by number can succeed while the original question retrieves nothing. Add a cold-rebuild case that renames the PR and removes the phrase from its description. Specify which surviving authorized evidence supports recall, such as the linked versioned design or a source-owned alias. If none survives, qualify the recall guarantee.

- **DESIGN — Capture and link work.** The feeder must reconsider mutable exclusions after a policy change, but the checkpoint rules permit advancement only after application, an idempotent no-op, immutable exclusion, or tombstone. A routine policy exclusion can therefore hold the contiguous checkpoint indefinitely even while every eligible record is indexed. Define a durable exclusion keyed by source revision and policy epoch that counts as processed for that epoch. On policy widening, mark affected coverage partial until reconsideration finishes. Test an excluded event followed by a visible event, then widen the policy and verify both become findable.

- **PRECISION — Acceptance evidence.** The ordinary replay asks reviewers to record whether discovery retrieved the PR even when the agent never called it. Record invocation, retrieval, and answer citation separately. Mark retrieval *unobserved* for a skipped call and record the direct Work lookup as a separate trial. This distinguishes a missed invocation from a measured search miss.

## Convergence verdict

Converged at the Tier 2 cap with explicitly recorded residual proof and wording items. The security rule in the exact reviewed body already requires each page to reauthorize every returned link and serve a grouping only while both edges remain authorized. Its concrete revocation and hidden-link tests are required before provider graduation. The other final items constrain recall completeness and replay observability without enabling writes or action gates. Independent internal lenses on the exact body found no residual safety blocker.
