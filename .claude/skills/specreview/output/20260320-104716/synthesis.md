# SpecReview Synthesis: Input Gate (Session Prompt Bridge)

**Review ID**: 20260320-104716
**Date**: 2026-03-20
**Round**: 2
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX/API, Marketing
**Spec**: `specs/session-prompt-bridge.md`

---

## Overall Assessment

**Status**: NEEDS WORK
**Average Score**: 6.9 / 10
**Score Range**: 4.5 - 8.5

| Reviewer | Status | Score | Key Finding |
|----------|--------|-------|-------------|
| Security | CONDITIONAL | 5.5/10 | Three critical vulnerabilities (callback authorization, prompt injection, unsanitized sendInput) remain unaddressed |
| Scalability | CONDITIONAL PASS | 7.5/10 | Architecturally sound for v1; capture loop O(n) forks and unbounded CallbackRegistry need addressing |
| Business | APPROVED | 8.5/10 | Strong feature with clear user value; competitive timing is urgent given Claude Code Remote Control launch |
| Architecture | CONDITIONAL | 8.0/10 | Two critical structural issues: WebSocketManager dependency breaks headless use; fingerprint dedup insufficient |
| Privacy | CONDITIONAL | 6.5/10 | Raw terminal content in logs, missing time-based retention, no user disclosure about Telegram data transit |
| Adversarial | CONDITIONAL | 4.5/10 | Two P0 vulnerabilities (LLM output prompt injection, pendingPromptReply hijacking) block Phase 3 |
| DX / API | CONDITIONAL | 7.5/10 | No onboarding path, no per-topic override access mechanism, no audit log API — feature not operable by users |
| Marketing | CONDITIONAL | 7.0/10 | Name "Input Gate" underperforms the feature; positioning statement and Telegram message formats are excellent |

---

## Consensus Findings

*Issues that 3+ reviewers independently identified:*

1. **pendingPromptReply accepts any message from any sender without authorization**: Identified by Security, Adversarial, DX/API
   - Summary: The `pendingPromptReply` map intercepts the next text message in a Telegram topic and injects it verbatim into the session. No sender verification, no length limit, no content filtering. Any group member (or accidental user message) can inject arbitrary text into a running Claude session. The spec's race condition dismissal ("prompt relay appears before the flag is set") is incorrect — the flag is set server-side immediately.
   - Recommended action: Require the user's reply to be a Telegram reply-to-message threading to the specific bot relay message (check `message.reply_to_message.message_id`). Additionally verify `message.from.id` matches the configured authorized owner. Add a length bound (<512 chars).

2. **No authorization check on callback_query sender**: Identified by Security, Adversarial, Privacy
   - Summary: Any member of the Telegram group can tap an inline keyboard button and approve an action on behalf of the session owner. The spec has no `from.id` verification in the callback handler. This is a new vulnerability introduced by the button design in Round 2.
   - Recommended action: Verify `update.callback_query.from.id` matches the configured `ownerId` before resolving the CallbackRegistry token and injecting any response.

3. **Indirect prompt injection via pattern matching on untrusted terminal output**: Identified by Security, Adversarial, Privacy
   - Summary: The InputDetector pattern-matches raw terminal output, which includes content Claude is processing from external sources (files, emails, web pages, API responses). Attacker-controlled content can be crafted to match prompt patterns, triggering auto-approve or relay with a legitimate-appearing question. The 2s debounce and ANSI stripping do not prevent this.
   - Recommended action: Gate pattern matching on session idle state (no active streaming output in the prior 2s, match only at the tail of the buffer). Add an LLM classification step (Haiku-class) before emitting relay events: "Is this an interactive system prompt or content Claude is printing?"

4. **Raw terminal content stored in audit log without data minimization**: Identified by Security, Privacy, Adversarial
   - Summary: The `summary` and `raw` fields in the audit log store terminal-derived text that may contain credentials, file paths, PII, and adversarially crafted payloads. No time-based retention limit (only size-based rotation). File permissions unspecified.
   - Recommended action: Log only classification metadata (type, action, response key, confidence); gate human-readable summary behind `verboseLogging: false`. Add `logRetentionDays: 30` config field. Specify file mode 0600. Truncate `raw` at 500 chars and strip control characters before writing.

5. **500ms capture loop / WebSocketManager dependency breaks headless use**: Identified by Architecture, Scalability, Security
   - Summary: The spec ties InputDetector to the WebSocketManager's 500ms capture loop, which only runs when dashboard clients are connected. Headless Telegram sessions — the primary use case — receive zero captures. Additionally, the loop scales as O(n) subprocess forks.
   - Recommended action: InputDetector needs its own capture loop or must hook into `SessionManager.monitorTick()` instead. Add idle-session skip optimization to reduce subprocess fork overhead.

---

## Critical Issues (Blockers)

*These must be resolved before Phase 3 (Telegram relay) is implemented.*

| # | Issue | Reviewer(s) | Severity | Suggested Fix |
|---|-------|------------|----------|---------------|
| 1 | Telegram callback_query — no `from.id` authorization check; any group member can approve agent actions | Security (CRIT-1), Adversarial (OBS-1) | CRITICAL | Verify `callback_query.from.id` matches configured `ownerId` before all CallbackRegistry resolution and sendInput calls |
| 2 | `pendingPromptReply` hijacking — any message in the topic is injected verbatim into the session with no sender verification or length bound | Security (SIG-3), Adversarial (CRIT-2), DX | CRITICAL | Require Telegram reply-thread to prompt message; verify sender; bound to 512 chars; strip control characters |
| 3 | `sendInput()` accepts arbitrary text without sanitization — newlines, ANSI codes, tmux special keys pass through unfiltered | Security (CRIT-3), Adversarial | CRITICAL | Sanitize at call site: strip control chars, define allowlist for button key values, enforce max length |
| 4 | Prompt injection via LLM output — InputDetector matches patterns on terminal content Claude is printing from external sources | Security (CRIT-2), Adversarial (CRIT-1) | CRITICAL | Gate detection on buffer-tail position + quiescence; add LLM classification step before relay |
| 5 | WebSocketManager integration breaks headless Telegram use — InputDetector receives no captures without dashboard clients connected | Architecture (CRIT-1) | CRITICAL | Decouple InputDetector from WebSocketManager; use SessionManager.monitorTick() or dedicated capture loop |
| 6 | Fingerprint-only dedup insufficient — tmux redraws with slight whitespace variation change fingerprint, re-emitting the same prompt | Architecture (CRIT-2) | HIGH | Add 5s post-emission cooldown window in addition to fingerprint tracking |

---

## Conflicts

### Conflict 1: Severity of token entropy (CallbackRegistry 8-char base62)

- **Security** says: Medium-High severity; primary concern is use of `Math.random()` rather than CSPRNG. 48 bits of entropy is acceptable if CSPRNG is used.
- **Adversarial** says: Even with CSPRNG, 48 bits is borderline for a localhost-accessible endpoint; recommends 12-char token (~71 bits) and rate limiting.
- **Tension**: Security is satisfied by CSPRNG; Adversarial wants both CSPRNG and increased token length. Both agree on CSPRNG requirement.
- **Resolution**: Non-conflicting in practice. Minimum fix is CSPRNG (both agree). Token lengthening to 12 chars is additive hardening that costs nothing. Accept Adversarial's recommendation to do both.

### Conflict 2: Post-session digest vs. real-time auto-approve notifications

- **Privacy** says: The spec's post-session digest is insufficient — an "anomaly notification" path should fire immediately for borderline auto-approve decisions, preserving real-time oversight.
- **Business** says: Post-session digest is the right call for noise reduction; moves it up from Phase 4 to Phase 2/3 but does not require real-time per-action notifications.
- **DX** says: Consider a single "first auto-approval" notification per session as an intermediate position.
- **Tension**: Privacy wants more real-time transparency; Business/DX want less notification noise.
- **Resolution**: DX's compromise is optimal: one notification per session when first auto-approval fires ("Auto-approving session actions — I'll summarize when done"), plus Privacy's anomaly path for borderline/low-confidence decisions. This satisfies both concerns.

### Conflict 3: bashSafe auto-approve inclusion

- **Security** says: Remove `bashSafe` from v1 entirely — reliable classification requires parsing shell expansion and environment variables, which are unavailable to a pattern matcher.
- **Business** says: The stall fallback is an adequate safety net for classification misses; does not flag `bashSafe` as a concern.
- **Tension**: Security sees `bashSafe` as a false-confidence surface; Business treats pattern drift as acceptable.
- **Resolution**: Security is correct on the technical merits. `curl $HOST` trivially bypasses a `localhost` check. Remove `bashSafe` from v1 auto-approve scope. The stall fallback is not an adequate mitigation for a deliberately incorrect classification.

---

## Recommendations (Prioritized)

| Priority | Recommendation | Source Reviewers | Effort | Impact |
|----------|---------------|-----------------|--------|--------|
| P0 | Add `from.id` authorization check to all callback_query handlers and pendingPromptReply routing | Security, Adversarial, Privacy | Low | Critical |
| P0 | Sanitize all `sendInput()` payloads: strip control chars, allowlist button keys, enforce max length | Security, Adversarial | Low | Critical |
| P0 | Gate InputDetector on buffer-tail position + session quiescence; add Haiku LLM classification step before relay | Security, Adversarial | Medium | Critical |
| P0 | Decouple InputDetector from WebSocketManager; use SessionManager.monitorTick() or dedicated capture loop | Architecture | Medium | Critical |
| P1 | Require `crypto.randomBytes()` (CSPRNG) for CallbackRegistry token generation; increase to 12 chars | Security, Adversarial | Low | High |
| P1 | Add path traversal normalization (`path.resolve()`) in InputClassifier before directory boundary check | Adversarial | Low | High |
| P1 | Use `strip-ansi` v7+ to handle OSC sequences; add post-strip pass for chars < 0x20; add idempotency test | Adversarial, Architecture | Low | High |
| P1 | Explicitly clear `pendingPromptReply` on final timeout (2x relay timeout) | Security, Adversarial, Privacy | Low | High |
| P1 | Remove `bashSafe` from v1 auto-approve scope — classification is unreliable without shell expansion context | Security, Business | Low | High |
| P1 | Define audit log file permissions (mode 0600); add `logRetentionDays: 30`; gate `summary` field behind `verboseLogging` | Security, Privacy, Adversarial | Low | Medium |
| P1 | Define first-run experience: CLI command or dashboard toggle to enable Input Gate (not raw JSON editing) | DX | Medium | High |
| P1 | Define per-topic override access path — API endpoint minimum; conversational command preferred | DX, Business | Medium | High |
| P2 | Add post-emission cooldown window (5s) for fingerprint dedup to handle tmux redraws | Architecture | Low | Medium |
| P2 | Track rejected prompts in a separate cooling-down set with 60s TTL to prevent re-fire after Ctrl+C | Adversarial | Low | Medium |
| P2 | Implement retry with exponential backoff for `editMessageText` on prompt supersede | Adversarial | Low | Medium |
| P2 | Add relay disclosure to onboarding: prompt text transits Telegram servers; advise against use with credentials/PII | Privacy, Marketing | Low | Medium |
| P2 | Add anomaly notification path for borderline auto-approve decisions (low classifier confidence) | Privacy, DX | Medium | Medium |
| P2 | Define audit log API endpoint (`GET /input-gate/log`) for dashboard rendering and CLI inspection | DX | Medium | Medium |
| P2 | Define "project directory" authoritatively in spec (cwd? git root? configurable?) | DX, Adversarial | Low | Medium |
| P2 | Move post-session digest to Phase 2/3; add first-auto-approve-per-session Telegram notification | Business, Privacy, DX | Low | Medium |
| P2 | Add `maxEntries: 500` guard to CallbackRegistry to prevent unbounded growth | Scalability | Low | Low |
| P2 | Implement relay queue with 1.1s drain rate to respect Telegram's 1 msg/s per-chat rate limit | Scalability | Low | Medium |
| P2 | Add `detectionWindowLines` config option (suggested: 50 lines) to bound capture buffer size | Scalability | Low | Low |
| P2 | Rename feature to "Prompt Gate" within gate convention, or "Prompt Relay" to foreground routing role | Marketing | Low | Low |
| P2 | Add first-use onboarding message when relay fires for the first time | Marketing, DX | Low | Low |

---

## Scalability Summary

This is a per-agent, per-machine deployment — not multi-tenant infrastructure. Scalability phases map to sessions per agent, not user count.

| Phase | Assessment | Key Risks | Reviewers Agree? |
|-------|-----------|-----------|-----------------|
| **MVP** (1-5 sessions) | Well-suited; no bottlenecks | None at this scale | Yes — all reviewers aligned |
| **Growth** (5-20 sessions) | Capture loop O(n) subprocess forks become noticeable; add idle-session skip | tmux socket contention; Telegram 1 msg/s rate limit on relay burst | Partial — Scalability and Architecture agree; Security notes it is not their concern |
| **Scale** (20-50 sessions) | Needs batched/multiplexed capture or PTY-based monitoring | pendingPromptReply one-active-per-topic becomes constraining in multi-session workflows | Yes — Architecture, Scalability, Business all flag this as v2 concern |
| **Multi-machine** | In-memory CallbackRegistry and pendingPromptReply do not survive restarts or sync across machines | Not a v1 concern but DX notes the spec does not flag it | Partial — DX flags it; others treat it as out of scope |

---

## Gaps

*Areas that no reviewer adequately covered, or areas where the spec itself is silent.*

1. **Session idle detection interaction with Input Gate relay**: Architecture flagged that sessions waiting for Telegram input will be killed as zombies by the existing 15-minute idle detection timer (observed in production as session 8a1956eb). No reviewer proposed a concrete fix beyond "coordinate the two systems." The spec needs an explicit mechanism: either suspend idle detection while `pendingPromptReply` is set, or extend the session lease when a relay is active.

2. **Non-Telegram sessions**: The spec defers this entirely, but no reviewer examined what happens to a Claude Code session started directly (not via Telegram) that hits a permission prompt. InputDetector will fire. InputClassifier will attempt to route. There is no relay adapter. The fallback path for non-Telegram sessions is entirely unspecified.

3. **Dashboard response path for relayed prompts**: DX noted that the dashboard shows a "blue dot" for relayed-waiting prompts but defines no interaction — users without Telegram access have no way to respond through the dashboard. No reviewer proposed a concrete dashboard response UI design beyond flagging the gap.

4. **Multi-session same-topic conflict resolution UX**: The spec acknowledges "last prompt wins" as the v1 behavior when multiple sessions in the same topic produce prompts simultaneously. No reviewer examined the UX of a superseded prompt where the user has already started typing a response. The Telegram "Superseded" message update may arrive after the user has already tapped a button or begun a reply.

5. **tmux capture flags**: No reviewer specified which exact `tmux capture-pane` flags the spec should mandate. DX recommended `-p` without `-e`; this was not reviewed against actual terminal behavior across different tmux versions. The ANSI strip handling depends on this choice.

6. **GDPR/regulatory compliance obligations**: Privacy reviewed the data minimization and consent gaps, but no reviewer addressed whether instar needs a Data Processing Agreement with Telegram, or whether the operator (user) needs to self-declare a DPIA before enabling relay for high-sensitivity sessions. This is a gap for any user deploying in an EU/CCPA-regulated context.

---

## Name Analysis (from Marketing Reviewer)

**Current name**: Input Gate
**Assessment**: Technically accurate but underperforms the feature. "Input" emphasizes mechanism over benefit. Has passive electronics connotation (logic gate terminal) that is semantically inverted from the feature's active behavior. The name does not signal mobile/Telegram context, which is the primary differentiator. Fits consistently within instar's gate naming convention, which is its main strength.
**Alternatives suggested**:
- **Prompt Gate** (recommended): Minimal change; replaces "input" with "prompt" for clarity; fits gate convention; config key `promptGate`
- **Prompt Relay**: Foregrounds routing/channel behavior; channel-agnostic framing scales to future adapters; config key `promptRelay`
- **Session Watchdog**: Guardian metaphor; familiar developer term; captures monitoring-and-response role; less obvious on bidirectional relay
- **InterruptRelay**: Uses LangGraph's `interrupt()` vocabulary; technically precise; compound name feels slightly heavy
- **Unblock / Agent Unblock**: Pure benefit framing; excellent as display/marketing label; too vague as technical config key

---

## Convergence Status

| Metric | Value |
|--------|-------|
| Reviewers issuing APPROVE (unconditional) | 1 / 8 (Business) |
| Conditional approvals | 7 / 8 |
| Blockers (BLOCK status) | 0 / 8 |
| Open conflicts | 3 |
| Resolved conflicts | 3 (with synthesis recommendations above) |

**Convergence**: CONVERGING

No reviewer issued an outright BLOCK. All 7 conditional reviewers identified specific, fixable issues. The business case is validated and uncontested. The architecture is sound at its core — the critical issues are implementation gaps and security omissions, not fundamental design flaws.

The two lowest-scoring reviewers (Adversarial: 4.5, Security: 5.5) both state that resolving their P0 and P1 issues would bring scores to approximately 7.5/10. The path to convergence is clear.

---

## Next Steps

- [ ] Address 6 critical issues (P0 blockers) before implementing Phase 3 (Telegram relay)
- [ ] Address P1 recommendations (11 items) before Phase 3 code review
- [ ] Resolve 3 open conflicts per synthesis recommendations above (CSPRNG + token length, notification strategy, bashSafe removal)
- [ ] Fill 2 specification gaps that have no proposed fix: (1) idle detection / relay interaction, (2) non-Telegram session fallback path
- [ ] Re-run security and adversarial reviews after P0 fixes: `/specreview specs/session-prompt-bridge.md --round 3 --reviewers security,adversarial`
- [ ] Consider whether architecture review re-run is needed after WebSocketManager decoupling decision is specified

---

## Round 2 vs Round 1 Assessment

**What Round 1 fixed (acknowledged by reviewers as correct):**
- Opt-in auto-approve default (previously opt-out) — Security, Business, Privacy, Adversarial all explicitly validate this decision
- CallbackRegistry server-side token design solving the 64-byte Telegram callback_data limit — Architecture, Security, DX all commend this as clean and correct
- Deduplication fingerprint + 2s debounce approach — Architecture, DX, Adversarial all approve

**What Round 2 introduced as new issues:**
- CRIT-1 (Security): Telegram callback button authorization gap — did not exist before the button design was added
- The button design is the right design; the authorization check was simply omitted

**What Round 1 left unresolved (still open in Round 2):**
- Indirect prompt injection via terminal output pattern matching
- sendInput sanitization
- WebSocketManager headless dependency
- Privacy disclosure for Telegram content transit

**Verdict on Round 2 revisions**: The revisions were genuine improvements that addressed the correct issues from Round 1. However, the new callback button design introduced a critical authorization gap that was not caught before submission. The remaining open issues are fixable without architectural rework. Round 3 review of security and adversarial dimensions is warranted after P0 fixes are applied.

---

*Generated by SpecReview multi-agent analysis — Round 2 synthesis.*
*8 reviewer reports consolidated. Review ID: 20260320-104716.*
