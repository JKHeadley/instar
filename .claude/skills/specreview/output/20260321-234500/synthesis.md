# SpecReview Synthesis: Baseline (Cross-Agent Telemetry) — Round 2

**Review ID**: 20260321-234500
**Date**: 2026-03-21
**Round**: 2 (post-revision)
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing
**Spec**: specs/cross-agent-telemetry.md

---

## Score Progression (Round 1 → Round 2)

| Reviewer | R1 Score | R1 Status | R2 Score | R2 Status | R1 Issues Resolved? |
|----------|----------|-----------|----------|-----------|---------------------|
| Security | 6/10 | CONDITIONAL | 8/10 | CONDITIONAL APPROVE | Yes (all 4 verified) |
| Scalability | 7/10 | CONDITIONAL | 8/10 | CONDITIONAL APPROVE | Yes (all 4 verified) |
| Business | 7.5/10 | APPROVE | 8.5/10 | APPROVE | Yes (all 4 notes addressed) |
| Architecture | 7/10 | CONDITIONAL | 8.5/10 | CONDITIONAL APPROVE | Yes (all 5 verified) |
| Privacy | 6/10 | CONDITIONAL | 8.5/10 | CONDITIONAL APPROVE | Yes (all 6 verified) |
| Adversarial | 6/10 | CONDITIONAL | — | CONDITIONAL | Partially (core vectors closed; new gaps found) |
| DX | 5.5/10 | CONDITIONAL | 8/10 | CONDITIONAL APPROVE | Yes (all 3 blockers resolved) |
| Marketing | 5.5/10 | CONDITIONAL | 8.5/10 | APPROVE | Yes (all 4 findings addressed) |

**Average Round 1**: 6.4 / 10
**Average Round 2**: 8.25 / 10
**Delta**: +1.85

---

## Overall Assessment

**Status**: CONDITIONAL APPROVE (6 of 8 reviewers; 1 outright APPROVE; 1 CONDITIONAL without numeric score)
**Average Score**: 8.25 / 10
**Score Range**: 8.0 (Security, Scalability, DX) — 8.5 (Architecture, Privacy, Business, Marketing)

The spec underwent a substantive revision. All six Round 1 consensus findings were addressed. The fundamental architecture is sound. The remaining blockers are implementation-level clarifications (HMAC canonical form, secret storage spec, erasure recovery path), not design flaws. Phase 1 is within one focused revision pass of an unconditional APPROVE.

---

## Round 1 Fix Verification

For each of the 6 Round 1 consensus findings:

### 1. Installation ID Not Meaningfully Anonymous
**Fix**: Replaced `SHA-256(machineId + projectDir)` with cryptographically random UUID stored at `{stateDir}/telemetry/install-id`.
**Verdict: FULLY RESOLVED.** All four reviewers who flagged this (Security, Privacy, Adversarial, Architecture) verified the fix as adequate. The spec includes the rationale for why SHA-256 was rejected, which will prevent silent regression by future contributors.

### 2. Phase 2 Population Queries Impossible with Phase 1 Data Model
**Fix**: Dual-write aggregation — submissions write to both per-installation DOs (raw data) and per-slug aggregate DOs (running counters) at ingest time.
**Verdict: FULLY RESOLVED for Phase 1.** Scalability, Architecture, and Business all verified the fix. The O(N) fan-out for Phase 2 queries is eliminated. A write-side hotspot concern at 500+ agents is acknowledged but explicitly deferred to Phase 2 pre-design, which is the correct call.

### 3. Phase 4 Evolution Crowdsourcing Requires Separate Security Review
**Fix**: Phase 4 now carries an explicit `STATUS: BLOCKED` notice with four named prerequisites: dedicated threat model, content signing architecture, kill-switch mechanism, and separate consent tier.
**Verdict: FULLY RESOLVED.** Security, Privacy, and Adversarial all verified the block as well-formed. The block is specific, not vague, and does not allow Phase 4 design to proceed without meeting the listed conditions.

### 4. Local Transparency Log Does Not Log What Was Sent
**Fix**: Log entry now stores the full outgoing JSON payload with `timestamp`, `payload`, `endpoint`, `responseStatus`.
**Verdict: FULLY RESOLVED.** Architecture, DX, and Security all verified. The spec includes the rationale ("does not answer 'did anything sensitive go out?'"), making the design intent durable.

### 5. Session Metrics Are Behavioral Fingerprints
**Fix**: `sessionsLast24h` replaced with `sessionsBucket` (coarse enum: `"0"`, `"1-5"`, `"6-20"`, `"20+"`). `avgDurationMin` removed entirely.
**Verdict: FULLY RESOLVED.** Privacy and Adversarial both verified. The rationale (work pattern + timezone fingerprinting) is stated in the spec. One low-priority residual: `uptimeHours` was flagged by Privacy as a future quasi-identifier candidate at small fleet sizes, but not a blocker.

### 6. No Unauthenticated Endpoint Protections
**Fix**: HMAC-SHA256 request signing with per-install local secret; ±5 minute timestamp window for replay protection; IP-level rate limiting (max 10 submissions/IP/hour); per-installationId rate limiting (max 1 submission per 5 hours); error response envelope with 6 error codes including `signature_invalid` and `timestamp_expired`.
**Verdict: SUBSTANTIALLY RESOLVED.** The core authentication architecture is correct. However, three reviewers independently identified residual implementation gaps in this fix (see New Issues below) — specifically around HMAC message canonicalization, secret file storage spec, and the DELETE endpoint's lack of server-side key binding.

---

## New Issues (Round 2)

Issues identified by multiple reviewers from the revisions themselves.

### Cross-Reviewer Consensus: HMAC Implementation Gaps (Security, Architecture, Adversarial, Scalability, DX)

Five reviewers independently flagged concerns about the HMAC construction. This is the strongest Round 2 consensus finding.

**HMAC-1: No canonical message format (Security NEW-1, Architecture Concern 1, Adversarial R1-1b)**
The spec defines `HMAC-SHA256(installationId + timestamp + SHA256(payload), localSecret)` using string concatenation without delimiters. Three reviewers identified this creates a potential canonicalization ambiguity — different input combinations can produce identical concatenated strings. Since installationId is a fixed-length UUID (36 chars) this is low practical risk, but it is a load-bearing implementation detail: if the Worker and `TelemetryAuth.ts` use different serializations, signatures will never match. Security and Architecture both require this to be defined before implementation begins. Adversarial rates it 2/10 risk but agrees explicit delimiters are the correct fix.

**Recommended canonical form** (Security's proposal, supported by Architecture): `installationId + ":" + timestamp + ":" + SHA256(payload_hex)` — or more robustly, `JSON.stringify({id, ts, ph})`.

**HMAC-2: Secret file storage unspecified (Security NEW-3, Architecture Concern 4, Adversarial R1-1a, Scalability NEW-1)**
Four reviewers flagged that `localSecret` storage location, file format, key length, and Unix permissions are unspecified. All converge on the same requirements: file path should be explicit (e.g., `{stateDir}/telemetry/local-secret`), format should be specified (hex or base64, minimum 32 bytes), permissions must be `chmod 600`. Without this, stateDir world-readable defaults leave the HMAC secret exposed to any process on the machine.

### Cross-Reviewer Consensus: DELETE Endpoint Key Binding Gap (Adversarial NEW-1, Privacy NC-1, Architecture Concern 2)

Three reviewers independently identified that the DELETE endpoint has an authentication gap, though they frame it differently:

- **Adversarial (7/10, highest-rated new finding)**: The Worker stores no key fingerprint at registration time. An attacker who learns a target's installationId can forge a valid HMAC-signed DELETE with any random localSecret, because the Worker has no reference to validate against. Fix: store `SHA-256(installationId + localSecret)` in the per-installation DO at first submission; validate all subsequent operations against it.
- **Privacy (NC-1, Medium)**: If the user's local secret is lost (disk failure, migration), they cannot send a valid signed deletion request and their data becomes permanently retained without recourse. Fix: allow unsigned deletion by installationId alone, or define a recovery path.
- **Architecture (Low)**: If the local install-id is deleted on `instar telemetry disable` but the DELETE network request fails, the user has no retry mechanism. The right approach is a pending-deletion state with retry on next startup.

These three concerns overlap and together form a coherent gap: the erasure guarantee is weaker than stated, from both an adversarial and a user-recovery standpoint.

### Cross-Reviewer Consensus: Consent Disclosure Content Unspecified (Privacy RG-1, DX gap, Marketing M-R2)

Three reviewers flagged that the spec defines a consent mechanism but not the required content of the disclosure text. Privacy requires GDPR-compliant elements (installationId, endpoint URL, retention period, deletion path). DX wants the verbatim copy in the spec to prevent implementation guessing. Marketing provided recommended copy including a "What's never collected" block. All three agree this is a pre-Phase-1-ship requirement.

### Single-Reviewer Issues (Not Consensus, But Noted)

| Issue | Reviewer | Severity | Action |
|-------|----------|----------|--------|
| Numeric field amplification — no upper bounds on count fields | Adversarial R1-2a | Medium (5/10) | Add server-side ceiling (~10k per 6h window) |
| Slug namespace pollution — no format validation on slug strings | Adversarial R1-2b | Medium (4/10) | Add regex validation: `^[a-z][a-z0-9-]{0,63}$` |
| Dual-write atomicity undefined | Scalability NEW-2, Adversarial NEW-2, Architecture Concern (implied) | Medium | Document eventual consistency explicitly; note aggregates may undercount |
| DELETE scope ambiguity — aggregate DOs not mentioned | Scalability NEW-3 | Low | Add one line: aggregate DOs not retroactively corrected on deletion |
| windowStart/windowEnd validation bounds incomplete | Architecture Finding 5 | Low | Add: windowStart < windowEnd, max duration ≤ 24h, within 30-day window |
| Startup behavior (overdue submissions) still an Open Question | DX, R1 Gap | Low | Close Open Question #5: submit current window only, no backfill |
| HTTP status codes not mapped to error response types | DX | Low | Map rate_limited→429, others to specific 400-class codes |
| Consent file bypass via direct config.json write | Adversarial NEW-3 | Medium (6/10) | Consider separate consent sentinel file created only by CLI |
| `instar telemetry disable` irreversibility not surfaced in CLI | DX | Low | Add warning: re-enable creates new identity, prior history lost |
| Open Question #6 (feature name) not formally closed | Marketing M-R1, Business | Low | Close before launch; "Baseline" is the de facto decision |
| Minimum population threshold for Phase 2 (Open Question #1) | Business | Medium | Set concrete milestone (e.g., 25 agents × 30 days) before Phase 2 begins |

---

## Remaining Conditionals

What specifically needs to happen for each CONDITIONAL to become APPROVE:

**Security (8/10 → APPROVE)**
1. Define canonical HMAC message format with explicit delimiters in the spec (blocking — must precede `TelemetryAuth.ts`)
2. Specify secret file path, encoding, key length, and `chmod 600` requirement in implementation notes (non-blocking, fix during impl)

**Scalability (8/10 → APPROVE)**
1. Add one-line explicit eventual consistency statement for dual-write: "partial write failures result in acceptable undercount in aggregates"
2. Clarify DELETE scope: aggregate DOs are population counters, not affected by per-installation deletion
3. Clarify key storage file structure (shared with Security)

**Architecture (8.5/10 → APPROVE)**
1. Define canonical HMAC message format (shared with Security)
2. Specify `TelemetryAuth.ts` secret file path, format, key length, permissions
3. Define deletion retry strategy for offline DELETE failure
4. Clarify whether `POST /telemetry/enable` and `POST /telemetry/disable` exist as server endpoints (required for dashboard toggle to share logic with CLI)
5. Add windowStart/windowEnd validation bounds to server-side validation list

**Privacy (8.5/10 → APPROVE)**
1. Define recovery path when HMAC secret is lost so erasure is never permanently blocked (NC-1)
2. Add explicit consent disclosure content requirements to the spec listing GDPR-required elements (RG-1)

**Adversarial (CONDITIONAL → APPROVE)**
1. Add server-side key fingerprint binding for DELETE endpoint (NEW-1, 7/10 — highest priority new finding)
2. Specify `chmod 600` on telemetry directory (R1-1a, 6/10)
3. Add server-side upper bounds on numeric count fields (R1-2a, 5/10)
4. Add slug format validation regex on server (R1-2b, 4/10)

**DX (8/10 → APPROVE)**
1. Define HTTP status codes for all six error response types
2. Explicitly state auth requirements on all three telemetry server endpoints
3. Add verbatim consent disclosure copy to spec
4. Define behavior when remote DELETE fails at disable time
5. Move startup behavior (no backfill) from Open Questions to spec body
6. Add last-error-code to `instar telemetry status` output

**Business**: Already APPROVE. Three low-priority items before launch (consent copy text, close Open Question #6 on naming, close Open Question #1 on minimum population threshold).

**Marketing**: Already APPROVE. Three cosmetic items (close naming question, surface "never collected" list in consent copy, tie "Baseline" and `instar telemetry` CLI namespaces together in help text).

---

## Conflicts (if any)

No new conflicts between reviewers in Round 2. The Round 1 tensions were all resolved by the revisions (HMAC signing resolved the DX vs. Security auth tension; random UUID resolved the stability vs. privacy tension; whitelist resolved the feature flags tension).

The only mild framing divergence: Privacy's NC-1 recommends allowing **unsigned** DELETE requests to protect the erasure right, while Adversarial's NEW-1 recommends storing a server-side key fingerprint to **prevent** unauthorized deletion. These are compatible: a key fingerprint stored at first submission strengthens authenticated deletion while a fallback unsigned path preserves the erasure right when the secret is lost. Both can coexist. The spec should address both concerns in a single "Deletion Authentication" section.

---

## Recommendations (Prioritized — Round 2 Only)

Items Round 1 fixed are excluded. These are new.

### Must Fix Before `TelemetryAuth.ts` / Worker Are Written

| # | Recommendation | Reviewers | Effort |
|---|---------------|-----------|--------|
| R2-1 | Define canonical HMAC message format with explicit delimiters (e.g., `id:timestamp:payloadHash`). Must be identical in Worker and `TelemetryAuth.ts` — this is load-bearing. | Security, Architecture, Adversarial | Trivial (one sentence in spec) |
| R2-2 | Specify `localSecret` file path (`{stateDir}/telemetry/local-secret`), encoding (hex, min 32 bytes), and Unix permissions (`chmod 600`) in implementation notes | Security, Architecture, Adversarial, Scalability | Low |
| R2-3 | Address DELETE authentication gap: store `SHA-256(installationId + localSecret)` as key fingerprint in per-installation DO at first submission; validate DELETE against it. Add fallback for secret-loss: unsigned DELETE accepted after installationId validation. | Adversarial, Privacy, Architecture | Medium |

### Must Fix Before Phase 1 Ships

| # | Recommendation | Reviewers | Effort |
|---|---------------|-----------|--------|
| R2-4 | Add consent disclosure content requirements: spec must list required elements (installationId, endpoint URL, retention period, deletion path). Marketing provided verbatim copy template — use it. | Privacy, DX, Marketing | Low |
| R2-5 | Add server-side count field upper bounds: reject numeric count fields exceeding ~10,000 per 6-hour window | Adversarial | Low |
| R2-6 | Add slug format validation: `^[a-z][a-z0-9-]{0,63}$` — reject non-conforming slugs with HTTP 400 | Adversarial | Low |
| R2-7 | Document explicit eventual consistency stance for dual-write: "partial write failures result in acceptable undercount in aggregates" | Scalability, Architecture | Trivial |
| R2-8 | Define DELETE scope: "The purge covers the per-installation DO only. Per-slug aggregate DOs are population-level counters and are not affected by deletion requests." | Scalability | Trivial |
| R2-9 | Define deletion retry strategy for offline DELETE failure: pending-deletion state file, retry on next startup | Architecture, Privacy, DX | Low |
| R2-10 | Define HTTP status codes for all six error types (`rate_limited`→429, etc.) | DX | Trivial |
| R2-11 | Explicitly state auth requirements on `GET /telemetry/status`, `/telemetry/submissions`, `/telemetry/submissions/latest` | DX | Trivial |
| R2-12 | Add `POST /telemetry/enable` and `POST /telemetry/disable` server endpoints — CLI and dashboard should call these rather than managing files directly | Architecture | Low |
| R2-13 | Move startup behavior from Open Questions to spec body: "Submit current window only on startup; no backfill." Close Open Question #5. | DX | Trivial |
| R2-14 | Add windowStart/windowEnd server-side validation bounds: `windowStart < windowEnd`, max duration ≤ 24h, `windowStart` within 30-day retention window | Architecture | Low |

### Before Phase 1 Launch (Not Blocking Implementation)

| # | Recommendation | Reviewers | Effort |
|---|---------------|-----------|--------|
| R2-15 | Close Open Question #6 — formally adopt "Baseline" as user-facing name; remove the open question entry | Business, Marketing | Trivial |
| R2-16 | Add last-error-code field to `instar telemetry status` output (for clock-skew and signature failure visibility) | DX | Low |
| R2-17 | Add CLI warning on `disable`: "Re-enabling will create a new identity. Prior submission history is not recoverable." | DX | Trivial |
| R2-18 | Tie CLI help text: `instar telemetry enable` should lead with "Enable Baseline — see how your agent compares to the population" | Marketing | Trivial |
| R2-19 | Surface "Never collected" list in CLI consent disclosure, not just in Privacy Architecture section | Marketing, Privacy | Trivial |

### Before Phase 2 Design

| # | Recommendation | Reviewers | Effort |
|---|---------------|-----------|--------|
| R2-20 | Close Open Question #1 — set minimum population milestone for Phase 2 activation (recommended: 25 agents × 30 days of submissions) | Business | Trivial |
| R2-21 | Document whether Phase 2 requires true population p95 or whether weighted mean from `meanMs + count` is sufficient; this affects Phase 1 data sufficiency | Architecture | Low |
| R2-22 | Define per-slug DO write throughput ceiling and sharding trigger (~200 agents) | Architecture, Scalability | Low |
| R2-23 | Apply k-anonymity floor to feature flag distribution queries in Phase 2, not just job metric queries | Adversarial | Low |

---

## Convergence Status

| Reviewer | R1 Verdict | R2 Verdict | Movement |
|----------|-----------|-----------|----------|
| Security | CONDITIONAL | CONDITIONAL APPROVE | +2 pts |
| Scalability | CONDITIONAL | CONDITIONAL APPROVE | +1 pt |
| Business | APPROVE | APPROVE | Stable (improved) |
| Architecture | CONDITIONAL | CONDITIONAL APPROVE | +1.5 pts |
| Privacy | CONDITIONAL | CONDITIONAL APPROVE | +2.5 pts |
| Adversarial | CONDITIONAL | CONDITIONAL | Improved, new issues found |
| DX | CONDITIONAL | CONDITIONAL APPROVE | +2.5 pts |
| Marketing | CONDITIONAL | APPROVE | +3 pts |

**Round 1 tally**: 1 Approve / 7 Conditional / 0 Block (Phase 1) / 1 Block (Phase 4)
**Round 2 tally**: 2 Approve / 6 Conditional / 0 Block (Phase 1) / Phase 4 remains Blocked

The spec moved from NEEDS WORK to CONDITIONAL APPROVE in one revision cycle. The distance to READY is now a small set of spec additions (canonical HMAC format, secret storage spec, DELETE authentication fix, consent disclosure content) rather than architectural redesign. No reviewer identified a fundamental flaw. The blocking items from every prior reviewer have been addressed.

Phase 4 remains correctly blocked. No action required there.

---

## Next Steps

**What's left before the spec is ready for implementation:**

1. **One focused spec update pass** addressing R2-1 through R2-14. Estimated effort: 2–4 hours. These are additions to existing sections, not redesigns.

   Priority order:
   - R2-1 (HMAC canonical form) — must go first; everything else depends on it
   - R2-3 (DELETE key binding + secret-loss fallback) — highest adversarial risk remaining
   - R2-2 (secret storage spec) — required before `TelemetryAuth.ts`
   - R2-4 (consent disclosure content) — required before consent surface is built
   - R2-5, R2-6 (field bounds + slug validation) — Worker-side, add to validation spec
   - R2-7 through R2-14 — editorial, can be done in one pass

2. **Optional Round 3 sign-off** — Given the remaining issues are all additions rather than design changes, a formal Round 3 is optional. Security, Privacy, and Adversarial are the three reviewers with open conditionals that are substantive rather than editorial. Consider a targeted re-review of only those three reviewers against the revised spec, rather than a full 8-reviewer round.

3. **Phase 1 implementation can begin** on the core collection, signing, and submission pipeline (`TelemetryCollector.ts`, `TelemetryAuth.ts`, Worker) once R2-1 and R2-2 are resolved. The consent surface and CLI commands can follow in parallel since they depend on the `POST /telemetry/enable` server endpoint design (R2-12), which can be specced quickly.

4. **Do not start Phase 2 design** until Open Question #1 is closed (R2-20) and the p95 data sufficiency question is answered (R2-21).
