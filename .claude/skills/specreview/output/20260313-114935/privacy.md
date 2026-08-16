# Privacy & Ethics Review — Dashboard Quick Paste

**Review ID**: 20260313-114935
**Round**: 1
**Spec**: dashboard-quick-paste.md
**Reviewer Role**: Privacy & Ethics Specialist
**Date**: 2026-03-13

---

## Approval Status

**CONDITIONAL**

The feature is conceptually sound and locally-scoped, which limits the blast radius of most privacy risks. However, several gaps in consent, data visibility, content sensitivity handling, and retention mechanics need to be addressed before implementation. None of the issues are blockers in isolation, but together they form a meaningful privacy debt that should be resolved in v1 rather than deferred.

---

## Critical Issues

### 1. No Content Sensitivity Warning at Time of Paste

The spec allows unrestricted paste of any content — including API keys, passwords, private keys, database credentials, production logs containing PII, and HIPAA/PII-regulated data. The only mention of content type handling is for binary/non-UTF8, which is an encoding concern, not a sensitivity concern.

**Risk**: A user pastes their `.env` file or a production error log containing customer emails. That content is now written to disk with a 7-day TTL, potentially included in the paste history panel visible to anyone with dashboard PIN access. The user may not have thought about what they were pasting — the frictionless UX is a feature, but it removes the moment of reflection that usually accompanies sharing sensitive data.

**Required fix**: Add a lightweight sensitivity warning before or after paste — not a blocker, but a visible notice: "This content will be stored locally for up to 7 days. Avoid pasting secrets or passwords." This mirrors best practices in password managers and secret management tools that explicitly warn against clipboard use for secrets.

---

### 2. Paste History Panel — No Access Scope or Expiry UI

The spec calls for a "history panel" showing recent pastes with timestamps, labels, and delivery status. This panel is protected only by the dashboard PIN — meaning anyone who can access the dashboard can see the full history of pasted content.

**Risk**: The dashboard is designed to be accessible from any device via tunnel. If the tunnel URL is shared (e.g., for mobile monitoring), paste history becomes visible to anyone with the PIN. There is no per-paste expiry control, no way to delete individual entries, and no indication in the UI that content is retained.

**Required fixes**:
- Individual paste deletion from the history panel
- Visual indicator showing TTL remaining (e.g., "expires in 5 days")
- Consider redacting content preview in the history panel (show label + char count only, not content)

---

### 3. Retention Policy Is Fixed and Non-Configurable

The spec hardcodes a 7-day TTL for paste files and a 24-hour TTL for unclaimed queued pastes. There is no user-facing control over retention, no option to delete immediately after delivery, and no disclosure at paste time about how long the content will be stored.

**Risk**: Under GDPR's storage limitation principle (Article 5(1)(e)), personal data must not be kept longer than necessary for the purpose. If the purpose of a paste is to deliver content to an agent session — and delivery succeeds — there is no longer a functional need to retain the file. A 7-day post-delivery retention period needs a justification beyond "audit trail."

**Required fixes**:
- Add a "delete after delivery" option (default: off, but surfaced)
- Disclose retention period at paste time
- Justify the 7-day TTL in terms of purpose — if it's for recovery/resend, say so

---

### 4. No Explicit Consent for Content Storage

The spec's security section notes that paste files are excluded from git-sync (good), but there is no point in the UX flow where the user is informed that their pasted content will be written to disk. The Send button implies "send to agent," not "store as a file for 7 days."

**Risk**: Users may reasonably expect paste content to be ephemeral — sent and gone, like a message. The file-based delivery mechanism (Option A, recommended) is an implementation detail that has significant privacy implications the user never sees.

**Required fix**: Add a single line of disclosure beneath the Send button: "Content is stored locally for up to 7 days." This is minimal friction and satisfies transparency requirements under GDPR Article 13 (information to be provided at collection time).

---

## Recommendations

### R1: Immediate Deletion After Confirmed Delivery
If Option A (file drop) is used and delivery is confirmed, offer to delete the file immediately. The "audit trail" value of retaining delivered paste files is low relative to the privacy cost. Make deletion on delivery the configurable default.

### R2: Redact History Panel Content Preview
The paste history panel should show label, character count, timestamp, and delivery status — not a content preview. If preview is desired, require an explicit click to expand, making the exposure intentional rather than automatic.

### R3: Sensitive Content Heuristics
Before writing to disk, run a lightweight pattern-match for obvious secrets (lines matching `API_KEY=`, `password=`, `-----BEGIN`, `sk-`, etc.). If detected, surface an interstitial: "This looks like it may contain secrets. Are you sure?" This is a non-blocking UX guardrail, not a hard block.

### R4: File Permission Hardening
The spec does not specify file permissions for `.instar/paste/` files. They should be created with `0600` (owner read/write only) at minimum. If the Instar server runs as a dedicated user, paste files should be owned by that user. This is basic defense-in-depth for local storage.

### R5: Configurable Retention Window
Allow `pasteRetentionDays` in `.instar/config.json` (default: 7, range: 1–30). This gives privacy-conscious users control without changing defaults for typical use.

### R6: Queue Expiry Disclosure
The spec mentions pastes expire after 24h if unclaimed, but there is no user-facing indication of this. If a user pastes content when no session is running, the dashboard should clearly show: "No active session — this paste will be held for 24 hours, then deleted if not claimed."

---

## Observations

### Ethical Consideration: Frictionless UX vs. Reflective Consent
The feature is designed for maximum convenience — large text area, no limits, immediate send. This is a good UX goal, but frictionless data submission can suppress the user's natural moment of reflection before sharing sensitive content. The parallel to clipboard security research is apt: users routinely paste secrets without thinking about where they're going. A well-designed paste feature should create one lightweight reflection point without becoming a liability waiver.

### Ethical Consideration: Paste History as a Secondary Data Store
The history panel functionally creates a searchable log of everything the user has ever pasted to their agent — potentially including code, credentials, private communications, and business-sensitive content. This secondary use (archival/audit) is distinct from the primary use (delivery to agent). The spec does not acknowledge this dual-use character. At scale, this is the kind of feature that accumulates significant sensitive data over time without users realizing it.

### Ethical Consideration: Truncation Detection and Behavioral Inference
The spec includes a truncation detection subsystem that analyzes incoming Telegram messages for behavioral signals (message length, timing, structural completeness). This is a form of passive behavioral monitoring. While the purpose (helpfully suggesting Quick Paste) is benign, users are not informed that their message patterns are being analyzed. At minimum, this should be documented in any privacy notice.

### Ethical Consideration: Power Asymmetry in Agent Platforms
The broader context matters here: users are submitting content to an AI agent that processes it autonomously. There is an inherent information asymmetry — the user pastes something, and the agent (and potentially future sessions, via the handoff/history system) retains access to it. The spec's choice to recommend file-based delivery precisely because it "leaves an audit trail" reflects a developer-centric value (debugging/reliability) that may conflict with user privacy interests.

---

## Research Findings

### Clipboard and Paste Privacy Risks
Research consistently identifies clipboard-as-attack-surface as a meaningful privacy risk: apps have been caught silently reading clipboard contents, and clipboard data persists in memory as plaintext on most operating systems. The Quick Paste feature sidesteps the clipboard access risk (the user intentionally pastes into a form field) but introduces a new surface: intentional paste of sensitive content that the user did not intend to persist. Mozilla's guidance on preventing secrets from leaking through clipboard and Android's secure clipboard handling guidelines both emphasize that the moment of paste is a high-risk data exposure event that applications should handle with explicit care.

Sources: [Mozilla Security Blog](https://blog.mozilla.org/security/2021/12/15/preventing-secrets-from-leaking-through-clipboard/), [Android Developers](https://developer.android.com/privacy-and-security/risks/secure-clipboard-handling), [PacketLabs](https://www.packetlabs.net/posts/clipboard-data-security/)

### GDPR Compliance for AI Agent Platforms
CNIL's recommendations for AI system GDPR compliance and IAPP's analysis of agentic AI emphasize that the data minimization principle (Article 5(1)(c)) requires that data collection be "adequate, relevant, and limited to what is necessary." For a paste feature whose purpose is content delivery to a session, retaining the raw content for 7 days post-delivery requires explicit justification. The storage limitation principle (Article 5(1)(e)) further requires that data not be kept longer than necessary. Platforms must also provide transparency at the point of collection under Articles 13-14.

AI agent platforms specifically face heightened scrutiny because they process potentially sensitive user inputs in an automated, opaque context. The user submitting content to an AI agent may not fully understand what happens to that data — making transparency at the submission point legally and ethically important.

Sources: [CNIL](https://www.cnil.fr/en/ai-system-development-cnils-recommendations-to-comply-gdpr), [IAPP](https://iapp.org/news/a/engineering-gdpr-compliance-in-the-age-of-agentic-ai), [heyData](https://heydata.eu/en/magazine/how-to-make-ai-agents-gdpr-compliant/), [Protecto](https://www.protecto.ai/blog/gdpr-compliance-for-ai-agents-startup-guide/)

### Data Retention Best Practices
Industry consensus on local storage of sensitive user data identifies three non-negotiable practices: (1) classify data by sensitivity before storing, (2) enforce minimum necessary retention periods with automated deletion, and (3) provide users with deletion controls. The spec satisfies (2) partially (7-day TTL with auto-cleanup) but does not satisfy (1) or (3). Secure deletion — not just file removal but ensuring content cannot be recovered from disk — is also recommended for sensitive data, though this may be overkill for the Instar use case given local-only storage.

Sources: [FileCloud](https://www.filecloud.com/blog/data-retention-policy-best-practices/), [Drata](https://drata.com/blog/data-retention-policy), [ZenData](https://www.zendata.dev/post/data-retention-policy-101-best-practices-for-storing-and-deleting-data-responsibly)

---

## Scalability Assessment

### How Privacy Posture Changes at Scale

**At current scale (single-user, local agent)**: The privacy risks are real but contained. One user, one machine, local-only storage, no external transmission. The main risk is accidental long-term retention of sensitive content the user forgot about.

**At 10-100 users (team deployment)**: The dashboard PIN becomes a shared credential, which means paste history is visible to all users with dashboard access. The current design has no per-user paste history isolation. If users are pasting team-specific or role-sensitive content (e.g., a developer pasting prod credentials to debug something), other team members can see it in the history panel. This is a significant escalation of the access control gap.

**At 1,000+ users (platform scale)**: If Instar evolves toward a hosted or multi-tenant model, the paste storage model would need fundamental redesign. Local files per agent are fine for single-user; a multi-tenant deployment would require encrypted-at-rest storage, per-user access controls, and formal data processing agreements. The current design does not anticipate this, which is fine for v1 — but the architecture should not assume local-only forever.

**Cumulative retention risk**: The 7-day TTL means each user accumulates up to 7 days of paste history at any given time. For power users pasting frequently, this could be a substantial corpus of sensitive content. The auto-cleanup handles the tail, but there is no mechanism for users to audit what is currently retained — only the history panel, which shows recent items. A "clear all paste history" action would be appropriate at any scale.

**Behavioral data accumulation**: The truncation detection subsystem generates implicit behavioral profiles (message length patterns, timing, content structure). At scale, this becomes a dataset about user behavior that was not collected for that purpose. This is a purpose limitation concern under GDPR Article 5(1)(b).

---

## Score

**6.5 / 10**

**Justification**: The spec demonstrates genuine privacy awareness in several areas — git-sync exclusion of paste files, auth token requirement for the API, local-only storage, and auto-cleanup. These are meaningful baseline controls. The score is held back by four issues that are addressable but not addressed: (1) no content sensitivity warning at paste time, (2) paste history panel with no deletion control or content redaction, (3) fixed retention with no user control or delivery-triggered deletion, and (4) no disclosure of storage at the point of collection. None of these are exotic requirements — they are standard expectations for any feature that stores user-submitted content. Addressing them would bring the score to 8.5+. The truncation detection subsystem is a minor additional concern (passive behavioral monitoring without disclosure) but does not significantly affect the score given its limited scope and benign purpose.

---

*Review generated by privacy-specialist agent | Round 1 | 20260313-114935*
