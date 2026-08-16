# Security Review — Round 2
## Instar SlackAdapter Spec v1.1

**Review ID**: 20260327-173101 | **Round**: 2 | **Prior Score**: 5.5/10 | **Updated Score**: 7.5/10
**Updated Status: CONDITIONAL APPROVE — BLOCK LIFTED**

---

## Round 1 Critical Issues — Resolution

### CRIT-1: Token Storage Insufficient — PARTIALLY FIXED
`xapp-` added to redaction patterns. Config `0o600`. Bitwarden recommended. Non-expiry risk documented. Plaintext storage remains — accepted constraint for local-first model (matches Telegram). Residual: MEDIUM (down from HIGH).

### CRIT-2: Prompt Injection Unmitigated — FIXED
Injection format changed to structured context file approach. Sanitization rules concrete for display names and channel names. Minor gap: trust boundary delimiter format unspecified (recommend random nonce).

### CRIT-3: Setup Wizard Credential Exposure — FIXED
Screenshots suppressed Steps 6/8. Workspace validation via `auth.test`. CLI changed to stdin (`read -s`). Artifact cleanup added.

---

## Round 1 Significant Issues — All FIXED

- SIG-1: Scopes reduced 17→11, `channels:manage` replaces deprecated `channels:write`
- SIG-2: `authorizedUserIds` required + fail-closed
- SIG-3: Interaction payload verifies user ID + checks `pendingPrompts`
- SIG-4: `downloadFile` path traversal protection specified
- SIG-5: Port fixed 4040→4042

---

## New Issues (Minor)

### NEW-1: CLI Token Flag vs Stdin Contradiction
Section 7.7 shows `--bot-token xoxb-...` flags contradicting Section 6.6's stdin guidance.

### NEW-2: Trust Boundary Delimiter Unspecified
Message body injected within "clearly delimited section" — delimiter format not specified. Recommend random nonce.

### NEW-3: `pendingPrompts` Set Unbounded
No TTL eviction — ignored prompts leak memory slowly. Fix: evict at `relayTimeoutSeconds`.

---

## Conditions for Full APPROVE
1. Reconcile CLI flag vs stdin contradiction in Section 7.7
2. Specify trust boundary delimiter format (random nonce)
3. Add TTL eviction to `pendingPrompts`

**Convergence**: Yes. BLOCK lifted. Spec can proceed to implementation.
