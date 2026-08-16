# Architecture Review — GitHub Collaboration Monitor

**Reviewer**: Technical Architecture
**Spec**: `specs/github-collaboration-monitor.md`
**Review ID**: 20260329-153418
**Round**: 1
**Date**: 2026-03-29

---

## Approval Status

**CONDITIONAL**

The architecture is well-conceived and demonstrates thoughtful design, but has two critical gaps that must be resolved before implementation: (1) the Stage 1 → Stage 2 handoff mechanism is underspecified, and (2) there is no rate-limit or cost ceiling on Opus sub-session invocations. Everything else is either solid or addressable with minor changes.

---

## Research Findings

### Two-Stage LLM Pipeline Patterns

Industry research on multi-stage LLM systems (2025-2026) confirms this architecture pattern is well-validated:

- **Atlassian RovoDev** deployed a code review assistant across 2,000+ repos, generating 54,000+ review comments over 12 months. Their key finding: "controlled pipeline approaches consistently outperform direct LLM prompting or monolithic LLM-based generation in accuracy, correctness, and completeness." The spec's two-stage design aligns with this validated approach.
- **Multi-stage inference research** (MIT/CSAIL, 2025) shows that tiered pipelines with routing logic — where cheap models handle classification and expensive models handle generation — are the dominant cost-efficient architecture in production. The key is clean stage boundaries with structured intermediate output.
- Academic work on automated code review confirms that "LLMs are prone to hallucination in code review comments" and recommends structured output formats with explicit reasoning fields — which this spec correctly implements via the JSON classification schema.

### Haiku→Opus Cascade Patterns

- The cascade pattern (attempt with Haiku first, escalate to Opus on qualified inputs) is a foundational cost optimization strategy. In production systems, this achieves 37%+ cost reduction with zero quality degradation for workloads where most inputs are routine.
- Current pricing (2026): Haiku at $1/$5 per million tokens vs. Opus at $5/$25 per million tokens — a 5x cost differential on input. This makes the cascade economically compelling: running Opus only on `needs-review` items is the correct choice.
- **Risk identified**: Most cascade implementations include a confidence threshold or explicit escalation condition. This spec uses classification output (`needs-review`/`auto-integrate`) as the gate, which is cleaner than confidence scores but creates a single point of failure if Haiku misclassifies.

### LLM-Orchestrated CI/CD Workflows

- GitHub Agentic Workflows (launched February 2026 in technical preview) enable similar patterns natively — worth monitoring as a potential future replacement for the custom job infrastructure.
- The dominant pattern in production: structured JSON output from the classifier stage, consumed by the executor stage. Unstructured text between stages is a reliability anti-pattern. This spec correctly uses JSON handoff.
- Key lesson from production deployments: "post-review comment sprawl" is a UX problem. One review per PR, updated in-place (as this spec specifies) is the right call — confirmed by community feedback on multi-comment bots.

---

## Critical Issues

### 1. Handoff Mechanism Underspecified

**Severity**: Must fix before implementation

The spec states Stage 1 "passes classified items to Stage 2 via handoff notes" and spawns Stage 2 via `POST /sessions`. However:

- The handoff note schema is not defined. What fields exactly? What's the maximum size? What happens if it exceeds size limits?
- The session prompt construction for Stage 2 is described in a template but the template has `[review comment template]` as a placeholder — the most critical part is left blank.
- The spec does not define what "sub-session spawn fails" means in terms of retry behavior vs. the skip ledger state. It says "items remain unprocessed" and "retry on next scan (max 2 retries)" but there's no definition of how retry count is tracked per item.

**Required**: Define the handoff note schema, complete the Stage 2 prompt template, and specify how retry counts are stored (presumably in the skip ledger item metadata or a separate key).

### 2. No Opus Cost Ceiling

**Severity**: Must fix before implementation

Stage 2 (Opus) is spawned whenever Stage 1 finds any `needs-review` or `auto-integrate` items. There is no limit on how many Opus reviews can be triggered per cycle or per day. In a scenario where a repo gets a burst of PRs (e.g., after a public launch, or a coordinated contribution campaign), this could trigger many Opus sub-sessions in a single run.

The `maxForksPerRun: 10` config shows awareness of rate-limiting, but there is no equivalent `maxOpusReviewsPerRun` config. Given Opus's cost and the potential for unbounded sub-session spawning, this is a real financial risk.

**Required**: Add `maxReviewsPerRun` to the job config (suggested default: 5). Items beyond the limit are queued for the next scan cycle. Notify Justin if the queue is building up.

---

## Recommendations

### R1: Specify Skip Ledger Retry Metadata

The spec says Stage 2 failures retry "max 2 retries" but doesn't specify where the retry count lives. The composite key scheme (`pr-{number}-{headRefOid}`) doesn't naturally carry retry state. Recommend either:
- Store retry count in the skip ledger item's metadata field (if the API supports it)
- Use a separate key `pr-{number}-{headRefOid}-retry-{n}` and consider `n >= 2` as "give up"
- Add a dedicated `.instar/logs/github-review-failures.jsonl` for failed items with retry context

### R2: Define the Draft PR Classification More Precisely

The edge case table says "Draft PR → classify as `ci-pending` (skip)." This is semantically wrong — a draft PR is not the same as one with pending CI. Using `ci-pending` for drafts conflates two distinct states:
- Draft: author intentionally not ready for review
- CI-pending: ready for review but CI hasn't finished

Recommend adding a `draft` category that behaves like `ci-pending` in terms of skip behavior but is tracked separately. This matters for metrics and for correctly communicating to Justin why something was skipped.

### R3: Add Structured Logging for Stage 1 Output

The spec logs Stage 2 decisions to `github-review-decisions.jsonl` but does not specify logging for Stage 1 classification output. If Stage 2 is never triggered because Stage 1 misclassifies everything as `informational`, there's no record of what Stage 1 decided or why. The audit trail is incomplete.

Recommend logging Stage 1's full classification array to a separate file (`github-scan-log.jsonl`) on every run, even when Stage 2 is not triggered.

### R4: Define "Significant Divergence" for Forks

The weekly fork analysis triggers on forks ">50 commits ahead." This threshold is hardcoded in the spec text but not in the job config. It should be a config parameter (`minForkCommitsForAnalysis`). Also, "50 commits ahead" may be the wrong heuristic — a fork with 50 small formatting commits is less interesting than one with 5 significant architectural commits. Consider also checking `aheadBy` vs. diff size rather than just commit count.

### R5: Disambiguation of "PR Review" vs. "Issue Comment" for Review Replies

The "Handling Replies" section says replies appear as "new issue comment events" and Stage 1 classifies them as `needs-review`. However, replies to a PR review are PR review thread comments, not issue comments — they appear via a different GitHub API endpoint. Confirm that the events polling captures PR review thread replies, not just `issue_comment` events.

---

## Observations

**The Haiku→Opus cascade is the right call.** At a 5x cost differential, running Haiku for every scan and Opus only on items that need attention is both economically sound and architecturally clean. The spec implements this well.

**The composite skip ledger key design is elegant.** Using `pr-{number}-{headRefOid}` means the system automatically re-evaluates a PR when new commits arrive, without needing a separate "dirty flag" mechanism. This is a clean, stateless approach.

**Security path hardcoding is a strength and a weakness.** The explicit security paths list in config is good — it makes the security boundary visible and auditable. The weakness is that it's a static list that will drift as the codebase evolves. There's no mechanism to warn when a new file is added to `src/server/` that isn't on the security paths list. Worth noting as a future enhancement, not a blocker.

**The "one review per PR, updated in-place" policy is correct.** Research confirms that bots that post multiple comments per PR create review clutter that reduces trust and adoption. The dismiss-and-repost approach is the right tradeoff between freshness and noise.

**The trust model graduation criteria are reasonable but brittle.** "2+ merged PRs with no reverts within 14 days" is a clear rule, but it doesn't account for cherry-picking behavior, PRs that are technically merged but later require hotfixes, or contributors who have a long track record on other repos. This is acceptable for an MVP trust model — just flag it as an area that will need refinement.

**The 12-hour schedule is appropriate for the stated SLA.** The success metric targets <12 hours from PR open to first review comment. A 12-hour cron cycle with the first scan at 8am and second at 8pm means worst-case latency is 12 hours (a PR opened at 8:01pm waits until 8am). This is acceptable for a non-blocking advisory system.

**The `autoMergeEnabled` default-off with shadow period requirement is exactly right.** This is the correct approach for introducing automation into a trust-sensitive workflow. The 5-consecutive-correct-recommendations gate is a reasonable proxy for system reliability.

---

## Scalability Assessment

**Current Phase (MVP)**: The architecture handles the stated scope well. Single repo, twice-daily cadence, expected PR volume of single digits per week. The complexity is appropriate for the scale.

**Growth Phase 1 (Multi-repo)**: If this pattern is generalized beyond JKHeadley/instar to other repos, the job config will need a `repos[]` array and the skip ledger keys will need repo namespacing (`{repo}:pr-{number}-{hash}`). The relationships/trust model will also need contributor identity to be repo-scoped or global. This is a non-trivial change but not a rewrite — the architecture supports it.

**Growth Phase 2 (Higher PR volume)**: The Opus cost ceiling issue (Critical Issue #2) becomes a hard blocker at higher volumes. The 10-fork-per-run cap shows the spec already anticipates this pattern — it just wasn't applied to Opus reviews. Once added, the architecture can scale to higher volumes by adjusting config values.

**Growth Phase 3 (General instar capability)**: The spec explicitly states this is "Echo-only" and not a general capability. That's the right call for Phase 1. If it's later generalized, the hardcoded repo references (`JKHeadley/instar`, `EchoOfDawn`) and Echo-specific trust context would need to be parameterized. The architecture is parameterizable — it's a matter of lifting hardcoded values to config, not a structural change.

**Bottleneck**: The `gh` CLI as the data access layer is the main scalability constraint. For higher frequency scans or multi-repo deployments, direct GitHub API calls with persistent HTTP connections would be more efficient. For current scope, `gh` CLI is fine.

---

## Score

**7/10**

The architecture is pragmatic, well-scoped, and demonstrates real systems thinking. The Haiku/Opus cascade, composite skip ledger keys, security path hardcoding, and shadow period for auto-merge are all examples of deliberate, experienced design decisions. The score is held back by the underspecified handoff mechanism (a critical operational gap) and the missing Opus cost ceiling (a financial risk that becomes real the moment the repo gets any burst of activity). Fix those two issues and this is an 8.5/10 architecture — solid, maintainable, and appropriately sized for the problem it solves.

---

*Architecture review by Echo (Technical Architecture Reviewer). Review ID: 20260329-153418.*
