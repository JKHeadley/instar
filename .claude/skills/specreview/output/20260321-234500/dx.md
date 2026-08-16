# DX/API Design Review — Cross-Agent Telemetry (Round 2)

**Review ID**: 20260321-234500
**Reviewer**: DX/API Design Specialist
**Round**: 2
**Date**: 2026-03-21
**Prior DX Score (Round 1)**: 5.5/10 — CONDITIONAL (3 blocking issues)
**Spec file**: specs/cross-agent-telemetry.md

---

## Round 1 Blocking Issues — Resolution Verdict

### Block 1: Consent UX dependency with no fallback
**Round 1 finding**: Phase 1 was blocked because it depended entirely on Topic 1895 with no owned fallback. If 1895 slipped, telemetry had no viable launch path.

**Fix claimed**: Hard dependency is now explicitly flagged AND a minimal fallback is defined — `instar telemetry enable` CLI command with inline disclosure and explicit confirmation, writing `monitoring.telemetry.enabled: true` to config.

**Verdict: RESOLVED.**
The fallback is concrete and the structural constraint is well-specified: the config key cannot be set by agent API calls, dispatch, evolution proposals, or any programmatic path. The spec names the exact mechanisms that CAN set it (CLI, dashboard toggle, direct file edit). This is the right shape of constraint — it does not rely on policy ("we won't do this") but on architecture ("these are the only code paths that can write this key").

One minor gap: the spec does not define what the `instar telemetry enable` disclosure text says. For audit purposes, the consent copy should be in the spec, not left to the implementer. This is not a blocker — but it is a P1 gap. Recommended addition: a verbatim copy block showing exactly what the user sees before confirmation.

---

### Block 2: Error response semantics undefined
**Round 1 finding**: No error envelope, no defined error codes. Implementors would invent inconsistent error handling.

**Fix claimed**: Error response envelope defined with six codes: `rate_limited`, `malformed`, `schema_version_unsupported`, `payload_too_large`, `signature_invalid`, `timestamp_expired`.

**Verdict: RESOLVED — and done well.**
The error taxonomy is complete and each code maps to a distinct client-side handling path. `signature_invalid` and `timestamp_expired` are the right granularity for HMAC failures — they are different problems requiring different fixes (bad secret vs. clock skew). `schema_version_unsupported` correctly signals "upgrade your client" rather than conflating with `malformed`. The `accepted: false` envelope is consistent with the success response structure.

One observation: the spec does not define which HTTP status codes map to which errors. `rate_limited` should be 429. `malformed`, `schema_version_unsupported`, `payload_too_large`, `signature_invalid` are all 400-class but presumably different codes. `timestamp_expired` is ambiguous — is it 400 or 401? This is a low-effort clarification that prevents implementor guessing. P1.

---

### Block 3: Transparency log logs summary, not payload
**Round 1 finding**: The log entry showed `metricsSubmitted: { jobCount: 23 }` — a summary that does not answer "did anything sensitive go out?"

**Fix claimed**: Full outgoing payload is now logged with the exact JSON body sent.

**Verdict: RESOLVED — and the rationale is explicit and correct.**
The spec includes the justification inline: "A log entry showing `metricsSubmitted: { jobCount: 23 }` is not an audit trail — it doesn't answer 'did anything sensitive go out?' The full payload lets users verify exactly what was transmitted." This is the right framing, and it is in the spec permanently so future maintainers understand why this choice was made.

The log schema is clean: `timestamp`, `payload`, `endpoint`, `responseStatus`. That is everything needed to reconstruct what happened.

---

## New Additions — DX Evaluation

### CLI Commands: `instar telemetry status/enable/disable`

**Status command** — shows current config, last submission time, next window. This is the right minimal surface. A developer troubleshooting "is this actually running?" gets everything they need in one command without reading config files.

**Enable command** — interactive consent flow, generates install-id and secret. The consent flow is human-interactive by design. The install-id and secret generation happen here, which is the right moment — no install-id exists until human consent is given, so there is no pre-consent artifact.

**Disable command** — disables, deletes local install-id, sends remote deletion. The spec links disable to Right to Erasure: disabling does not just flip a flag — it deletes the local install-id and triggers the remote DELETE. This means "disable" is a meaningful erasure operation, not a pause.

One UX concern: **disable is irreversible in a meaningful way.** If a user disables and then re-enables, they get a new install-id and the remote data for the old install-id is purged. This is the correct privacy behavior, but it is a loss of longitudinal history the user might not expect. The CLI should surface this explicitly: "Re-enabling will create a new identity. Your previous submission history will not be recoverable." Not a blocker, but important for informed consent. P1.

---

### Server Endpoints: `GET /telemetry/status` and `GET /telemetry/submissions/latest`

**`GET /telemetry/status`** returns: `enabled`, `lastSubmission`, `nextWindow`, `installationId` (first 8 chars).

The truncated installationId (first 8 chars) is a good call — it allows correlation without exposing the full ID used in HMAC signatures.

**`GET /telemetry/submissions/latest`** returns the full payload of the most recent submission. This endpoint is essential for the "verify what was sent" use case and complements the local transparency log by making the most recent payload accessible via API without requiring file system access.

Critical gap: **the spec does not state whether these endpoints require authentication.** The local transparency log has no auth concern since it is on-disk. But the server endpoints expose the full submission payload — which, while privacy-preserving by design, still reveals job slugs and execution patterns. Given that the rest of the server API requires auth, these endpoints almost certainly should too. The spec must state this explicitly. P1.

Same auth question applies to `GET /telemetry/status` and `GET /telemetry/submissions`.

---

### HMAC Auth Flow — DX Perspective

The HMAC scheme `HMAC-SHA256(installationId + timestamp + SHA256(payload), localSecret)` is sound from an API design standpoint. The signature covers the payload hash, the timestamp (replay protection), and the installationId (binds signature to identity). The ±5 minute timestamp window is appropriate — tighter creates clock-skew problems, wider reduces replay protection.

**DX concern: clock skew is invisible to the user.** If an agent's system clock is significantly wrong, submissions will fail with `timestamp_expired` and the agent will silently not submit (fire-and-forget). The `instar telemetry status` command should include the last error code if the most recent submission failed. Otherwise users get "last submission: 3 days ago" with no explanation. P1.

The local secret storage location (`{stateDir}/telemetry/` alongside install-id) is correct. Storing them together is appropriate since the secret is only useful with the install-id.

**No registration step is required** — the Worker accepts any correctly-signed submission and treats the installationId as the identity anchor. No server-side key provisioning, no user-facing setup beyond `instar telemetry enable`. Clean.

---

### Deletion UX

The Right to Erasure flow is well-designed:
- Local: install-id and log deleted immediately on `instar telemetry disable`
- Remote: HMAC-signed DELETE request to `DELETE /v1/telemetry/{installationId}`
- Remote purge SLA: within 24 hours

The 24-hour remote purge window is reasonable. The CLI should fire the DELETE, log it locally, and confirm to the user "Deletion request sent. Remote data will be purged within 24 hours." Do not block on Worker response. P1.

Critical gap: **what happens if the remote DELETE fails?** Once the local install-id is deleted, the client no longer has the HMAC secret needed to re-send the deletion request. The spec should define a retry path: either retain the install-id and secret in a "pending deletion" state until the Worker confirms, or explicitly accept that the remote data will expire under the 30-day rolling retention. The latter is acceptable from a practical standpoint — but the spec must acknowledge the failure mode rather than leaving it implicit. P1.

---

## Gaps Not Addressed in Round 2

These were P1 items from Round 1 that appear unaddressed in the revised spec. Not blockers, tracking for completeness:

1. **HTTP status code mapping for error responses** — which error string maps to which HTTP status code?
2. **Auth on server telemetry endpoints** — `GET /telemetry/status`, `/submissions`, `/submissions/latest` should explicitly state auth requirements
3. **Startup behavior for overdue submissions** — the spec notes this in Open Question #5 and proposes "submit current window only, don't backfill." This is the right answer and should be moved from Open Questions to the spec body as a decided behavior.
4. **Consent disclosure copy** — verbatim text shown during `instar telemetry enable` should be in the spec
5. **Last error code in `telemetry status`** — if most recent submission failed, surface why

---

## Score

| Dimension | R1 Score | R2 Score | Delta |
|-----------|----------|----------|-------|
| Consent UX | 2/5 | 5/5 | +3 |
| Error semantics | 1/5 | 4/5 | +3 |
| Transparency log | 2/5 | 5/5 | +3 |
| CLI surface | 0/5 | 4/5 | +4 |
| Server endpoints | 0/5 | 3.5/5 | +3.5 (auth gap) |
| HMAC flow (DX) | n/a | 4/5 | new |
| Deletion UX | 0/5 | 3.5/5 | +3.5 (failure mode gap) |
| Error HTTP codes | 0/5 | 1/5 | +1 (still incomplete) |

**Round 1 overall**: 5.5/10
**Round 2 overall**: 8/10
**Delta**: +2.5

---

## Verdict

**CONDITIONAL APPROVE — Phase 1 is unblocked from a DX perspective.**

All three Round 1 blocking issues are resolved. The CLI surface, server endpoints, HMAC auth flow, and deletion UX are well-designed. The remaining gaps are P1 polish items, not architectural defects. None require spec rework — they are additions, not corrections.

**Required before implementation begins (P1):**

1. Define HTTP status codes for all six error response types
2. Explicitly state auth requirements on all three telemetry server endpoints (`/telemetry/status`, `/telemetry/submissions`, `/telemetry/submissions/latest`)
3. Define the `instar telemetry enable` disclosure copy verbatim in the spec
4. Define behavior when remote DELETE fails at disable time (retain pending-deletion state, or accept 30-day expiry as the fallback)
5. Move startup behavior (no backfill) from Open Questions to spec body as a decided behavior
6. Add last-error-code field to `instar telemetry status` output for clock-skew and signature failure visibility
7. Add CLI warning on disable: re-enabling creates a new identity and prior history is not recoverable
