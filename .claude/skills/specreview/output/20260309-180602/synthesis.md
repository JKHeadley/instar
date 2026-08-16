# SpecReview Synthesis: Cross-Topic Injection Defense

**Review ID**: 20260309-180602
**Date**: 2026-03-09
**Spec**: specs/cross-topic-injection-defense.md

## Overall Status
**NEEDS WORK**

The spec demonstrates strong security thinking, correct threat identification, and an elegant layered architecture. However, 6 of 8 reviewers gave conditional approval, citing critical gaps in cryptographic provenance, warning mechanism vulnerability, privacy/data handling, and developer experience. No reviewer blocked, but the volume and severity of conditional findings — particularly around the warning-as-injection-vector problem and tag forgery — warrant resolution before implementation.

## Score Summary
| Reviewer | Score | Status |
|----------|-------|--------|
| Security | 6/10 | CONDITIONAL |
| Scalability | 7/10 | CONDITIONAL |
| Business | 8/10 | APPROVE |
| Architecture | 8/10 | APPROVE |
| Privacy | 6/10 | CONDITIONAL |
| Adversarial | 6.5/10 | CONDITIONAL |
| DX | 7/10 | CONDITIONAL |
| Marketing | 6/10 | CONDITIONAL |
| **Average** | **6.8/10** | |
| Min | 6/10 | (Security, Privacy, Marketing) |
| Max | 8/10 | (Business, Architecture) |

## Consensus Findings (3+ reviewers agree)

- **Warning injection is itself an injection vector**: Security, Architecture, Adversarial, DX (4 reviewers). The warning text competes with attacker content in the same context window. Sophisticated payloads can neutralize the warning. This is the single most-agreed-upon critical issue.

- **Provenance tags lack cryptographic verification**: Security, Adversarial, Architecture (3 reviewers). Plain-text `[telegram:N]` tags are trivially forgeable by any same-user process. HMAC-signed tags are the recommended fix.

- **Rate limiter burst creates a bypass vector**: Security, Scalability, Adversarial, Architecture, DX (5 reviewers). The 1-per-5s rate limiter with fail-open means an attacker sending multiple messages in rapid succession gets most through unreviewed. Token bucket or queue-based approaches recommended.

- **Dashboard allowlisting (Phase 3) should be Phase 1 or 1.5**: Scalability, Business, Architecture, DX, Marketing (5 reviewers). Without dashboard tagging, every dashboard input to a topic-bound session triggers false positives. This will be the most visible user friction.

- **"Warn, don't block" default is correct**: Business, Architecture, DX, Scalability, Marketing, Privacy (6 reviewers). Universally praised as the right UX/security tradeoff. Blocking creates false-positive burden that gets features disabled.

- **Layered architecture (deterministic + LLM) is sound**: All 8 reviewers affirm the three-layer approach as correct defense-in-depth, with the deterministic first layer handling 95%+ of cases at zero cost.

- **Deterministic heuristics should precede LLM review**: Security, Architecture, Adversarial, Privacy (4 reviewers). Regex patterns for known injection signatures ("ignore previous instructions", role-switching language) should run before the Haiku call, reducing both cost and attack surface.

- **`[AGENT MESSAGE]` tag is too broadly trusted**: Security, Adversarial (plus Architecture mentions it). Automatic PASS for agent messages creates a bypass path if any agent is compromised or the tag format is spoofed.

- **No observability/metrics**: Scalability, Business, DX (3 reviewers). The spec logs to security.jsonl but provides no counters, dashboards, or stats endpoints for monitoring detection rates, false positives, or review latency.

- **Environment variables for binding are fragile**: Scalability, Architecture, DX (3 reviewers). Set at spawn time, cannot change. If session is reassigned or needs multi-topic scope, env vars go stale.

## Critical Issues (any reviewer blocked or raised critical)

- **Warning-as-text vulnerability (P0)**: Security, Adversarial — Attacker can craft counter-narratives that neutralize the warning in the same context window. Recommended: deliver warnings via system prompt or structured metadata, not inline text.

- **Tag forgery (P0)**: Adversarial, Security — Any same-user process can prepend a valid `[telegram:N]` tag to an injection. Without HMAC verification, provenance check is "security theater." Recommended: cryptographic message authentication.

- **tmux socket is the true attack surface (P0/P1)**: Security, Adversarial, Architecture — The entire defense operates at the application layer, but the injection primitive (`tmux send-keys`) has no authentication. Any same-user process bypasses all layers.

- **Synchronous LLM call in injection hot path (P1)**: Scalability, DX — `injectMessage` is currently synchronous. Adding an async ~1s Haiku call blocks the message delivery pipeline. Async-parallel (inject first, review in background) recommended.

- **Message content sent to external LLM without consent disclosure (P1)**: Privacy — Full message text sent to Haiku API for classification with no data minimization, no retention policy, and no user disclosure. GDPR Art. 22 implications for block mode.

- **`injectMessage` sync-to-async migration scope underestimated (P1)**: DX — The spec claims callers are already async, but DX reviewer found `injectMessage` uses `execFileSync` with sync callers. Refactoring scope is non-trivial.

- **CONTINUATION prefix bypass**: Adversarial — Messages starting with `CONTINUATION` pass provenance unconditionally. An attacker can prefix injections with this keyword. Should be restricted to session initialization only.

## Conflicts (reviewers disagree)

- **Fail-open vs. fail-closed**: Security recommends fail-closed for Layer 2 (prepend warning by default when classifier unavailable). Scalability, Architecture, Business, and DX all support fail-open for availability. The DX/Scalability position is that fail-closed creates latency and user friction; Security's position is that fail-open under attack conditions negates the defense. **Resolution path**: Fail-open with a deterministic fallback (regex-based injection pattern check when LLM is unavailable).

- **Async-blocking vs. async-parallel for Layer 2**: DX and Scalability recommend injecting immediately and reviewing in parallel (warning follows if suspicious). Security and Adversarial prefer blocking until review completes (no suspicious content reaches session unwarned). Architecture notes both are valid. **Resolution path**: Async-parallel is more pragmatic given the "warn, don't block" philosophy — the warning arrives 1-2s after the message, well before the LLM generates a response.

- **Severity of "warn-only" approach**: Business sees it as a strength ("developer-friendly, differentiated positioning"). Security and Adversarial see it as a weakness ("a sufficiently crafted injection always reaches the session"). Privacy sees it as privacy-respectful. **Resolution path**: Not a true conflict — all agree warn is the correct default, but enterprise/high-security deployments should have a straightforward path to block mode.

## Gaps (areas no reviewer covered)

- **Testing strategy**: No reviewer addressed how to test this feature — unit tests for provenance parsing, integration tests for the Haiku classifier, adversarial test suite. DX mentioned a test endpoint but not a broader testing plan.

- **Rollback plan**: No mention of how to safely disable the feature if it causes problems in production, beyond setting `enabled: false`.

- **Internationalization / non-English messages**: The coherence reviewer prompt and injection patterns assume English. No reviewer addressed how non-English messages would be handled.

- **Performance benchmarks**: Scalability estimated latency but no reviewer called for actual benchmarks (p50/p99 injection latency with and without Layer 2).

- **Interaction with existing Coherence Gate**: The spec mentions the output-side Coherence Gate but no reviewer deeply analyzed how the two systems interact, potential conflicts, or redundancy.

- **Mobile/low-bandwidth scenarios**: No discussion of how the ~1s Layer 2 latency affects users on mobile networks accessing via tunnel.

## Top Recommendations (prioritized by impact)

1. **Add cryptographic message authentication (HMAC-signed tags)** — Closes the tag forgery vector, which is the single most exploitable gap. Without this, provenance checking verifies a convention, not an identity. (Security, Adversarial, Architecture)

2. **Restructure the warning mechanism** — Move warnings to system prompt level or structured metadata, not inline text. Alternatively, use a gatekeeper model that makes block/pass decisions without exposing suspicious content alongside a bypassable warning. (Security, Adversarial, Architecture)

3. **Add deterministic injection pattern detection before LLM review** — Regex for known signatures ("ignore previous instructions", role-switching, system prompt references, zero-width characters). Zero-cost, catches obvious attacks, reduces LLM call volume. (Security, Architecture, Adversarial, Privacy)

4. **Move dashboard allowlisting to Phase 1** — Dashboard is the primary source of legitimate untagged messages. Without early tagging, every dashboard interaction triggers false positives. Tag at source (`[dashboard:SESSION_ID]`) rather than allowlisting via env var. (Scalability, Business, Architecture, DX, Marketing — 5 reviewers)

5. **Switch to async-parallel review** — Inject immediately, review in background, inject follow-up warning if suspicious. Eliminates latency from injection path, avoids sync-to-async migration across all callers, preserves security benefit. (Scalability, DX)

6. **Redesign rate limiter** — Replace 1-per-5s fixed window with token bucket (e.g., 10 tokens, refill 2/sec). Add circuit breaker for API degradation (trip after 3 failures, skip review for 60s). (Scalability, Adversarial)

7. **Add data minimization for Haiku calls** — Send topic keywords/summary rather than full message text and conversation history. Consider local embedding-based similarity check before external API call. Add retention policy for security.jsonl. (Privacy)

8. **Rename the feature and give it a top-level config section** — "Cross-Topic Injection Defense" is unsellable and architecturally limiting. Recommended name: "Input Guard" (pairs with existing "Coherence Gate"). Move config out of `responseReview.inputValidation` to its own section. (Marketing, DX)

9. **Add observability** — Counters for total/passed/warned/blocked messages, review latency (p50/p99), false positive rate. Expose via `/status` or a dedicated `/security/stats` endpoint. (Scalability, Business, DX)

10. **Restrict `[AGENT MESSAGE]` and `CONTINUATION` bypass paths** — Agent messages should carry sender identity and signature. CONTINUATION should only be honored on session initialization, not arbitrary messages. (Adversarial, Security)

## Scalability Summary
| Phase | Assessment | Key Risks |
|-------|-----------|-----------|
| MVP (current: 1 agent, <50 sessions) | Strong. Layer 1 is O(1), Layer 2 triggers rarely (<5/day). Cost ~$0.03/mo. | False positives from dashboard input without Phase 3. Sync LLM call adds ~1s to reviewed messages. |
| Growth (10x: 10 agents, 50 sessions) | Fine with minor changes. ~50 Haiku calls/day, ~$0.30/mo. | Rate limiter burst bypass becomes more likely. security.jsonl grows unbounded. Env var binding goes stale on reassignment. |
| Scale (100x: 100 agents, multi-user) | Needs architectural changes. ~500 calls/day, ~$3/mo. | Synchronous review becomes head-of-line blocking. Single-topic binding is limiting. Cross-user data exposure in reviewer prompts. Need DPIA for GDPR. |

## Next Steps
- [ ] Address P0: Add HMAC-signed provenance tags (closes tag forgery)
- [ ] Address P0: Restructure warning delivery (system prompt or structured metadata, not inline text)
- [ ] Address P1: Add deterministic injection pattern pre-filter (regex layer before Haiku)
- [ ] Address P1: Move dashboard source tagging to Phase 1 (tag at source, not allowlist via env var)
- [ ] Address P1: Switch to async-parallel review architecture (inject first, review in background)
- [ ] Address P1: Redesign rate limiter (token bucket + circuit breaker)
- [ ] Address P1: Add data minimization for Haiku calls and retention policy for security.jsonl
- [ ] Address P2: Rename feature to "Input Guard" and create standalone config section
- [ ] Address P2: Add observability counters and `/security/stats` endpoint
- [ ] Address P2: Restrict CONTINUATION and AGENT MESSAGE bypass paths
- [ ] Address P2: Design multi-topic binding data structure (array from the start)
- [ ] Address P2: Add privacy section to spec (data flows, lawful basis, retention, user rights)
- [ ] Create adversarial test suite for the feature
- [ ] Draft user-facing copy (changelog, docs, warning text)
