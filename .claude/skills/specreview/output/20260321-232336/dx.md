# DX & API Design Review: Cross-Agent Telemetry
**Spec:** `specs/cross-agent-telemetry.md`
**Review ID:** 20260321-232336
**Round:** 1
**Reviewer role:** Developer Experience & API Design Specialist
**Date:** 2026-03-21

---

## Research Findings

Before evaluating the spec, I surveyed how comparable tools handle telemetry DX.

**VS Code** — Opt-out by default. Uses a `telemetryLevel` setting with four tiers (off, crash, error, all). Documentation is thorough but the default-on model has generated ongoing community friction. The key positive: it exposes a `@vscode/extension-telemetry` package so extensions hook in consistently rather than rolling their own.

**Gatsby / Next.js** — Gatsby shows a first-run notice and collects by default; the community has repeatedly pushed back asking for opt-in on first run with a clear prompt rather than buried documentation. Next.js is opt-out via a single CLI command (`next telemetry disable`). Both expose a dedicated CLI surface (`gatsby telemetry --disable`, `next telemetry`) which creates discoverability and a natural "where do I manage this?" answer.

**Nuxt** — Explicitly opt-in. First-run interactive prompt. Versioned consent — if the data schema changes, the prompt fires again. This is the gold standard for developer trust.

**Homebrew** — No consent dialog at all, disclosed only in docs. Considered poor practice even by the community that uses it; cited as a cautionary example.

**npm** — `npm config set send-metrics false`. No interactive prompt. Opt-out model with env var override (`NPM_CONFIG_SEND_METRICS`).

**Key takeaway from research:** The direction of industry movement is clearly toward opt-in + interactive first-run prompt + dedicated CLI surface for inspection and management. Opt-out without a first-run notice is increasingly seen as a trust failure, even when data is genuinely anonymous. The Nuxt versioned consent model is notably forward-thinking because it handles schema evolution gracefully.

---

## Overall Assessment

The spec is well-reasoned and the privacy architecture is strong. The phased rollout is the right call — collect first, analyze later avoids premature complexity. However, **Phase 1 as written has meaningful DX gaps that will slow adoption and erode trust** if shipped as-is. The problems are concentrated in four areas: the consent/enable flow, the local transparency log, the submission API response, and the absence of any CLI surface for inspection.

**Signal-to-noise:** The data model is thoughtful. The skip reason taxonomy is particularly good — distinguishing `quota` from `disabled` from `error` is exactly the kind of nuance that makes population data actionable rather than just large.

---

## Detailed Findings

### 1. Onboarding Experience — NEEDS WORK

**Rating: 3/5**

The spec says telemetry is opt-in with default OFF, which is correct. But it says nothing about *how* a user or agent builder enables it. The only mechanism described is editing `config.json` directly:

```json
{
  "monitoring": {
    "telemetry": {
      "enabled": false
    }
  }
}
```

**Problems:**
- No CLI command to enable/disable. A developer has to know the exact JSON key path. This is a lookup problem masquerading as a config problem.
- No first-run notice. A new instar user will never know this exists unless they read docs. Since adoption requires awareness, this is a growth limiter.
- No feedback when telemetry is enabled. The first time data is submitted, nothing visible happens unless the user knows to look at the submissions log.
- "Time to first value" is undefined. How long until a user enabling telemetry sees the population size reflected back? The response includes `populationSize` but there is no documentation or onboarding message that tells them to expect it.

**Recommendations:**
- Add `instar telemetry enable` / `instar telemetry disable` / `instar telemetry status` CLI commands.
- On first run after `instar server start` (or in the first heartbeat cycle), emit a one-time notice: "Telemetry is available. Run `instar telemetry enable` to contribute anonymous metrics." Do not auto-prompt; just make it discoverable.
- When telemetry is enabled and the first submission succeeds, log a human-readable confirmation: "Telemetry: first submission accepted. Population size: 42. Audit log: .instar/telemetry/submissions.jsonl"

---

### 2. API Design — MOSTLY GOOD, TWO GAPS

**Rating: 4/5**

The submission endpoint is clean:

```
POST /v1/telemetry
```

The payload structure is sensible. Version in the top-level envelope is good practice. The `window` field is a smart addition for server-side deduplication.

**Positives:**
- Anonymous installation ID using a hash is exactly right.
- Fire-and-forget with no retry is appropriate — telemetry failure must not block the agent.
- Submission frequency aligned with the heartbeat avoids introducing a new timer.

**Gap 1: Response schema is underspecified**

The response is documented as:
```json
{
  "accepted": true,
  "populationSize": 42,
  "nextSubmissionAfter": "2026-03-22T12:00:00Z"
}
```

But what does `accepted: false` mean? Is it transient (retry) or permanent (schema mismatch, version unsupported)? The spec does not define error responses at all. Without defined error semantics, client code will guess — typically by silently swallowing all non-200 responses, which breaks the debug path.

**Recommendation:** Define the error envelope:
```json
{
  "accepted": false,
  "error": "schema_version_unsupported",
  "message": "Submit a schema upgrade or downgrade to a supported version"
}
```

Include: `schema_version_unsupported`, `rate_limited`, `payload_too_large`, `malformed`.

**Gap 2: No API versioning strategy documented**

The endpoint is `/v1/telemetry`. Good. But the spec does not say what happens when the payload schema evolves (which it will — Phase 2 and Phase 3 both require new fields). Does the server accept partial payloads? Does it reject unknown fields? Is the client responsible for version negotiation?

**Recommendation:** Add a paragraph on forward/backward compatibility contract. Suggest: server accepts unknown fields and ignores them; client sends `schemaVersion` field in the envelope; server rejects submissions where `schemaVersion` is below minimum supported.

---

### 3. Authentication Flow — CLEAN

**Rating: 5/5**

No auth on the submission endpoint is the right call for anonymous telemetry. The installation ID hash provides the only identity anchor needed. Requiring auth tokens would create a barrier to contribution and would introduce a new secret management surface for no privacy benefit. This is correct.

---

### 4. Data Contribution Experience — GOOD, ONE CONCERN

**Rating: 4/5**

The data model is the strongest part of the spec. The skip reason taxonomy deserves specific praise — it encodes domain knowledge about *why* a skip is interesting before a single byte of data has been collected. That is good speccing.

**One concern: `feature flags` field is underspecified**

```json
"featureFlags": { "feature": enabled }
```

What is "feature"? Which features are tracked? How are new features added to this map? If an agent is running v0.8.x and a new feature flag exists only in v0.9.x, what does the server receive? The field is listed but never defined.

**Recommendation:** Either enumerate the specific feature flags that Phase 1 will track (and note they are pinned to a schema version), or remove this field from Phase 1 and add it in Phase 2 once the schema story is clearer. A vague map is worse than no map because it creates inconsistent data across agent versions.

---

### 5. Query Experience (Local Transparency Log) — NEEDS WORK

**Rating: 3/5**

The local transparency log is the spec's strongest DX commitment:

```json
{
  "timestamp": "2026-03-22T06:00:00Z",
  "metricsSubmitted": { "jobCount": 23, "featureFlags": 5 },
  "endpoint": "v1/telemetry",
  "responseStatus": 200
}
```

This is viewable via `GET /telemetry/submissions`. Good. But the log entry as shown is nearly useless for actual audit. It tells you *that* data was submitted, not *what* was submitted.

**Problems:**
- A user who wants to verify "did anything sensitive go out?" cannot answer that question from this log. They would have to trust the implementation.
- `metricsSubmitted: { "jobCount": 23 }` means 23 jobs had metrics submitted — but which metrics? What values? A count is not an audit trail.
- No way to see the most recent submission payload in its entirety.

**Recommendations:**
- Store the full outgoing payload (or a canonical hash + field list) in the local log, not just the count. The full payload is JSON, it is small, and it is what "local transparency" actually means.
- Add `GET /telemetry/submissions/latest` that returns the most recent full payload that was sent. This is the key audit query: "show me exactly what you sent."
- Add `GET /telemetry/submissions?limit=10` with pagination support. A JSONL file that grows indefinitely with no pagination API is a footgun.

---

### 6. Documentation — INCOMPLETE FOR SHIPPING

**Rating: 3/5**

The spec reads like an internal design document, which is appropriate for a spec. But the document notes it is for building Phase 1. Phase 1 is a user-facing feature change. The spec does not specify:

- Where end-user documentation will live (AGENT.md? Docs site? README?)
- What the changelog entry will say
- Whether the CLAUDE.md capability index needs updating (it does — this becomes a new row in the capability table)
- What the consent UX looks like if topic 1895 is not complete by the time Phase 1 ships

**The dependency on topic 1895 is a risk.** The spec explicitly defers consent UX to that topic. If Phase 1 ships before 1895 is resolved, there is no consent story — users would have to edit JSON directly to opt in, which is not a credible consent UX. This cross-spec dependency should be made explicit with a clear statement: "Phase 1 is blocked until 1895 delivers a consent surface, or this spec must own a minimal consent UX as a fallback."

---

### 7. Developer Ergonomics — MISSING

**Rating: 2/5**

This is the most significant gap. The spec describes what gets collected and where it goes, but provides no tooling for a developer to introspect, debug, or verify the telemetry pipeline end-to-end.

**Missing entirely:**
- No `instar telemetry status` showing: enabled/disabled, last submission time, last response, current population size, next scheduled submission.
- No dry-run mode. A developer enabling telemetry for the first time has no way to preview what would be sent without actually sending it.
- No health endpoint surface. The server exposes `GET /health` — does that show whether the telemetry collector is running? It should.
- No explicit handling for clock skew. The `nextSubmissionAfter` field in the response is a server timestamp. If the client clock is drifted, this could cause double-submissions or missed windows. The spec should specify that the client uses the duration between submission time and `nextSubmissionAfter`, not the absolute timestamp.
- No mention of what happens at agent startup if a submission is overdue. Does it submit immediately? Does it wait for the next scheduled window? This gap means the behavior is left to implementation choice, which will be inconsistent.

**Recommendations:**
- Define `GET /telemetry/status` returning:
  ```json
  {
    "enabled": true,
    "lastSubmission": "2026-03-22T06:00:00Z",
    "lastResponseStatus": 200,
    "nextSubmission": "2026-03-22T12:00:00Z",
    "populationSize": 42
  }
  ```
- Add a `?dryRun=true` query param on `GET /telemetry/status` (or a separate `GET /telemetry/preview`) that returns the payload that would be submitted in the next window, without sending it.
- Specify startup behavior: if a submission is more than 1 hour overdue at startup, submit immediately; otherwise wait for the scheduled window.

---

## Summary Table

| Dimension | Rating | Key Issue |
|-----------|--------|-----------|
| Onboarding Experience | 3/5 | No CLI surface; no first-run discoverability |
| API Design | 4/5 | Error responses and schema versioning unspecified |
| Authentication Flow | 5/5 | Correct — no auth needed |
| Data Contribution Experience | 4/5 | `featureFlags` field underspecified |
| Query Experience (local log) | 3/5 | Log entry does not contain actual payload |
| Documentation | 3/5 | Consent UX dependency not gated; no changelog plan |
| Developer Ergonomics | 2/5 | No status endpoint, no dry-run, no CLI introspection |

---

## Blocking Issues (Must Fix Before Shipping Phase 1)

1. **Consent UX dependency** — Either gate Phase 1 on topic 1895, or define a minimal fallback consent UX within this spec. Shipping without a consent surface means opt-in is a JSON edit, which is not acceptable.

2. **Error response semantics** — Define the error envelope for rejected submissions. Without this, client error handling will be undefined and the debug path will be blind.

3. **Local log must contain actual payload** — A log that says "23 jobs submitted" does not constitute a transparency log. It needs the full outgoing payload or the audit guarantee is hollow.

## High-Priority Recommendations (Ship With or Shortly After)

4. Add `instar telemetry status` / `enable` / `disable` CLI surface.
5. Add `GET /telemetry/status` server endpoint.
6. Add `GET /telemetry/submissions/latest` for full payload inspection.
7. Define schema versioning and forward-compatibility contract.
8. Specify startup behavior for overdue submissions.

## Lower Priority (Phase 2 or Later)

9. Dry-run preview mode.
10. Pagination on `GET /telemetry/submissions`.
11. Enumerate specific `featureFlags` keys for Phase 1.
12. Add telemetry status to `GET /health` response.

---

## Closing Note

The core design is sound. Privacy architecture is strong, phasing is appropriate, and the skip reason taxonomy shows genuine domain thinking. The gaps are mostly in the developer-facing surface: the tooling a builder reaches for when they want to understand, debug, or trust the system. Closing the blocking issues and the CLI gap would bring this to a shippable state with good DX fundamentals.
