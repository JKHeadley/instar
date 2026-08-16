# Scalability Review — GitHub Collaboration Monitor
**Review ID**: 20260329-153418
**Round**: 1
**Reviewer**: Scalability & Infrastructure
**Date**: 2026-03-29

---

## Approval Status: CONDITIONAL

The spec is well-designed for its stated scope (a single-repo, single-agent monitor) and is appropriately conservative. It will work well at MVP scale. However, several specific scaling constraints are unaddressed that will cause silent failures or cost surprises if the repo grows or the system is ever generalized.

---

## Score: 7/10

**Justification**: Strong MVP design with clear rate-limit awareness and sensible caps (maxForksPerRun: 10, maxDiffLines: 1000). Loses points for: the GitHub Events API being fundamentally unsuitable for fork activity detection at scale; no pagination strategy for any GitHub API call; no cost model for Opus invocations; and the skip ledger having unbounded growth with no archival strategy.

---

## Critical Issues

### 1. GitHub Events API: 300-Event Hard Cap Will Miss Activity (Hits at ~50+ active contributors)

**Severity: HIGH**

The spec uses `gh api repos/JKHeadley/instar/events?per_page=100` to filter forks by `PushEvent`. The GitHub Events API has a documented hard ceiling of **300 events total** with a **30-day retention window** (changed from 90 days in January 2025). The `per_page` parameter is also documented as unreliable for this endpoint.

At low activity levels (a few PRs/week), 300 events covers weeks of history. But as the repo grows — more contributors, CI runs generating events, issue comments, reviews — the 300-event pool fills with noise (PullRequestReviewEvent, IssueCommentEvent, WatchEvent, etc.), and PushEvents from forks get squeezed out or lost entirely.

**When it breaks**: At approximately 50+ active contributors with CI bots generating events, PushEvents from less-active forks will be absent from the 300-event window within a single 12-hour scan cycle. The system will silently classify active forks as inactive and skip them.

**Fix**: Use the dedicated `GET /repos/{owner}/{repo}/forks` endpoint with `sort=newest` or `sort=pushed`, then query each fork's own push activity via `GET /repos/{fork_owner}/{fork_repo}/commits?since={last_scan_time}`. This is more API calls but is accurate and pageable.

---

### 2. No Pagination on Any GitHub API Call (Hits at ~100 items per category)

**Severity: HIGH**

Every `gh api` call in the spec uses a fixed `per_page` value (50 or 100) with no pagination loop. GitHub's REST API returns a maximum of 100 results per page, and will silently truncate beyond that. The spec has no `Link: <next>` header handling.

Affected calls:
- `repos/JKHeadley/instar/issues/comments?since=...&per_page=50` — will miss comments if >50 since last scan
- `repos/JKHeadley/instar/forks?per_page=100` — will miss forks beyond 100
- `gh issue list`, `gh pr list` — uses gh CLI defaults (typically 30)

**When it breaks**: If the repo has 101+ forks, the oldest forks are never seen. If there's a burst of 51+ comments in a 12-hour window (e.g., a viral issue thread), comments are silently dropped.

**Fix**: Implement a pagination loop that follows `Link` headers until exhausted, or use the GraphQL API which allows fetching larger result sets with cursor-based pagination. Add a logged warning when a single page is full (indicating possible truncation).

---

### 3. Opus Cost Model Absent — No Budget Guard Rails (Cost cliff risk)

**Severity: MEDIUM-HIGH**

The spec invokes Claude Opus (currently claude-opus-4.6 at $5/$25 per million tokens) for every `needs-review` item without any per-run or per-month cost ceiling. A busy week for the instar repo could generate multiple PRs with large diffs simultaneously.

**Cost scenario at growth scale (50-500 contributors)**:
- 10 PRs/week each needing Opus review
- Each review: ~8K tokens input (diff + context) + ~2K output = ~10K tokens
- 10 reviews/week × 10K tokens × $25/M output = ~$2.50/week output costs
- At 500 contributors with 50 PRs/week: $25/week — acceptable but unmonitored

**The real risk**: A single PR with a 1000-line diff plus full file context fetches can easily reach 50K-100K tokens input. If 5 such PRs arrive simultaneously, one scan cycle costs $12+ in Opus calls. With no budget guard, this is invisible until the invoice arrives.

**Fix**: Add a `maxOpusTokensPerRun` config parameter. Estimate token count before spawning Stage 2. If the batch exceeds budget, process highest-priority items first and defer the rest to the next cycle with a notification.

---

## Recommendations

### R1: Add Pagination to All GitHub API Calls

Implement a utility function that handles `Link` header pagination transparently. This is a foundational fix that prevents silent data loss as the repo grows. The `gh api --paginate` flag handles this automatically for the gh CLI.

### R2: Replace Events API Fork Filter with Direct Fork Activity Check

Query fork activity via `GET /repos/{fork}/commits?since={last_scan_time}&per_page=1` — a cheap HEAD-equivalent that returns quickly and is reliably pageable. This uses 1 API request per active fork vs. the unreliable events pool.

### R3: Add Skip Ledger Archival Strategy

The skip ledger stores every processed item by composite key forever. At 2 scans/day × 365 days × ~20 items/scan = ~14,600 entries/year. This is manageable in year 1 but will grow indefinitely. Add a TTL: PR/issue keys older than 90 days where the PR is closed can be archived to a separate `.instar/logs/skip-ledger-archive.jsonl` and removed from the active ledger.

### R4: Implement Exponential Backoff on Rate Limit Deferral

The current spec defers the entire scan if API quota is <100 remaining. This is correct but blunt. Better: defer Stage 2 (Opus invocations) while completing Stage 1 classification, since Stage 1 uses far fewer API calls. This preserves classification accuracy even when quota is low.

### R5: Consider GitHub GraphQL for Stage 1

The current Stage 1 makes 6+ separate REST API calls. A single GraphQL query can fetch PRs with their CI status, recent comments, and author details in one round trip. This reduces rate-limit consumption by ~60% and eliminates the timing gap between sequential REST calls (where state can change between requests).

### R6: Add Per-Run API Budget Tracking to Audit Log

Log the number of GitHub API calls consumed per scan run to the audit JSONL. After 30 days, you'll have an empirical baseline for quota consumption that informs whether the 12-hour schedule is sustainable as activity grows.

---

## Observations (Fine at MVP, Watch Later)

**O1: Handoff Notes as Stage 1→2 IPC** — Using handoff notes to pass classified items from Stage 1 to Stage 2 is simple and works well at MVP scale (tens of items). If the repo grows to hundreds of PRs, the handoff note payload could become large. Not a current concern given the `maxForksPerRun: 10` and other caps.

**O2: `.instar/logs/github-review-decisions.jsonl` Growth** — This file grows without bound. At 2 reviews/day × 365 days = ~730 entries/year with full diff context stored. If diff content is included in each log entry, this could reach hundreds of MB over 2-3 years. Recommend storing only the signals/metadata, not the full diff, in the audit log. The diff is retrievable from GitHub if needed.

**O3: Trust Model is Single-Machine State** — The relationships API data lives on Echo's machine. If Echo is ever migrated or the state is lost, trust history for all contributors is gone. The spec doesn't mention backup/restore for this trust data specifically. Since it's in the relationships API, it should be covered by instar's backup system, but worth verifying explicitly.

**O4: 12-Hour Cadence Creates 12-Hour Worst-Case Latency** — The spec targets "<12 hours from PR open to first review comment." This is exactly the cadence — meaning in the worst case (PR opened one minute after a scan), the SLA is barely met. As contributor volume grows, this may become a pressure point. The spec doesn't address on-demand triggering (e.g., a webhook or Telegram command to trigger an immediate scan). Worth adding as an operational control.

**O5: Stage 2 Sub-Session Memory Isolation** — Opus sub-sessions spawned by Stage 1 don't have access to Echo's full MEMORY.md context about contributors. If a contributor has notable history in memory (e.g., "rolandcanyon-cmd tends to omit error handling"), that context won't inform the review unless explicitly passed in the prompt. Consider passing relevant memory excerpts as part of the Stage 2 prompt.

---

## Scalability Assessment: Phase-by-Phase

| Phase | Users/Agents | Data Volume | Key Bottleneck | Status |
|-------|-------------|-------------|----------------|--------|
| MVP | 1-10 contributors, 1 repo | <500 skip ledger entries | None — well within all limits | OK |
| Growth | 10-100 contributors | ~5K ledger entries, ~50 forks | Events API 300-event cap begins silently dropping fork PushEvents; pagination gaps appear | RISK |
| Scale | 100-500 contributors | ~50K entries, 100+ forks | Forks endpoint truncated at 100; Stage 2 costs uncontrolled; skip ledger needs archival | BLOCK without fixes |
| Viral | 500+ in days | Rapid | GitHub rate limits hit within hours of spike; no queue/backpressure; 12-hour cadence creates 12-hour review backlog | NEEDS PLAN |

### Viral Spike Analysis

If instar goes viral and 500 contributors fork it in a week:
- `gh api repos/JKHeadley/instar/forks?per_page=100` returns page 1 only — 400 forks are invisible
- The events API is completely overwhelmed with noise; fork PushEvents are unreachable
- Stage 1 Haiku classification of 500 items at once likely hits the secondary rate limit (900 points/minute)
- Stage 2 Opus invocations for 50+ `needs-review` items would exhaust API quota and budget in a single run
- The system has no queue/backpressure — it would either time out or produce incomplete results

The `maxForksPerRun: 10` cap is a reasonable emergency brake, but there's no prioritization logic for which 10 forks to pick when 500 exist. Currently the cap just takes the first 10 from the unordered events pool.

---

## Research Findings

**GitHub API Rate Limits (2026)**:
- Authenticated REST API: 5,000 requests/hour standard; 15,000 for Enterprise Cloud
- Secondary rate limit: 900 points/minute for REST endpoints
- Events API hard cap: 300 events per request, 30-day retention window (reduced from 90 days in January 2025)
- Events API `per_page` parameter: documented as unreliable/unsupported for this endpoint
- ETag conditional requests available for events polling (returns 304 if no new events, doesn't consume rate limit quota)
- Pagination: `Link` header with `rel="next"` is the standard pattern; `gh api --paginate` handles this automatically

**LLM Code Review at Scale**:
- Inference time (not API limits) is often the bottleneck for solo developer tooling
- Context optimization (providing only changed methods + surrounding context rather than full files) reduces token consumption by 60-80% without reducing review quality
- Multi-model synthesis (having multiple reviewers and synthesizing) improves F1 scores by up to 43.67% vs single-model review
- Fast parallel CI integration is preferred over serial review workflows
- Reviews completing in parallel with CI checks (rather than sequentially after CI) significantly improves developer experience

**Opus 4.6 Cost Model (2026)**:
- Input: $5/million tokens, Output: $25/million tokens
- Batch API: 50% discount for async workloads — highly relevant for this use case since reviews don't need real-time response
- Prompt caching: 10% of input price after first read — worth implementing for stable system prompt components (instar codebase conventions, security path list)
- 1M token context window now standard (no surcharge)
- The Batch API would reduce Stage 2 costs by 50% with no architectural changes

**Actionable insight from research**: The Batch API is a near-zero-effort cost optimization. Since Stage 2 reviews don't need to complete in real-time (the target is <12 hours, not <1 minute), submitting all Opus review requests as a batch job would cut Stage 2 costs in half. This should be in the spec.

---

## Summary

The spec is production-ready for the stated scope (Echo + one repo + ~10 contributors) and shows careful thinking about rate limits, skip ledger design, and security gating. The critical gaps are: the Events API being fundamentally wrong for fork activity detection at scale (silent failure mode), missing pagination on all API calls (data loss cliff), and no cost model for Opus invocations. These are mechanical fixes, not architectural rethinks. The overall architecture is sound and the two-stage design is well-reasoned.

Sources consulted:
- [GitHub REST API Rate Limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub REST API Best Practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [GitHub Events API 30-day retention change](https://github.blog/changelog/2024-11-08-upcoming-changes-to-data-retention-for-events-api-atom-feed-timeline-and-dashboard-feed-features/)
- [GitHub Events API Endpoints](https://docs.github.com/en/rest/activity/events?apiVersion=2026-03-10)
- [Claude Opus 4.6 Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [LLM Code Review Scaling - Ericsson Experience Report](https://arxiv.org/html/2507.19115v2)
- [Code Review Agent Benchmark 2026](https://arxiv.org/html/2603.23448)
