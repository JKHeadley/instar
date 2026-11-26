# Convergence Report — Find prior pull requests before answering or assigning work

## Cross-model review: codex-cli:gpt-6.2-astra

The Codex CLI returned a GPT 6.2 Astra review on every reviewed revision. Gemini lacked authentication and the clean Anthropic door was unavailable through the installed wrapper. One independent internal reviewer covered the six internal perspectives across the review. The internal review used one model and reviewer allocation across those perspectives. The final internal pass cleared its material design findings. The final Astra pass retained two design findings and one precision finding. This is a capped convergence, with the remaining risks described below.

## ELI10 Overview

The Chief of Staff had a way to search conversation history and a separate check for code files. When asked if Instar already had permanent agent links, neither path surfaced the open pull request. This adds a lookup that can search open pull requests and recent merged work using a term such as instar.sh. It can find a match by title, branch or a relevant part of the description. The answer tells the agent whether it finished searching each source.

The lookup is available from Chief of Staff when it answers or considers a new assignment. This release adds the evidence and the instructions to read it. The broader work-discovery spec will design automatic checking across kinds of work.

## Original vs Converged

The first version refreshed open and merged evidence together and showed only one short list. The reviewed design can return the open evidence if merged history is slow, distinguishes login problems from throttling, and lets the agent read later pages without silently skipping matches when the observations change. Matching descriptions can return a labeled excerpt. The plain-language instructions explain when to verify the full source.

## Iteration Summary

| Round | Reviewable body SHA-256 | Standards findings | Main change |
| --- | --- | --- | --- |
| 1 | `4b8c04c0daa3ff92e3e6a32ff72f644a9e41f12883cc47ed4e174b355b956a1b` | 7 | Separate coverage by state, disclose unchanged-token revocation lag, rank useful matches, and name both live replay outcomes. |
| 2 | `66c5e3d823b4c8f306ef97cb3dbb2677d336759ab4778940ea6036b550a9672a` | 5 | Fence publication after denial, retain verified partial matches, return a supporting excerpt, and allow result continuation. |
| 3 | `ff62a9b5dbdb28d3dc24283eb4744b1050f0317dffdac77fa61e5399fe2ea2c1` | 6 | Preserve prior complete evidence during degradation, give merged evidence terminal precedence, document direct GitHub links for older known numbers, and cap decoded page bytes. |
| 4 | `f5330750b20fc24209bea2a263c64f019548438356603a42caf40b3dcd0f4076` | 5 | Define provider error classes, reconcile rows before matching, bind continuation to evidence expiry, and specify the incident replay. |
| 5 | `7ee3acd43dfdd30eb93f17437f7ea6d5cd0f185527066379b250f392b90ff0bb` | 8 | Require affirmative throttling evidence, preserve eligible merged state across a contradictory open sighting, and sample current open state for the live probe. |
| 6 | `24aab0e7713f526afaf5138262d42da1758a5daa8ed6cb7a236e917acdebb1a4` | 9 | Stopped at cap. See the explicit remaining dispositions below. |

The Standards-Conformance Gate ran on every round against 102 standards, with no degraded result. Each returned advisory findings. The applicable auth, resource, visibility, multi-machine, truncation, and fixture findings were folded into the design or turned into release proof.
- Round 1 Standards-Conformance Gate: ran (7 flags).
- Round 2 Standards-Conformance Gate: ran (5 flags).
- Round 3 Standards-Conformance Gate: ran (6 flags).
- Round 4 Standards-Conformance Gate: ran (5 flags).
- Round 5 Standards-Conformance Gate: ran (8 flags).
- Round 6 Standards-Conformance Gate: ran (9 flags).

## Proportion

Tier 2 with six of six review rounds. A narrow read surface reached the cap because reviewers kept finding independent behavior at the auth, pagination, and evidence boundaries. The broader project remains separate.

## Experience fit

The motivating sequence is the owner asking about permanent Instar addresses, the agent declaring the design absent, and the agent considering a fresh assignment. The answer should cite the existing open PR and explain the URL behavior it covers. The delegation should continue or extend related work after reading that source. Incomplete provider coverage should lead to scoped uncertainty. Endpoint, provider and shipped awareness tests establish access to the evidence. The maturation check calls for a normal-turn replay before claiming the person-facing outcome.

## Left behind

- The final external review asks for an explicit spec statement that the merged cutoff is anchored once per snapshot and applied to stale supplementation. The design already binds continuations to the observed snapshot and deteriorating coverage. Implementation must prove clock crossing through a continuation test. The residual wording ambiguity does not authorize false absence or change a source record.
- The final external review asks the graduation probe to require complete open coverage, with merged coverage recorded separately. Treat both as release evidence, alongside the known-item measurement. The residual maturity wording carries no runtime authority, and an incomplete scan remains labeled partial.
- The final external review asks for clarification when a long body-only query exceeds the excerpt length. The excerpt provides overlap and the response labels truncation. The caller checks the full canonical record before deciding relevance.
- Standards flags for automatic initiation checks, semantic discovery across sources, and arbitrary repository coverage are outside this narrow advisory scope and are requirements for Spec A. The route reports literal coverage and is limited to the public Instar repository.
- The resource ceilings and merged lookback bound producer cost for this slice. Measured cold scan results and degraded coverage are the basis for the initial values. Maturation records measured coverage and cost before any wider use.
- A bounded release replay can show the owner experience on the tested paths. It cannot establish that the advisory lookup runs every turn. Spec A covers continuous evidence for avoidance and structural coverage.

## Full Findings Catalog

The external reviewer used its own DESIGN and PRECISION classes. The table above records the corresponding remediation for each earlier revision. The final two DESIGN findings are handled at the cap as described above.

### Round 1 external review

**Verdict: SERIOUS ISSUES**

- **DESIGN — Inventory and coverage, Decision points touched.** The spec promises immediate invalidation on authorization loss, but a cache hit can return data for two minutes without contacting GitHub. Revocation with an unchanged token is unobservable during that interval. Define the guarantee as eviction on *observed* authorization loss, disclose the cache-hit interval, and forbid stale fallback after an authorization denial. If immediate revocation is required, revalidate access before serving a hit. Test revocation after a successful refresh with the token unchanged.

- **DESIGN — Inventory and coverage, Open questions for review.** The spec calls for atomic snapshot replacement and treats an interrupted traversal as a failed refresh. It also proposes returning completed open results when merged history exceeds the response budget. On a cold start those rules yield different answers to the motivating question. Choose the failure behavior explicitly. I recommend publishing each completed state stream with its own observation time and status. Test a cold request where open contains #3342 and merged times out. The response should carry the PR URL and identify merged coverage as unavailable.

- **DESIGN — Behavior, Inventory and coverage.** The agent can judge only the candidates it receives. The endpoint caps returned rows and supplies an overflow count, but the spec defines neither ordering nor a way to retrieve omitted matches. A broad body match could occupy the last slot ahead of an exact title match. Define deterministic ordering and a continuation mechanism, or specify how the caller narrows an overflowing query. Test a relevant PR below the initial result cap with unrelated literal matches above it.

- **PRECISION — Standards and evidence.** The spec correctly distinguishes endpoint and template tests from evidence that an agent actually uses the lookup. It leaves the separate conversational replay’s acceptance condition implicit. For #3342, specify the observable outcome in each entry point: the answer cites the existing PR, and the assignment scenario recognizes the existing work before proposing a duplicate design.

### Round 2 external review

**Verdict: SERIOUS ISSUES**

- **DESIGN — Inventory and coverage.** The spec requires an observed authorization denial to invalidate both snapshots. Each state stream can also publish independently. If one stream gets a denial while its sibling is still fetching, the spec leaves open whether that sibling can repopulate the cache under the same token. Give each refresh a generation identifier. A denial should invalidate the generation, discard its pending publications, and take precedence when assembling the response. Test both completion orders and recovery after a subsequent authorized refresh.

- **DESIGN — Behavior / Inventory and coverage.** The answer and assignment paths both depend on open-PR discovery, yet a cold open scan that reaches any safety bound discards all open coverage, including an exact match already encountered. The proposed measurement covers the current repository size. It leaves a predictable failure as the repository grows past a fixed bound. Permit validated rows from a bounded scan to serve as positive evidence, mark the state partial, and report the total as unknown. Keep authorization denial as a hard invalidation. Test a cold scan that encounters #3342 before exhausting its page budget.

- **DESIGN — Behavior / Standards and evidence.** The agent must “read a matching GitHub record” and may dismiss a similarly named PR. The route searches bodies but returns only metadata and a link. For a body-only match with an ambiguous title, the replay can pass by citing the expected URL without demonstrating that the agent could establish relevance. Specify how a CLI-free caller reads the supporting text, for example through a bounded excerpt returned with the candidate. Test two similarly titled PRs whose bodies distinguish their purposes, and verify the assignment follows the relevant one.

- **PRECISION — Inventory and coverage.** “Whole-input snippets and distinctive literals” leaves the meaning of `q` unclear. Specify whether the caller submits one literal per request or the server extracts several from prose. Give one request and its expected matches so callers can reproduce a zero result.

### Round 3 external review

**Verdict: SERIOUS ISSUES**

- **DESIGN — Inventory and coverage, cross-state deduplication.** The spec says to keep the more recently updated row when both streams observe a PR. An open observation and a later merged observation can carry the same `updatedAt`. If the open row wins, the response describes merged work as still open. For a validated open/merged pair, retain the merged row because a merged PR cannot reopen. Test equal timestamps with both stream completion orders.

- **DESIGN — Inventory and coverage, refresh after an error.** The spec permits an interrupted scan to return validated earlier rows and says upstream errors retain the last successful snapshot. It leaves the caller’s result undefined when both exist. A refresh that fails on page two could hide a known match from page five of the previous scan. Define precedence. One simple rule is to serve the prior complete snapshot as stale until its ten-minute expiry, then use current partial evidence if available. Preserve the explicit denial override. Test a late-page match across failure and expiry.

- **DESIGN — Inventory and coverage, exact-number lookup.** The incident motivates searching by domain or description. The proposed route also supports exact PR numbers, yet a cold `#3342` lookup can trigger both inventory scans and miss an older merged PR. The spec’s own probe reports 22 merged-history pages. Resolve numeric queries through a single repository-scoped GraphQL `pullRequest(number:)` lookup. Keep the open/merged state filter and report coverage for that number. If the 30-day limit is intentional even for known numbers, state that decision and its rationale.

- **PRECISION — Behavior, numeric example.** The literal `#3342` works as a query parameter value, but a raw `?q=#3342` URL sends an empty `q` because the fragment stays in the client. Show `?q=%233342` in the awareness entry so the agent can copy a working request.

### Round 4 external review

**Verdict: SERIOUS ISSUES**

- **DESIGN — Inventory and coverage, denial handling.** The spec distinguishes authorization denial, which evicts both snapshots, from an upstream failure, which can preserve stale evidence. It does not define how the GraphQL transport makes that distinction. A rate-limit response and a credential rejection require different behavior, and a GraphQL response can contain both data and errors. Define the mapping and test it at the HTTP boundary. In particular, verify that an access denial alongside usable rows suppresses those rows and invalidates both snapshots, while throttling follows the cooldown and retention rules.

- **DESIGN — Inventory and coverage, partial-scan reconciliation.** The spec says partial scans supplement current hits with prior complete hits. Suppose an earlier body contained `instar.sh`, a partial refresh reads the edited body without that literal, and a later page times out. Combining *hits* can resurrect a match the refresh directly disproved. Reconcile validated rows by PR number **before** matching and ranking. Use prior evidence only for PRs the refresh did not observe. Test both the edited-body case and an open-to-merged transition in which the merged row no longer matches.

- **DESIGN — Inventory and coverage, retention expiry during pagination.** Continuations invalidate on a changed snapshot, scope or query. Prior evidence also expires after ten minutes. If it expires between pages, the ordered result set can shrink without a new upstream snapshot. Applying the old offset can then skip a still-valid match. Make expiry of contributing evidence invalidate the revision and return 409. Test with a prior-only hit on page one expiring before page two.

- **PRECISION — Behavior and Standards and evidence.** The release replay says the agent should conclude that #3342 “already covers the work.” The inlined evidence establishes topic overlap but does not include the PR or the replayed request in enough detail to establish coverage. Include the requested behavior and the corresponding PR evidence in the replay fixture so reviewers can score the conclusion independently of whether the agent returned the expected URL.

### Round 5 external review

**Verdict: SERIOUS ISSUES**

- **DESIGN — Inventory and coverage, HTTP 403 classification.** The spec says a 403 “with rate-limit headers” counts as throttling, while an observed denial must evict both snapshots. It never identifies which header values establish throttling. A 403 with a positive remaining quota and an ordinary reset timestamp could therefore preserve cached evidence after a permission denial. Require affirmative throttle evidence, such as zero remaining quota or a valid `Retry-After`. Test a warm cache against both a permission 403 carrying routine quota headers and a throttled 403.

- **DESIGN — Inventory and coverage, reconciliation across refreshes.** The spec gives a *current* merged row precedence over a *current* open row, but gives current observations priority over prior complete rows. Consider a warm cache where a completed merged scan observed PR #3342 as merged. The next open traversal reports it open and the merged refresh times out. Applying the current-over-prior rule can report #3342 as open, despite the spec’s own invariant that a merged PR cannot reopen. Treat that pair as contradictory while the prior evidence remains eligible. Test the response state, provenance and coverage for this sequence.

- **DESIGN — Maturation plan, graduation criterion.** Graduation requires a live cold probe to return “the known open PR,” while the incident target is #3342 and the spec explicitly acknowledges that GitHub state changes. If #3342 merges and ages beyond the 30-day window, a correct implementation could fail graduation. Keep #3342 fixed in the incident replay. For the live probe, record a PR observed open immediately before the run, query its exact number, and recheck its state on a miss so a transition can be distinguished from a retrieval failure.

These findings come from the inlined specification. The reported probe timings are the author’s measurements. The failure sequences above are review cases, not observed runtime failures.

### Round 6 external review

**Verdict: SERIOUS ISSUES**

- **DESIGN — Inventory and coverage, merged-window continuation.** The spec requires both a 30-day window and stable pagination. It says each response discloses the cutoff, but leaves open whether a request reuses the snapshot’s cutoff or computes a new one. If page one includes a PR just inside the window, it can age out before page two and shift the offset even though the snapshot revision still matches. Anchor the cutoff to the merged scan, use it for filtering and stale supplementation, and bind it to the revision. Test two pages with a clock advance across the boundary.

- **DESIGN — Maturation plan, cold-probe graduation criterion.** The probe checks that a known open PR is returned within budget. The inventory rules expressly allow a partial scan to return that row. A server that retrieves only the first open page could therefore pass the live probe whenever the chosen PR is on that page. The fixture tests deeper pagination, but only with injected data. Require the live probe to show both the verified PR and complete open coverage within budget. Record merged coverage separately so the evidence shows what each stream achieved.

- **PRECISION — Inventory and coverage, excerpt contract.** The route accepts a 256-character literal but caps a body-match excerpt at 240 characters. A valid body-only match can therefore exceed the entire excerpt. Define the excerpt as text overlapping the match, specify how the truncation flag behaves, and test a 256-character body-only query.

The November 23 timings are measurements reported by the spec. I did not independently reproduce them.

### Independent internal review themes

- Security and adversarial. Require explicit owner-bearer admission before any GitHub work, withhold invalidated generations, verify terminal merged state and preserve scope for untrusted excerpts.
- Scaling. Bound per-page decoded payload and aggregate elapsed time, expose state-specific coverage, and keep complete positive evidence labeled when a refresh is partial.
- Integration. Run auth cases through production routing, consume a response captured from the real public GraphQL API, and verify a replacement machine uses canonical GitHub reads.
- Decision completeness. The final decision labels, maturation plan, and empty Open questions section pass the deterministic checks. Exact access, query and transport outcomes are invariants. The agent judges candidate relevance.
- Lessons-aware. Conversation search and pre-build file overlap cannot substitute for discovering earlier work during ordinary answers and delegation. The replay tests those cases and distinguishes a PR from deployment.

## Convergence verdict

The six-round Tier 2 cap was reached. There are no open design decisions for the operator. The final internal review raised no blocking issue. The two final external DESIGN findings are bounded, non-safety issues, with explicit implementation and release evidence above. The spec is eligible for approval at the cap. This report records the review outcome, while test and rollout records establish what has been verified in use.
