# Privacy & Ethics Review — Instar SlackAdapter Spec

**Review ID**: 20260327-164445 | **Round**: 1 | **Reviewer**: Privacy & Ethics Specialist | **Date**: 2026-03-27

## Approval Status: CONDITIONAL APPROVAL

### Score: 6.5/10

Foundation is strong. DIY model, local-first architecture, and Socket Mode reflect genuine privacy-by-design thinking. Score held back by three concrete gaps.

---

## Research Findings

- **Slack App Scope Risks**: `channels:history` and `groups:history` grant access to entire message history of any channel the bot joins — including messages sent *before* the bot was installed. `users:read` exposes workspace member profiles including email addresses — personal data under GDPR.
- **GDPR Implications**: Under GDPR the instar user is the data controller. Bot tokens provide ongoing access to workspace personal data. Workspace members whose messages are read receive no privacy notice — DIY model skips the published-app compliance path.
- **Browser Automation Token Risks**: Playwright navigates authenticated Slack sessions and extracts OAuth tokens via regex. Token extraction via browser automation bypasses Slack's standard OAuth redirect mechanism.
- **Slack Developer Policy**: Slack prohibits requesting scopes not required for app functioning. The spec's 19-scope bundle violates this for Phase 1.

---

## Critical Issues

### CRITICAL-1: No Retention Policy for Local Message Logs
JSONL message logs persist indefinitely containing personal data (names, user IDs, message content, file references). GDPR Article 5(1)(e) requires data not be kept longer than necessary.

**Required**: Add configurable `logRetentionDays` to `SlackConfig`, implement purge on `instar remove slack`, document that logs contain personal data.

### CRITICAL-2: Workspace Members Have No Notice of Bot Presence
DIY app model avoids the privacy policy / Slack review path intentionally. But workspace members have no way to know an AI agent is reading their messages and logging them locally. Under GDPR Articles 13/14, data subjects must receive a privacy notice.

**Required**: Bot posts pinned notice in each channel it joins; bot display name clearly identifies it as AI; documentation flags this for regulated-industry users. Dedicated workspace default substantially mitigates this.

### CRITICAL-3: Overly Broad Scope Bundle — No Least-Privilege Analysis
Manifest requests 19 OAuth scopes as a single bundle. `im:history`+`im:write`+`im:read` (full DM access, not needed). `files:write` (not needed Phase 1). `groups:history`+`groups:write` (private channel access — significant privacy escalation).

**Required**: Define minimal Phase 1 scope set. Document which scope enables which feature. Make DM and private channel scopes opt-in.

---

## Recommendations

1. **Token Storage Warning**: Completion message should warn about token sensitivity. Elevate Bitwarden integration prominence.
2. **Browser Automation Sandboxing**: Run in isolated profile. Verify `team_id` matches expected workspace before writing config.
3. **`users:read` Data TTL**: Cap cached user profile data at 24 hours. Exclude email from local storage.
4. **`instar remove slack` Must Purge Personal Data**: Delete JSONL logs, cached profiles, and tokens on removal.
5. **Strengthen Dedicated Workspace Recommendation**: Frame as privacy benefit — "only you in this workspace, privacy considerations substantially simpler."
6. **Disclose Retroactive History Access**: When bot joins a channel, `channels:history` allows reading all pre-existing messages. Disclose this.
7. **Align Log Retention with Slack's 90-Day History**: Default `logRetentionDays` to 90.

---

## Observations

- DIY app model is genuinely privacy-preserving from operator's perspective
- Socket Mode eliminates internet-exposed event endpoint attack surface
- Consent model works for dedicated workspace; problematic for shared workspace path
- Bot passively monitors all messages in joined channels — ack reactions (👀, ✅) are good transparency for direct interactions but don't address passive monitoring
- No sensitive data handling (health, financial) addressed — acceptable for v1

---

## Scalability Assessment

Privacy architecture scales well for single-user, single-workspace use. Risks: (1) Multiple workspace support multiplies personal data surface area; (2) Unbounded JSONL log growth; (3) `users:read` caching at scale in large workspaces.
