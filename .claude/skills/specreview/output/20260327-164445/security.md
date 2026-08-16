# Security Review — Instar SlackAdapter Spec

**Review ID**: 20260327-164445 | **Round**: 1 | **Reviewer**: Security Specialist | **Date**: 2026-03-27

## Approval Status: CONDITIONAL — BLOCKED on 3 critical issues

### Score: 5.5/10

Rises to ~7.5/10 with critical issues resolved. The DIY app model and Socket Mode (no public webhooks) are genuine security positives.

---

## Research Findings

- **Slack token (xoxb-) threat landscape**: Active exploitation tools (EvilSlackbot, slackattack) target these tokens specifically. 1,500+ tokens found exposed on GitHub. Tokens do not expire — compromise is persistent until manually revoked.
- **Prompt injection in Slack**: Documented and exploited in production (PromptArmor 2024, The Register 2026). AI agents reading Slack messages are prime targets — malicious content in a channel causes the agent to exfiltrate data or execute attacker instructions.
- **Playwright security**: A documented advisory (GHSA-qxm8-4v54-964r) covers RCE via improper SSL cert validation during browser package installation. Browser automation handling OAuth tokens is an elevated-risk operation.
- **Scope over-permissioning**: Slack reports ~60% of security incidents involve misconfigured scopes. The spec requests 17 bot scopes, several unnecessarily broad.

---

## Critical Issues (must fix before building)

### CRIT-1: Token storage insufficient for actual threat model
Both `xoxb-` and `xapp-` tokens stored in `config.json`. Unlike Telegram, Slack tokens don't expire. No mandatory rotation procedure. Token redaction patterns may not cover `xapp-` prefix. Bitwarden storage is listed as "optional" — should be mandatory or at minimum strongly recommended with clear risk disclosure.

**Fix**: Add `xapp-` to redaction patterns. Add token rotation documentation. Elevate Bitwarden/encrypted storage from "optional" to "recommended." Add rotation reminder to dashboard.

### CRIT-2: Prompt injection attack surface is completely unmitigated
Messages from Slack channels are injected verbatim into Claude sessions. The `slack-channel-context.sh` hook injects the last 30 channel messages as context. A single malicious message persisting in that 30-message window is a persistent injection vector. No sanitization, no trust boundary, no injection defense layer specified anywhere in the spec.

**Fix**: Add input sanitization layer. Consider content classification before injection. Add trust boundary markers around user-supplied content. Document the risk explicitly.

### CRIT-3: Setup wizard scrapes credentials from rendered DOM with no safeguards
Playwright scrapes the `xoxb-` token from the OAuth page via regex. No prohibition on screenshots during this window. No certificate validation enforcement (Playwright SSL advisory). CLI fallback passes token as a command argument (captured by shell history and `ps aux`). No validation that the extracted token belongs to the expected workspace.

**Fix**: Suppress screenshots during token extraction steps. Validate token workspace via `auth.test` immediately. Use stdin for CLI token input (not command args). Add cert validation.

---

## Significant Issues

- **SIG-1**: 17-scope manifest is over-permissioned. `im:*` DMs are in scope despite DM support being deferred. `chat:write.public` allows posting to any workspace channel without membership.
- **SIG-2**: `authorizedUserIds: []` defaults to "workspace membership sufficient" — fail-open. Should be deny-all by default, especially for the "existing workspace" scenario.
- **SIG-3**: Interaction payload (button press) handling does not verify user ID against `authorizedUserIds`. A crafted interaction payload could inject a Prompt Gate response as an arbitrary user.
- **SIG-4**: `downloadFile(url, destPath)` with Slack-provided filenames risks path traversal to sensitive locations like `.instar/config.json`.
- **SIG-5**: `slack-reply.sh` defaults to port 4040 (actual is 4042), and silently attempts unauthenticated requests if AUTH token is unavailable.

---

## Observations

- DIY app model eliminates supply-chain token custody risk — genuine security positive
- Socket Mode eliminates public webhook attack surface — genuine security positive
- Existing `PolicyEnforcementLayer.ts` token redaction is a good foundation
- File permission `0o600` on config is appropriate baseline

---

## Scalability Assessment

- **MVP**: Security posture is adequate for single-user dedicated workspace
- **Growth**: Shared workspace installs multiply attack surface significantly
- **Scale**: Token rotation becomes critical — no expiry means compromise is permanent
- **Viral spike**: Not applicable (DIY model, each user independent)
