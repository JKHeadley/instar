# Architecture Review: Cross-Agent Telemetry (Round 2)

**Review ID**: 20260321-234500
**Date**: 2026-03-21
**Round**: 2 (post-revision)
**Reviewer**: Systems Architect
**Prior Round**: specreview/output/20260321-232336/synthesis.md
**Spec**: specs/cross-agent-telemetry.md

---

## Summary Verdict

**Status: CONDITIONAL APPROVE**
**Score: 8.5 / 10** (up from 7/10 in Round 1)

The revision is substantive and targeted. All five Round 1 architecture findings are addressed — four convincingly, one with a caveat. Three new architectural concerns emerge from the additions: the HMAC construction has a subtle input ordering ambiguity, the deletion flow has a race condition, and the CLI surface partially duplicates existing server endpoint responsibilities in a way that will complicate routing. None of these are blockers, but two require spec clarification before implementation begins.

---

## Fix Verification: Round 1 Findings

### Finding 1: p50/p95 Statistically Invalid for Fleet Aggregation
**Round 1**: p50/p95 per-agent percentiles cannot be meaningfully aggregated across a fleet; mean-of-percentiles is statistically invalid.
**Fix claimed**: Replaced with `meanMs + count` in the duration metrics row.

**VERIFIED — Fix is correct and complete.**

The spec now reads: `slug, meanMs, count` with an explicit note: "The backend can compute true population percentiles from raw mean+count pairs." The note is architecturally accurate — with mean and count, you can compute a weighted mean across the fleet. True population percentiles (p50, p95) still require the full distribution, but `meanMs + count` is the right primitive to collect when you cannot afford per-agent histograms. The rationale footnote demonstrates the author understands *why* the fix is necessary, not just what to change. This is the correct approach.

**One note for implementation**: If Phase 2 requires true population p95 (not just mean), the backend will need either (a) approximate histograms (HyperLogLog / t-digest) or (b) accepting that only weighted-mean is available from mean+count. The spec does not commit to which. This should be a documented decision before Phase 2 design begins — it affects whether Phase 1 data is sufficient for Phase 2's stated analytical goals.

---

### Finding 2: Phase 1 Data Model Doesn't Support Phase 2
**Round 1**: Per-installation DOs cannot efficiently serve Phase 2 cross-fleet population queries without an O(N) fan-out.
**Fix claimed**: Dual-write aggregation layer — submissions write to both per-installation DOs and per-slug aggregate DOs at ingest time.

**VERIFIED — Fix is architecturally sound for the described scale.**

The relevant spec text:

> "submissions are dual-written at ingest time. Per-installation DOs store the raw submission. Per-slug aggregate DOs maintain running counters (total skips by reason, mean durations, model distribution) updated on each write."

This is the correct pattern. Write-time fan-in to pre-aggregated state eliminates the O(N) read fan-out at query time. Phase 2's `GET /telemetry/population/:slug` can read a single aggregate DO rather than scanning all installation DOs.

**Residual concern — aggregate DO write hotspot at scale.** The Round 1 synthesis flagged this explicitly in the scalability summary: at 500–5,000 agents, the per-slug aggregate DO becomes a write contention point. Each ingest writes to potentially many per-slug DOs simultaneously (one per job slug in the payload). If an agent reports 50 job slugs, that's 50 aggregate DO writes per submission. At 1,000 agents submitting every 6 hours, that's ~8,300 aggregate DO writes per minute during burst recovery.

The spec acknowledges this at the viral scale (5,000+) but classifies the growth scale (500–5,000) as requiring only "jitter + per-slug DO sharding." The fix covers MVP and early growth; sharding strategy needs to be designed before crossing ~200 agents. This is not a new finding — it was in Round 1 — but the spec does not fully resolve it, it defers it.

**Assessment**: The dual-write design is the right architecture for Phase 1 and early Phase 2. The write hotspot concern is a Phase 2 prerequisite, not a Phase 1 blocker. Fix accepted.

---

### Finding 3: Transparency Log Logs Summary Not Payload
**Round 1**: Log entry showed `metricsSubmitted: { jobCount: 23 }` — a summary, not the actual payload. DX called it "nearly useless for actual audit."
**Fix claimed**: Full payload logging.

**VERIFIED — Fix is correct and well-reasoned.**

The spec now defines the log entry as:
```json
{
  "timestamp": "2026-03-22T06:00:00Z",
  "payload": { <the exact JSON body that was sent> },
  "endpoint": "v1/telemetry",
  "responseStatus": 200
}
```

The accompanying rationale is architecturally sound: "A log entry showing `metricsSubmitted: { jobCount: 23 }` is not an audit trail — it doesn't answer 'did anything sensitive go out?'" Logging the full outgoing payload is the correct answer to "what did we actually send?"

**One implementation note**: The payload stored in the log should be the post-serialization bytes (or a canonical JSON form), not a re-serialized object from memory. If the signing step happens before logging, log the bytes that were signed — not a reconstructed object. This ensures the log and the HMAC signature are auditable against the same artifact. This is an implementation detail, not a spec gap, but worth calling out.

---

### Finding 4: Missing Schema Versioning
**Round 1**: No `schemaVersion` field; server cannot reject unsupported clients without it.
**Fix claimed**: `"v": 1` field added to payload.

**VERIFIED — Fix is present and the error response envelope is defined.**

The payload now includes `"v": 1` at the top level. The error response envelope includes `"schema_version_unsupported"` as a named error code. The forward/backward compatibility contract (server accepts unknown fields; client sends `v`; server rejects below minimum supported version) is noted in the Phase 2 pre-decisions section.

**Minor concern**: The field name `v` is very terse. `schemaVersion` or `schema_version` is more legible and self-documenting for anyone reading raw DO storage or logs. This is a low-priority style preference, not an architectural issue — but terse field names compound over time as the schema evolves. Either is acceptable; the spec should declare the choice deliberately.

---

### Finding 5: Missing Window Timestamps
**Round 1**: No `windowStart`/`windowEnd` in the submission payload; backend cannot determine what time period a submission covers.
**Fix claimed**: `windowStart` and `windowEnd` added.

**VERIFIED — Fix is correct.**

The payload now includes:
```
"windowStart": "2026-03-22T00:00:00Z",
"windowEnd": "2026-03-22T06:00:00Z",
```

Both are ISO 8601 UTC. The server-side validation includes "no future timestamps," which provides a basic sanity check on `windowEnd`. The spec does not specify validation of `windowStart` (e.g., must be within 30 days, must be before `windowEnd`, duration must match `submissionIntervalHours`). These should be added to the server-side validation list to prevent malformed windows from polluting aggregate state.

**Recommended additions to server-side validation:**
- `windowStart` must be before `windowEnd`
- Window duration must be ≤ 24 hours (prevents artificially inflated windows)
- `windowStart` must be within the last 30 days (retention alignment)

---

## New Architectural Concerns

### Concern 1: HMAC Construction Has an Input Ambiguity
**Severity: Medium — Spec clarification required before implementation**

The spec defines the HMAC construction as:

> `HMAC-SHA256(installationId + timestamp + SHA256(payload), localSecret)`

The `+` operator is concatenation, but concatenation of variable-length strings without a delimiter creates a canonicalization problem. Consider:
- `installationId = "abc"`, `timestamp = "123xyz"` → concatenated: `"abc123xyz"`
- `installationId = "abc123"`, `timestamp = "xyz"` → concatenated: `"abc123xyz"`

These two different inputs produce the same HMAC input string. An attacker who can influence the installationId (they can't in the current design, but this is a structural weakness) could craft a collision. More practically, a bug in how any client constructs the string leads to subtle, hard-to-debug signature failures.

**Fix**: Use a structured serialization format with length-prefixing or a delimiter that cannot appear in the inputs:
```
HMAC-SHA256(installationId + "." + timestamp + "." + SHA256(payload), localSecret)
```
Or, more robustly, use a canonical JSON object:
```
HMAC-SHA256(JSON.stringify({id: installationId, ts: timestamp, ph: payloadHash}), localSecret)
```
The second form is unambiguous and easy to audit. The Worker and `TelemetryAuth.ts` must use the identical construction or validation will fail silently (signatures will never match). The spec must define the canonical form precisely — this is load-bearing.

---

### Concern 2: Deletion Flow Has a Race Condition
**Severity: Low — Worth documenting but not a blocker**

The deletion flow as specified:

> "Disabling telemetry sends a final `DELETE` request to the Worker: `DELETE /v1/telemetry/{installationId}` (HMAC-signed). The Worker purges all stored data for that installation ID within 24 hours."

The race: if the agent sends a DELETE and then immediately (before the 24-hour purge completes) re-enables telemetry and submits with the same installationId (which it would, since the file wasn't deleted yet — wait, the spec says the local install-id IS deleted on disable), the user generates a new install-id on re-enable. So the race is: DELETE is in-flight, new enable generates a new random UUID, first submission under the new UUID arrives before the DELETE completes. The Worker must not accidentally purge data for the new UUID if it shares any property with the deleted one.

Since the new UUID is cryptographically random and unrelated to the old one, the race is actually safe — the DELETE is scoped to the old installationId and the new submissions use a different UUID. The 24-hour purge window is a Worker cleanup latency, not a gap in the deletion guarantee.

**However**: The spec says the local install-id file is deleted on `instar telemetry disable`. What happens if the DELETE network request fails (agent is offline, Worker is down)? The local state is gone but the remote data is not purged. There is no retry mechanism specified. For GDPR Right to Erasure compliance, the deletion must eventually complete. The spec should define a retry strategy: log the pending deletion, retry on next startup, or provide a `instar telemetry delete-remote` command for manual retry.

---

### Concern 3: CLI Surface / Server Endpoint Responsibility Overlap
**Severity: Low — Design clarity issue**

The CLI and server endpoints overlap in ways that will create routing complexity:

| CLI Command | Server Endpoint | Overlap |
|-------------|-----------------|---------|
| `instar telemetry status` | `GET /telemetry/status` | Same data, two surfaces |
| `instar telemetry enable` | (no direct endpoint — config write) | CLI owns consent gating |
| `instar telemetry disable` | (no direct endpoint — triggers DELETE) | CLI owns side effects |

The status overlap is fine — CLI commands typically call the local server. But the `enable`/`disable` commands have significant side effects (generating install-id, writing local secret, sending DELETE to Worker) that make them more than config toggles. The spec should clarify whether `instar telemetry enable` calls a server endpoint (e.g., `POST /telemetry/enable`) that coordinates the side effects, or whether the CLI directly manages files and calls the Worker. The distinction matters for:

1. **Dashboard toggle**: The spec says the dashboard toggle is a valid consent surface. If the CLI talks directly to files, the dashboard must duplicate that logic. If the CLI calls a server endpoint, the dashboard can use the same endpoint.
2. **Atomicity**: Generating install-id + secret + updating config + first submission should succeed or fail as a unit. Coordinating this through a server endpoint is cleaner than having the CLI manage file writes and API calls directly.

**Recommendation**: Specify `POST /telemetry/enable` and `POST /telemetry/disable` server endpoints that encapsulate the full enable/disable flow. The CLI and dashboard both call these endpoints. This is the standard instar pattern and avoids duplicated state management logic.

---

### Concern 4: TelemetryAuth.ts Secret Storage Unspecified
**Severity: Medium — Security gap**

The spec introduces `TelemetryAuth.ts` as responsible for "install-id generation, secret management, HMAC signing." The secret (`localSecret`) is described as "a randomly generated key stored alongside the install-id." But the spec does not specify:

1. **Where exactly**: "alongside the install-id" implies `{stateDir}/telemetry/local-secret` but this should be explicit.
2. **Format**: Raw bytes? Hex-encoded? Base64? The format must be identical between the writer (TelemetryAuth.ts) and the signer, or HMAC computation will silently produce wrong results.
3. **Permissions**: On Unix, this file should be `chmod 600` (user-readable only). The spec mentions no file permission requirements for any telemetry files. Given this is a cryptographic key, it's not optional.
4. **Key length**: HMAC-SHA256 security is bounded by key length. Less than 32 bytes is suboptimal. The spec should specify minimum key length (32 bytes of random data, encoded as 64 hex chars, is conventional).

These are implementation details that, if inconsistent between developer and spec, produce bugs that are indistinguishable from correct behavior until someone tries to verify a signature externally.

---

### Concern 5: Per-installationId Rate Limiting Window vs. Submission Interval Mismatch
**Severity: Low — Potential operational issue**

The spec states:
- Submission frequency: every 6 hours
- Per-installationId rate limiting: "max 1 submission per 5 hours"

The 5-hour rate limit window is tighter than the 6-hour submission interval. If clock drift, restart jitter, or retry logic causes a submission to arrive at hour 5:58 instead of 6:00, the next submission at hour 11:58 would be 6 hours later (fine). But if the submission at 5:58 is retried at 6:10 due to a transient error, and then the regular submission fires at 11:58, the gap is 5:48 — under 6 hours on the server side, but the rate limiter allows it (5:48 > 5 hours). This is actually fine.

The real risk runs the other direction: a submission arrives at 5:58, then the regular cycle fires at 11:50 (8 minutes early due to timer drift). The gap is 5:52 — under 6 hours. The rate limiter (5-hour window) allows it. So the rate limiter provides no protection against slightly-early submissions. This is benign but means the rate limiter's stated purpose ("reject early resubmissions") is only partially effective against clock drift.

**This is not a blocker** — the rate limiter is a backstop against abuse, not a precision control. But the spec should document that the 5-hour window is intentionally permissive (not accidentally under the 6-hour interval).

---

## Architecture Scorecard

| Area | Round 1 | Round 2 | Change |
|------|---------|---------|--------|
| Metric types (percentiles) | Fail | Pass | Fixed |
| Phase 1 → Phase 2 data model | Fail | Pass (with caveat) | Fixed |
| Transparency log | Fail | Pass | Fixed |
| Schema versioning | Fail | Pass | Fixed |
| Window timestamps | Fail | Pass | Fixed |
| HMAC construction | N/A | Concern (medium) | New |
| Deletion flow robustness | N/A | Concern (low) | New |
| CLI/endpoint responsibility split | N/A | Concern (low) | New |
| TelemetryAuth.ts secret spec | N/A | Concern (medium) | New |
| Rate limit/interval alignment | N/A | Observation (low) | New |

---

## Required Before Implementation Begins

1. **HMAC canonical form** — Spec must define the exact byte sequence that gets signed. Suggest: `HMAC-SHA256(base64url(JSON.stringify({id, ts, ph})), localSecret)`. This must be identical in `TelemetryAuth.ts` and the Worker.

2. **TelemetryAuth.ts secret spec** — Add to implementation section: file path, encoding format, key length (min 32 bytes), Unix permissions (0600).

3. **Deletion retry strategy** — Define behavior when DELETE to Worker fails on disable: store pending deletion in state, retry on next startup, or expose manual retry command.

4. **Server endpoints for enable/disable** — Clarify whether `POST /telemetry/enable` and `POST /telemetry/disable` exist on the local server. Required for dashboard toggle to share logic with CLI.

5. **windowStart/windowEnd validation bounds** — Add to server-side validation list: `windowStart < windowEnd`, max duration ≤ 24h, `windowStart` within 30-day retention window.

---

## Recommended Before Phase 2 Design

6. **p95 availability decision** — Document whether Phase 2 can derive true population percentiles from `meanMs + count`, or whether approximate histograms (t-digest) need to be added to Phase 1 collection. This is a data sufficiency question that affects whether Phase 1 data is analytically complete for Phase 2's stated goals.

7. **Aggregate DO sharding threshold** — Define the agent-count trigger at which per-slug aggregate DOs require sharding. Round 1 synthesis suggests ~200 agents. Defer implementation but document the decision point.

---

## What Held Up Well

- **Random UUID installation ID** — Correctly implemented. The explanation of why SHA-256(machineId+projectDir) is reversible is accurate and demonstrates design understanding.
- **HMAC authentication design** — The approach (per-install secret, timestamp window, installationId binding) is correct. The concern above is about the string canonicalization, not the authentication model.
- **Phase 4 block** — The explicit BLOCK notice with four specific prerequisites is the right posture. The conditions are concrete and testable.
- **Session activity bucketing** — `sessionsBucket` (coarse enum) is the right answer to the fingerprinting concern. The rationale (work pattern + timezone revelation) is correctly stated.
- **Feature flag whitelist** — Explicit exclusion of security-posture flags with a stated reason (reveal defensive configuration to endpoint compromise) is exactly the right level of specificity.
- **Consent architecture** — The structural constraint (config key cannot be set by agent API calls, evolution proposals, or dispatch) is correctly defined. The minimal fallback consent path (`instar telemetry enable` with explicit disclosure) is an adequate gate for Phase 1 if Topic 1895 is delayed.
- **k-anonymity floor** — Present in Phase 2 (suppress metric combinations with k < 5). Correct placement — this is an analysis-time concern, not a collection-time one.

---

## Overall Assessment

This is a well-revised spec. The Round 1 findings were addressed correctly and with evident understanding of the underlying concerns — not just mechanically patched. The dual-write architecture is the right answer to the Phase 1/Phase 2 data model problem. The HMAC authentication model is sound in concept.

The new concerns (HMAC canonicalization, secret storage spec, deletion retry, CLI/endpoint boundary) are all addressable with spec clarifications — none require architectural redesign. The two medium-severity items (HMAC canonical form, secret storage spec) must be resolved before implementation begins because they are load-bearing: inconsistent implementations of either will produce silent failures that are hard to debug post-deployment.

**Ready to proceed to implementation planning after the five required clarifications are incorporated into the spec.**

