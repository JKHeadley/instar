# SpecReview Synthesis: Presence Proxy

**Review ID**: 20260327-124457
**Date**: 2026-03-27
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing
**Overall Status**: NEEDS WORK
**Average Score**: 6.8/10

---

## Score Summary

| Reviewer | Score | Status |
|----------|-------|--------|
| Security | 5/10 | CONDITIONAL — DO NOT IMPLEMENT AS WRITTEN |
| Scalability | 7.5/10 | CONDITIONAL APPROVE |
| Business | 8.5/10 | CONDITIONAL APPROVE |
| Architecture | 8/10 | APPROVED WITH CONDITIONS |
| Privacy | 6.5/10 | CONDITIONAL |
| Adversarial | 5.5/10 | CONDITIONAL APPROVE |
| DX | 7.5/10 | APPROVED WITH CONDITIONS |
| Marketing | 7.5/10 | CONDITIONAL APPROVE |

---

## Consensus (findings 3+ reviewers agree on)

**Prompt injection / tmux output sanitization** — Security, Privacy, and Adversarial all flag this as the single most dangerous unaddressed risk. Raw tmux terminal output (up to 200 lines) is fed directly into LLM prompts with no sanitization. Terminal output routinely contains credentials, tokens, and sensitive file contents. This creates both a data exfiltration vector (to external LLM APIs) and a prompt injection surface.

**Persistence of PresenceState** — Security, Scalability, and Adversarial all flag that timer state is in-memory only. Server restarts lose all tier snapshots, break delta comparison, risk duplicate tier fires, and allow restart-amplification attacks. All three agree the fix is disk persistence per topic.

**Rate limiting on LLM calls** — Security, Scalability, and Adversarial all flag the absence of per-topic LLM call caps. Without rate limiting, adversarial message timing or conversation mode flooding can exhaust Claude CLI session budgets at scale.

**Restart recovery algorithm underspecified** — Architecture, DX, and Business all note that Edge Case 4 ("re-initialize timers with adjusted delays") is intent, not a design. The actual algorithm — what to do when elapsed time spans tier boundaries, when snapshots are missing, whether to skip or synthesize — is not defined.

**CLI subprocess model is a scalability ceiling** — Scalability and Adversarial both flag that the `ClaudeCliIntelligenceProvider` spawning `claude -p` subprocesses per tier fire has no concurrency cap or queue. At 15-20+ concurrent active topics, Claude Max session budget exhaustion becomes a hard ceiling.

**Quiet command UX gap** — Scalability, DX, and Adversarial all flag that `quiet` gives no acknowledgment, no way to cancel early, and no way to check remaining silence time. A silenced proxy is indistinguishable from a broken one.

**Proxy conversation mode is the feature's differentiator** — Business and Marketing both independently identify "proxy conversation mode" as the most differentiated capability, currently buried in the spec. Both recommend elevating its positioning.

---

## Critical Issues (any reviewer blocked or flagged as critical)

### Prompt Injection via tmux Output [Security CRITICAL-1, Adversarial CRITICAL-1, Privacy C1]

Raw tmux output is passed directly to Haiku/Sonnet calls across all three tiers. Any process — a malicious npm package, compromised API response, or crafted file — can embed instruction-pattern text that the LLM receives and may relay verbatim as a trusted `🔭 [Presence]` message. The proxy becomes a phishing relay.

**Required fixes:**
- Wrap tmux output in `<tmux_output>` delimiters with system prompt reinforcement that it is observational data only
- Strip ANSI codes, control characters, and instruction-pattern lines before LLM injection
- Add a second-pass guard: classify LLM output before relay; reject any proxy message containing URLs, imperative commands, or requests for user input
- Default `allowExternalLLM` to `false`; run a local credential scanner before any external transmission

### Unauthenticated Command Execution [Security CRITICAL-2]

Anyone who can send a Telegram message to the bot can execute `restart` (destroys a running session) or `unstick` (sends Ctrl+C to the agent). No sender authentication, rate limiting, or confirmation step exists. Edge Case 6 explicitly says `unstick` should work regardless of proxy state, making it universally triggerable.

**Required fixes:**
- Validate Telegram `from.id` against a config-defined authorized user ID whitelist before executing any action command
- Require confirmation for `restart`
- Rate-limit `unstick` to 3/topic/hour

### StallDetector Injection Tracker Bug [Architecture CRITICAL-1]

`POST /telegram/reply/:topicId` calls `ctx.sessionManager.clearInjectionTracker(topicId)` unconditionally. Proxy messages through this endpoint will reset StallDetector's timer — directly contradicting the spec's requirement that "proxy messages do NOT count as agent responses for StallDetector." This causes StallDetector to silently skip genuine stall intervention because the proxy message restarted its cooldown.

**Required fix:** Add `{ "isProxy": true }` to the reply body and skip `clearInjectionTracker()` when set, or create a dedicated internal send path.

### Double-Triage Collision [Adversarial CRITICAL-3]

Tier 3 fires at 5 minutes. StallTriageNurse also fires at 5 minutes. Both fire concurrently → two Ctrl+C sequences hit the same session → double-triage → recovery failure and destruction of legitimate work.

**Required fix:** Implement a per-session triage mutex. Proxy Tier 3 should preempt/pause StallTriageNurse when active; StallTriageNurse fires only if the user does not respond to Tier 3 within 60 seconds.

### Tier-Fired Timestamps Not Reset with userMessageAt [Architecture CRITICAL-2]

When a new user message arrives mid-sequence, `userMessageAt` resets but `tier1FiredAt`/`tier2FiredAt`/`tier3FiredAt` are not cleared. Tier 2's trigger logic ("Tier 1 already fired → 2 minutes since user message") would fire immediately after a mid-sequence message reset.

**Required fix:** Reset all tier-fired timestamps together with `userMessageAt`.

### Sensitive Data Exfiltration to External LLM API [Security CRITICAL-3]

When `ANTHROPIC_API_KEY` is configured, up to 200 lines of terminal output (potentially containing credentials, tokens, private code) are transmitted to Anthropic's external servers. This is framed as a seamless convenience feature with no data sensitivity controls.

**Required fix:** Default `allowExternalLLM` to `false`. Document this data flow explicitly. Add pre-transmission credential scrubbing.

---

## Conflicts (where reviewers disagree)

**Natural language command parsing** — Architecture recommends NL detection (lightweight Haiku intent classifier) for the `unstick` command, calling it "the right call." Adversarial disagrees and recommends deterministic string matching for safety-critical commands (`quiet`, `restart`), reserving NL only for `unstick`. These positions are compatible if implemented as Adversarial suggests: deterministic for `quiet`/`restart`, NL only for `unstick`.

**Conversation mode phase** — Architecture recommends conversation mode be deferred to Phase 2 if timeline is tight. Business and Marketing both argue it is the feature's primary differentiator and should be elevated, not deferred. DX says Tier 1 is ready to build now, implying Tiers 2-3 and conversation mode can follow. The conflict is about priority sequencing, not viability.

**"Zero cost" framing** — Business accepts the "zero cost" framing as a positioning asset. Scalability flags that CLI usage draws from Claude Max session budgets ("cost is subscription budget, not dollar cost") and the framing conceals the real consumption. Not a fundamental conflict, but the nuance should be surfaced internally.

---

## Top Recommendations (prioritized by cross-reviewer agreement)

1. **Prompt injection defenses** (Security P0, Adversarial P0, Privacy C1) — Sanitize all tmux output before LLM injection; add second-pass output guard before relay. This is the single highest-consensus finding and blocks implementation.

2. **Persist PresenceState to disk** (Security P1, Scalability Significant, Adversarial P1) — Store tier snapshots as temp files on every tier transition; restore on restart; never re-fire already-completed tiers.

3. **Fix the StallDetector injection tracker bug** (Architecture Critical 1) — The proxy bypassing `clearInjectionTracker` silently disables the existing stall detection system. Must be fixed before any deployment.

4. **Fix the double-triage collision** (Adversarial Critical 3) — Implement a per-session triage mutex with proxy preemption of StallTriageNurse.

5. **Telegram sender authentication for action commands** (Security P0, Adversarial implied) — Whitelist-based `from.id` validation before executing `unstick`, `restart`, or `quiet`.

6. **Reset all tier-fired timestamps with userMessageAt** (Architecture Critical 2) — Fix the state corruption on mid-sequence message arrival.

7. **CLI concurrency cap with queue** (Scalability Critical 1, Adversarial) — Cap concurrent `claude -p` invocations at 3-5 with a queue; handle rate-limit errors explicitly; always drain queue for Tier 3.

8. **Default `allowExternalLLM` to false + credential scrubbing** (Security P0, Privacy C1) — Prevent accidental credential exfiltration; require explicit opt-in for external LLM use.

9. **Per-topic LLM rate cap** (Security P1, Adversarial P2) — Cap at ~20 LLM calls/topic/hour; max 5 Tier 3 re-checks; auto-silence after 30 minutes of continuous proxy engagement.

10. **Define the restart recovery algorithm concretely** (Architecture, DX, Business) — Compute elapsed time; determine tier skip/fire logic; implement `PresenceProxy.recoverFromRestart()` in server init.

11. **Fix the quiet command UX** (Scalability R4, DX C2, Adversarial H2) — Send acknowledgment on `quiet`; add `resume` command; add remaining-silence visibility.

12. **Hard LLM timeouts per tier** (DX R2) — Tier 1 = 10s, Tier 2 = 15s, Tier 3 = 30s. On timeout, degrade to templated message; never silently fail.

13. **Rename the feature before prefix locks in** (Marketing Critical 1) — Decide on "Standby" or "Deputy" before implementation locks in the `🔭 [Presence]` prefix. 2-minute change with long-term brand consequences.

14. **Add `__dev_accelerateTimers` config flag** (DX R6) — Integration testing Tier 3 requires a real 5-minute wait per test run without this.

15. **Cap conversationHistory in PresenceState** (DX, Architecture) — Unbounded conversation history causes memory leaks; cap at last 20 exchanges.

---

## Scalability Summary

| Phase | Assessment | Key Risks |
|-------|-----------|-----------|
| **MVP (1-10 agents)** | Passes cleanly | Security issues present at any scale; must fix before any deployment |
| **Growth (50-500 agents)** | Functional with friction | CLI rate limits visible at ~100-150 agents; clustered tmux captures without jitter; subscription budget tracking needed |
| **Scale (500-5000 agents)** | Requires architectural changes | CLI model needs replacement with API + prompt caching; tmux serialization adds latency; in-memory persistence is a reliability gap |
| **Viral (5000+ agents)** | Would not survive | Single-server model is the binding constraint; needs stateless design with external state store |

---

## What's Working Well (consensus strengths)

- **Tier 1-2 observation-only bias** — Multiple reviewers praised this as correct defensive design. Never intervening in the first two tiers prevents false-positive action on working sessions.

- **Process tree as authoritative signal** — `ps` overriding LLM assessment is a production-grade hard invariant praised by Architecture, DX, and Scalability. OS-level signals beat behavioral text classification and cannot be hallucinated.

- **Third-person proxy persona** ("Echo is currently...") — Avoids the proxy making commitments the agent hasn't made. Praised by Scalability and Architecture.

- **Three-snapshot delta approach** — The Tier 1/Tier 2/Tier 3 delta comparison is described by DX as "more sophisticated than anything in current AI monitoring literature" and a textbook consecutive-failure confirmation pattern by DX research.

- **Event-driven cancellation via `message:logged`** — Clean, no polling, no race window beyond one timer cycle. Praised by Scalability.

- **Technology choices** — Haiku for Tiers 1-2 (low latency), Sonnet for Tier 3 (consequential reasoning), reuse of `ClaudeCliIntelligenceProvider` and `SessionManager.captureOutput()`. Architecture found all choices well-matched to requirements.

- **Market positioning** — Business and Marketing both confirm genuine white space: no competitor addresses the human experience of agent silence. The product-market fit is strong.

- **Proxy Conversation Mode** — Independently identified by Business and Marketing as the feature's most differentiated capability. Genuinely novel — no competitor does intelligent meta-conversation about agent state.

- **Telescope emoji (🔭)** — Marketing notes it is visually distinct, semantically appropriate, and won't appear in standard notification UIs. A small but durable UX choice.

- **The `quiet` command design** — Giving users direct control over proxy behavior is praised across DX and Marketing as a maturity signal. The implementation details need work; the concept is right.

---

## Next Steps

- [ ] **[BLOCKER] Implement prompt injection defenses** — Sanitize tmux output before every LLM call; add second-pass output guard before Telegram relay
- [ ] **[BLOCKER] Fix StallDetector injection tracker bypass** — Add `isProxy` flag to bypass `clearInjectionTracker()` on proxy messages
- [ ] **[BLOCKER] Fix double-triage collision** — Implement per-session triage mutex; proxy Tier 3 preempts StallTriageNurse
- [ ] **[BLOCKER] Fix tier timestamp reset bug** — Clear all `tierNFiredAt` fields when `userMessageAt` resets
- [ ] **[BLOCKER] Add Telegram sender authentication** — Whitelist-based `from.id` validation before any action command execution
- [ ] **[BLOCKER] Default `allowExternalLLM` to false** — Add credential scrubbing before any external LLM transmission
- [ ] **[HIGH] Persist PresenceState tier snapshots to disk** — Deterministic restart recovery; prevent restart amplification attacks
- [ ] **[HIGH] CLI concurrency cap** — 3-5 concurrent `claude -p` invocations with queue; explicit rate-limit error handling
- [ ] **[HIGH] Per-topic LLM rate cap** — ~20 calls/hour; max 5 Tier 3 re-checks; auto-silence at 30-minute engagement limit
- [ ] **[HIGH] Write concrete restart recovery algorithm** — Time-elapsed branch logic; implement `PresenceProxy.recoverFromRestart()`
- [ ] **[MEDIUM] Fix quiet command UX** — Acknowledgment message on activation; add `resume` command; expose remaining-silence status
- [ ] **[MEDIUM] Add hard LLM timeouts per tier** — 10s/15s/30s with templated fallback on timeout
- [ ] **[MEDIUM] Cap conversationHistory** — Max 20 exchanges in PresenceState
- [ ] **[MEDIUM] Add jitter to tier timer fires** — ±5 seconds to prevent synchronized tmux capture waves
- [ ] **[MEDIUM] Decide on feature name before implementation** — "Standby" or "Deputy"; update `🔭 [Presence]` prefix accordingly
- [ ] **[MEDIUM] Add `sanitizeBeforeLlm` and `logRetentionDays` to PresenceProxyConfig** — Privacy controls for credential redaction and data lifecycle
- [ ] **[LOW] Add `__dev_accelerateTimers` config flag** — Multiply all delays by 0.1 for local testing
- [ ] **[LOW] Add `tier3Summary` field to PresenceState** — Preserve diagnostic context beyond classification label
- [ ] **[LOW] Add `status` command** — Proxy reports its own monitoring state on demand
- [ ] **[LOW] Add per-session intervention lock** — Prevent thundering herd when multiple topics map to same session
- [ ] **[LOW] Add `presence-proxy-audit.jsonl`** — Log LLM call inputs for forensic capability; currently only outputs are logged
- [ ] **[LOW] Make long-running process whitelist user-configurable** — Move from hardcoded to `config.json`
- [ ] **[LOW] Align spec reference from `onMessageInjected` to actual `message:logged` EventBus pattern**
- [ ] **[LOW] Elevate proxy conversation mode in spec positioning** — It's the differentiator, currently buried in implementation step 5
