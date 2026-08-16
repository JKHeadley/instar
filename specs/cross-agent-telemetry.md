# Baseline — Cross-Agent Telemetry

> Spec status: IMPLEMENTING (Phase 1 client-side + backend Worker built — needs deploy)
> Origin: Topic 1839 (Job System Meta-Review)
> Related: Topic 1895 (Consent & Discovery Framework)
> Date: 2026-03-22
> Review R1: specreview/output/20260321-232336/synthesis.md
> Review R2: specreview/output/20260321-234500/synthesis.md

## Problem Statement

Each deployed instar agent independently runs jobs, makes decisions, hits failures, and learns — but all that intelligence stays siloed. No single agent can know whether its patterns are normal or anomalous. Echo (the instar developer) has no visibility into how agents actually behave in the wild, making it hard to distinguish good defaults from bad ones.

**Primary goal:** Give Echo population-level data to make informed design decisions about jobs, schedules, models, and defaults.

**User-facing value prop:** See how your agent's behavior compares to the population — without sharing a single byte of content. "Help your agent know if it's healthy."

## Design Principles

1. **Opt-in, human-gated** — Default OFF. Telemetry can only be enabled through human-interactive actions (CLI command or dashboard toggle). Agent API calls cannot enable telemetry — this is a structural constraint, not a policy.
2. **Privacy by architecture** — No content, names, paths, or prompts. Only structural/statistical data.
3. **Graceful degradation** — Telemetry failure never affects agent operation. Fire-and-forget.
4. **Local transparency** — Every submission's full payload logged locally for user audit.
5. **Phased rollout** — Collect first, analyze later. Don't build what we don't need yet.
6. **Authenticated submissions** — All submissions are HMAC-signed to prevent data poisoning.

## Phases

### Phase 1: Data Collection (PRIMARY FOCUS)

Get structured metrics flowing from agents to a central store. No analysis, no insights engine, no recommendations. Just the data.

#### What we collect

All metrics are anonymous, structural, and contain no content.

**Job metrics (per job slug, per submission window):**

| Metric | Fields | Why it matters |
|--------|--------|----------------|
| Skip events | `slug, reason, count` | Distinguish quota-gated vs disabled vs deprioritized |
| Execution results | `slug, success, error, timeout, count` | Basic health signal |
| Durations | `slug, meanMs, count` | Cost/performance baseline |
| Model used | `slug, model, runCount` | Know what models agents actually use |
| Schedule adherence | `slug, expectedRuns, actualRuns` | Gap between intent and reality |

> **Note:** Duration metrics use `meanMs + count` (not p50/p95). Per-agent percentiles cannot be meaningfully aggregated across a fleet — mean-of-percentiles is statistically invalid. The backend can compute true population percentiles from raw mean+count pairs.

**Agent-level metrics (per submission):**

| Metric | Fields | Why it matters |
|--------|--------|----------------|
| Version + platform | `version, nodeVersion, os, arch` | Segment by version |
| Uptime | `uptimeHours` | Stability signal |
| Job count | `totalJobs, enabledJobs, disabledJobs` | Config complexity |
| Feature flags | `{ feature: enabled }` (curated whitelist) | What capabilities are actually used |
| Session activity | `sessionsBucket` (one of: `"0"`, `"1-5"`, `"6-20"`, `"20+"`) | Usage intensity bucket (not exact count) |
| Quota pressure | `gateTriggersLast24h, blocksLast24h` | System-wide resource signal |

> **Feature flag whitelist:** Only usage/adoption flags are collected (e.g., `threadline`, `telemetry`, `evolution`, `playbook`). Security-posture flags (e.g., `coherenceGate`, `sentinel`, `operationGate`) are explicitly excluded — they would reveal defensive configuration to anyone who compromises the endpoint.

> **Session activity bucketing:** Exact session counts and durations are behavioral fingerprints that reveal work patterns and timezone. Coarse buckets preserve the segmentation value (distinguishing active vs dormant agents) without the fingerprinting risk.

**Skip reason taxonomy** — this is where the "common practice vs common issue" distinction lives:

- `quota` — agent wanted to run the job but couldn't afford it (constraint)
- `priority` — a higher-priority job won the slot (constraint)
- `cooldown` — job ran recently, skipped to avoid redundancy (healthy)
- `disabled` — user or agent explicitly turned it off (choice)
- `error` — job attempted but failed (broken)
- `stale-handoff` — skipped because prior run's output wasn't consumed (healthy)

The server validates skip reasons against this enum and rejects unknown values with HTTP 400.

By collecting *reason* alongside *rate*, we can later distinguish "agents skip this because the design is broken" from "agents skip this because they should."

#### Installation ID

A cryptographically random UUID generated at first opt-in and stored locally at `{stateDir}/telemetry/install-id`. This ID:

- Is **never derived from machine properties** (no machineId, no projectDir)
- Provides longitudinal tracking (same agent across submissions) for trend detection
- Is used for deduplication at the backend
- Can be regenerated by the user at any time (deleting the file generates a new one)

> **Why not SHA-256(machineId + projectDir)?** The input space is too small. machineId is a fixed hardware UUID shared across software, and projectDir follows predictable patterns like `/Users/{name}/.instar/agents/{agent}`. An adversary can enumerate likely inputs and reverse the hash. A random UUID has no relationship to the machine, making it truly anonymous.

#### Submission protocol

Extends the existing heartbeat endpoint:

```
POST https://instar-telemetry.sagemind-ai.workers.dev/v1/telemetry
Content-Type: application/json
X-Instar-Signature: hmac-sha256=<hex digest>
X-Instar-Timestamp: <unix epoch seconds>

{
  "v": 1,                             // Schema version
  "installationId": "random-uuid",    // Locally-stored random UUID
  "version": "0.9.3",
  "windowStart": "2026-03-22T00:00:00Z",
  "windowEnd": "2026-03-22T06:00:00Z",
  "agent": { ... },                   // Agent-level metrics
  "jobs": [ ... ]                     // Per-job metrics (max 100KB payload)
}
```

**HMAC authentication:** Each submission is signed using the following canonical message format:

```
message = installationId + ":" + timestamp + ":" + hex(SHA-256(payload))
signature = HMAC-SHA256(message, localSecret)
```

Where:
- `installationId` is the 36-character UUID (fixed length, but delimiters prevent any ambiguity)
- `timestamp` is Unix epoch seconds as a decimal string (matches the `X-Instar-Timestamp` header)
- `payload` is the exact JSON request body as bytes (no re-serialization)
- `localSecret` is a 32-byte cryptographically random key (see Secret Storage below)
- The resulting signature is sent as `X-Instar-Signature: hmac-sha256=<hex digest>`

> **Why explicit delimiters?** Without them, different input combinations can produce identical concatenated strings. The colon delimiter is safe because UUIDs, timestamps, and hex strings never contain colons. Both `TelemetryAuth.ts` and the Worker MUST use this exact format — if they differ, signatures will never match. (R2-1)

**Secret storage:** The HMAC signing secret is stored at `{stateDir}/telemetry/local-secret`:
- **Format:** 32 bytes of `crypto.randomBytes()`, encoded as hex (64 characters)
- **File permissions:** `chmod 600` (owner read/write only)
- **Directory permissions:** The `{stateDir}/telemetry/` directory is created with `chmod 700`
- **Generated:** At first `instar telemetry enable`, alongside the install-id
- **Never transmitted:** The secret never leaves the machine. Only the signature it produces is sent.

> **Why chmod 600?** Without explicit permissions, the stateDir's default permissions apply, potentially making the secret readable by any process on the machine. The HMAC is only as strong as the secret's confidentiality. (R2-2)

The Worker validates:
1. Signature matches using the canonical message format above
2. Timestamp is within ±5 minutes of server time
3. installationId in payload matches the one used in the signature
4. On first submission from a new installationId, stores `SHA-256(installationId + ":" + localSecret)` as a key fingerprint in the per-installation DO (see Deletion Authentication below)

This prevents data poisoning (can't submit fake metrics without the secret) and replay attacks (timestamp window) without requiring server-side key management or user-facing auth tokens.

**Response:**
```json
{
  "accepted": true,
  "nextSubmissionAfter": "2026-03-22T12:00:00Z"
}
```

> **No `populationSize` in response.** Exposing exact fleet size on an unauthenticated response reveals competitive intelligence. If needed later, add with noise (±10% jitter, rounded to nearest 10).

**Error responses (R2-10):**

| Error Code | HTTP Status | Meaning |
|-----------|------------|---------|
| `rate_limited` | 429 | IP or per-installation rate limit exceeded |
| `malformed` | 400 | JSON parse failure or missing required fields |
| `schema_version_unsupported` | 422 | `v` field not in supported set |
| `payload_too_large` | 413 | Exceeds 100KB limit |
| `signature_invalid` | 401 | HMAC signature does not match |
| `timestamp_expired` | 401 | Timestamp outside ±5 minute window |

```json
{
  "accepted": false,
  "error": "rate_limited" | "malformed" | "schema_version_unsupported" | "payload_too_large" | "signature_invalid" | "timestamp_expired"
}
```

**Submission frequency:** Every 6 hours (aligned with existing heartbeat). First submission gets a random 0–6h jitter on `nextSubmissionAfter` to spread fleet across submission windows and prevent thundering herd on backend recovery.

**Startup behavior (R2-13):** When an agent starts up after being offline, it submits the current window only — no backfill of missed windows. Historical accuracy is less important than simplicity and preventing submission storms from agents that have been offline for days or weeks.

**Payload size limit:** 100KB hard cap. If the `jobs` array exceeds this, truncate from least-recently-run jobs.

**Server-side validation:**
- Skip reasons must match the defined enum — unknown values rejected with 400
- Field value bounds enforced (no negative counts, no future timestamps)
- Schema version must be supported (currently only `v: 1`)
- **Count field upper bounds (R2-5):** Any numeric count field (skip counts, run counts, gate triggers, etc.) exceeding 10,000 per 6-hour window is rejected with HTTP 400. This prevents metric amplification attacks without affecting legitimate agents (10,000 job runs in 6 hours is far beyond any real usage pattern).
- **Slug format validation (R2-6):** Job slugs must match `^[a-z][a-z0-9-]{0,63}$`. Non-conforming slugs are rejected with HTTP 400. This prevents namespace pollution and injection via slug strings.
- **Window validation (R2-14):** `windowStart` must be before `windowEnd`, the window duration must not exceed 24 hours, and `windowStart` must be within the 30-day retention window. Submissions with impossible time ranges are rejected with HTTP 400.

#### Local transparency log

Every submission's **full outgoing payload** is logged to `{stateDir}/telemetry/submissions.jsonl`:

```json
{
  "timestamp": "2026-03-22T06:00:00Z",
  "payload": { <the exact JSON body that was sent> },
  "endpoint": "v1/telemetry",
  "responseStatus": 200
}
```

> **Why the full payload?** A log entry showing `metricsSubmitted: { jobCount: 23 }` is not an audit trail — it doesn't answer "did anything sensitive go out?" The full payload lets users verify exactly what was transmitted.

**Retention:** 30-day rolling window. On each write, entries older than 30 days are truncated (same pattern as SkipLedger).

Viewable via `GET /telemetry/submissions` and `GET /telemetry/submissions/latest` (returns last full payload).

#### Consent surface

**Hard dependency on Topic 1895** (Consent & Discovery Framework) for the full consent UX. Phase 1 cannot ship without a viable consent mechanism.

**Minimal fallback** if Topic 1895 is not ready: `instar telemetry enable` CLI command that displays a clear disclosure of what is collected, asks for explicit confirmation, and writes `monitoring.telemetry.enabled: true` to config. This is the minimum viable consent path.

**Required consent disclosure content (R2-4):** The `instar telemetry enable` command MUST display the following elements before asking for confirmation:

```
┌─ Enable Baseline ─────────────────────────────────────────┐
│                                                            │
│  Baseline helps your agent know if it's healthy by         │
│  comparing its behavior to the population — anonymously.   │
│                                                            │
│  What's collected:                                         │
│  • Job skip rates (with reasons), durations, results       │
│  • Model usage per job, schedule adherence                 │
│  • Version, uptime, feature flags (curated list only)      │
│  • Session activity (coarse bucket, not exact count)       │
│                                                            │
│  What's NEVER collected:                                   │
│  • Names, prompts, memory, conversations, file paths       │
│  • Error messages, IP addresses, Telegram data             │
│  • Security configuration flags                            │
│                                                            │
│  How it works:                                             │
│  • Anonymous ID: random UUID (not derived from your machine│
│  • Submitted to: instar-telemetry.sagemind-ai.workers.dev  │
│  • Frequency: every 6 hours                                │
│  • Retention: 30 days (local and remote)                   │
│  • Every submission is logged locally for your review:      │
│    run `instar telemetry submissions` to inspect            │
│                                                            │
│  You can disable at any time with `instar telemetry disable`│
│  which deletes your local ID and requests remote deletion. │
│                                                            │
│  Enable Baseline? [y/N]                                    │
└────────────────────────────────────────────────────────────┘
```

The consent disclosure MUST include: (1) what is collected, (2) what is never collected, (3) the anonymous installation ID mechanism, (4) the submission endpoint URL, (5) the retention period, (6) the local audit path, and (7) the deletion/disable path. These are GDPR-required elements.

**Structural constraint:** The `monitoring.telemetry.enabled` config key can only be set by:
- The CLI command `instar telemetry enable/disable`
- The dashboard toggle (human-interactive)
- The server endpoints `POST /telemetry/enable` and `POST /telemetry/disable` (R2-12, called by CLI and dashboard — not exposed to agent API)
- Direct config file editing by the user

It **cannot** be set by agent API calls (`POST /config`, dispatch system, evolution proposals, or any programmatic path). This prevents agents from opting themselves into telemetry without human knowledge.

> **Note on config.json bypass (Adversarial R2):** A user can manually edit `config.json` to set `monitoring.telemetry.enabled: true`, bypassing the consent flow. This is acceptable — it's a deliberate human action. The consent flow exists to ensure informed opt-in, not to prevent a knowledgeable user from editing their own config.

#### Deletion Authentication & Right to Erasure

**Key fingerprint binding (R2-3):** On the first submission from a new installationId, the Worker stores `SHA-256(installationId + ":" + localSecret)` in the per-installation DO. This binds the secret to the installation without storing the secret itself. All subsequent submissions and deletion requests are validated against this fingerprint.

**Authenticated DELETE:** The primary deletion path uses the same HMAC signing as submissions:
```
DELETE /v1/telemetry/{installationId}
X-Instar-Signature: hmac-sha256=<hex digest>
X-Instar-Timestamp: <unix epoch seconds>
```
The Worker validates the signature against the stored key fingerprint. This prevents unauthorized deletion — an attacker who learns an installationId cannot forge a valid DELETE without the localSecret.

**Secret-loss fallback:** If the user's local secret is lost (disk failure, migration), authenticated deletion is impossible. To preserve the erasure right:
- The user can run `instar telemetry purge --force` which sends an unsigned DELETE with a `X-Instar-Purge-Reason: secret-lost` header
- The Worker accepts unsigned DELETEs but applies a **72-hour grace period** before purging — during which the original secret-holder can cancel the deletion via a signed request
- This balances the erasure right (Privacy) against unauthorized deletion prevention (Adversarial)

**Deletion scope (R2-8):** The purge covers the per-installation DO only. Per-slug aggregate DOs are population-level counters and are not affected by deletion requests — they contain no per-installation data, only running sums.

**Deletion retry strategy (R2-9):** If the remote DELETE request fails at disable time (network error, server down):
1. A `{stateDir}/telemetry/pending-deletion.json` file is written containing `{installationId, timestamp, retryCount}`
2. On next instar server startup, if the file exists, retry the DELETE request
3. Retry up to 5 times with exponential backoff (1h, 6h, 24h, 72h, 168h)
4. After 5 failures, log a warning and surface in `instar telemetry status` output
5. The local install-id and secret are deleted immediately regardless of remote DELETE success — telemetry stops sending on disable, even if the remote purge is pending

**Local deletion:** `instar telemetry disable` immediately:
- Deletes `{stateDir}/telemetry/install-id`
- Deletes `{stateDir}/telemetry/local-secret`
- Clears `{stateDir}/telemetry/submissions.jsonl`
- Sets `monitoring.telemetry.enabled: false` in config
- Sends the remote DELETE (or writes pending-deletion file on failure)

> **CLI warning (R2-17):** `instar telemetry disable` displays: "Re-enabling telemetry will create a new identity. Prior submission history is not recoverable."

#### CLI and server endpoints

**CLI commands:**

| Command | Purpose |
|---------|---------|
| `instar telemetry status` | Show current config, last submission time, next window, last error code (R2-16) |
| `instar telemetry enable` | Interactive consent flow — displays disclosure, generates install-id and secret. Lead with: "Enable Baseline — see how your agent compares to the population" (R2-18) |
| `instar telemetry disable` | Disables, deletes local install-id/secret, sends remote deletion. Warns about identity loss (R2-17) |
| `instar telemetry submissions` | View local transparency log |
| `instar telemetry purge --force` | Secret-loss fallback: unsigned remote deletion with 72h grace period |

**Server endpoints (R2-11, R2-12):**

All telemetry server endpoints require the standard instar auth token (`Authorization: Bearer <authToken>`). These are local management endpoints, not the remote Worker endpoints.

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /telemetry/status` | Required | JSON: `{enabled, lastSubmission, nextWindow, installationId (first 8 chars), lastErrorCode}` |
| `GET /telemetry/submissions` | Required | List local transparency log entries (paginated) |
| `GET /telemetry/submissions/latest` | Required | Full payload of most recent submission |
| `POST /telemetry/enable` | Required | Programmatic enable (called by CLI and dashboard). Generates install-id and secret if not present. Returns the consent disclosure as JSON for dashboard rendering. Does NOT bypass the human-gate — dashboard must show disclosure and get confirmation before calling. |
| `POST /telemetry/disable` | Required | Programmatic disable (called by CLI and dashboard). Deletes local files, sends remote DELETE. |

#### Implementation

**Files to modify:**
- `src/monitoring/TelemetryHeartbeat.ts` — Extend with job/agent metric collection, HMAC signing
- `src/core/types.ts` — Metric interfaces, skip reason enum
- `src/core/Config.ts` — Add `monitoring.telemetry.enabled` (default false) with human-gate constraint

**New files:**
- `src/monitoring/TelemetryCollector.ts` — Reads ledger data, computes aggregate metrics per window. Uses offset tracking to avoid scanning full 30-day ledger on every tick.
- `src/monitoring/TelemetryAuth.ts` — Install-id generation, secret management, HMAC signing

**Config:**
```json
{
  "monitoring": {
    "telemetry": {
      "enabled": false,
      "submissionIntervalHours": 6
    }
  }
}
```

**Backend:**
- Extend existing Cloudflare Worker to accept the new payload
- HMAC signature validation on all submissions
- IP-level rate limiting (Cloudflare-native): max 10 submissions per IP per hour
- Per-installationId rate limiting: max 1 submission per 5 hours (reject early resubmissions)
- Server-side enum validation on skip reasons
- Storage: dual-write to per-installation DOs (for raw data) AND per-slug aggregate DOs (for population queries)
- 30-day rolling retention, enforced by scheduled Worker cleanup
- `DELETE /v1/telemetry/{installationId}` endpoint for Right to Erasure
- No analysis logic yet — just store and aggregate counts

> **Aggregation layer (designed now, built in Phase 1):** To support Phase 2 population queries, submissions are dual-written at ingest time. Per-installation DOs store the raw submission. Per-slug aggregate DOs maintain running counters (total skips by reason, mean durations, model distribution) updated on each write. This avoids the O(N) fan-out problem where querying population data requires reading every installation DO.
>
> **Eventual consistency (R2-7):** The dual-write is not transactional. If the per-installation DO write succeeds but the per-slug aggregate DO write fails (network partition, DO limit), the raw data is preserved but aggregates may undercount. This is an acceptable trade-off — aggregates are statistical summaries, not authoritative records. The per-installation DO is the source of truth; aggregates can be recomputed from raw data if needed.

#### What "done" looks like

- Agents with telemetry enabled submit HMAC-signed metrics every 6h
- Full payload logged locally with 30-day retention
- `instar telemetry status/enable/disable` CLI works
- Backend stores raw data + maintains per-slug aggregates
- Echo can query aggregate data to answer "what's the population skip rate for job X by reason?"
- Users can disable and trigger remote data deletion

---

### Phase 2: Echo's Analysis Dashboard (FUTURE)

Once data is flowing, build tools for Echo to query and analyze it.

- `GET /telemetry/population/:slug` — Population stats for a job (reads from per-slug aggregate DOs)
- `GET /telemetry/population/overview` — Fleet-wide summary
- Manual query tools for Echo to explore patterns
- Cohort segmentation (by version, job count, usage intensity)
- k-anonymity floor: suppress metric combinations with fewer than 5 contributing agents

The key analytical framework for this phase:

| Pattern | Meaning | Action |
|---------|---------|--------|
| High skip rate + reason=quota | Job is overpriced for most agents | Downgrade model or reduce frequency |
| High skip rate + reason=disabled | Agents tried it, turned it off | Feature isn't delivering value |
| High skip rate + reason=priority | Other jobs consistently win | Adjust priority or schedule |
| Low skip rate + high error rate | Job runs but fails | Fix the job |
| Feature flag mostly OFF | Feature isn't adopted | Discovery/onboarding issue or not useful |

This is where the "common practice vs common issue" question gets answered — but it requires Phase 1 data to be meaningful.

**Pre-Phase 2 decisions:**
- Admin query interface design (API on Worker vs. direct DO queries)
- Forward/backward compatibility contract: server accepts unknown fields; client sends `v`; server rejects below minimum supported version
- OTEL compatibility assessment: evaluate whether data format should align with OpenTelemetry for downstream integration

---

### Phase 3: Automated Insights (FUTURE)

Once Echo has manually identified recurring patterns, codify them:

- Insight generation rules based on population data
- Agents receive relevant insights with their submission response
- Insights are informational only — no auto-actions
- Categories: job design quality, model routing, schedule optimization, failure prediction
- Weight new installation IDs lower in aggregates until they establish 48h+ history (Sybil mitigation)

---

### Phase 4: Evolution Crowdsourcing (FUTURE — BLOCKED)

> **STATUS: BLOCKED** — This phase creates a fleet-wide behavioral update distribution channel. A single compromise of the distribution pipeline reaches every opted-in agent simultaneously. Phase 4 cannot proceed to design until:
> 1. A dedicated threat model is written
> 2. Content signing architecture is specified (signed packages, agent-side verification)
> 3. A kill-switch mechanism is designed
> 4. A separate consent tier is defined (Phase 1 consent does not cover this)

The most ambitious phase — sharing successful adaptations across agents:

- Track which evolution proposals stuck vs reverted
- Anonymize and share successful patterns
- Agents can opt into receiving suggestions from the population
- EU AI Act (fully applicable August 2026) implications for automated decision-making must be assessed

## Privacy Architecture

### Never collected (any phase)

- Agent names, user names, or any PII
- Prompt content, memory content, conversation text
- File paths, environment variables, secrets
- Error messages or stack traces (only error *counts*)
- IP addresses (Worker discards origin)
- Telegram IDs, chat IDs, or message content
- Security-posture feature flags

### Installation ID

Cryptographically random UUID, generated at first opt-in, stored at `{stateDir}/telemetry/install-id`. Not derived from any machine property. User can regenerate at any time. Remote deletion available on opt-out.

### Data retention

- **Local:** 30-day rolling transparency log, auto-truncated
- **Remote:** 30-day rolling retention, enforced by scheduled Worker cleanup
- **On opt-out:** Local install-id and log deleted immediately; remote data purged within 24 hours

## Open Questions

1. **Minimum population for useful data** — 25 agents with 30 days of submissions before Phase 2 begins (R2-20). 10+ agents is sufficient for spotting gross outliers in Phase 1 manual analysis.

2. **Echo's query interface** — API endpoint on the Worker? Direct Durable Object queries? Dashboard? Start simple (API), add UI later.

3. **Cross-version segmentation** — Should data from different instar versions be analyzed separately? Probably yes for major.minor, aggregated for patches.

4. **Backend observability** — How does Echo know if the telemetry Worker itself has errors or latency spikes? Cloudflare Analytics Engine is available but needs to be wired up.

5. ~~**Startup behavior for overdue submissions**~~ — **CLOSED (R2-13).** Submit current window only, no backfill. Moved to spec body under "Startup behavior."

6. ~~**Feature name**~~ — **CLOSED (R2-15).** User-facing name is **"Baseline"**. CLI namespace: `instar telemetry`. Help text leads with "Enable Baseline." Contextual framing: "Your skip rate is 2x the Baseline average."
