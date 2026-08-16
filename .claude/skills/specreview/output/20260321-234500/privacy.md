# Privacy & Ethics Review: Cross-Agent Telemetry (Round 2)

**Review ID**: 20260321-234500
**Date**: 2026-03-21
**Round**: 2 (Post-Revision Verification)
**Reviewer**: Privacy & Ethics Specialist
**Spec**: specs/cross-agent-telemetry.md (DRAFT, post-review revision)
**Prior Review**: specreview/output/20260321-232336/synthesis.md

---

## Round 2 Summary

**Status**: CONDITIONAL APPROVE
**Privacy Score**: 8.5 / 10 (up from 6/10 in Round 1)

The revision addressed all six Round 1 critical findings with substantive fixes, not cosmetic acknowledgments. The core privacy architecture is now sound. Two new concerns introduced by the fixes require attention before Phase 1 ships. One residual gap from Round 1 was not fully addressed.

---

## Fix Verification: Round 1 Critical Findings

### Finding 1: Consent Model Unspecified
**Round 1 finding**: No consent mechanism described. Telemetry could theoretically be enabled by agent API calls. No human-gated path existed.

**Fix claimed**: Human-gated consent, CLI fallback, structural constraint.

**Verification**: VERIFIED — STRONG FIX.

The revised spec adds a structural constraint (not just a policy) on lines 19 and 167–172. The `monitoring.telemetry.enabled` key is explicitly blocked from being set by agent API calls, dispatch system, or evolution proposals. The list of permitted paths is narrow and correct: CLI command, dashboard toggle, or direct config file editing.

The minimal consent fallback (`instar telemetry enable` with disclosure + confirmation) is defined on lines 165–166. The hard dependency on Topic 1895 is acknowledged with a named fallback, not a vague deferral.

One gap remains: the spec does not define what the disclosure text must contain. "Clear disclosure of what is collected" is intention without specification. A subsequent implementation could satisfy this with inadequate disclosure (e.g., "Metrics about your agent's jobs will be collected"). The consent surface must explicitly name the installationId, the remote endpoint, and the retention period. This is not a blocker but should be captured in the implementation spec.

---

### Finding 2: No Erasure Mechanism
**Round 1 finding**: No Right to Erasure. GDPR noncompliant for any EU user.

**Fix claimed**: DELETE endpoint + local cleanup on `instar telemetry disable`.

**Verification**: VERIFIED — ADEQUATE, with one new concern noted below.

The spec now defines a complete erasure path on lines 176–179:
- Local: `instar telemetry disable` deletes install-id file and clears local log
- Remote: `DELETE /v1/telemetry/{installationId}` (HMAC-signed), Worker purges within 24 hours

The 24-hour purge window is appropriate (GDPR Article 17 does not mandate instant deletion; "without undue delay" is the standard, and 24 hours is clearly compliant).

**New concern introduced by this fix** (see "New Concerns" section): The deletion endpoint uses the same HMAC signing as submission. This creates a dependency: if the local secret is lost or corrupted before the user disables telemetry, they cannot send a valid signed deletion request. The spec provides no recovery path for this case. This is a real gap — see NC-1.

---

### Finding 3: Phase 4 Consent Gap
**Round 1 finding**: Phase 1 consent does not cover Phase 4 Evolution Crowdsourcing, which creates a fleet-wide behavioral update channel.

**Fix claimed**: Phase 4 blocked, separate consent tier noted.

**Verification**: VERIFIED — STRONG FIX.

Phase 4 now carries an explicit BLOCKED status with four named prerequisites (lines 281–285):
1. Dedicated threat model
2. Content signing architecture
3. Kill-switch mechanism
4. Separate consent tier

The separate consent tier requirement is explicit: "Phase 1 consent does not cover this." This is exactly what Round 1 required. The BLOCKED status prevents implementation from proceeding before these prerequisites are met.

No weakening or hedging is present. The block is clean.

---

### Finding 4: SHA-256 ID Reversible
**Round 1 finding**: `SHA-256(machineId + projectDir)` is reversible due to small input space. Preimage attacks are practical.

**Fix claimed**: Random UUID stored locally.

**Verification**: VERIFIED — STRONG FIX.

Lines 78–85 fully address this. The install-id is now:
- Cryptographically random UUID
- Generated at first opt-in
- Stored at `{stateDir}/telemetry/install-id`
- Never derived from machine properties
- User-regenerable (delete file to get new UUID)

The spec includes explicit reasoning for why SHA-256 was rejected (lines 85–86), which indicates this was a considered fix rather than a mechanical substitution. The reasoning correctly identifies that predictable input space makes enumeration attacks feasible.

The longitudinal stability concern from Round 1 (Tension 2 in synthesis) is cleanly resolved: stability comes from the stored file, not from deterministic derivation. This is the right tradeoff.

---

### Finding 5: Session Metrics as Quasi-Identifiers
**Round 1 finding**: `sessionsLast24h` and `avgDurationMin` reveal work intensity, timezone, and schedule — behavioral fingerprints, not structural data.

**Fix claimed**: Bucketed ranges.

**Verification**: VERIFIED — FIX APPLIED, ONE RESIDUAL CONCERN.

The spec now uses `sessionsBucket` with values `"0"`, `"1-5"`, `"6-20"`, `"20+"` (line 56). The explicit rationale is provided on lines 61–63: "Exact session counts and durations are behavioral fingerprints that reveal work patterns and timezone. Coarse buckets preserve the segmentation value without the fingerprinting risk."

`avgDurationMin` has been removed entirely, not bucketed — this is correct and good (the field was the higher-risk one). The bucket design for session count is appropriate.

**Residual concern**: The `uptimeHours` field (line 53) was not in scope for Round 1 but deserves scrutiny now. Raw uptime hours reveal behavioral patterns comparable to what `avgDurationMin` revealed — specifically, agents with high continuous uptimes (e.g., 600+ hours) are distinguishable from those with work-hour patterns (8-12h uptimes between restarts). If an adversary can correlate `uptimeHours` against known infrastructure (always-on server agents vs. laptop agents), this is a weak additional quasi-identifier. This is not a blocker — the correlation is weaker than session metrics — but it should be noted as a future candidate for bucketing if population size remains small.

---

### Finding 6: No Retention Enforcement
**Round 1 finding**: No enforcement mechanism for data retention. 30-day TTL was mentioned but not mechanically enforced.

**Fix claimed**: 30-day rolling with scheduled cleanup.

**Verification**: VERIFIED — BOTH SIDES ADDRESSED.

Local retention: "On each write, entries older than 30 days are truncated (same pattern as SkipLedger)" (line 157). Write-time truncation is the right implementation pattern — it does not require a separate cleanup job and maintains the invariant continuously.

Remote retention: "30-day rolling retention, enforced by scheduled Worker cleanup" (line 222). The scheduled Worker cleanup is specified. The spec also states the opt-out purge contract: "remote data purged within 24 hours" (line 314).

The dual specification (local + remote, each with its own mechanism) is correct. No gap remains here.

---

## New Privacy Concerns Introduced by Fixes

### NC-1: HMAC Secret — Loss or Corruption Makes Erasure Impossible

**Severity**: Medium — Must fix before Phase 1 ships
**Classification**: New concern from HMAC addition

The HMAC signing architecture stores a `localSecret` alongside the install-id (line 108). Deletion requests are HMAC-signed (line 178). This creates a dependency chain: a valid deletion request requires the local secret. If the user:
- Loses the secret file (disk failure, migration without state)
- Has the secret corrupted
- Manually deletes the secret file thinking it is safe to do so

...they cannot send a valid signed `DELETE /v1/telemetry/{installationId}` request. Their remote data becomes permanently retained without recourse, which directly violates the erasure right the spec claims to provide.

The spec provides no recovery path.

**Required fix**: One of the following:
1. Allow unsigned deletion requests that include the raw installationId. The secret's purpose is preventing data poisoning, not preventing deletion. An attacker who knows an installationId can already identify and suppress a submission, not read data. An unsigned DELETE with the UUID accomplishes erasure without enabling spoofing.
2. Store installationId and secret in a single file managed atomically — they cannot be separated at the filesystem level.
3. Define a fallback: if local secret is missing, the server accepts deletion based on installationId alone after a short delay (e.g., 48h, to allow for rate-limiting of replay attempts).

Option 1 is simplest and architecturally sound.

---

### NC-2: Full Payload in Local Log — Persistence in Backups After Opt-Out

**Severity**: Low-Medium — Document as known limitation
**Classification**: New concern from transparency log addition

The spec states that `instar telemetry disable` "deletes the install-id file and clears the local log" (line 177). The local log at `{stateDir}/telemetry/submissions.jsonl` contains the full outgoing payload of every submission.

The concern is not the log's existence during active telemetry — that is the transparency design working correctly. The concern is:
1. The log file may be included in agent state backups (instar has a backup/snapshot system). If a user opts out and expects their telemetry history to be gone, backup restoration could re-introduce the log.
2. The log contains the full payload including `installationId` (lines 98–106). After opt-out, the installationId in backup copies is a linkability token that persists.

**Recommended fix**: Document explicitly that:
- `instar telemetry disable` deletes the submissions log as stated
- Backup snapshots taken while telemetry was active will contain the log at that point in time — this is a known side-effect and not a defect, but should be disclosed to users
- When a backup is restored, the submissions log in the backup is historical and the restored agent must not re-submit those payloads

This does not require a change to the erasure flow, but the backup interaction should be called out as a known limitation in the Privacy Architecture section.

---

### NC-3: Deletion Not Verifiable by User

**Severity**: Low — Recommended fix
**Classification**: New concern from erasure mechanism

The spec states the Worker purges data within 24 hours of receiving a `DELETE /v1/telemetry/{installationId}`. There is no mechanism for the user to verify that deletion occurred.

The deletion response is not specified in the API table (lines 184–190). A 200 OK from the Worker confirms the request was received, not that deletion completed. For users who need to demonstrate compliance (particularly in regulated industries), this is an audit gap.

**Recommended fix**: Add `GET /telemetry/deletion-status/{installationId}` that returns `{"deletionRequested": "2026-03-22T10:00:00Z", "status": "pending" | "completed"}`. This is a low-effort addition that closes the verification gap and provides meaningful audit evidence.

Alternatively, if the Worker purges synchronously rather than asynchronously, change the spec from "within 24 hours" to "synchronously" and return confirmation in the DELETE response body.

---

## Residual Round 1 Gap (Not Fully Addressed)

### RG-1: Consent Disclosure Content Unspecified

**Severity**: Medium — Must specify before Phase 1 ships

The spec defines that the CLI consent flow shows "a clear disclosure of what is collected" but does not specify the required content. This is weaker than the spec implies.

A compliant disclosure under GDPR Articles 13/14 must include at the point of collection:
- What is collected (the spec says this generically)
- The remote endpoint URL (not specified in disclosure surface)
- Retention period (present in Privacy Architecture section but not specified as required disclosure)
- The installationId and its purpose (not specified)
- How to delete data after opt-in (not specified in disclosure)

The current spec delegates disclosure content to implementation, which risks inadequate disclosure without it being detectable in review.

**Recommended fix**: Add a subsection "Consent disclosure requirements" that lists the exact elements required in the enable-flow disclosure text. This is a spec addition, not a design change.

---

## Additional Observation: uptimeHours as Future Quasi-Identifier

Not a current blocker, but flagged for the record. The `uptimeHours` field was not examined in Round 1. At small fleet sizes (under 50 agents), continuous uptime values can distinguish always-on server deployments from laptop-pattern deployments, which is a weak behavioral fingerprint. If the fleet stays small, this field may warrant bucketing in a future revision. No action required before Phase 1 ships.

---

## Overall Privacy Architecture Assessment

The revised spec demonstrates genuine engagement with Round 1 findings, not superficial fixes. The core changes — random UUID, HMAC signing, human-gated structural constraint, bucketed session metrics, full payload logging, explicit erasure path — are each correctly implemented.

The privacy architecture now correctly separates:
- **Structural anonymity**: Nothing linkable to a person (content, names, paths, PII) is collected
- **Longitudinal pseudonymity**: The installationId is a persistent but non-reversible handle, user-regenerable, remote-deletable
- **Transparency**: Full payload logged locally, viewable via CLI and API
- **Consent**: Structurally human-gated, not agent-automatable

The remaining concerns are all addressable without design changes. NC-1 (secret loss blocking erasure) and RG-1 (consent disclosure content) are the two items that must be resolved before Phase 1 ships.

---

## Privacy Verdict

| Item | Round 1 Status | Round 2 Status |
|------|---------------|----------------|
| Consent model unspecified | CRITICAL | RESOLVED |
| No erasure mechanism | CRITICAL | RESOLVED (NC-1 caveat) |
| Phase 4 consent gap | CRITICAL | RESOLVED |
| SHA-256 ID reversible | CRITICAL | RESOLVED |
| Session metrics quasi-identifiers | CRITICAL | RESOLVED |
| No retention enforcement | CRITICAL | RESOLVED |
| NC-1: Secret loss blocks erasure | — | NEW — Must fix before Phase 1 |
| NC-2: Log persists in backups after opt-out | — | NEW — Document as known limitation |
| NC-3: Deletion not verifiable | — | NEW — Recommended fix |
| RG-1: Consent disclosure content unspecified | Implicit in Finding 1 | RESIDUAL — Must specify before Phase 1 |

**Round 2 Verdict**: CONDITIONAL APPROVE

Phase 1 can proceed to implementation subject to two required fixes before shipping:
1. **NC-1**: Define a recovery path when the local HMAC secret is lost, so erasure is never permanently blocked
2. **RG-1**: Add explicit consent disclosure content requirements to the spec

NC-2 and NC-3 are recommended but not blocking for Phase 1.

Phase 4 block is correctly maintained and requires no further action from this review.
