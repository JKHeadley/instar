# SpecReview Synthesis: Cross-Agent Telemetry

**Review ID**: 20260321-232336
**Date**: 2026-03-21
**Round**: 1
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing
**Spec**: specs/cross-agent-telemetry.md

---

## Overall Assessment

**Status**: NEEDS WORK
**Average Score**: 6.4 / 10
**Score Range**: 5.5 (Marketing) — 8 (Architecture implied for Phase 1 with fixes)

| Reviewer | Status | Score | Key Finding |
|----------|--------|-------|-------------|
| Security | CONDITIONAL | 6/10 | SHA-256 installation ID is reversible; unauthenticated write endpoint is a data poisoning surface |
| Scalability | CONDITIONAL | 7/10 | Per-installation DO keying cannot support Phase 2 population queries without a redesign |
| Business | APPROVE | 7.5/10 | Problem-solution fit is strong; adoption risk is the primary threat to ROI |
| Architecture | CONDITIONAL | 7/10 | p50/p95 percentiles are statistically invalid for fleet aggregation; Phase 1 data model doesn't support Phase 2 |
| Privacy | CONDITIONAL | 6/10 | Consent model unspecified; no deletion/erasure mechanism; session metrics are quasi-identifiers |
| Adversarial | CONDITIONAL | 6/10 | Sybil attack is trivially executable with no authentication; metric poisoning would corrupt design decisions |
| DX | CONDITIONAL | 5.5/10 | No CLI surface, no status endpoint, local log contains summary not payload — transparency claim is hollow |
| Marketing | CONDITIONAL | 5.5/10 | Feature is technically strong but has no user-facing value prop, no name, no consent narrative |

---

## Consensus Findings

Issues identified independently by 3+ reviewers — these are the real problems.

### 1. Installation ID Is Not Meaningfully Anonymous (Security, Privacy, Adversarial, Architecture)

All four reviewers independently flagged that `SHA-256(machineId + projectDir)` is not a non-reversible identifier in practice. The input space is constrained: machineId is a fixed hardware UUID shared across software, and projectDir follows highly predictable patterns. Preimage attacks on this space are fast. Security cites VSCode's MAC address hashing vulnerability; Privacy cites Rocher et al. (99.98% re-identification from 15 attributes); Adversarial notes the attack is practical with a dictionary of ~1,000 common paths.

**Consensus fix**: Replace deterministic hash with a cryptographically random UUID generated at first opt-in and stored locally. Never derive from machine properties.

### 2. Phase 2 Population Queries Are Impossible Given Phase 1 Data Model (Scalability, Architecture, Business)

All three reviewers independently identified that storing raw submissions keyed by installation ID (one Durable Object per installation) cannot efficiently support Phase 2's cross-fleet queries like "skip rate for job X across all agents." Scalability calls it "the primary risk"; Architecture calls it "one architectural decision that is expensive to undo"; Business flags it as a "backend architectural lock-in" risk.

**Consensus fix**: Design the aggregation layer before Phase 1 is built. Two options: write-time fan-in to per-slug aggregate DOs, or a background sweep job that materializes population stats.

### 3. Phase 4 Evolution Crowdsourcing Requires a Separate, Dedicated Security Review (Security, Privacy, Adversarial)

Three reviewers independently flagged Phase 4 as a fleet-wide behavioral update distribution channel with no described signing, integrity checking, or sandboxing. Security issues a BLOCK on Phase 4. Adversarial rates Phase 4 evolution poisoning as HIGH priority (score 10). Privacy flags it as requiring a distinct consent category, not an extension of Phase 1 consent.

**Consensus**: Phase 4 must not proceed to design until a dedicated threat model is written and content signing is specified.

### 4. Local Transparency Log Does Not Log What Was Sent (Architecture, DX, Security)

Three reviewers found the same gap: the proposed log entry records `metricsSubmitted: { jobCount: 23 }` — a summary, not the actual payload. Architecture notes the existing `logHeartbeat()` correctly logs the full payload and this should match. DX calls the current log "nearly useless for actual audit." Security recommends logging the full payload or a hash to allow independent verification.

**Consensus fix**: Log the full outgoing payload (or a deterministic hash of it) in the local transparency log.

### 5. Session Metrics Are Behavioral Fingerprints, Not Structural Data (Privacy, Adversarial, Marketing implicitly)

Privacy and Adversarial both independently identified that `sessionsLast24h` and `avgDurationMin` reveal work intensity, schedule, and timezone — not just structural configuration. Adversarial calls it "work pattern surveillance." Privacy flags it as a quasi-identifier that undermines the "structural data only" privacy claim.

**Consensus fix**: Bucket both fields into coarse ranges (e.g., 0, 1–5, 6–20, 20+) or remove them if no specific design question requires them.

### 6. No Unauthenticated Endpoint Protections (Security, Adversarial, Privacy)

All three agree the write endpoint with no authentication, no rate limiting, and no request signing is a data poisoning surface. Security details four specific attack vectors. Adversarial rates the Sybil attack as CRITICAL (priority 15). Privacy recommends HMAC request signing.

**Consensus fix**: IP-level rate limiting (Cloudflare-native), HMAC request signing using the per-install secret, server-side schema validation with strict field bounds.

---

## Critical Issues (Blockers)

### BLOCK — Phase 4 (Security)
Phase 4 as described creates a fleet-wide behavioral update channel with no integrity guarantees. Blast radius if the distribution pipeline is compromised is every opted-in agent simultaneously. Security issues an explicit BLOCK on Phase 4 until a dedicated threat model and content signing architecture are written.

### CONDITIONAL BLOCK — Phase 1 without consent surface (DX, Privacy)
DX states directly: "Phase 1 is blocked until 1895 delivers a consent surface, or this spec must own a minimal consent UX as a fallback." Privacy adds that consent must be structurally human-initiated — telemetry must not be enableable via agent API calls. Neither defines a hard BLOCK on Phase 1 itself, but both agree Phase 1 cannot ship without a viable consent mechanism.

---

## Conflicts

### Tension 1: p50/p95 Metrics — Architecture vs. Current Spec

Architecture flags that p50/p95 per-agent per-window values cannot be fleet-aggregated (mean-of-percentiles is statistically invalid). Architecture recommends replacing with `meanMs + count` for Phase 1. No other reviewer addresses this directly, so there is no conflict — but the spec itself implicitly treats these as aggregatable. This needs a decision from the spec owner, not cross-examination.

### Tension 2: Installation ID Stability vs. Longitudinal Tracking Value

Security and Adversarial both recommend breaking longitudinal linkability (random UUID; monthly key rotation), while Architecture notes that "Phase 4 (Evolution Crowdsourcing) requires tracking proposal outcomes over time, which requires longitudinal installation identity." This is a genuine tension: privacy and security want ephemeral IDs; functionality wants stable ones. Resolution: random UUID satisfies both if stored locally and never derived from machine properties. Stability comes from the stored file, not from deterministic derivation.

### Tension 3: DX Recommends No Auth on Write Endpoint; Security/Adversarial Recommend HMAC Signing

DX rates the "no auth on submission endpoint" as 5/5 correct, saying "requiring auth tokens would create a barrier." Security and Adversarial both call the unauthenticated endpoint a critical vulnerability. Resolution: these are not actually in conflict. HMAC signing using a locally-stored per-install secret provides authentication without requiring user-facing auth tokens or server-side key management. DX was evaluating OAuth-style token auth; Security/Adversarial propose a lower-friction alternative.

### Tension 4: Feature Flags — Business Wants Them; Privacy/Security Want Them Restricted

Business considers feature flag data valuable for design decisions. Privacy and Security both recommend restricting to a count or pre-defined whitelist (excluding security-relevant flags). Adversarial adds that full flag maps enable competitive intelligence extraction. Resolution: adopt a curated whitelist of usage/adoption flags explicitly; exclude security-posture flags.

---

## Recommendations (Prioritized)

### P0 — Must fix before Phase 1 ships

| # | Recommendation | Reviewers | Effort |
|---|---------------|-----------|--------|
| P0-1 | Replace SHA-256(machineId+projectDir) installation ID with cryptographically random UUID stored at first opt-in | Security, Privacy, Adversarial, Architecture | Low |
| P0-2 | Add HMAC request signing: compute `HMAC-SHA256(installId + timestamp + payload_hash, localSecret)`; Worker validates signature and timestamp window | Security, Adversarial, Privacy | Medium |
| P0-3 | IP-level rate limiting on write endpoint (Cloudflare-native); max N submissions per installationId per 24h | Security, Adversarial | Low |
| P0-4 | Server-side enum validation on skip reasons — reject unknown values with 400 | Security, Adversarial | Low |
| P0-5 | Replace `p50Ms, p95Ms` with `meanMs, count` in job metrics schema | Architecture | Low |
| P0-6 | Log full outgoing payload in local transparency log, not summary counts | Architecture, DX, Security | Low |
| P0-7 | Define consent surface: human-gated, not enableable via agent API; either gate Phase 1 on Topic 1895 or define minimal fallback consent UX in this spec | Privacy, DX | Medium |
| P0-8 | Add deletion API: `DELETE /telemetry/submissions/{installationId}` — GDPR Right to Erasure compliance | Privacy | Medium |
| P0-9 | Define error response envelope: `schema_version_unsupported`, `rate_limited`, `payload_too_large`, `malformed` | DX | Low |

### P1 — Ship with or immediately after Phase 1

| # | Recommendation | Reviewers | Effort |
|---|---------------|-----------|--------|
| P1-1 | Design aggregation layer for Phase 2 now (even if not built): decide between write-time fan-in to per-slug aggregate DOs vs. background sweep job | Scalability, Architecture, Business | Medium |
| P1-2 | Replace `sessionsLast24h` and `avgDurationMin` with bucketed ranges, or remove if no specific design question requires exact values | Privacy, Adversarial | Low |
| P1-3 | Add `windowStart`/`windowEnd` ISO timestamps to submission payload; add `"v": 1` schema version field | Architecture, DX | Low |
| P1-4 | Add 30-day local log retention with truncation on write (apply same pattern as SkipLedger) | Scalability, Architecture, Privacy | Low |
| P1-5 | Add payload size cap (100 KB hard limit); truncate `jobs` array from oldest if over limit | Scalability | Low |
| P1-6 | Replace feature flags full map with curated whitelist of usage/adoption flags; explicitly exclude security-posture flags | Security, Privacy, Business, Adversarial | Low |
| P1-7 | Add `instar telemetry status / enable / disable` CLI surface | DX | Medium |
| P1-8 | Add `GET /telemetry/status` server endpoint with last submission time, next window, population size | DX | Low |
| P1-9 | Add `GET /telemetry/submissions/latest` returning full last payload for audit | DX | Low |
| P1-10 | Randomize `nextSubmissionAfter` on first submission (0–6h jitter) to spread fleet across submission windows | Scalability | Low |
| P1-11 | Remove `populationSize` from unauthenticated response, or add noise (±10% jitter / nearest-10 rounding) | Security, Privacy, Adversarial | Low |

### P2 — Before Phase 2 design begins

| # | Recommendation | Reviewers | Effort |
|---|---------------|-----------|--------|
| P2-1 | Enforce strict 30-day TTL in Worker implementation; add `DELETE /telemetry/submissions/{id}` with verification | Privacy, Security | Medium |
| P2-2 | Add a `backoff: true` field to response for server-side backpressure signaling | Scalability | Trivial |
| P2-3 | Add minimum population filter for aggregate queries: suppress metric combinations with k < 5 (k-anonymity floor) | Adversarial, Privacy | Medium |
| P2-4 | Weight new installation IDs lower in aggregates until they establish history (Sybil mitigation) | Adversarial | Medium |
| P2-5 | Document Phase 2 admin query interface before Phase 1 launches — Echo needs a way to validate data is flowing | Architecture | Low |
| P2-6 | Add OTEL compatibility note and decision point for whether Phase 1 data format should align with OTEL | Business | Low |
| P2-7 | Define forward/backward compatibility contract: server accepts unknown fields; client sends `schemaVersion`; server rejects below minimum | DX | Low |

---

## Scalability Summary

| Phase | Agents | Key Risk | Verdict |
|-------|--------|----------|---------|
| MVP (10–50) | Trivial load | None at this scale — single DO works | Safe to ship |
| Growth (50–500) | DO keying strategy starts to matter | Per-installation DOs fine for writes; aggregation queries begin to hurt | Need aggregation layer designed before crossing 100 agents |
| Scale (500–5,000) | ~1–10 req/sec average | Single aggregate DO becomes a write hotspot; burst recovery (post-outage) can spike to 1,000 concurrent writes — hitting DO overload threshold | Jitter + per-slug DO sharding required |
| Viral (5,000+) | Hundreds of req/sec in bursts | Cross-DO aggregation for population queries is O(N) fan-out — infeasible without a materialized view layer | Backend rewrite required before this phase |

Cost model is favorable throughout: Workers pricing is linear and cheap, storage stays bounded under 30-day rolling retention. No cost cliff exists in the current design.

---

## Gaps

Areas no reviewer covered, or where the spec is silent:

1. **Monitoring the monitor**: No reviewer asked how Echo will know if the telemetry Worker itself has errors or latency spikes. Architecture briefly notes Cloudflare Analytics Engine but doesn't make it a recommendation. The backend needs its own observability.

2. **Startup behavior for overdue submissions**: DX notes this is unspecified. If an agent has been offline for 2 weeks and comes back, does it submit immediately? Backfill multiple windows? The spec is silent. This will be inconsistent across implementations.

3. **TelemetryCollector scan performance**: Architecture flags that scanning 30 days of `job-runs.jsonl` on every 6-hour tick could be slow for busy agents. Offset tracking is the standard solution and should be designed in from the start. No other reviewer addressed this.

4. **EU AI Act compliance (August 2026)**: Marketing notes the EU AI Act becomes fully applicable August 2026. Privacy covers GDPR/CCPA but does not specifically address the EU AI Act's requirements for automated decision-making systems (which Phases 3 and 4 potentially trigger). This regulatory gap should be assessed before Phase 3 design.

5. **Minimum age gate for submissions**: Adversarial recommends requiring 48+ hours of uptime before a new installation can submit (to prevent empty-state pollution from abandoned agents). No other reviewer addressed this operational quality concern.

6. **Changelog and docs plan**: DX notes the spec doesn't say where end-user documentation will live or what the changelog entry will say. Not a design issue, but a launch readiness gap.

---

## Name Analysis

**Current name**: "Cross-Agent Telemetry"

**Marketing's assessment**: Functional but unbranded. "Cross-agent" implies agents talking to each other (wrong). "Telemetry" is clinical and describes the mechanism, not the value.

**Candidates evaluated**:

| Name | Verdict |
|------|---------|
| **Baseline** | **Recommended** — "Is your agent's behavior normal?" is answered in the name. "Enable Baseline" is self-explanatory. "Your skip rate is 2x the Baseline average" is immediately actionable. |
| Pulse | Generic; used by too many other tools |
| Field Intelligence | Abstract; two words; harder to explain |
| Constellation | Poetic but slow to explain |
| Echoes | Too close to the Echo agent name; creates brand confusion |

**User-facing value prop (currently missing from spec)**: "See how your agent's behavior compares to the population — without sharing a single byte of content."

**Consent copy recommendation**: "Help your agent know if it's healthy" outperforms "Enable anonymous telemetry" by an estimated 4x on opt-in rate for developer tools.

---

## Convergence Status

| Reviewer | Verdict |
|----------|---------|
| Security | CONDITIONAL (BLOCK on Phase 4) |
| Scalability | CONDITIONAL |
| Business | APPROVE (with notes) |
| Architecture | CONDITIONAL (Ready for Phase 1 with 4 fixes) |
| Privacy | CONDITIONAL |
| Adversarial | CONDITIONAL |
| DX | CONDITIONAL (3 blocking issues) |
| Marketing | CONDITIONAL |

**Tally**: 1 Approve / 7 Conditional / 0 Block (on Phase 1) / 1 Block (on Phase 4)

**Overall convergence rating**: **NEEDS WORK — addressable.** No reviewer found a fundamental design flaw in Phase 1. The issues are concrete and fixable: wrong installation ID scheme, missing authentication, wrong metric types, hollow transparency log, absent consent surface, and missing CLI tooling. Phase 4 has a hard block that requires separate design work. The foundation — opt-in default, privacy-by-architecture, fire-and-forget, skip reason taxonomy, phased rollout — is praised by 6 of 8 reviewers. This spec is close to READY after targeted revisions.

---

## Next Steps

- [ ] **Replace installation ID scheme** — random UUID at first opt-in, stored in `{stateDir}/telemetry/install-id` (P0-1)
- [ ] **Add HMAC request signing** to submission payload; update Worker to validate (P0-2)
- [ ] **Add IP-level rate limiting** in Worker config (P0-3)
- [ ] **Replace p50/p95 with meanMs+count** in job metrics schema (P0-5)
- [ ] **Update local transparency log** to store full outgoing payload (P0-6)
- [ ] **Define consent surface** — either explicit dependency on Topic 1895 with gate, or minimal fallback UX in this spec (P0-7)
- [ ] **Add deletion API spec** for Right to Erasure compliance (P0-8)
- [ ] **Add error response envelope** definition to API spec (P0-9)
- [ ] **Add server-side skip reason enum validation** — reject unknown values (P0-4)
- [ ] **Design aggregation layer** for Phase 2 before Phase 1 implementation begins (P1-1)
- [ ] **Bucket or remove session metrics** (`sessionsLast24h`, `avgDurationMin`) (P1-2)
- [ ] **Add windowStart/windowEnd + schema version** to payload spec (P1-3)
- [ ] **Add local log retention** (30-day, truncate on write) and payload size cap (P1-4, P1-5)
- [ ] **Curate feature flags whitelist** — usage/adoption only, no security-posture flags (P1-6)
- [ ] **Add CLI and server endpoints**: `instar telemetry status/enable/disable`, `GET /telemetry/status`, `GET /telemetry/submissions/latest` (P1-7, P1-8, P1-9)
- [ ] **Issue formal BLOCK notice on Phase 4** — document that Phase 4 requires a dedicated threat model and content signing spec before any design work proceeds
- [ ] **Name decision** — evaluate "Baseline" as user-facing feature name; write user-facing value prop
- [ ] **Round 2 review** after P0 items are resolved — resubmit for security and privacy sign-off
