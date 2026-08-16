# DX Review — Input Relay

**Review ID**: 20260327-230839 | **Round**: 1
**Reviewer**: Developer Experience
**Score**: 8/10
**Approval Status**: APPROVED WITH RECOMMENDATIONS

---

## Research Findings

- Agentic AI UX research structures interventions as Pre-Action / In-Action / Post-Action. Input Relay correctly occupies In-Action.
- Telegram approval workflows (ZeroClaw HITL, n8n) universally use Inline Keyboards for structured choices.
- Home Assistant Telegram bot demonstrates production requirements: handle undelivered messages, 4096 char limit.
- HITL best practices require: agent pauses on relay, human context sufficient, agent resumes only after explicit response. Spec satisfies all three.

---

## Critical Issues

### 1. No Telegram Inline Keyboards
Numbered text options requiring typed replies is inferior UX. Telegram's Inline Keyboard renders tappable buttons. For mobile users making high-stakes decisions, tap vs type is material friction.

**Fix**: Use `InlineKeyboardMarkup` for permission, plan, selection, and confirmation types. Free-text questions remain plain text.

### 2. Multi-topic/multi-session routing underspecified
What happens when a session has no topic binding (spawned by a job), multiple topics bind to the same session, or session was spawned autonomously?

**Fix**: Define routing priority: (1) topic bound to session, (2) most recent active topic, (3) configured default topic ID, (4) drop with audit log.

### 3. Response association fragile without thread reply
User's reply arrives as new message with no guaranteed association to the specific pending relay.

**Fix**: Use Telegram reply-to threading. With inline keyboards, handled automatically via `callback_query`.

---

## Recommendations

1. First-run discoverability — one-time onboarding message explaining the mechanic
2. Persist PendingRelay state to `.instar/pending-relays.json`
3. Reduce first reminder from 10 minutes to 3-5 minutes
4. Differentiate "auto-resolved" messages (timeout vs crash vs agent self-handled)
5. Add "kill session" escape hatch (`"kill"` or `"abort session"`)
6. Send relay immediately, edit in-place when LLM context arrives (don't block on Haiku)

---

## Observations

- Architecture fit with PromptGate is excellent — InputDetector already emits parsed options
- Message templates are production-ready
- Credential redaction from `sanitizeTmuxOutput()` should also apply to Haiku context input
- The "no auto-escalation" principle preserves meaningful human oversight

---

## Scalability Assessment

Low concern for single-agent use. LLM latency risk if Haiku cold-starts (>2-3s). Fast path: send relay immediately, follow up with context. Multi-agent routing needs explicit constraints documented.
