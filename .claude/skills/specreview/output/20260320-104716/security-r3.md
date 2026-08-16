## Round 3 Security Review — Prompt Gate

**Updated Score: 8.5 / 10** (up from 5.5 in R2)
**Approval Status: CONDITIONAL APPROVE**

All 6 Round 2 issues are **FIXED**. The spec received substantive fixes, not cosmetic ones. Two new minor gaps were introduced by the fix design.

### R2 Issue Verdicts

| Issue | Status | Notes |
|-------|--------|-------|
| CRIT-1: No auth on callback_query | **FIXED** | `ownerId` check added before token resolution; non-owner preserves token |
| CRIT-2: Indirect prompt injection | **FIXED** | Two-stage: quiescence gate (2s silence + buffer-tail only) + Haiku-class LLM classifier |
| CRIT-3: sendInput unsanitized | **FIXED** | Button allowlist `['1','2','3','y','n','Enter','Escape']` + `sanitizeInput()` with control-char strip, newline→space, 512-char limit |
| P1: Math.random tokens | **FIXED** | `crypto.randomBytes` specified explicitly; CSPRNG test in matrix |
| P1: bashSafe unreliable | **FIXED** | Removed from v1 scope entirely; bash always classifies as relay |
| P1: Path traversal in classifier | **FIXED** | `path.resolve()` normalization before boundary check; test in matrix |

### New Issues

**N1 — P2: ownerId auto-population is a trust escalation race**

The spec allows `ownerId` to be auto-populated from the first relay responder. In a group chat or topic with multiple members, any user who taps the button first gets permanently authorized as the session owner. The authorization check reads `if (ownerId && senderId !== ownerId)` — while `ownerId` is null the check is skipped entirely (fail-open). Recommend: restrict auto-population to private chats, require a challenge-response, or fail-closed when `ownerId` is not set.

**N2 — P3: sanitizeInput() control-char/newline overlap**

`/[\x00-\x1F\x7F]/g` already replaces `\n` (0x0A) with a space, so the explicit `.replace(/\n/g, ' ')` on the next line never fires. Correctness issue, not a security hole, but if the first line is removed by a future editor the newline-as-keypress protection disappears silently. Should be documented or restructured.

### Implementation Notes

1. LLM classifier prompt must use clearly delimited "untrusted input" blocks (XML tags or equivalent) — standard defense against prompt injection in the classifier itself.
2. Decide on ownerId null behavior: fail-closed (block all callbacks) is safer than fail-open.
3. Document the sanitizeInput() overlap explicitly.
