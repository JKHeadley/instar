# Privacy & Ethics Review — Input Relay

**Review ID**: 20260327-230839 | **Round**: 1
**Reviewer**: Privacy & Ethics
**Score**: 6/10
**Approval Status**: CONDITIONAL APPROVAL

---

## Research Findings

- Terminal output routinely contains credentials in env var exports, tokens in curl commands, private file paths. Industry practice treats terminal output as inherently sensitive.
- Contextual integrity (Nissenbaum): terminal output is private to dev environment — relaying to Telegram crosses a contextual boundary.
- GDPR Article 5(1)(c): data minimization requires transmitting only what's needed for the decision.
- Informed consent requires disclosure of scope — "configures Telegram bot" ≠ consent to terminal content relay.

---

## Critical Issues

### CRITICAL-1: Unredacted terminal output relay
20 lines of tmux output sent to Telegram without credential scrubbing. Terminal output contains API keys, bearer tokens, database strings. PresenceProxy already has `sanitizeTmuxOutput()` — this spec doesn't reference it.

**Fix**: Reuse `sanitizeTmuxOutput()` for all tmux captures before relay or LLM calls.

### CRITICAL-2: Telegram as unintended data processor
Terminal context and action summaries sent to Telegram servers where they're stored (including cloud backup). No data processor relationship addressed.

**Fix**: Add relay content policy. Consider "minimal relay mode" — notify only, serve context via local dashboard.

### CRITICAL-3: Missing explicit consent for terminal content relay
Setup consent ≠ informed consent to terminal content relay. No disclosure of what gets transmitted.

**Fix**: One-time onboarding message on first relay explaining what Input Relay transmits, with command to disable/restrict.

### CRITICAL-4: Audit log indefinite retention
`prompt-gate-audit.jsonl` logs raw `promptText` with no retention limits. Creates persistent record of all terminal content ever relayed.

**Fix**: Apply scrubber before logging. Apply 30-day retention via `jsonl-truncator.ts`.

---

## Recommendations

1. Separate "notification" (low-sensitivity) from "content relay" (high-sensitivity, configurable)
2. Batch multiple prompts within 30s into single message to limit privacy exposure
3. Include "ignore this type" response option in every relay message
4. Document LLM data flow — terminal output to Haiku is a second data processor relationship

---

## Scalability Assessment

Privacy posture scales poorly with volume — each session increases terminal content transmitted. Scrubbing and minimization limit blast radius. Multi-user would need redesigned consent model. Current architecture assumes single authorized user.
