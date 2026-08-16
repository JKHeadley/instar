# Scalability Review — Cross-Agent Telemetry (Round 2)

**Review ID**: 20260321-234500
**Reviewer**: Scalability & Infrastructure
**Round**: 2
**Spec**: specs/cross-agent-telemetry.md
**Prior findings**: specreview/output/20260321-232336/synthesis.md

---

## Verdict

**CONDITIONAL APPROVE**

All four Round 1 scalability findings have been addressed with adequate fixes. Two new concerns emerge from the Round 2 additions (HMAC overhead and dual-write complexity). Neither is a blocker, but one requires a clarification in the spec before implementation begins.

Score: **8/10** (up from 7/10 in Round 1)

---

## Round 1 Fix Verification

### HIGH: No aggregation layer for population queries
**Fix claimed**: Dual-write to per-installation DOs (raw data) AND per-slug aggregate DOs (running counters).

**Verdict: ADEQUATE.**

The spec now explicitly describes the dual-write strategy in the backend section:

> "submissions are dual-written at ingest time. Per-installation DOs store the raw submission. Per-slug aggregate DOs maintain running counters (total skips by reason, mean durations, model distribution) updated on each write."

This is the correct design. Write-time fan-in to per-slug DOs eliminates the O(N) fan-out problem for Phase 2 queries entirely. The aggregate DO is updated once per submission — not queried across N installations at read time.

One unresolved detail: the spec does not specify how many per-slug DOs are expected at scale, or how slug-space sharding works if a single slug accumulates enough write traffic to saturate a single DO. At Phase 1 scale (10–100 agents) this is irrelevant. At 500+ agents with a handful of high-frequency slugs (e.g., `heartbeat`, `memory-sweep`), a hot per-slug DO is theoretically possible. The spec's "no analysis yet" posture means this won't be hit in Phase 1, but it should be flagged for Phase 2 design.

**Action**: Note in Phase 2 pre-design: assess per-slug DO write throughput for top-N most common job slugs. Not a Phase 1 blocker.

---

### HIGH: Single aggregate DO burst risk
**Fix claimed**: Submission jitter + per-installationId rate limiting.

**Verdict: ADEQUATE.**

The spec now includes:
1. First-submission jitter: "random 0–6h jitter on `nextSubmissionAfter`" to spread fleet across windows
2. Per-installationId rate limiting: "max 1 submission per 5 hours (reject early resubmissions)"
3. IP-level rate limiting: "max 10 submissions per IP per hour (Cloudflare-native)"

The combination addresses the burst risk well. The 5-hour minimum window between submissions from a single installation means even a post-outage fleet recovery won't all hit simultaneously — the jitter from prior `nextSubmissionAfter` values was already applied. The IP-level cap provides a secondary defense against resubmission storms.

One minor gap: the spec doesn't specify what happens when `nextSubmissionAfter` from the server is ignored (e.g., a client bug resubmits at full rate). The per-installationId rate limiter handles this correctly — the Worker will reject with `rate_limited` and the client will back off. The error response envelope includes `rate_limited` as a defined code. This chain is intact.

**Verdict: fix is complete and coherent.**

---

### MEDIUM: Local JSONL log no retention
**Fix claimed**: 30-day rolling retention.

**Verdict: ADEQUATE.**

The spec now states:

> "30-day rolling window. On each write, entries older than 30 days are truncated (same pattern as SkipLedger)."

This is the correct approach. Truncating on write rather than via a scheduled job is simpler and avoids the need for a separate maintenance process. The SkipLedger pattern is proven in the codebase.

Storage bound estimate: at 100KB per submission cap, 4 submissions/day, 30 days = 12GB theoretical maximum. In practice, most agents will have far fewer than 100 jobs, so real payloads will be 1–10KB. Expected actual storage per agent: 120KB–1.2MB over 30 days. Well within acceptable bounds.

**Verdict: fix is complete.**

---

### MEDIUM: Payload size unbounded
**Fix claimed**: 100KB hard cap, truncate from least-recently-run jobs.

**Verdict: ADEQUATE.**

The spec states:

> "Payload size limit: 100KB hard cap. If the `jobs` array exceeds this, truncate from least-recently-run jobs."

The truncation strategy (drop least-recently-run jobs first) is reasonable — it preserves the most actionable data. An agent with 200 configured jobs but only 30 active ones will keep the 30 active ones in the payload. This is the right priority ordering.

The Worker also enforces the cap server-side with a `payload_too_large` error code in the response envelope. Client + server enforcement is belt-and-suspenders and correct.

**Verdict: fix is complete.**

---

### MEDIUM: No cost model
**Round 1 finding**: Noted as favorable. No specific fix required.

**Round 2 check**: The cost model remains favorable. No changes in the spec affect this assessment. Workers pricing is still linear and cheap, dual-write adds marginal DO write cost (two writes per submission instead of one), and the 30-day retention bound on storage means no unbounded cost accumulation. The dual-write cost is effectively doubled storage writes but at Durable Object pricing this is negligible — likely under $1/month at 1,000 agents.

**Verdict: no concern.**

---

## New Concerns from Round 2 Additions

### NEW-1: HMAC validation overhead (MEDIUM — monitor, not a blocker)

The spec adds HMAC-SHA256 signing:

> `HMAC-SHA256(installationId + timestamp + SHA256(payload), localSecret)`

The Worker must validate this on every submission. HMAC-SHA256 is CPU-fast — microseconds per operation at this payload size — so this is not a compute concern at scale. However, the spec notes "the Worker validates: 1. Signature matches, 2. Timestamp within ±5 minutes of server time, 3. installationId in payload matches."

**Concern**: The per-install `localSecret` is stored on disk at `{stateDir}/telemetry/install-id`. The spec says this key is "stored alongside the install-id" but does not specify the exact file or whether both the UUID and the secret are in the same file or separate files. If an attacker who compromises the agent's state directory gets both the UUID and the secret, they can submit arbitrary data attributed to that installation.

This is a security concern more than a scalability one, but it has a scalability implication: there is no mechanism for the server to revoke or rotate a per-installation key if it's compromised. The only recourse is `instar telemetry disable` (which sends a DELETE) followed by `instar telemetry enable` (which regenerates both UUID and secret). The spec should make this explicit — and the `instar telemetry` CLI should mention that disabling + re-enabling generates a fresh identity.

**Verdict**: Not a scalability blocker. Flag for security review. Add a note to the spec clarifying key storage file structure and rotation path.

---

### NEW-2: Dual-write atomicity under failure (MEDIUM — spec gap)

The spec specifies dual-write at ingest:

> "dual-write to per-installation DOs (for raw data) AND per-slug aggregate DOs (for population queries)"

The spec does not specify what happens if one write succeeds and the other fails. Cloudflare Durable Objects do not support cross-DO transactions. If the per-installation DO write succeeds but the per-slug aggregate DO write fails (or vice versa), the data is permanently inconsistent: raw data exists without a corresponding aggregate update, or an aggregate was incremented without raw data to back it.

**At Phase 1 scale (10–100 agents)**: Inconsistencies are rare and the impact is minor — a small number of submissions missing from aggregate counts. Population stats would be slightly underreported but not misleadingly wrong.

**At Phase 2+ scale**: If the aggregate DOs are the primary query surface, silent under-counting becomes a data quality issue that could lead to incorrect design decisions.

**Recommended resolution**:
1. Accept eventual consistency as the explicit design stance (appropriate for telemetry). Document that aggregate DOs may undercount by a small fraction in the event of partial write failures.
2. Log the partial failure (if detectable) in the Worker's analytics so Echo can monitor the rate.
3. Do not implement retry-with-deduplication — the added complexity is not worth it at Phase 1 scale.

The spec should explicitly acknowledge this trade-off rather than leaving it implicit. "No analysis logic yet" is the right call for Phase 1; "no consistency guarantee defined" is a gap that will be inherited by Phase 2.

**Verdict**: Not a blocker for Phase 1, but the spec should acknowledge the eventual consistency trade-off explicitly. Add a one-line note in the backend spec section.

---

### NEW-3: DELETE endpoint scaling and purge scope (LOW — design note)

The new deletion endpoint:

> `DELETE /v1/telemetry/{installationId}` (HMAC-signed)

This is the Right to Erasure path. Two minor scalability notes:

1. **Purge scope ambiguity**: "within 24 hours" is specified for remote purge. The spec doesn't state whether the purge covers both the per-installation DO and the per-slug aggregate DOs. Purging the raw installation DO is straightforward. Purging a deleted installation's contribution from a running aggregate counter is harder — you'd need to recompute the aggregate minus that installation's historical contributions, which requires reading the raw data (which is being deleted). **Resolution**: Clarify that aggregate DOs are not retroactively corrected on deletion; only the raw installation DO is purged. Aggregate DOs contain no personally identifiable data (they're population-level counters), so their retention after installation deletion is appropriate and not a GDPR concern. This should be stated explicitly in the Privacy Architecture section.

2. **Abuse surface**: A bad actor who obtains someone else's installationId could attempt to delete their data via a forged DELETE request. The HMAC requirement prevents this — they'd need the localSecret too. This is correctly handled.

**Verdict**: No scalability blocker. Add a one-line clarification that aggregate DOs are not retroactively corrected on deletion.

---

### NEW-4: TelemetryCollector offset tracking (LOW — confirm it's in scope)

The Round 1 synthesis flagged this as a gap (not covered by any reviewer). The revised spec now mentions it:

> "Uses offset tracking to avoid scanning full 30-day ledger on every tick."

This is listed as a design note in the implementation section for `TelemetryCollector.ts`. Confirming this is present is sufficient — it's the right call. Scanning 30 days of `job-runs.jsonl` on every 6-hour tick would be wasteful for busy agents. Offset tracking means each collection pass only reads new entries since the last window, which is O(new entries) not O(all entries).

**Verdict**: Adequately addressed. No further action required.

---

## Scalability Model — Updated

| Phase | Agents | Write load | Aggregate query load | Verdict |
|-------|--------|------------|---------------------|---------|
| MVP (10–50) | ~0.002 req/sec average | Trivial | N/A (Phase 1 only) | Safe |
| Growth (50–500) | ~0.02 req/sec average | Low | Per-slug DOs handle this without sharding | Safe |
| Scale (500–5,000) | ~0.2 req/sec average, ~5 req/sec burst | Moderate | Per-slug aggregate DOs are read/write hot for top slugs | Monitor hot slugs |
| Viral (5,000+) | ~2 req/sec average, ~50 req/sec burst | High | Per-slug DOs may need sharding for top slugs | Design before crossing this threshold |

The dual-write fix substantially improves the Phase 2+ scaling trajectory. The O(N) fan-out problem is eliminated for read queries. The remaining concern is write-side hot spots on per-slug aggregate DOs at high agent counts, which is a solvable problem with slug-space sharding (not needed until Phase 3+).

---

## Summary Table

| Finding | Round 1 Status | Round 2 Fix | Verdict |
|---------|----------------|-------------|---------|
| No aggregation layer | HIGH | Dual-write to per-installation + per-slug DOs | ADEQUATE |
| Single aggregate DO burst risk | HIGH | Submission jitter + rate limiting | ADEQUATE |
| Local JSONL log no retention | MEDIUM | 30-day rolling retention | ADEQUATE |
| Payload size unbounded | MEDIUM | 100KB hard cap | ADEQUATE |
| No cost model | Favorable (noted) | Unchanged — still favorable | ADEQUATE |
| HMAC validation overhead (NEW) | — | Not a compute issue; key storage and rotation path unclear | MONITOR — flag for security |
| Dual-write atomicity (NEW) | — | No consistency guarantee defined | NOTE IN SPEC |
| DELETE endpoint purge scope (NEW) | — | Aggregate DO behavior on deletion unstated | NOTE IN SPEC |
| TelemetryCollector offset tracking (NEW) | Gap (unaddressed) | Now mentioned in implementation section | RESOLVED |

---

## Recommended Spec Additions Before Implementation

1. **Dual-write consistency stance** — Add one line to the backend section: "Writes to per-installation and per-slug DOs are eventually consistent; partial write failures result in undercount in aggregates and are acceptable for a telemetry system."

2. **DELETE scope clarification** — Add one line to the Deletion section: "The purge covers the per-installation DO only. Per-slug aggregate DOs are population-level counters that do not contain installation-specific data and are not affected by deletion requests."

3. **Key storage file structure** — Clarify whether `localSecret` and `installationId` are stored in the same file or separate files at `{stateDir}/telemetry/`. Add a note that `instar telemetry disable` followed by `instar telemetry enable` rotates both, generating a fresh identity.

4. **Phase 2 pre-design note** — Add to Phase 2 pre-design decisions: "Assess per-slug DO write throughput ceiling for top-N most common job slugs before Phase 2 implementation begins."

None of these require spec revision before Phase 1 implementation. They are clarifications, not design changes. They can be added as notes in the relevant sections within a day.

---

## Overall Scalability Recommendation

**CONDITIONAL APPROVE for Phase 1 implementation.**

All critical scalability blockers from Round 1 are resolved. The dual-write architecture is sound and eliminates the primary structural risk identified in Round 1. The new concerns (HMAC overhead, dual-write consistency, DELETE scope) are minor and appropriate to address with spec annotations rather than redesign.

The spec is ready to proceed to implementation with the four recommended annotations added. No redesign is required.
