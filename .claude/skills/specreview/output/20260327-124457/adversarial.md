# Adversarial Review — Presence Proxy

**Review ID**: 20260327-124457 | **Round**: 1 | **Date**: 2026-03-27
**Reviewer**: Red Team / Adversarial
**Score**: 5.5/10
**Approval Status**: CONDITIONAL APPROVAL

---

## Research Findings

1. **LLM Monitoring Injection** — OWASP LLM01:2025 identifies indirect prompt injection as the #1 risk for LLM-integrated systems. Raw data fed into LLM prompts (like tmux output) is the canonical attack surface. ACM 2025 research shows adversarial inputs ~30 chars long can block >97% of LLM requests via safeguard manipulation.

2. **Proxy/Intermediary Abuse** — SMTP relay exploits (Proofpoint/Google 2024-25) show that trusted relays become phishing vehicles precisely because their sender reputation bypasses scrutiny. The `🔭 [Presence]` prefix will train users to trust it — making it a high-value target.

3. **Timer Race Conditions** — TOCTOU vulnerabilities are endemic to timer-escalation systems. AWS's 2025 DynamoDB outage was caused by a race condition in a timer-based DNS system. In-memory timer state lost on restart is a documented, common failure mode.

---

## Critical Issues

### CRITICAL-1: Indirect Prompt Injection via tmux Output [P0]
**Likelihood: High | Impact: Critical**

The tmux pane contains raw stdout/stderr from whatever is running. Any process can write instruction-pattern text that the Haiku/Sonnet call receives as context and may relay verbatim as a `🔭 [Presence]` message to the user — a trusted channel. The proxy becomes a phishing relay.

**Defenses:**
- Sanitize tmux output before injection: strip instruction-pattern lines
- Wrap tmux output in clearly delimited `<tmux_output>` blocks with system prompt reinforcement that it's observational data only
- Add a second-pass guard: classify LLM output before sending — reject any proxy message containing URLs, imperative commands, or requests for user input

### CRITICAL-2: Proxy Prefix Spoofing / Impersonation [P1]
**Likelihood: Medium | Impact: High**

Once users trust `🔭 [Presence]`, any code with access to `POST /telegram/reply/{topicId}` (no auth required from localhost) can send spoofed proxy messages. A compromised dependency running in the session has this access by default.

**Defenses:**
- HMAC-sign proxy messages using authToken; validate server-side before relay
- Rate-limit `/telegram/reply` to prevent burst flooding from compromised session processes
- `source: 'presence-proxy'` metadata must be validated server-side, not just passed through

### CRITICAL-3: Double-Triage Collision [P1]
**Likelihood: High | Impact: High**

Tier 3 fires at 5 minutes. StallTriageNurse also fires at 5 minutes ("remains unchanged"). Both fire concurrently → two Ctrl+C sequences hit the same session → double-triage → recovery fails and legitimate work is killed.

**Defenses:**
- Proxy Tier 3 should preempt/pause StallTriageNurse when active; StallTriageNurse fires only if user doesn't respond to Tier 3 within 60s
- Implement a per-session triage mutex: only one triage in-flight at a time
- Stagger timers: proxy at 4:30, StallTriageNurse at 5:00

---

## High-Severity Issues

### HIGH-1: LLM Cost Exhaustion via Conversation Mode Flooding [P2]
A script sending a message every 21 seconds triggers one Haiku call per message indefinitely. No rate limit, no cap.

**Defense:** Max 1 conversation-mode proxy response per 60s per topic; max 3/hour globally per topic; auto-silence after 30 minutes of continuous proxy engagement.

### HIGH-2: "quiet" Command — Silent Surveillance Window [P2]
If `quiet` can be triggered via natural language detection, a crafted tmux output line could silence the proxy for 30 minutes during a malicious operation.

**Defense:** `quiet` and `restart` must only be accepted from `fromUser: true` messages. Never inferred from session output or LLM analysis.

### HIGH-3: Server Restart Loses All Tier State [P2]
Restart during active Tier 2 loses tier1Snapshot, tier2Snapshot, and which tiers have fired. Re-initialization sends duplicate Tier 1 messages and breaks delta comparison.

**Defense:** Persist PresenceState to disk on every tier transition. Restore on restart. Never re-fire already-completed tiers.

---

## Medium Issues

**MED-1: Haiku Hallucinating False Progress** — Timestamp-driven terminal output always changes hash even when the session is frozen. Haiku reports "progress" while nothing is happening. Fix: normalize tmux output (strip timestamps, ANSI codes, spinners) before hashing.

**MED-2: Conversation Mode Identity Confusion** — After several proxy exchanges, users forget they're talking to a proxy. Fix: strict topic constraint (session status only); insert reminder after 3 exchanges.

**MED-3: Natural Language Command Parsing = Injection Surface** — NL detection via LLM means adversarial input can trigger or suppress safety-critical commands. Fix: deterministic string matching for `quiet`/`restart`; NL detection only for `unstick`.

**MED-4: Unbounded Tier 3 Re-Checks** — No cap on re-check count. A 2-hour build fires 12 Sonnet calls. Fix: cap at 5 re-checks; after that, send final message and go silent.

---

## Edge Cases Not Addressed

- **EDGE-1:** Multiple users on same topic — PresenceState holds only one `userMessageText`
- **EDGE-2:** Agent sends a message with `🔭 [Presence]` prefix — cancellation may race with a queued proxy send
- **EDGE-3:** Tier 3 re-check infinite loop — no maximum re-check count
- **EDGE-4:** LLM in-flight when `cancelled` is set — check again immediately before send; use AbortController

---

## Scalability Assessment

Scales to ~5-10 concurrent busy sessions before LLM overhead becomes noticeable. Bottlenecks: synchronous Sonnet calls (5-8s), no concurrency cap, unbounded PresenceState accumulation, no Tier 3 re-check cap.

**Recommendation:** Cap concurrent proxy LLM calls at 3-5 with queue. Max PresenceState lifetime: 60 minutes. Max Tier 3 re-checks: 5.

---

## Recommendations (Priority Order)

1. **[P0]** tmux output sanitization + second-pass LLM output guard before any relay
2. **[P0]** Reject proxy messages containing URLs, credential requests, or imperative commands
3. **[P1]** Triage mutex: one triage in-flight per session; proxy preempts StallTriageNurse
4. **[P1]** Persist PresenceState to disk; restart recovery from disk
5. **[P2]** Rate-limit conversation mode LLM calls
6. **[P2]** Cap Tier 3 re-checks at 5
7. **[P2]** Deterministic command parsing for `quiet`/`restart`
8. **[P3]** Normalize tmux output before hashing
9. **[P3]** Check `cancelled` immediately before send + AbortController
10. **[P3]** 60-minute maximum proxy engagement lifetime per topic

**Score: 5.5/10** — Thoughtful design undermined by a clean prompt injection path. With P0+P1 mitigations, rises to 8/10.
