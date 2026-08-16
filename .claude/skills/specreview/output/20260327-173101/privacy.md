# Privacy & Ethics Review — Round 2
## Instar SlackAdapter Specification v1.1

**Round**: 2 | **Prior Score**: 6.5/10 | **Updated Score**: 7.5/10 | **Date**: 2026-03-27

## Updated Approval Status: CONDITIONAL APPROVAL (up from 6.5)

---

## Round 1 Critical Issues — Verification

### CRITICAL-1: No retention policy for local message logs — PARTIALLY FIXED

The spec adds `logRetentionDays?: number` (default: 90) to `SlackConfig`. Right field, right default. However:
- No implementation specified — no method in SlackAdapter, no cron task, no reference to MessageLogger purging old entries. A config field nothing reads is not a retention policy.
- `instar remove slack` is listed but completely unspecified. Round 1 REC-4 (removal must purge personal data) not addressed.
- `Set to 0 for unlimited` documented without GDPR caveat.

### CRITICAL-2: Workspace members have no notice of bot presence — FIXED

Section 6.7 "Third-Party Awareness" added with concrete pinned message template and GDPR Articles 13/14 citation. Bot display name requirement ("Echo (AI Agent)") is specific. Section 5.5 warns existing workspace users.

**Remaining gap**: Notice is "good practice" in dedicated workspaces — should be mandatory unconditionally. Cost: one pinned message. Risk of omitting: GDPR violation if workspace is less private than assumed.

### CRITICAL-3: Overly broad scope bundle — FIXED

Phase 1 reduced from 17-19 scopes to 11. Private channel scopes moved to Phase 2. `channels:write` replaced with `channels:manage`. Each scope has inline justification. DM scopes correctly included since DMs promoted to Phase 1.

---

## Round 1 Recommendations — Verification

| Rec | Status | Notes |
|-----|--------|-------|
| REC-1: Token warning in setup completion | PARTIALLY | In Section 6.6, absent from Step 14's message template |
| REC-2: Browser automation sandboxing | NOT ADDRESSED | No Playwright profile isolation |
| REC-3: `users:read` TTL | NOT ADDRESSED | No caching TTL defined |
| REC-4: `instar remove slack` data purge | NOT ADDRESSED | CLI command listed with no behavior |
| REC-5: Dedicated workspace privacy messaging | ADDRESSED | Section 5.5 updated |
| REC-6: Retroactive history disclosure | PARTIALLY | Retroactive nature not surfaced to user |
| REC-7: Align retention to 90-day default | ADDRESSED (intent) | Purge mechanism unspecified |

---

## New Features — Privacy Assessment

**DM Support**: DM content enters same JSONL log without acknowledgment of higher sensitivity. `im:history` grants retroactive DM access — higher stakes than channel history.

**Thread Support**: No new privacy concerns.

**Third-Party Notices**: Genuine fix. Template specific, GDPR reference accurate, AI display name concrete.

---

## Conditions for Full APPROVE

1. Specify `instar remove slack` behavior: what data is deleted, confirmation prompt, optional pre-deletion export
2. Specify where `logRetentionDays` purge is implemented (one sentence: "MessageLogger purges entries older than logRetentionDays on startup")
3. Acknowledge DM log sensitivity — note DM content in unified JSONL log
4. Move Bitwarden recommendation into Step 14 completion message
