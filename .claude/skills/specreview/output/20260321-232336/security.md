# Security Review: Cross-Agent Telemetry
**Review ID:** 20260321-232336
**Round:** 1
**Spec:** cross-agent-telemetry.md
**Reviewer role:** Security Specialist
**Date:** 2026-03-21

---

## Approval Status: CONDITIONAL

The spec demonstrates solid security instincts — opt-in default, privacy-by-architecture, fire-and-forget, local transparency log. These are meaningful structural choices, not just aspirational policy. However, several issues in the current design require resolution before implementation, and one issue in Phases 3-4 is serious enough that it warrants a BLOCK on those phases until a threat model is written for them specifically.

Phase 1 is conditionally approvable with the mitigations below. Phases 3 and 4 introduce new trust surfaces that this spec has not adequately analyzed.

---

## Critical Issues

### ISSUE-1 — SHA-256 Installation ID Is Reversible in Practice
**Severity: HIGH**

The spec states the installation ID is "SHA-256(machineId + projectDir), truncated to 16 hex chars. Non-reversible."

This claim is incorrect for most deployments. The existing `TelemetryHeartbeat.ts` implementation confirms the input is `machineId + projectDir`. Both components have low entropy in practice:

- `machineId` on macOS is an `IOPlatformUUID` — a fixed hardware UUID that does not rotate and is shared with other software. On Linux it is `/etc/machine-id`, also a fixed value. An adversary with access to even one other telemetry dataset that includes the same machineId can trivially correlate.
- `projectDir` follows highly predictable patterns: `/Users/<username>/Documents/instar/`, `/home/<username>/.instar/`, or similar. An attacker enumerating common directory structures and known hardware UUIDs for a target machine can reverse-lookup the hash.

The VSCode team discovered this exact class of vulnerability with MAC address hashing (GitHub Issue #8688). Running all common directory patterns against SHA-256 on modern hardware is fast — the input space is far smaller than 2^64.

**Truncating to 16 hex chars (64 bits) does not add security** — it reduces false-positive collisions in the dedup use case, but the input space is not large enough for the truncation to be the limiting factor.

**Recommended fix:** Apply HMAC-SHA256 with a randomly generated per-install secret salt stored locally (never transmitted). This makes the ID a commitment to the salt, not a function of guessable inputs. Alternatively, generate a random UUID at first opt-in and store it. The ID does not need to be deterministic — deduplication only requires consistency within an installation.

---

### ISSUE-2 — No Authentication on the Telemetry Endpoint
**Severity: HIGH**

The submission protocol shows:
```
POST https://instar-telemetry.sagemind-ai.workers.dev/v1/telemetry
```
with no authentication header. The spec does not mention any form of request authentication, rate limiting, or proof-of-work.

An unauthenticated write endpoint accepting structured JSON is a data poisoning surface. Threats:

1. **Metrics inflation:** An adversary submits fabricated high skip-rate data for specific job slugs, causing Echo to incorrectly conclude those jobs are broken and change defaults for the real population.
2. **Sybil attack:** An adversary generates thousands of fake installation IDs and floods the population, diluting real data to the point it is meaningless for analysis.
3. **Denial-of-analysis:** Flood with plausible-but-wrong data for a period before a planned instar release, causing bad design decisions.
4. **Enumeration:** The response includes `populationSize`. An attacker sending one submission per second and watching the counter reveals the real agent count — a competitive intelligence leak.

The "fire-and-forget" design philosophy (telemetry failure never blocks agent operation) is correct for availability, but it does not justify leaving the write surface unauthenticated.

**Recommended fix:**
- Add a lightweight HMAC request signature using the per-install secret (from ISSUE-1). This does not require server-side key management — the Worker can verify that the `installationId` is consistent with the signature, preventing spoofed submissions from unknown IDs.
- Rate-limit by installationId: max N submissions per 24h window. Cloudflare Durable Objects make this straightforward.
- Remove `populationSize` from the response, or gate it behind a minimum population threshold before disclosure.

---

### ISSUE-3 — Phase 4 Evolution Crowdsourcing Introduces Untrusted Code/Config Paths
**Severity: CRITICAL (for Phase 4)**

Phase 4 describes: "Agents can opt into receiving suggestions from the population." The mechanism is agents receiving content from a centrally-administered endpoint that influences their behavior.

This is a vector for:

- **Prompt/config injection at scale:** If the suggestions pipeline is compromised (supply chain attack on the Worker, Cloudflare account takeover, or a malicious insider), every opted-in agent receives manipulated "suggestions" simultaneously. The blast radius is the entire fleet.
- **Trust chain collapse:** The spec says these are "informational only — no auto-actions," but an LLM-based agent receiving "informational" suggestions that recommend a config change will frequently apply them, especially if the suggestions arrive with the authority of the instar developer persona.
- **Cross-agent contamination:** A single agent that has been compromised and reports poisoned "successful evolution" data could, if the aggregation logic is not robust, propagate its corrupted patterns to other agents.

Phase 4 essentially creates a fleet-wide behavioral update channel with no described signing, integrity checking, or sandboxing. The 2025-2026 agentic AI supply chain attack literature (CrowdStrike, Datadog research) specifically identifies this architecture as the highest-risk configuration for AI agent fleets.

**Recommended fix:** Phase 4 requires a separate, dedicated security review before design proceeds. Minimum requirements: content signing (suggestions must be signed by a key under Echo's control), an explicit threat model for the distribution pipeline, and a kill-switch mechanism that disables suggestion receipt fleet-wide without requiring individual agent updates.

---

### ISSUE-4 — Feature Flags in Telemetry Payload Reveal Security Posture
**Severity: MEDIUM**

The agent-level metrics include `featureFlags: { feature: enabled }`. Some instar features are security-relevant (e.g., coherence gate, external operation gate, sentinel). Reporting which security features are enabled or disabled per installation:

- Allows adversaries who compromise the telemetry endpoint to identify agents with security features disabled — effectively a targeting list for attacks.
- Even in aggregate, population-level data on "what % of agents have the coherence gate disabled" is sensitive.

**Recommended fix:** Either omit security-relevant feature flags from the telemetry payload entirely, or establish a whitelist of feature flags that are safe to report (usage/adoption features only, not security features).

---

## Recommendations

### REC-1 — Replace Deterministic Installation ID with Random UUID
Generate a cryptographically random UUID at first opt-in consent. Store it in `{stateDir}/telemetry/install-id`. Never derive it from machine properties. This eliminates the re-identification surface entirely and is simpler to implement correctly.

### REC-2 — Add HMAC Request Signing
Before each submission, compute `HMAC-SHA256(installationId + timestamp + payload_hash, localSecret)`. Include the signature and timestamp in a request header. The Worker validates that the signature is consistent and the timestamp is within a 5-minute window (replay protection). This prevents spoofed submissions without requiring per-agent registration.

### REC-3 — Validate Payload Schema Server-Side
The Worker should enforce strict schema validation on incoming payloads: max job count, max slug length, numeric ranges for all metric fields. Reject anything that exceeds expected bounds. This limits the damage from malformed or malicious submissions without requiring authentication.

### REC-4 — Remove populationSize from Unauthenticated Response
Move `populationSize` to a separate authenticated endpoint. Or omit it until Echo has a private analysis dashboard (Phase 2).

### REC-5 — Scope the "Never Collected" List to Implementation
The spec lists what is "never collected" but does not enforce this at the data collection layer. The `TelemetryCollector.ts` implementation should include a lint/audit pass to verify the collected fields against this list. A future contributor adding error messages to the skip-reason field would violate the spec's intent without triggering any check.

### REC-6 — Add Submission Integrity Hash to Local Log
The local transparency log currently records only `metricsSubmitted` summary counts, not the actual payload. An adversary with brief local access could modify the log to hide what was sent. Log the full payload (or a hash of it) so users can independently verify the submission matches what was logged.

### REC-7 — Define Data Retention Scope for Durable Objects
The spec says "30-day rolling retention" but does not specify what happens at deletion time. If a user opts out of telemetry, their historical data should be purged, not just future submissions stopped. The opt-out flow should include a data deletion request.

---

## Observations

### OBS-1 — "Privacy by Architecture" Claim Is Partially True
The design correctly excludes PII and content. The privacy model is sound for Phase 1 data (structural/statistical only). The concern is not what is designed but what is implemented — the spec does not describe enforcement mechanisms, only intent. This is normal for a Phase 1 spec, but it means the security review of Phase 1 is contingent on implementation review.

### OBS-2 — Cloudflare Worker Trust Boundary Is Appropriate
Cloudflare Workers V8 isolate architecture provides reasonable tenant isolation. Durable Objects keyed by installation hash are a reasonable storage choice for this use case. The Worker is not the primary attack surface — the unauthenticated endpoint and the installation ID scheme are.

### OBS-3 — Fire-and-Forget Is Correct
The graceful degradation principle is sound. Telemetry systems that block agent operation on failure are worse than useless. The 3-second timeout in the existing implementation is appropriate.

### OBS-4 — Opt-In Default Significantly Reduces Attack Surface
Default OFF means only agents whose operators have made a deliberate choice participate. This limits the population to more technically engaged users who are more likely to notice anomalies, and means the dataset is self-selected rather than universal — which is a valid tradeoff at Phase 1 scale.

### OBS-5 — Model Used Field Has Privacy Implications
`slug, model, runCount` reveals which AI models an agent uses. While this is not PII, it is commercially sensitive data. If the telemetry endpoint is compromised, this data could reveal which clients are using which providers. Consider whether this field is necessary for Phase 1.

### OBS-6 — Slug Is User-Configurable and May Contain PII
Job slugs are defined by users. While the spec intends slugs to be structural identifiers like `memory-sync` or `health-check`, there is no enforcement preventing a user from naming a job after sensitive content (e.g., `check-alice-account-balance`). The collector should validate that slugs match a safe pattern (alphanumeric + hyphens, max 64 chars) before inclusion in telemetry.

---

## Research Findings

### Finding 1 — SHA-256 Hashing Is Not Anonymization
The Teleport blog post "The False Allure of Hashing for Anonymization" and the VSCode GitHub issue #8688 both document the same class of attack relevant to ISSUE-1: when the input space is small or predictable, SHA-256 provides no meaningful anonymization. Running SHA-256 over all US phone numbers takes under two hours on a laptop. The instar input space (machineId patterns + common directory structures) is similarly constrained. NIST recommends HMAC with a 256-bit random key as the minimum acceptable approach for de-identification.

### Finding 2 — Differential Privacy Would Strengthen Phase 2+
Privacy-preserving telemetry literature (Mozilla's use of Prio/DAP, Apple's RAPPOR-based system, Google's differential privacy library) consistently recommends adding calibrated noise to aggregate statistics before disclosure. For Phase 2 queries like "population skip rate for job X," differential privacy with a small epsilon would prevent an adversary with partial knowledge from inferring individual agent behavior from population stats. This is not a Phase 1 requirement but should be in scope for Phase 2 design.

### Finding 3 — Agentic AI Telemetry Poisoning Is an Active Threat Class
The 2025-2026 agentic AI security research landscape (CrowdStrike, Datadog, arXiv 2602.19555) has specifically identified telemetry poisoning as an attack class against AI agent fleets. The attack pattern is: compromise the telemetry pipeline, inject metrics that cause incorrect design decisions, the developer deploys changes that degrade all agents. The instar threat model is low-risk now (small population, Echo manually reviews data) but Phase 3 (automated insights) and Phase 4 (evolution crowdsourcing) move this risk from theoretical to active.

### Finding 4 — The populationSize Disclosure Is a Non-Obvious Information Leak
Several telemetry systems have inadvertently leaked user counts through response metadata. The `populationSize: 42` example in the spec would allow anyone to poll the endpoint repeatedly and watch the counter, inferring install velocity. This is competitive intelligence for anyone building competing software.

### Finding 5 — Cloudflare Durable Objects Provide Adequate Isolation for This Use Case
The Cloudflare Workers security model (V8 isolates + cordon-based process isolation) is appropriate for a telemetry aggregation backend. Known Spectre-class concerns in isolate environments are mitigated by Cloudflare's trust-tier separation. This architecture does not introduce new security concerns beyond standard web service security practices.

---

## Scalability Assessment

### Phase 1 (Data Collection)
Security posture is acceptable with the mitigations in ISSUE-1 and ISSUE-2 applied. The architecture is simple enough that a security review of the implementation (not just the spec) should be feasible before rollout. Recommended: implement random UUID installation ID and HMAC request signing before any public rollout.

### Phase 2 (Echo's Analysis Dashboard)
Requires: authenticated query endpoints (Echo-only access), rate limiting on population queries, and evaluation of whether differential privacy noise should be added to aggregate stats returned. Lower risk than Phase 3-4 because analysis is manual and read-only.

### Phase 3 (Automated Insights)
Significant increase in risk. Automated insights flowing back to agents from a central server creates a command-and-control-like channel. The spec says "informational only — no auto-actions" but this distinction does not hold for LLM-based agents that read and act on informational content. Requires dedicated threat model. Conditional approval with mandatory security review before implementation.

### Phase 4 (Evolution Crowdsourcing)
BLOCK. This phase as described creates a fleet-wide behavioral update distribution system with no described integrity guarantees. The blast radius of a compromise is every opted-in agent receiving manipulated evolution suggestions simultaneously. This requires a fundamentally different security architecture — signed update packages, agent-side verification, staged rollout with canary population — before it should be designed, let alone built.

---

## Score: 6 / 10

**Justification:** The Phase 1 design reflects genuine security thinking — opt-in default, no PII, local transparency, fire-and-forget. These are correct structural choices that many telemetry systems skip. The score is held back by: (1) a factually incorrect claim about SHA-256 anonymization that will lead to a weak implementation, (2) an unauthenticated write endpoint that is a data poisoning surface, and (3) Phases 3-4 being sketched without a threat model for the new trust surfaces they introduce. Phase 1, properly implemented with a random UUID installation ID and HMAC request signing, would score 8/10. The current spec as written scores 6/10 because the anonymization claim is wrong and will propagate into implementation without correction.
