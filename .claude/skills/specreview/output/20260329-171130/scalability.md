# Scalability Review: GitHub Collaboration Monitor (Sentinel)

**Review ID**: 20260329-171130
**Reviewer**: Scalability & Infrastructure
**Round**: 2
**Date**: 2026-03-29

---

### Approval Status: CONDITIONAL APPROVAL

### Score: 8.5/10

**Justification**: Revision 2 closes all five Round 1 scalability issues. The Events API cap is eliminated, cost ceiling is bounded with token estimation, data retention policies are explicit, all GitHub API calls are paginated, and the fork cap protects against runaway growth. The remaining concerns are low-severity edge cases at higher scale that don't block deployment.

---

### Round 2 Fix Verification

**Fix 1: Events API 300-event cap (P1 from Round 1)**
- Round 1 finding: Fork activity detection used the GitHub Events API, which is capped at 300 events per repo and silently drops older events at moderate scale.
- Revision 2 resolution: Fork detection now uses `pushed_at` from `GET /repos/{owner}/{repo}/forks` — a field on the fork object itself, not the Events API. Only forks with `pushed_at` within 48 hours are analyzed. The 300-event cap is completely bypassed.
- Verification: The spec reads "no Events API dependency — avoids the 300-event cap" explicitly. RESOLVED.

**Fix 2: Cost ceiling (P0 from Round 1)**
- Round 1 finding: No per-run limit on Opus sub-session spawning; burst PRs could trigger unbounded cost.
- Revision 2 resolution: `maxReviewsPerRun: 5` (configurable). Token pre-estimation at ~4 tokens/diff line. If total exceeds `maxTokenEstimate: 200000`, Stage 2 is NOT spawned — items are queued with a notification. Stage 1 processes highest-priority items first; remaining items carry over.
- Verification: Both controls are present in spec (Section "Cost ceiling (P0)") and in `config` block. RESOLVED.

**Fix 3: Data retention (P1 from Round 1)**
- Round 1 finding: Skip ledger and audit log accumulated indefinitely, creating GDPR concerns and unbounded storage growth.
- Revision 2 resolution: `contributorRetentionDays: 180` (configurable). Closed/merged PR skip ledger entries archived after 30 days. Audit log retained 90 days, then compressed. Right-to-erasure path documented in CONTRIBUTING.md.
- Verification: Data Retention section fully specified. RESOLVED.

**Fix 4: Pagination on GitHub API calls (P2 from Round 1)**
- Round 1 finding: Multiple API calls lacked pagination, causing silent truncation at >30 items.
- Revision 2 resolution: All API calls include `per_page=100` and follow `Link` header pagination. Forks endpoint explicitly capped at 100 per request with pagination support documented. Fork volume capped at `maxForksPerRun: 10` per run.
- Verification: Spec states "All GitHub API calls use pagination (per_page=100, follow Link headers)". RESOLVED.

**Fix 5: GitHub API rate limits (P1 from Round 1)**
- Round 1 finding: No pre-flight rate limit check; the monitor could exhaust quota needed by other operations.
- Revision 2 resolution: Pre-flight check: `gh api rate_limit` before each scan. If <100 requests remaining, defer to next cycle. Also checks `gh auth status` for token validity.
- Verification: Pre-flight check section explicitly present. RESOLVED.

---

### Remaining Scalability Concerns

**S1 (LOW) — Forks endpoint itself truncates at scale**

`GET /repos/{owner}/{repo}/forks` with `per_page=100` and pagination will eventually return thousands of forks if the repo becomes widely forked. The spec caps analysis at 10 per run (prioritized by `pushed_at`), which is the right protection — but the API call to enumerate all forks still needs to fetch potentially many pages to find the 10 most recently active ones.

At 1,000+ forks, full enumeration to find the 10 most recent could consume 10+ API requests every scan cycle (200 requests/day just for fork discovery).

**Suggested fix**: Use `?sort=newest` on the forks API to get the most recently created forks first, then stop fetching pages once all returned `pushed_at` timestamps are older than 48 hours. This bounds the page-walk without fetching the full list. The spec already uses `?sort=newest` (confirmed in data sources section) — document the early-termination condition explicitly to prevent future code authors from fetching all pages unnecessarily.

**S2 (LOW) — Skip ledger composite key collision on rapid commit flood**

The PR skip ledger key is `pr-{number}-{headRefOid}`. Each new commit generates a new key and re-triggers analysis. With `maxReReviewsPerPRPerDay: 3`, a contributor pushing 20 commits in a day will trigger exactly 3 re-reviews — the cap handles the worst case.

However, the 3-per-day limit resets at midnight UTC. A contributor who learns the reset time can time a 3-commit burst just before midnight and just after, getting 6 reviews per effective day. This is low-severity (the attacker just gets more reviews, not a security bypass) but worth documenting.

**Suggested fix**: Use a 24-hour rolling window for the re-review rate limit rather than calendar-day reset. Minor implementation note, not a blocker.

**S3 (LOW) — Stage 2 sub-session concurrency not capped**

`maxReviewsPerRun: 5` bounds how many items are passed to Stage 2, but the spec doesn't clarify whether Stage 2 processes items sequentially or spawns concurrent sub-sessions. If Stage 1 spawns 5 parallel Opus sessions simultaneously, the actual peak cost is 5× what a sequential run would consume, and rate limit consumption spikes.

**Suggested fix**: Clarify in the spec that Stage 2 processes items sequentially within a single sub-session (the current architecture implies this since it's one spawned session), or explicitly state "one sub-session per review run, processes N items sequentially." This is likely already the intent — just make it explicit.

---

### Scalability Assessment

| Phase | Contributor Volume | Key Characteristics | Risk Level |
|-------|-------------------|---------------------|------------|
| **MVP** | 1-10 contributors | 2-5 PRs/week, <10 forks | LOW — all limits far from ceiling |
| **Growth** | 10-100 contributors | 20-50 PRs/week, 50-200 forks | LOW-MEDIUM — fork enumeration starts consuming quota; skip ledger grows but archived at 30d |
| **Scale** | 100-500 contributors | 100+ PRs/week, 500+ forks | MEDIUM — `maxReviewsPerRun` creates queue buildup on burst days; fork scan page-walks become expensive; still functional but latency increases |
| **Viral spike** | 500+ in days | 1000+ PRs in days | HIGH — 12-hour polling cadence creates 12-hour lag; needs webhook-driven triggering at this scale; current architecture degrades gracefully (queues items, doesn't fail) but throughput is capped |

**Assessment notes:**

- **MVP through Growth**: Architecture is fully appropriate. All Round 1 concerns addressed. Low operational risk.
- **Scale**: The `maxReviewsPerRun: 5` cap means a backlog builds during PR surges. Items carry over to next scan cycle (every 12 hours). This is graceful degradation, not failure — but Justin should be aware that classification latency grows from <12 hours to potentially 2-3 scan cycles (24-36 hours) during activity spikes.
- **Viral spike**: The 12-hour polling architecture is not designed for this scenario, and the spec appropriately scopes to MVP/Growth. A webhook-driven architecture would be needed for sub-minute latency at 500+ contributors — this is correctly identified as a future concern, not a current requirement.

**Cost envelope at Growth scale (100 contributors):**
- Stage 1 (Haiku): 2 runs/day × ~50 items × ~1K tokens = 100K tokens/day ≈ $0.03/day
- Stage 2 (Opus): 2 runs/day × 5 reviews × ~10K tokens = 100K tokens/day ≈ $1.50/day
- Monthly at Growth scale: ~$45/month — acceptable for the capability delivered

---

### Observations

- The `pushed_at`-based fork detection is cleanly superior to the Events API approach. No polling artifacts, no silent cap, and the timestamp is always fresh on the fork object.
- The token pre-estimation guard (`4 tokens/diff line × diffLines` against `maxTokenEstimate`) is a practical heuristic. It will occasionally over- or under-estimate, but erring toward notification rather than spawning is the right failure mode.
- `maxDiffLines: 1000` combined with `maxForksPerRun: 10` and `maxReviewsPerRun: 5` creates a well-bounded cost envelope. Three independent caps operating at different layers is good defense-in-depth against runaway cost.
- The audit log at 90-day retention with compression is appropriate. At 10 decisions/day, that's ~900 entries before archival — trivial storage.
- Skip ledger TTL for closed PRs at 30 days is correct. Open PR entries are correctly retained indefinitely (since the composite key ensures they re-trigger on new commits).

---

### Verdict

Round 2 is a materially improved spec. All five Round 1 scalability issues are cleanly resolved with direct, pragmatic fixes. The architecture is well-calibrated for MVP and Growth phases. The three remaining concerns (S1, S2, S3) are low-severity edge cases that don't affect near-term operation and can be addressed during implementation.

**Recommended for deployment with the following implementation notes:**
1. Document fork scan early-termination condition (stop page-walking when all `pushed_at` < 48h) to prevent future regression
2. Clarify Stage 2 runs sequentially (not parallel sub-sessions) in the implementation
3. Use 24-hour rolling window for re-review rate limit (minor)

---

*Generated by SpecReview Scalability Reviewer, Round 2. Spec: github-collaboration-monitor.md.*
