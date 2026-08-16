# Adversarial Review — Round 2
## Instar SlackAdapter Spec v1.1

**Review ID**: 20260327-173101 | **Round**: 2 | **Prior Score**: 6.5/10 | **Updated Score**: 7.0/10
**Status: CONDITIONAL APPROVAL**

---

## Round 1 Issue Verification

| Issue | Status |
|-------|--------|
| CRITICAL-1: AuthGate fail-open | FIXED |
| CRITICAL-2: Token screenshots | FIXED |
| CRITICAL-3: Prompt injection via names/sender | PARTIALLY FIXED (HIGH residual) |
| CRITICAL-4: Ack before auth check | FIXED |
| HIGH-1: wsUrl in logs | FIXED |
| HIGH-2: Channel creation cap | PARTIALLY FIXED (LOW residual) |
| HIGH-3: Reaction race condition | FIXED |
| HIGH-4: Manifest URL injection | PARTIALLY FIXED (LOW residual) |
| HIGH-5: Reconnection loop | FIXED |
| Bug: split('_') separator | FIXED |
| Bug: port 4040 | FIXED |

7/11 fully fixed. 0 still open. CRITICAL-3 has HIGH residual.

---

## CRITICAL-3 Residual (HIGH)

Section 10.1 says "trust boundary markers" but never defines them. Message content injected "as-is." Attacker sending crafted delimiters can break any text boundary. Spec needs JSON-encoded message content or concrete delimiter format with random nonce.

---

## New Attack Vectors from v1.1

### NEW-3: Ring Buffer Poisoning (HIGH)
Ring buffer populated from ALL Socket Mode events before AuthGate runs. Unauthorized workspace member can poison buffer with adversarial content that gets injected into authorized users' session context. Bypasses AuthGate entirely.

### NEW-1: DM Unauthorized File Download (HIGH)
DM support added but `handleFileShared()` auth check not confirmed for DMs. Unauthorized user can send large files via DM repeatedly → disk exhaustion.

### NEW-2: Thread Hijacking (HIGH)
Thread routing new in v1.1. No explicit confirmation that `handleMessage` applies AuthGate for thread replies. Unauthorized colleagues can reply to bot's threads in shared workspaces.

### NEW-5: SSRF via upload_url (MEDIUM)
Three-step file upload does `fetch(urlResponse.upload_url)` without hostname validation. Should require `.slack.com` domain.

### NEW-7: CLI Spec Contradiction (MEDIUM)
Section 6.6 says stdin for tokens. Section 7.7 shows `--bot-token` argument. Insecure form must be deleted.

### NEW-4: /tmp Path Injection via Channel ID (MEDIUM)
No channel ID format validation before constructing `/tmp/instar-slack/ctx-CHANNEL_ID-TIMESTAMP.txt`. Should validate `^[CDG][A-Z0-9]{8,12}$`.

### NEW-6: mrkdwn Injection in Third-Party Notice (LOW-MEDIUM)
`{agent-name}` and `{operator-name}` in pinned notice need mrkdwn escaping.

---

## Required Before APPROVE

- P0: Define trust boundary format — JSON-encode message content in context files
- P0: Scope ring buffer to authorized-user messages only OR document it's not a security boundary
- P0: Confirm thread replies go through AuthGate
- P1: Confirm DM file_shared checks auth before download
- P1: Validate upload_url hostname before PUT
- P1: Delete insecure `--bot-token` argument form from CLI spec
