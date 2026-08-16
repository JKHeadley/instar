# Consolidated Review Synthesis — Input Relay

**Review ID**: 20260327-230839 | **Round**: 1
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing
**Overall Status**: NEEDS WORK
**Average Score**: 6.88 / 10

---

## 1. Score Summary Table

| Reviewer | Score | Status |
|----------|-------|--------|
| Security | 5/10 | CONDITIONAL — DO NOT IMPLEMENT AS WRITTEN |
| Scalability | 7/10 | CONDITIONAL APPROVE |
| Business | 7.5/10 | APPROVED WITH CONDITIONS |
| Architecture | 8/10 | APPROVED WITH RECOMMENDATIONS |
| Privacy | 6/10 | CONDITIONAL APPROVAL |
| Adversarial | 6/10 | CONDITIONAL APPROVAL |
| DX | 8/10 | APPROVED WITH RECOMMENDATIONS |
| Marketing | 7.5/10 | APPROVED WITH REVISIONS |
| **Average** | **6.88/10** | **NEEDS WORK** |

---

## 2. Consensus Findings (3+ Reviewers Agree)

### A. PendingRelay state must be persisted to disk
**Reviewers**: Security, Scalability, Architecture, Adversarial, DX (5/8)

In-memory-only state is universally flagged. A server restart while a relay is pending causes silent failure: the user responds, nothing happens, the session stays blocked. The fix is consistent across all reporters: write-through persistence to `pending-relays.json`, matching the PresenceProxy state persistence pattern.

### B. Pre-injection process verification required
**Reviewers**: Security, Architecture, Adversarial (3/8)

Before calling `sendKey`, the system must re-fingerprint tmux state and verify the foreground process is still Claude Code at the expected prompt. Race conditions between relay creation and response injection can cause keystrokes to land in a live shell. This is a prerequisite for safe free-text injection.

### C. Credential scrubbing must be applied before any tmux capture leaves the system
**Reviewers**: Security, Privacy, DX (3/8)

The 20-line tmux context sent to Telegram and to Haiku is not scrubbed. PresenceProxy already implements `sanitizeTmuxOutput()` with credential patterns. This spec fails to reference it. Terminal output routinely contains API keys, bearer tokens, and database connection strings. Every tmux capture — whether for LLM context, relay messages, or audit logs — must pass through `sanitizeTmuxOutput()` first.

### D. Inline keyboards over text replies
**Reviewers**: Security, Adversarial, DX (3/8)

Numbered text options requiring typed replies introduce parsing ambiguity, replay risk, and friction for mobile users. Telegram's `InlineKeyboardMarkup` renders tappable buttons, eliminates text parsing, and handles `callback_query` association automatically. Universally recommended for permission, plan, selection, and confirmation prompt types.

### E. Notification spam risk requires batching and rate limiting
**Reviewers**: Scalability, Business, Adversarial (3/8)

Multiple concurrent prompts firing in rapid succession create unbounded notification chains. The 10-minute and 30-minute reminders repeat indefinitely for unresponsive prompts. With multiple sessions, this trains users toward blind approval (notification fatigue). Fixes: batch prompts within a time window, cap reminders at 2-3 per relay, add a rate limit (e.g. max 5 relays per topic per hour).

### F. LLM context generation should not block relay delivery
**Reviewers**: Architecture, DX (2/8 — notable agreement on mechanism)

The current design holds the relay message until Haiku finishes generating context (500ms–3s). The session remains blocked the entire time. The correct pattern: send the relay immediately with minimal context, then edit the message in-place when Haiku context arrives. This is better UX with no data model changes.

---

## 3. Critical Issues Grouped by Theme

### Theme 1: Injection Safety
- **Free-text relay enables arbitrary command injection** (Security CRIT-1, Adversarial CRIT-1): Free-text answers sent directly as keystrokes to tmux. If the foreground process has changed since relay creation, input lands in a shell. Shell metacharacter sanitization is unspecified.
- **TOCTOU race condition** (Security HIGH, Architecture HIGH): "yes" injected for prompt A could land on prompt B if the session advances between relay creation and injection. Must re-fingerprint immediately before every `sendKey()`.
- **No concurrent injection control** (Scalability, Adversarial): Two simultaneous pending relays for the same session can race. Requires a per-session injection mutex with sequential queue.

### Theme 2: Authentication & Replay
- **Telegram sender authentication underspecified** (Security CRIT-2): Spec defers to "same as Standby" with no details. Forwarded messages retain the original `from.id` — a forwarding attack can pass authentication. No `forward_origin` rejection, topic thread validation, or `via_bot` rejection specified.
- **Replay attack via message forwarding** (Adversarial CRIT-3): A forwarded relay message plus a forwarded reply can pass `from.id` validation. Fix: reject `forward_origin` messages; prefer inline keyboard callbacks which include original message context.
- **Callback button concurrent tap race** (Architecture MEDIUM-HIGH): `responded: boolean` is set after async operations, allowing two simultaneous taps to both be processed. `CallbackRegistry` one-use tokens are the correct atomicity gate — confirm they are consumed synchronously.

### Theme 3: Data Privacy & Credential Exposure
- **Unredacted terminal output relay** (Privacy CRIT-1, Security CRIT-3): tmux context sent to Telegram and Haiku without credential scrubbing. `sanitizeTmuxOutput()` exists and must be applied.
- **Telegram as unintended data processor** (Privacy CRIT-2): Terminal content and action summaries are stored on Telegram servers including cloud backups. No data processor relationship addressed. Consider "minimal relay mode" — notify only, serve context via local dashboard.
- **Missing explicit consent for terminal content relay** (Privacy CRIT-3): Setup consent does not imply informed consent to terminal content relay. First-relay onboarding message is required.
- **Audit log indefinite retention** (Privacy CRIT-4): `prompt-gate-audit.jsonl` logs raw `promptText` with no retention limits. Apply scrubber before logging and 30-day retention via `jsonl-truncator.ts`.

### Theme 4: State & Persistence
- **In-memory PendingRelay with no persistence** (Scalability, Architecture, Security, Adversarial): Unanimous. Restart = silent drop. Fix: `pending-relays.json` write-through.
- **`responded: true` not persisted** (Security): Post-restart, a Telegram response to an expired relay is re-processed.
- **`promptId` fingerprint should survive restarts for dedup** (Scalability): Dedup requires stable identity across restarts.

### Theme 5: Prompt Spoofing & Classification
- **NLP classification prompt injection** (Security HIGH): Multi-line Telegram replies could contain adversarial text targeting the Haiku classifier. Classify intent from first 100 chars only; inject raw text separately.
- **Prompt spoofing via crafted terminal output** (Adversarial CRIT-2): Compromised dependency prints fake prompt text matching InputDetector patterns, generating a fake permission request. The approval keystroke goes to the real process. Fix: 3-capture stability threshold (up from 2), cross-reference Claude Code tool-use state if accessible.

### Theme 6: Specification Gaps
- **Timeout value conflict** (Architecture): Spec says 10min/30min, existing code uses 5min/10min via `relayTimeoutSeconds`. Must resolve.
- **`last20Lines` source** (Architecture): Must be a fresh `captureSessionOutput()` call, not `prompt.raw` (only 5 lines from quiescence gating).
- **`Map<topicId, PendingRelay>` only holds one relay per topic** (Architecture): Multi-session sharing will silently drop relays. Document constraint or switch to a queue.
- **Multi-topic/multi-session routing underspecified** (DX): Sessions spawned by jobs with no topic binding, or multiple topics bound to one session, have no defined routing priority.

---

## 4. Conflicts Between Reviewers

| Conflict | Position A | Position B | Recommendation |
|----------|-----------|-----------|----------------|
| **Urgency to ship** | Business: ship fast, competitive window closing due to Claude Dispatch | Architecture: much functionality already exists, wiring is the bulk of work | Low real conflict — existing code makes fast shipping feasible |
| **Reminder timing** | Spec: 10min first reminder | DX: reduce to 3-5 minutes | DX is correct for mobile UX; shorter is better |
| **Scope of "safe fallback"** | Business: needs configurable auto-reject/auto-approve/suspend | Security/Adversarial: "no auto-action ever" is a safety principle | Configurable safe-defaults (suspend session or reject) is the right compromise — never auto-approve |
| **Haiku context blocking** | Architecture: send immediately, edit in-place | No explicit objection from others | Non-controversial — Architecture recommendation should be adopted |

---

## 5. Top Recommendations (Prioritized by Cross-Reviewer Agreement)

### P0 — Blockers (must fix before any implementation)

1. **Persist PendingRelay to disk** — `pending-relays.json`, write-through on every state change. (5 reviewers)
2. **Pre-injection process verification** — Re-fingerprint tmux state and verify foreground process is Claude Code before every `sendKey()`. Fail closed if changed. (4 reviewers)
3. **Apply `sanitizeTmuxOutput()` to all tmux captures** — Before relay messages, before Haiku calls, before audit logging. (4 reviewers)
4. **Reject forwarded Telegram messages** — Check `forward_origin`, validate topic thread ID, reject `via_bot`. (3 reviewers)

### P1 — High Priority (required before GA)

5. **Switch to Inline Keyboards** — `InlineKeyboardMarkup` for all structured choices. Free-text only for open-ended questions. (3 reviewers)
6. **Per-session injection mutex** — Queue responses and inject sequentially. (3 reviewers)
7. **Cap reminder notifications** — Max 2-3 per relay. Rate limit: max 5 relays per topic per hour. (3 reviewers)
8. **First-relay onboarding message** — Disclose what gets transmitted, with disable/restrict command. (2 reviewers)
9. **Send relay immediately, edit in-place when Haiku context arrives** — Don't block relay delivery on LLM call. (2 reviewers)
10. **3-capture stability threshold for prompt detection** — Up from 2 to reduce spoofing risk. (2 reviewers)

### P2 — Recommended before GA

11. **Resolve timeout value conflict** — Spec (10min/30min) vs. existing code (`relayTimeoutSeconds` 5min/10min).
12. **Define multi-topic/multi-session routing priority** — Topic bound to session → most recent active → configured default → drop with audit log.
13. **Apply 30-day retention to audit log** — Via `jsonl-truncator.ts`, after scrubbing raw `promptText`.
14. **NLP classification: use first 100 chars only** — Prevent adversarial text in multi-line replies from poisoning Haiku classifier.
15. **Add "kill session" escape hatch** — `"kill"` or `"abort session"` keywords in relay response.
16. **Verify `sessionName` against live session list before every injection**.

### P3 — Post-MVP

17. **Channel-agnostic message formatter** — Build for WhatsApp/Slack from day one.
18. **Consider "minimal relay mode"** — Notify only, serve context via local dashboard instead of Telegram.
19. **Per-relay HMAC signatures** — Prevent crafted approval responses.
20. **Auto-expire PendingRelay after 1 hour** with no response.

---

## 6. Scalability Summary Table

| Phase | Agents | Status | Key Risks |
|-------|--------|--------|-----------|
| MVP (1-10) | 1-10 | Works | In-memory state loss on restart |
| Growth (50-500) | 50-500 | Functional with fixes | Notification spam, LLM queue contention |
| Scale (500-5000) | 500-5000 | Needs work | In-memory state, concurrent injection, queue isolation |
| Viral (5000+) | 5000+ | Not designed for this | Per-agent feature; main constraint is Telegram bot rate limits |

**Privacy note**: Privacy posture scales poorly with volume — each session increases terminal content transmitted. Scrubbing and data minimization limit blast radius. Multi-user would require a redesigned consent model.

---

## 7. What's Working Well (Consensus Strengths)

- **Architecture fit with PromptGate is excellent** — InputDetector already emits parsed options; integration points are clean. (Architecture, DX)
- **Much of the implementation already exists** — `TelegramAdapter.relayPrompt()`, `formatPromptMessage()`, `processCallbackQuery()`, `handlePromptTextReply()`, and `pruneExpiredRelayPrompts()` are already in the codebase. The spec is primarily about completing wiring. (Architecture)
- **Message format examples are production-ready** — Templates read like finished product copy. (DX, Marketing)
- **"No auto-escalation" principle is correct** — Preserves meaningful human oversight; never auto-approve. (DX, Business, Security)
- **LLM context generation ("explains WHY, not just WHAT") is a genuine differentiator** — Justification for the action, not just the action label. (Marketing, DX)
- **"Never mind" auto-resolution message is demo-worthy** — Signals a live, aware system. (Marketing)
- **Automatic detection with zero instrumentation** — Unlike all competing HITL tools (HumanLayer, n8n, Microsoft Agent Framework), Instar detects blocked sessions automatically without requiring agent code changes. (Marketing, Business)
- **HITL best practices satisfied** — Agent pauses on relay, human context is sufficient, agent resumes only after explicit response. (DX)
- **Strong market category timing** — AI agents market at 46.3% CAGR; real demand confirmed by community-built Telegram bridges. (Business)

---

## 8. Prioritized Next Steps Checklist

### Blockers — Fix before writing any new code

- [ ] **Persist PendingRelay state** to `.instar/pending-relays.json` with write-through on every mutation
- [ ] **Pre-injection tmux re-fingerprint** — verify foreground process is Claude Code before every `sendKey()`; fail closed if changed
- [ ] **Apply `sanitizeTmuxOutput()`** to all tmux captures (relay messages, Haiku input, audit log writes)
- [ ] **Reject forwarded Telegram messages** — check `forward_origin`, validate topic thread ID, reject `via_bot`

### High Priority — Required before GA

- [ ] **Switch to Inline Keyboards** (`InlineKeyboardMarkup`) for all structured choices
- [ ] **Per-session injection mutex** — sequential queue for concurrent responses
- [ ] **Cap reminders**: max 2-3 per relay; rate limit 5 relays/topic/hour
- [ ] **First-relay onboarding message** — disclose what gets transmitted
- [ ] **Non-blocking relay delivery** — send immediately, edit in-place when Haiku context arrives
- [ ] **3-capture stability threshold** for prompt detection
- [ ] **Resolve timeout conflict** — spec (10/30min) vs. code (`relayTimeoutSeconds` 5/10min)
- [ ] **Define multi-session routing priority** for sessions without topic binding
- [ ] **Audit log retention** — 30-day limit via `jsonl-truncator.ts`, after `sanitizeTmuxOutput()`
- [ ] **NLP classifier: first 100 chars only** — prevent adversarial injection in multi-line replies
- [ ] **`sessionName` re-validation** against live session list before injection
- [ ] **Add "kill session" escape hatch** in relay response handling

### Post-MVP

- [ ] Channel-agnostic message formatter (Slack, WhatsApp)
- [ ] "Minimal relay mode" — notify only, context via dashboard
- [ ] Per-relay HMAC signatures
- [ ] Auto-expire PendingRelay after 1 hour
- [ ] Ship fast positioning against Claude Dispatch — frame as "Telegram-first, zero instrumentation"

---

## Overall Status: NEEDS WORK

The core concept is strong and the architectural foundation is largely already built. However, four security/privacy blockers — all involving data leaving the system (credential exposure via unscrubed tmux output) or input entering the system (injection without process verification, unauthenticated relay responses, unvalidated forwards) — must be resolved before implementation begins. None of the blockers are architecturally difficult; they are all gaps in wiring to existing infrastructure. An estimated 1-2 focused sessions should clear the P0 and P1 list, putting this at READY.
