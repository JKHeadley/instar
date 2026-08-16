# SpecReview Synthesis: Dashboard Observability

**Review ID**: 20260320-113858
**Date**: 2026-03-20
**Round**: 1
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing
**Spec**: specs/dashboard-observability.md

---

## Overall Assessment

**Status**: NEEDS WORK
**Average Score**: 7.0 / 10
**Score Range**: 5.5 - 8.0

| Reviewer | Status | Score | Key Finding |
|----------|--------|-------|-------------|
| Security | CONDITIONAL | 7/10 | Rate limits missing on new mutation endpoints; PATCH CORS oversight; operation log leaks sensitive decision context |
| Scalability | CONDITIONAL | 7.5/10 | Unbounded JSONL ledger is the primary time bomb; monolithic file approaching maintainability cliff |
| Business | APPROVE | 8/10 | Strong problem-solution fit; attention queue undervalued; Phase 3 (evolution/trust) is true strategic moat |
| Architecture | CONDITIONAL | 7.5/10 | `switchTab()` doesn't scale to Phase 3; WebSocket message dispatch fragile; tab overflow unresolved |
| Privacy | CONDITIONAL | 7/10 | Unauthenticated `/health` leaks operational state; no retention policy; raw error messages expose internals |
| Adversarial | CONDITIONAL | 5.5/10 | `POST /jobs/:slug/run` is a remote code execution primitive behind a single token; operation log reveals gate's rulebook |
| DX / API | CONDITIONAL | 7.5/10 | Vital signs drill-down broken for Phase 1; "Run Now" feedback loop unspecified; 5 critical UX gaps |
| Marketing | CONDITIONAL | 7/10 | No positioning narrative; "Dashboard Observability" is wrong name; buried origin story |

---

## Consensus Findings

*Issues that 3+ reviewers independently identified:*

1. **Unbounded JSONL ledger / no retention policy**: Identified by Security (OBS-05), Scalability (ISSUE 1), Privacy (Critical Issue 3), Adversarial (OBS-5), Architecture (Recommendation 2), DX (History Retention)
   - Summary: The job history ledger grows indefinitely. At current growth rate (~2MB/day, ~60MB/month), slug-filter queries degrade to 440ms+ at 12 months. The spec explicitly defers this as an open question, but all reviewers agree it must be answered before the Reports view ships. Additionally, unbounded retention is a data minimization failure under GDPR proportionality principles.
   - Recommended action: Cap at 500 runs per job (configurable). Add nightly trim job. Implement before Phase 2 build begins. Consider 90-day time-based cutoff as a secondary bound.

2. **Unauthenticated `/health` endpoint exposes sensitive operational state**: Identified by Security (ISSUE-SEC-05), Privacy (Critical Issue 1), Adversarial (CRIT-1), DX (Critical Issue 2)
   - Summary: `/health` returns session counts, disk %, memory pressure, job failure counts, and uptime — all with no authentication. With Cloudflare tunnel active, this is internet-accessible to anyone. The adversarial reviewer notes this is a reconnaissance gift: session saturation signals attack timing windows, disk pressure signals near-full filesystem.
   - Recommended action: Split into a public `/ping` returning only `{"status":"ok"}` and an authenticated `/health/detail` endpoint. The vital signs strip polls the authenticated endpoint post-login. This is a clean breaking change — external health monitors use `/ping`.

3. **Tab overflow and navigation architecture unresolved**: Identified by Architecture (Critical Issue 1 + Recommendation 1), DX (Critical Issue 6 + R6), Scalability (R7), Marketing (Risk 4)
   - Summary: Phase 1 adds 1 tab (4 total). Phase 3 adds 3 more (7 total). The current `switchTab()` is imperative and brittle. Seven flat tabs overflow on 320px screens. This decision affects HTML structure for every new tab — deferring it creates rework.
   - Recommended action: Adopt a data-driven `TAB_REGISTRY` pattern now (Architecture's 30-minute refactor). Commit to a "System" dropdown grouping Jobs, Health, Evolution, Autonomy before Phase 1 ships. Tab bar stays at 4 top-level items.

4. **Missing rate limits on new mutation endpoints**: Identified by Security (ISSUE-SEC-02), Adversarial (CRIT-2, REC-5), Scalability (Compute section)
   - Summary: `POST /jobs/:slug/run` has no rate limit. An attacker (or accidental double-click) can spam job triggers, exhausting Claude API quota and session capacity. The UI-only "disable while running" button provides zero server-side protection.
   - Recommended action: Server-side rate limit: max 1 manual trigger per job per schedule interval. Global cap of 5 concurrent manual triggers. Return 409 Conflict if job is already running.

5. **`PATCH /jobs/:slug` has no field allow-list**: Identified by Security (ISSUE-SEC-06), Adversarial (implicit in CRIT-3)
   - Summary: The spec only describes enabling/disabling jobs, but doesn't constrain what fields the endpoint accepts. A naive merge would allow modifying job schedules, model selection, or prompts — with significant cost and behavioral implications.
   - Recommended action: Explicitly restrict to `{ enabled: boolean }`. All other fields → 400 Bad Request. Document this constraint in the spec.

6. **WebSocket message dispatch is fragile**: Identified by Architecture (Critical Issue 2), Scalability (R4 — prefer SSE), DX (R5 — promote to Phase 1)
   - Summary: The current `ws.onmessage` assignment pattern and monkey-patching in Drop Zone will cause job events to be silently dropped after WebSocket reconnects. Adding job events to a broken dispatch architecture creates hard-to-debug regressions.
   - Recommended action: Refactor to a pub-sub `wsOn(type, fn)` pattern before adding job events. Alternatively, use a new SSE endpoint (`GET /jobs/events`) to avoid coupling job-event latency requirements with session-output latency requirements.

---

## Critical Issues (Blockers)

*No reviewer issued a full BLOCK status. The Adversarial reviewer's 5.5/10 is the lowest score, with conditional approval. The following issues are the closest to blockers and must be addressed before specific phases proceed:*

| # | Issue | Reviewer | Severity | Phase Gate | Suggested Fix |
|---|-------|----------|----------|------------|---------------|
| 1 | Unauthenticated `/health` feeds vital signs strip | Security, Privacy, Adversarial | HIGH | Before Phase 1 ships | Public `/ping`, auth-gated `/health/detail` |
| 2 | `POST /jobs/:slug/run` — no rate limit, no server-side running-state guard | Security, Adversarial, Scalability | HIGH | Before Phase 1 ships | Per-slug rate limit + 409 on duplicate trigger |
| 3 | `PATCH /jobs/:slug` — no field allow-list | Security | HIGH | Before Phase 1 ships | Explicit allow-list: only `enabled` |
| 4 | Unbounded ledger — no retention policy | Scalability, Privacy, Security, Architecture | HIGH | Before Phase 2 (Reports) ships | 500-run cap per job, nightly trim |
| 5 | `switchTab()` does not scale to Phase 3 | Architecture | MEDIUM | Before Phase 3 ships | Data-driven TAB_REGISTRY refactor |
| 6 | WebSocket dispatch fragile for job events | Architecture | MEDIUM | Before real-time job events ship | pub-sub `wsOn()` refactor or SSE endpoint |
| 7 | Operation log reveals gate's rulebook | Security, Adversarial | MEDIUM | Before Phase 3 (Autonomy tab) ships | Sanitize: show decision + category, not full parameters |
| 8 | Evolution proposal approval — no elevated auth | Adversarial | MEDIUM | Before Phase 3 (Evolution tab) ships | PIN re-entry for approve/reject; log to security.jsonl |

---

## Conflicts

*Points where reviewers disagree or provide contradictory recommendations.*

### Conflict 1: WebSocket Job Events — Phase 1 Priority vs. SSE Alternative

- **DX Reviewer** says: WebSocket job events should be Phase 1, not a stretch goal. 30-second lag on job failure visibility is significant for a monitoring dashboard.
- **Scalability Reviewer** says: Use SSE (`GET /jobs/events`) instead of the existing WebSocket — SSE is unidirectional, simpler to operate, and avoids coupling session-output and job-event latency requirements.
- **Architecture Reviewer** says: The WebSocket dispatch must be refactored first; without that, adding job events will cause reconnection-related silent drops.
- **Tension**: All three agree real-time events are valuable. The dispute is over whether to extend WebSocket (after fixing dispatch) or introduce a new SSE endpoint. The Architecture + Scalability position is more cautious and architecturally cleaner. The DX position is that users shouldn't wait.
- **Resolution recommendation**: SSE is the better long-term answer and avoids the fragility risk. Treat `GET /jobs/events` as Phase 1 server work, with WebSocket as the fallback. This resolves the DX urgency without the architectural fragility.

### Conflict 2: Attention Queue — Header Badge vs. Dedicated Tab

- **Architecture Reviewer** says: Close the open question in favor of the header badge + slide-out panel. Attention items are urgent, rare, and actionable — a header pattern, not a tab.
- **Business Reviewer** says: The attention queue is undervalued — consider making it the *default landing view* when there are open items.
- **DX Reviewer** says: Commit to header badge + slide-out now because this decision affects Phase 1 header structure.
- **Tension**: Business wants to elevate it further; Architecture and DX want it decided now as a header element.
- **Resolution recommendation**: Architecture and DX are aligned. Adopt header badge + slide-out panel for Phase 1. The Business suggestion to make it the default landing view is compatible with this approach (redirect to the slide-out state on login if items exist).

### Conflict 3: Monolithic Index.html — Accept vs. Plan Escape

- **Business Reviewer** says: The no-external-dependencies constraint is strategically sound and excellent product discipline. Zero-dependency dashboard is correct.
- **Scalability Reviewer** says: The monolithic file has no stated escape hatch. At 200KB+ with Phase 3, developer experience degrades meaningfully — a build step and module splitting will eventually be worth it.
- **Architecture Reviewer** says: The no-build-step constraint is correct. The right answer is architectural patterns (TAB_REGISTRY, wsOn pub-sub) applied to vanilla JS, not a framework.
- **Tension**: Business and Architecture defend the constraint; Scalability flags the long-term maintenance cost.
- **Resolution recommendation**: The Architecture position is most balanced. Adopt the TAB_REGISTRY and pub-sub patterns to manage complexity within the constraint. Revisit the build-step question if/when the file exceeds 250KB. The constraint is correct for now.

---

## Recommendations (Prioritized)

| Priority | Recommendation | Source Reviewers | Effort | Impact |
|----------|---------------|-----------------|--------|--------|
| P0 | Split `/health` into public `/ping` + auth-gated detail | Security, Privacy, Adversarial, DX | Low (1-2h server) | Eliminates reconnaissance exposure |
| P0 | Add rate limit + 409 guard to `POST /jobs/:slug/run` | Security, Adversarial, Scalability | Low (1h server) | Prevents quota exhaustion attack |
| P0 | Enforce field allow-list on `PATCH /jobs/:slug` (only `enabled`) | Security | Low (30min) | Closes unintended config mutation |
| P0 | Add `PATCH` to CORS allowed methods in middleware.ts | Security | Trivial (5min) | Prevents CORS preflight failures |
| P1 | Decide retention policy before building Reports view | Scalability, Privacy, Security, Architecture | Medium (1 day) | Prevents unbounded ledger technical debt |
| P1 | Refactor `switchTab()` to data-driven TAB_REGISTRY | Architecture | Low (30min) | Unlocks Phase 3 without regressions |
| P1 | Implement SSE `GET /jobs/events` for real-time updates | DX, Scalability, Architecture | Medium (2-3h) | Eliminates 30s monitoring lag |
| P1 | Resolve tab overflow — commit to "System" dropdown grouping | Architecture, DX, Scalability | Low (1h design) | Prevents HTML structure rework in Phase 3 |
| P1 | Implement `wsOn(type, fn)` pub-sub dispatch | Architecture | Low (1h) | Prevents silent event drops after reconnect |
| P2 | Add error message sanitization layer | Security, Privacy | Medium (2h) | Reduces internal state leakage |
| P2 | Add dashboard action audit log (Run Now, Enable/Disable, Dismiss) | Privacy, Adversarial | Medium (2-3h) | Enables post-incident forensics |
| P2 | Spec "Run Now" feedback loop explicitly (2s polling + elapsed timer + 120s timeout) | DX | Low (1h spec) | Prevents user confusion + duplicate runs |
| P2 | Add tiered auth: PIN re-entry for Evolution approve/reject and trust changes | Adversarial, Privacy | Medium (3-4h) | Reduces blast radius of token theft for Phase 3 |
| P2 | Resolve vital signs drill-down broken affordance (links to non-existent tabs) | DX | Low (1h) | Prevents broken click behavior at launch |
| P3 | Sanitize operation log display before Phase 3 (decision + category, not full params) | Security, Adversarial | Medium | Prevents gate rulebook exposure |
| P3 | Add HTTP security headers (X-Frame-Options, X-Content-Type-Options, CSP) | Security, Adversarial | Low (1-2h server) | Defense-in-depth for tunneled access |
| P3 | Rename feature to "Agent Pulse" for user-facing copy | Marketing | Low (copy only) | Improves positioning and memorability |
| P3 | Server-side pagination for `/jobs/history` from day one | Scalability | Low (1h) | Prevents fetch-all-then-slice pattern |

---

## Scalability Summary

| Phase | Assessment | Key Risks | Reviewers Agree? |
|-------|-----------|-----------|-----------------|
| **MVP (Phase 1)** | Solid — 30s poll, lazy history load, no external deps. 4 requests/minute is negligible. | CORS PATCH oversight will break toggle; unauthenticated `/health` is live risk in tunneled deployments | Yes — all reviewers approve Phase 1 proceeding after P0 fixes |
| **Growth (Phase 2, ~3-6 months)** | Conditional — Reports view depends on retention policy decision. Without it, JSONL scan degrades to 200ms+ per slug query. | Ledger growth becomes user-noticeable (query latency); monolith approaches 5,500 lines; attention queue action log needed before mutations ship | Consensus: do not ship Reports view without retention policy |
| **Scale (Phase 3, 100x / multi-agent)** | Requires prep — evolution/trust controls need elevated auth tier; operation log sanitization needed; 7 tabs needs navigation rework | Tab overflow becomes a real problem; single-token model insufficient for evolution approve/reject; operation log exposes gate rulebook to token holders | Partial: Architecture + Adversarial agree Phase 3 needs stronger auth. Business sees Phase 3 as strategic moat — supports prioritizing it. |

---

## Gaps

*Areas that no reviewer adequately covered, or where the spec is silent:*

1. **Job output persistence decision (Open Question 1)**: Every reviewer noted this is blocking for Phase 2, but no reviewer proposed a specific storage schema. The spec mentions `.instar/ledger/job-outputs/` as a possibility. This needs a concrete storage design (file naming, size limits, cleanup policy) before Phase 2 begins.

2. **"Run Now" response contract**: The spec and DX reviewer identified the feedback loop gap, but no reviewer specified what `POST /jobs/:slug/run` should return. The Architecture reviewer suggested 202 Accepted + run ID. No reviewer specified how the run ID maps to session names, or how the history polling loop should correlate the triggered run.

3. **Multi-agent dashboard data model**: The Scalability reviewer flagged that `machineId` is already in ledger records, hinting at multi-agent federation. No reviewer analyzed whether the current API responses are structured to support multi-agent aggregation in the dashboard, or what changes would be needed.

4. **Accessibility**: Only the DX reviewer mentioned accessibility (color-only status indicators failing 8% of color-blind users). No reviewer assessed keyboard navigation, screen reader compatibility, or ARIA labeling for the new components. This is a gap given the spec's mobile-first claims.

5. **Cron-to-human converter edge cases**: The DX reviewer flagged complex cron expressions (e.g., `0 0 1,15 * *`). No reviewer specified what the full set of cron patterns in the current 23 jobs actually looks like, so the converter's required coverage is unknown. A survey of `.instar/jobs.json` patterns should inform the converter design.

6. **Handoff notes storage model**: The spec proposes showing handoff notes inline in the Reports view. Privacy flagged they may contain sensitive content. No reviewer analyzed where handoff notes are currently stored, whether they're already in the ledger, or whether they need a separate retention policy.

---

## Convergence Status

| Metric | Value |
|--------|-------|
| Reviewers in agreement (APPROVE) | 1 / 8 |
| Conditional approvals | 7 / 8 |
| Blockers | 0 / 8 |
| Open conflicts | 3 |

**Convergence**: CONVERGING

The reviews converge strongly on: Phase 1 proceeding after P0 security fixes; retention policy as a Phase 2 pre-condition; tab architecture refactor before Phase 3. The three conflicts (WebSocket vs SSE, attention queue placement, monolith escape hatch) are all resolvable without stalling progress — they don't require consensus to proceed.

---

## Next Steps

- [ ] **Before writing any Phase 1 code**: Fix CORS (add PATCH), split `/health` into ping + auth-gated detail, add rate limit + 409 guard to `POST /jobs/:slug/run`, add field allow-list to `PATCH /jobs/:slug`
- [ ] **Architecture prep (30-min each)**: Refactor `switchTab()` to TAB_REGISTRY; implement `wsOn()` pub-sub dispatch
- [ ] **Resolve open questions in spec**: Tab overflow → commit to System dropdown; Attention queue → commit to header badge + slide-out; Real-time events → commit to SSE `GET /jobs/events`
- [ ] **Decision gate before Phase 2**: Retention policy must be decided and implemented (500 runs per job + nightly trim job) before Reports view is built
- [ ] **Decision gate before Phase 3**: Implement PIN re-entry for evolution approve/reject; sanitize operation log endpoint; add HTTP security headers
- [ ] **Launch prep (Marketing)**: Write the 8-consecutive-spawn-error origin story; rename feature to "Agent Pulse" in user-facing copy; prepare vital signs strip screenshot for Phase 1 launch post

---

*Generated by SpecReview multi-agent analysis. Round 1 of 1.*
