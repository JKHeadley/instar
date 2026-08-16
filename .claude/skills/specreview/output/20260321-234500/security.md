# Security Review: Cross-Agent Telemetry (Round 2)

**Review ID**: 20260321-234500
**Date**: 2026-03-21
**Round**: 2 (Post-Revision Verification)
**Reviewer**: Security
**Spec**: specs/cross-agent-telemetry.md
**Prior Synthesis**: .claude/skills/specreview/output/20260321-232336/synthesis.md

---

## Approval Status

**CONDITIONAL APPROVE** — Phase 1 is ready to implement with one remaining concern (see NEW-1 below). All four Round 1 findings have been adequately addressed. One new issue has been identified in the HMAC implementation details that requires a minor clarification before the Worker is built.

---

## Round 1 Fix Verification

### ISSUE-1 (HIGH): SHA-256 Installation ID Is Reversible
**Fix claimed**: Replaced with cryptographically random UUID.

**Verdict: ADEQUATE.**

The spec now states the installation ID is "a cryptographically random UUID generated at first opt-in and stored locally at `{stateDir}/telemetry/install-id`" and explicitly calls out why the old approach was broken: "An adversary can enumerate likely inputs and reverse the hash. A random UUID has no relationship to the machine, making it truly anonymous." The fix is correct by design — a random UUID has no input space to enumerate, no relationship to machine properties, and stability comes from the stored file rather than deterministic derivation. The addition of user-regeneration ("deleting the file generates a new one") and remote deletion on opt-out completes the lifecycle management.

One minor note: the spec correctly states the UUID is "never derived from machine properties" but does not specify the generation method. Implementation must use a cryptographically secure random source (e.g., `crypto.randomUUID()` in Node.js, not `Math.random()`). This should be noted in the implementation file `TelemetryAuth.ts`.

### ISSUE-2 (HIGH): No Authentication on Telemetry Endpoint
**Fix claimed**: HMAC request signing added.

**Verdict: ADEQUATE WITH ONE NEW CONCERN (see NEW-1).**

The spec now specifies HMAC-SHA256 signing with a locally-stored per-install secret, timestamp window validation (±5 minutes), and three-part Worker validation (signature, timestamp, installationId binding). This addresses the original data poisoning and Sybil attack vectors. The design correctly avoids server-side key management — secrets are local to each agent and never transmitted. The ±5 minute replay window is appropriate and standard for this pattern.

The error response envelope now includes `"signature_invalid"` and `"timestamp_expired"` codes, which closes the gap identified in P0-9.

The new concern is in the HMAC construction details — see NEW-1.

### ISSUE-3 (CRITICAL): Evolution Crowdsourcing Is a Fleet-Wide Compromise Vector
**Fix claimed**: Phase 4 formally blocked.

**Verdict: ADEQUATE.**

Phase 4 now carries an explicit `STATUS: BLOCKED` notice with four named prerequisites: (1) dedicated threat model, (2) content signing architecture with agent-side verification, (3) kill-switch mechanism, (4) separate consent tier. This is a complete and well-formed block — it does not merely defer the problem but specifies the exact conditions required before Phase 4 design can proceed. The kill-switch requirement in particular is a meaningful addition that was not in the original block recommendation. No further action needed on this issue for Phase 1.

### ISSUE-4 (MEDIUM): Feature Flags Reveal Security Posture
**Fix claimed**: Curated whitelist implemented; security flags excluded.

**Verdict: ADEQUATE.**

The spec now specifies: "Only usage/adoption flags are collected (e.g., `threadline`, `telemetry`, `evolution`, `playbook`). Security-posture flags (e.g., `coherenceGate`, `sentinel`, `operationGate`) are explicitly excluded — they would reveal defensive configuration to anyone who compromises the endpoint." The spec also adds the excluded flags to the "Never collected (any phase)" section in the Privacy Architecture. The whitelist approach with explicit exclusion of named security flags is the correct fix. The rationale is stated in the spec itself, which means it will survive code review and will not be silently reversed by a future contributor who does not understand the intent.

---

## New Issues

### NEW-1 (MEDIUM): HMAC Construction Has an Ambiguous Binding

**Description:**

The HMAC construction is specified as:

```
HMAC-SHA256(installationId + timestamp + SHA256(payload), localSecret)
```

This is almost correct but has a potential canonicalization vulnerability. The inputs `installationId`, `timestamp`, and `SHA256(payload)` are being concatenated as strings before being passed to HMAC. If these components are concatenated without delimiters or length-prefixing, a length-extension or component-boundary attack is possible in theory, though the practical risk here is low because SHA256(payload) is fixed-length.

More concretely: the spec does not define how `installationId + timestamp` are combined. If a naive string concatenation is used:
- `installationId = "abc"`, `timestamp = "123payload_hash"` is indistinguishable from `installationId = "abc123"`, `timestamp = "payload_hash"` before the fixed-length SHA256 component.

Since installationId is a UUID (fixed 36-char format) and timestamp is a Unix epoch integer (variable length, currently 10 digits), the collision space is narrow but nonzero in edge cases.

**Recommended fix:** Define the canonical message format explicitly in the spec, e.g.:

```
message = installationId + ":" + timestamp + ":" + SHA256(payload_hex)
HMAC-SHA256(message, localSecret)
```

Using `:` as a delimiter with the documented field order eliminates the ambiguity and ensures the Worker and client implementations agree without coordination errors.

This must be fixed in the spec before `TelemetryAuth.ts` is written, or the Worker and client may implement incompatible signing schemes.

### NEW-2 (LOW): DELETE Endpoint Uses installationId in URL Path — Unauthenticated Enumeration Risk

**Description:**

The deletion endpoint is specified as:

```
DELETE /v1/telemetry/{installationId}
```

The spec states this request is "HMAC-signed," which means deletion requires knowing the localSecret — good. However, the installation ID itself is a UUID that appears in the request URL (logged by Cloudflare, potentially observable in access logs).

Since the DELETE request is HMAC-authenticated using the localSecret, an attacker who does not have the secret cannot successfully delete another user's data. The HMAC prevents unauthorized deletion. This is not a critical vulnerability — the authentication gate is in place.

The residual risk is informational: a valid installationId seen in transit (e.g., via network interception) could theoretically be used to probe the `/v1/telemetry/{installationId}` endpoint for existence. However, without the matching HMAC secret, an attacker can only confirm whether an ID exists — they cannot read or modify the data. This is acceptable given the anonymity guarantees of the system (no PII is stored under the ID).

**Recommendation:** No change required for Phase 1. If the Worker logs request URLs, ensure those logs are restricted to Echo-only access. This is an operational concern, not a design flaw.

### NEW-3 (LOW): Local Secret Storage Location Not Specified

**Description:**

The spec introduces a `localSecret` that is "a randomly generated key stored alongside the install-id." The install-id is stored at `{stateDir}/telemetry/install-id`. The spec does not specify:
1. Where exactly the secret is stored (implied: `{stateDir}/telemetry/secret` or similar)
2. What file permissions are set on it
3. Whether it is included in the local transparency log

The secret is the only credential that can submit data on behalf of an installationId. If it is stored with world-readable permissions (e.g., mode 644) in a shared environment, or accidentally included in a backup or state export that the user shares, it could allow data poisoning for that specific installation.

**Recommendation:** `TelemetryAuth.ts` should create the secret file with mode 600 (owner-read-only). The secret should explicitly appear in the "Never collected" section of the privacy architecture. The transparency log spec should clarify that the secret is never written to `submissions.jsonl`.

---

## Adequacy of Other Round 1 P0 Items (From Synthesis)

These were P0 issues identified by other reviewers in Round 1. Verified as addressed:

| P0 Item | Status in Revised Spec |
|---------|----------------------|
| P0-3: IP-level rate limiting | Present — "max 10 submissions per IP per hour" + per-installationId rate limit (max 1/5h) |
| P0-4: Skip reason enum validation | Present — "Server validates skip reasons against this enum and rejects unknown values with HTTP 400" |
| P0-5: Replace p50/p95 with meanMs+count | Present — spec uses `meanMs, count` throughout |
| P0-6: Full payload in transparency log | Present — "full outgoing payload" with rationale |
| P0-7: Consent surface defined | Present — hard dependency on Topic 1895 with minimal fallback CLI path; structural constraint on config key |
| P0-8: Deletion/Right to Erasure | Present — DELETE endpoint specified with 24h purge SLA |
| P0-9: Error response envelope | Present — 6 error codes enumerated |

All P1 session metric items are addressed: `sessionsBucket` is now a coarse enum (`"0"`, `"1-5"`, `"6-20"`, `"20+"`), and exact session counts/durations are absent from the schema.

---

## Remaining Security Posture Assessment

### Threat Model Coverage (Phase 1)

| Threat | Mitigation in Spec | Adequacy |
|--------|-------------------|----------|
| Data poisoning (fake metrics) | HMAC signing with per-install secret | Adequate |
| Replay attack | ±5 minute timestamp window | Adequate |
| Sybil attack (many fake IDs) | IP rate limiting + per-ID rate limiting + new-ID weighting in Phase 3 | Adequate for Phase 1 |
| Installation ID reversal | Random UUID, not derived | Adequate |
| PII exfiltration | No-content-by-design + explicit exclusion list | Adequate |
| Security posture exposure via feature flags | Explicit whitelist with named exclusions | Adequate |
| Unauthorized opt-in | Config key human-gated; agent API cannot set it | Adequate |
| Fleet-wide behavioral update abuse | Phase 4 blocked with prerequisites | Adequate |
| Unauthorized data deletion | DELETE is HMAC-authenticated | Adequate |
| HMAC key compromise | Secret is per-installation (blast radius = 1 agent) | Adequate |

### What Phase 1 Cannot Protect Against

The following are known limitations that are acceptable at this scale and explicitly acknowledged:

1. **Agent reporting false metrics about itself**: An agent can lie in its own submission (e.g., report 0 errors when errors exist). This is a data quality concern, not a security vulnerability — the data is for population-level design decisions, not enforcement.

2. **IP-level identity correlation**: The Worker discards origin IPs per the privacy spec, but Cloudflare infrastructure logs may retain them for a short window. This is Cloudflare's data handling, outside the spec's control.

3. **Timing correlation**: Submission every 6 hours is a behavioral signal. An observer with access to network traffic can correlate submission timing with agent activity. Acceptable for Phase 1 given opt-in default.

---

## Score

**Round 1 score**: 6/10 (CONDITIONAL)
**Round 2 score**: 8/10 (CONDITIONAL APPROVE)

The two-point improvement reflects: HMAC signing eliminates the data poisoning surface; random UUID eliminates the reversible-ID risk; Phase 4 block is well-formed; feature flag whitelist is correctly specified. The remaining gap from a full score reflects the HMAC construction ambiguity (NEW-1), which must be resolved before implementation begins.

---

## Required Actions Before Phase 1 Implementation

### Blocking (must fix before TelemetryAuth.ts is written)

- [ ] **NEW-1**: Define canonical HMAC message format with explicit delimiters in the spec. Specify whether fields are concatenated with separators and document the exact byte encoding. This must be agreed before Worker and client are built separately.

### Non-blocking (fix during implementation)

- [ ] **NEW-3**: Specify secret file permissions (mode 600) in `TelemetryAuth.ts` implementation notes. Add secret to "Never collected" list in privacy architecture.
- [ ] **ISSUE-1 note**: Specify `crypto.randomUUID()` (or equivalent CSPRNG) in `TelemetryAuth.ts`, not `Math.random()`-based generation.

### Not required for Phase 1

- [ ] **NEW-2**: Monitor Cloudflare access log access controls at deployment time. No spec change needed.

---

## Summary

The Round 1 revisions were thorough and correctly targeted. All four flagged issues have been addressed with appropriate depth — not just patched but explained, with rationale that will survive future contributors. The HMAC design is structurally sound; it only needs a one-sentence canonicalization clarification before implementation.

Phase 1 is ready to build once NEW-1 is resolved. Phase 4 has an appropriate and well-formed block. The spec has matured from a 6/10 "needs work" to an 8/10 "conditional approve" in a single revision cycle.
