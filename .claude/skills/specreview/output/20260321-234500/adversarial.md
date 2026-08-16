# Adversarial Review: Cross-Agent Telemetry (Round 2)

**Review ID**: 20260321-234500
**Date**: 2026-03-21
**Round**: 2
**Reviewer**: Red Team / Adversarial
**Spec**: specs/cross-agent-telemetry.md (post-Round-1 revision)

---

## Round 1 Defense Verification

Each claimed fix is assessed: Does the defense actually close the attack vector?

---

### R1-1: Sybil Attack via Unauthenticated Endpoint

**Fix claimed**: HMAC-SHA256 signing + per-install secret + IP-level rate limiting + per-installationId rate limiting (max 1 per 5h).

**Verdict**: PARTIAL — closes the unauthenticated write vector but introduces new exploitable properties.

**Defense analysis**:

The HMAC construction is `HMAC-SHA256(installationId + timestamp + SHA256(payload), localSecret)`. This is correct in structure and closes the "anyone can POST anything" attack. The ±5 minute timestamp window prevents replay attacks. Per-installationId rate limiting (1 submission per 5 hours) prevents burst spamming from a single ID.

**What it doesn't close — new attack 1: Secret bootstrap / storage gap**

The spec says `localSecret` is "generated at first opt-in" and stored alongside the install-id. The exact storage path is unspecified — the spec mentions `{stateDir}/telemetry/install-id` but does not name the secret file separately, and no file permissions are specified. If the telemetry directory is world-readable (the default for many stateDir implementations), any process running as a different user on the same machine can read the secret and forge valid HMAC submissions for that installationId.

**Likelihood**: Medium (requires read access to stateDir; OS-protected but not encrypted; shared systems or backup exfiltration are realistic vectors)
**Impact**: High (can submit arbitrarily poisoned data that appears authenticated for that installation)
**Rating**: 6/10

The spec should require `chmod 600` on `{stateDir}/telemetry/` and document this as a security requirement in the implementation notes.

---

**What it doesn't close — HMAC canonicalization gap**:

The HMAC input is `installationId + timestamp + SHA256(payload)` — string concatenation without delimiters. This is theoretically vulnerable to canonicalization collision, but in practice the UUID format (36 chars with fixed hyphens) and Unix epoch integer format are structurally distinct enough that accidental or deliberate collision is not feasible.

**Likelihood**: Low
**Impact**: Medium
**Rating**: 2/10 — Not a practical attack. Recommend adding explicit delimiters (`\x00` separators) in the implementation as a defensive habit.

---

### R1-2: Metric Poisoning via Enum Bypass

**Fix claimed**: Server-side validation on skip reasons; enum enforced; unknown values rejected with HTTP 400.

**Verdict**: ADEQUATE for the stated field. Does not cover all poisoning surfaces.

**New attack 3: Numeric field amplification via legitimate enum values**

The enum is closed, but the numeric fields accompanying valid enum values are not bounded on the upper end. The spec says "no negative counts" but specifies no ceiling. A single authenticated submission with an astronomically large `count` for a valid skip reason:

```json
{ "slug": "health-check", "reason": "quota", "count": 2147483647 }
```

...would inflate the per-slug aggregate DO's running counter permanently until that submission's 30-day TTL expires. The dual-write aggregation layer maintains "running counters updated on each write." A single signed payload from any opted-in installation is sufficient to corrupt 30 days of population data for a specific job slug.

**Likelihood**: Medium (requires only one legitimate installation with malicious intent — a low bar)
**Impact**: Medium (corrupts aggregate data for specific job slugs; Echo makes design decisions on poisoned population stats for 30 days)
**Rating**: 5/10

**Fix**: Add per-field upper bounds to the server-side validation rules. Reasonable ceiling for `count` per 6-hour window: ~10,000 (a job running every 2 seconds for 6 hours). Reject or clamp values exceeding plausible operational bounds.

---

**New attack 4: Slug namespace pollution**

The `jobs` array entries contain arbitrary `slug` strings. The spec restricts content fields via enum but does not restrict slug format. A malicious submission could include:

```json
{ "slug": "../../admin", ... }
{ "slug": "__proto__", ... }
{ "slug": "a" * 10000, ... }
```

Cloudflare Durable Object keys are arbitrary strings. A crafted slug creates an aggregate DO at an unexpected namespace address, pollutes the slug keyspace, and could disrupt Phase 2 population queries that iterate over per-slug DOs.

**Likelihood**: Low (requires a legitimate opted-in installation)
**Impact**: Medium (orphaned DOs, namespace pollution, disrupted Phase 2 queries)
**Rating**: 4/10

**Fix**: Validate slug format server-side against a strict regex (e.g., `^[a-z][a-z0-9-]{0,63}$`) before writing to any DO. Reject non-conforming slugs with HTTP 400.

---

### R1-3: Installation ID Enumeration

**Fix claimed**: Random UUID with no derivation from machine properties.

**Verdict**: ADEQUATE. The attack is genuinely closed.

A random UUIDv4 has 122 bits of entropy. The preimage attack on the prior `SHA-256(machineId + projectDir)` scheme is closed. No new attack vector against ID generation.

**Residual privacy gap**: Disable → re-enable within 24h leaves both UUID-A (scheduled for deletion) and UUID-B (active) on the backend simultaneously. Not a security issue but a privacy consistency gap worth documenting.

**Likelihood**: Low | **Impact**: Low | **Rating**: 2/10

---

### R1-4: Feature Flag Reconnaissance

**Fix claimed**: Curated whitelist of usage/adoption flags only; security-posture flags explicitly excluded.

**Verdict**: ADEQUATE as specified. One residual Phase 2 risk.

The whitelist approach (`threadline`, `telemetry`, `evolution`, `playbook`) correctly excludes security-posture flags. The core attack — querying the backend to identify installations without defensive guards — is closed.

**Residual: Whitelist as Phase 2 fingerprinting surface**

With 4 binary flags, there are 16 possible combinations. In a small fleet (10–25 agents at launch), certain flag combinations will have fewer than k=5 agents. If the k-anonymity floor in Phase 2 is applied only to job metric combinations rather than flag combinations, the population query API could allow isolation of specific small groups. Flag values themselves are not sensitive, but the segmentation enables inference.

**Likelihood**: Low | **Impact**: Low | **Rating**: 3/10 — Ensure Phase 2 k-anonymity floor applies to flag distribution queries, not just job metric queries.

---

### R1-5: Phase 4 Evolution Poisoning

**Fix claimed**: Phase 4 blocked — four explicit prerequisites before design can proceed.

**Verdict**: ADEQUATE. The block is clearly stated, conditions are explicit, no new attack surface to probe.

---

## New Attack Vectors (Round 2 Originals)

---

### NEW-1: Deletion Endpoint Lacks Server-Side Key Binding

**Target**: `DELETE /v1/telemetry/{installationId}` (HMAC-signed per spec)

**The structural problem**: The spec says deletion is HMAC-signed and "the Worker purges all stored data for that installation ID within 24 hours." However, the spec also explicitly says the design avoids "server-side key management." This creates a contradiction: without storing a key hash server-side, the Worker cannot verify that the entity sending the DELETE request is the same entity that submitted the data.

The DELETE HMAC is signed with `localSecret`. The Worker validates the HMAC structure but has no stored reference to compare it against. Any attacker who:
1. Learns a target's `installationId` (visible as first 8 chars in `GET /telemetry/status`; also potentially leaked in error logs or observability tooling)
2. Generates a random `localSecret`
3. Signs a valid DELETE request

...will have the Worker accept and execute the deletion, because the Worker cannot distinguish a forged secret from the real one.

**Likelihood**: Medium (installationId is a random UUID, but the first 8 chars are exposed in the API; full ID could be learned via log exfiltration or a compromised backend)
**Impact**: High (unauthorized permanent deletion of another installation's telemetry data; destroys longitudinal tracking; the deleted user has no recourse — their 30 days of data is gone)
**Rating**: 7/10

**Fix**: At first successful submission, the Worker stores `SHA-256(installationId + localSecret)` in the per-installation DO as a "key fingerprint." All subsequent operations (submissions and DELETE) are validated against this stored fingerprint. This requires storing one 32-byte hash per installationId — minimal server-side state that does not expose the secret itself.

---

### NEW-2: Dual-Write Aggregation Race Condition

**Target**: Per-installation DOs + per-slug aggregate DOs (dual-write on ingest)

The spec requires dual-write to two separate Durable Objects on each submission. This is not atomic. If the aggregate DO write fails (DO overload, network partition, Worker CPU timeout), the raw submission exists in the per-installation DO but the aggregate counters are not updated.

**The attack**: This is not a directly attacker-controlled vector but an adversary who wants to corrupt population data without forging submissions. By timing legitimate submissions to coincide with burst recovery windows (when many installations submit simultaneously after an outage), they can maximize aggregate DO write contention. The per-installationId rate limit (1 per 5h) means one installation cannot generate the burst — but N installations submitting simultaneously after a 2-week outage (the "startup behavior" scenario) can.

**More concerning**: Silent aggregate staleness is undetectable. Echo makes design decisions on per-slug aggregate data without knowing that 20% of submissions failed to update the aggregates. There is no reconciliation mechanism specified.

**Likelihood**: Low-Medium (requires an outage followed by burst recovery, which is realistic)
**Impact**: Medium (silently stale aggregates; incorrect population statistics; no alert mechanism)
**Rating**: 5/10

**Fix**: The spec must specify dual-write failure behavior before implementation. Recommended: mark submissions with `aggregationStatus: "pending" | "complete"` and run a scheduled reconciliation sweep that re-applies pending submissions to aggregate DOs. Alternatively, explicitly document eventual consistency and the acceptable staleness bound.

---

### NEW-3: CLI Consent Constraint Is Enforced at the Wrong Layer

**Target**: The structural constraint preventing `monitoring.telemetry.enabled` from being set via agent API calls.

The spec states: "It cannot be set by agent API calls (`POST /config`, dispatch system, evolution proposals, or any programmatic path). This prevents agents from opting themselves into telemetry without human knowledge."

**The gap**: The spec lists "Direct config file editing by the user" as a valid consent path. All instar agents have write access to their own `stateDir`, which contains `config.json`. A compromised agent (via a malicious job, a crafted dispatch payload, or an evolution proposal that wrote to disk) can set `monitoring.telemetry.enabled: true` by writing `config.json` directly. The API-layer constraint is bypassed entirely at the filesystem layer.

This is not a remote attack — it requires an already-compromised agent process. But the threat model this constraint is designed to prevent is specifically "agent self-enrolls in telemetry without human knowledge," and this scenario is reachable via any code execution path that can write files.

**Likelihood**: Low-Medium (requires a compromised job or dispatch payload that writes to config.json; within the threat model of "what can a compromised component of the agent do")
**Impact**: High (violates the consent guarantee — the core privacy promise of the feature; agent submits data the user never authorized; destroys user trust if discovered)
**Rating**: 6/10

**Fix**: Implement a separate consent sentinel: when `instar telemetry enable` is run, it writes a consent proof file to `{stateDir}/telemetry/consent` (distinct from `config.json`). The submission code checks for this file, not the config key. The consent file is created only by the CLI — no documented programmatic path creates it. Additionally, at submission time, verify the consent file's mtime is consistent with user-initiated action (not a process that runs continuously). This doesn't eliminate all bypass vectors but raises the bar significantly and decouples consent verification from the config system.

---

### NEW-4: `nextSubmissionAfter` Enables Fleet Timing Fingerprinting

**Target**: Response field `"nextSubmissionAfter": "2026-03-22T12:00:00Z"`

After the initial jitter is applied on first submission, subsequent submissions follow a deterministic 6-hour cadence anchored to the jitter offset. A passive observer of the submission endpoint can correlate arrival times to specific installationIds and build an activity map of the fleet.

This is low-severity given that the Worker is instructed to discard origin IPs, but any logging or observability layer on the Worker (Cloudflare Analytics Engine, which the spec mentions) will capture arrival timestamps associated with installationIds.

**Likelihood**: Low | **Impact**: Low | **Rating**: 3/10 — Acceptable residual risk. Note for implementation: ensure Worker observability logs do not correlate installationId with timestamp in a way that could be queried by a compromised admin path.

---

### NEW-5: Patient Sybil Attack Defeats the 48h Weighting Mechanism

**Target**: Phase 3 Sybil mitigation ("Weight new installation IDs lower in aggregates until they establish 48h+ history")

The 48-hour weighting assumes an adversary will create installation IDs and immediately begin submitting. A patient adversary creates N installation IDs, submits legitimate-looking data for 48+ hours to establish history weight, then switches to poisoned payloads. The weighting mechanism grants no protection against this.

The HMAC + rate limiting constraints mean each ID needs a real `localSecret` and is limited to 1 submission per 5 hours. Running N real instar instances or modifying the client to behave as N instances is the required effort. This is not trivial but is within reach for a motivated adversary targeting a small fleet.

**Likelihood**: Low | **Impact**: Medium | **Rating**: 4/10 — Phase 3 concern, not Phase 1. The right mitigation is anomaly detection in Phase 3 analysis infrastructure: flag installationIds that submit statistically identical metrics across windows (real agents vary; synthetic agents repeat patterns). Document this as a Phase 3 requirement now.

---

## Summary Table

| ID | Attack Vector | Likelihood | Impact | Rating | Fix Required Before Phase 1? |
|----|--------------|-----------|--------|--------|------------------------------|
| R1-1a | localSecret file permissions unspecified | Medium | High | 6/10 | Yes |
| R1-1b | HMAC canonicalization (no delimiters) | Low | Medium | 2/10 | No (impl detail) |
| R1-2a | Numeric field amplification (no upper bounds) | Medium | Medium | 5/10 | Yes |
| R1-2b | Slug namespace pollution | Low | Medium | 4/10 | Yes |
| R1-3 | Installation ID enumeration | CLOSED | — | — | — |
| R1-4 | Feature flag recon | MITIGATED | — | — | Phase 2: apply k-anon to flag queries |
| R1-5 | Phase 4 evolution poisoning | BLOCKED | — | — | — |
| NEW-1 | DELETE endpoint lacks key binding | Medium | High | **7/10** | Yes |
| NEW-2 | Dual-write aggregate race condition | Low-Med | Medium | 5/10 | Specify failure behavior before impl |
| NEW-3 | Consent bypass via config file write | Low-Med | High | **6/10** | Yes |
| NEW-4 | Timing fingerprinting via nextSubmissionAfter | Low | Low | 3/10 | No |
| NEW-5 | Patient Sybil (48h wait defeats weighting) | Low | Medium | 4/10 | No (Phase 3 concern) |

---

## Verdict

**Status**: CONDITIONAL — four issues require resolution before Phase 1 ships

The Round 1 fixes are structurally sound. The HMAC scheme closes the core data poisoning and Sybil vectors. The random UUID closes the enumeration attack. The enum validation closes the skip reason injection. Phase 4 is correctly blocked with explicit prerequisites.

Four issues require resolution before Phase 1 ships:

**Priority 1 (7/10): NEW-1 — DELETE endpoint without server-side key binding.** The Worker cannot verify that a DELETE request originates from the same entity that submitted the data, because it stores no key reference. Any attacker who learns an installationId can forge a valid deletion. Fix: store `SHA-256(installationId + localSecret)` as a key fingerprint in the per-installation DO at first submission; validate all subsequent operations against it.

**Priority 2 (6/10): NEW-3 — Consent constraint enforced only at the API layer.** A compromised agent process can write `config.json` directly, bypassing the "no programmatic path" constraint. Fix: implement a separate consent sentinel file created only by the CLI, verified by the submission code independently of the config system.

**Priority 3 (6/10): R1-1a — Secret file permissions unspecified.** The `localSecret` storage location and permissions are undefined. On shared or backup-exposed systems, world-readable secrets enable HMAC forgery. Fix: specify `chmod 600` on `{stateDir}/telemetry/` in implementation requirements.

**Priority 4 (5/10): R1-2a — No upper bounds on numeric count fields.** A single authenticated submission with implausibly large counts corrupts aggregate DOs for 30 days. Fix: add server-side upper bound validation on all count fields (ceiling: ~10,000 per 6-hour window).

The dual-write race condition (NEW-2) and slug namespace pollution (R1-2b) are design gaps that should be addressed in the implementation spec before coding begins, but are not blocking issues at the specification level.
