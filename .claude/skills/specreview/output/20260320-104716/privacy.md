# Privacy & Ethics Review — Input Gate (Session Prompt Bridge)

**Spec:** `specs/session-prompt-bridge.md`
**Review ID:** 20260320-104716
**Round:** 2
**Reviewer:** Privacy & Ethics Specialist
**Date:** 2026-03-20

---

## Approval Status

**CONDITIONAL APPROVAL** — The spec has meaningfully improved since Round 1. The critical auto-approve opt-in decision is sound, audit logging is present, and the design shows genuine privacy awareness. However, several gaps remain that need resolution before implementation, particularly around terminal content handling, audit log data minimization, and the regulatory status of content relayed through Telegram.

---

## Research Findings

Before conducting the review, the following areas were researched:

### Terminal Session Monitoring & GDPR

Continuous capture of terminal output is legally and ethically analogous to privileged session recording — a practice that GDPR treats as high-sensitivity processing requiring documented lawful basis and proportionality. Capturing terminal output every 500ms creates a near-complete behavioral record of what the agent (and by extension, the user's intent) is doing at all times. Under GDPR, this requires a Data Protection Impact Assessment (DPIA) if the output may include personal data. The CFAA in the US treats unauthorized terminal monitoring as a federal crime; in this context, because the user is the controller of their own agent, consent is implicit — but the audit trail and data minimization obligations still apply.

### GDPR/CCPA on Automated Decision-Making

GDPR Article 22 creates a right not to be subject to solely automated decisions with significant effects. California finalized CCPA ADMT (Automated Decision-Making Technology) regulations effective January 1, 2026, with full ADMT compliance required by January 1, 2027. These regulations require:
- Pre-use notice of automated decision systems
- Opt-out rights for significant decisions
- Risk assessments before initiating high-risk automated processing

The auto-approve function in this spec is an automated decision-making system — it takes terminal output, runs classification logic, and autonomously acts on behalf of the user without real-time consent. While the scope (file creation approval) is narrower than "significant decisions" under CCPA, the regulatory trend is clearly toward requiring transparency and user control for any automated action that has real-world effects.

### Telegram Data Handling

Telegram's Standard Bot Privacy Policy states that bot developers receive the user's public account data and any messages sent to the bot. When prompt content from a Claude session is relayed to Telegram, that content leaves the local server and passes through Telegram's infrastructure. Telegram servers are subject to Telegram's own privacy policy, which permits data disclosure under legal process from authorized bodies. Content that contains sensitive user data (credentials, personal information appearing in terminal output) is therefore exposed to a third-party infrastructure provider without the user being necessarily aware of that fact.

Telegram Bot Developer Terms of Service also state that developers must only collect data for purposes necessary to furnish the service, and must not share user data with third parties. This constrains what the server can log about Telegram interactions.

### Audit Log Privacy Best Practices

NIST SP 800-92 and GDPR log management guidance both emphasize data minimization in logs: logs should capture the minimum data necessary to serve their security/audit purpose. Storing the full raw terminal prompt text in the audit log creates a record of potentially sensitive content (file paths, command arguments, partial data visible in the terminal) that persists far beyond the session lifetime. Best practice is to log the classification and outcome (what was decided, why) rather than the raw content that triggered the decision. Log files should be encrypted at rest, access-controlled, and have a defined retention policy with automatic deletion.

---

## Critical Issues

### 1. Raw Terminal Content in Audit Log (HIGH)

**Location:** Section 3.3 — Audit log schema, field `"summary": "Create gmail-scan.py"`

The audit log stores a human-readable summary derived from the raw terminal prompt text. The example in the spec (`"Create gmail-scan.py"`) seems benign, but the same mechanism will log prompt text containing file paths, command arguments, data fragments visible in the terminal, and clarifying question content (e.g., `"summary": "What email address should I use for the sender filter?"`). The `raw` field on `DetectedPrompt` makes this worse — if the raw text is ever logged, it could include ANSI-stripped but otherwise complete terminal context.

The log file lives at `.instar/input-gate-log.jsonl` with rotation but no encryption, no access controls beyond filesystem permissions, and a retention policy only defined by file size (10MB, 3 rotations). There is no time-based retention limit specified, which means sensitive summaries could persist indefinitely.

**Risk:** Sensitive user data (file names, email addresses, command content) permanently stored in plaintext logs. If the host machine is compromised or shared, this log is an information leak.

**Required fix:** Define a maximum retention period in time (e.g., 30 days), not just file size. Log only the classification metadata (type, action, reason, response key) and omit the human-readable summary from the durable log. If the summary is useful for debugging, gate it behind a `verboseLogging` config flag, off by default.

### 2. Terminal Output Contains User Data That Is Never Scoped or Filtered (HIGH)

**Location:** Section 3.1 — InputDetector, Section 4 — Data Flow

The InputDetector reads all terminal output every 500ms. Terminal output from Claude Code sessions regularly contains: file contents being created or edited, data fetched from APIs, email content, credentials in environment variable output, and any other content Claude is working with. The spec strips ANSI codes but makes no attempt to filter or scope what portions of the terminal output are retained or analyzed.

The `DetectedPrompt.raw` field captures "the raw terminal text of the prompt" — but prompt detection heuristics scan the full output buffer to find patterns. If that buffer is ever stored (in memory or on disk for debugging), it represents a complete capture of all terminal content during the session.

**Risk:** The system is designed as a monitoring layer over an opaque data stream. Users have no awareness that the system is reading terminal content, and there is no mechanism to exclude sensitive output from analysis.

**Required fix:** The spec must explicitly state that raw terminal capture data is ephemeral — used only for pattern matching in-memory and never written to disk. The `raw` field on `DetectedPrompt` should be dropped or replaced with a hashed fingerprint. Add a note in the config that sessions processing sensitive data (credentials, PII) should consider keeping auto-approve disabled.

### 3. Content Relayed to Telegram Leaves the Trust Boundary (MEDIUM-HIGH)

**Location:** Section 3.4 — Telegram Relay, message format examples

When a prompt is relayed, the message content includes session-derived text:

```
"What email address should I use for the sender filter?"
```

This text originated in the user's Claude session, was captured from the terminal, and is now transmitted through Telegram's servers. Telegram is a third-party infrastructure provider. The user has not been explicitly informed that session content will transit through Telegram — they likely assume Telegram is only used for their own messages, not for agent session output.

The CallbackRegistry stores session context server-side and only passes a token to Telegram. That part is well-designed. But the prompt text itself goes into the Telegram message body, which is Telegram's data.

**Risk:** Session content (which may include sensitive file names, task descriptions, or question text containing PII) is processed by a third-party platform without explicit informed consent for that specific data flow.

**Required fix:** Add a disclosure notice in the onboarding flow and in the configuration UI: "When prompts are relayed to Telegram, prompt text is transmitted through Telegram's servers. Do not use Input Gate relay for sessions handling credentials, personal data, or confidential information." Consider a content sensitivity flag per topic that suppresses relay and falls back to dashboard-only for sensitive sessions.

### 4. Auto-Approve Classification Has No Real-Time Transparency (MEDIUM)

**Location:** Section 3.2 — InputClassifier, Section 10 — Open/Resolved, item 3

The spec resolves the question of per-action Telegram notifications by choosing a "post-session digest" — a summary sent after the session completes listing what was auto-approved. This means a user with auto-approve enabled may not know what actions were taken on their behalf until the session ends.

From a consent and agency standpoint, this is a meaningful gap. The auto-approve decision is made by a classification heuristic (not by the user), and the user only learns about it after the fact. If the classifier has a false positive and auto-approves something unexpected, the user has no real-time opportunity to intervene.

**Risk:** Erosion of user agency and trust if unexpected actions are taken. Users who enable auto-approve may underestimate what they are delegating.

**Required fix:** The post-session digest is appropriate for normal operation, but the spec should add an "anomaly notification" path: if auto-approve takes an action that is at the boundary of its configured scope (e.g., a file creation outside the project directory that the classifier almost blocked, or a command that triggered a pattern near the "destructive" boundary), send an immediate Telegram notification flagging it. This preserves the noise-reduction benefit of digests while providing real-time oversight for edge cases.

---

## Observations

### Strengths

**Opt-in default is correct and well-reasoned.** The spec's decision to make auto-approve opt-in, with an explicit rationale about mobile users not realizing the agent is making decisions on their behalf, reflects genuine privacy awareness. This is the right call and should not be revisited.

**CallbackRegistry design is privacy-preserving.** Storing prompt context server-side and sending only an opaque token to Telegram is a good privacy pattern. It limits what Telegram sees and ensures the token is one-time-use. This reduces the surface area of data exposed to Telegram's infrastructure.

**Audit log is present and structured.** The existence of an audit trail with a defined schema is positive. Many agent systems take actions with no durable record. The log schema includes enough metadata to reconstruct what happened and why, which is necessary for accountability.

**Dry-run mode is privacy-protective.** The `dryRun` config flag allows users to observe what would be auto-approved without committing to it. This is an excellent consent-building mechanism and should be prominently documented.

**"Default to relay" classification posture is correct.** The spec explicitly states this as a design principle. This means uncertain cases go to the human, not to automation. This is the right default for a trust-building system.

### Minor Observations

**No mention of log access controls.** The audit log path is defined but the spec says nothing about who can read it or what permissions it should have. On multi-user systems, this matters.

**The `stallFallbackSeconds` notification leaks session state to Telegram.** The fallback notification ("Your agent paused and is waiting for you") confirms to Telegram that a session is active and stalled. For users in high-sensitivity contexts, even session existence metadata is sensitive. This is a minor point but worth noting in the documentation.

**Pattern matching on "text ending with ? + no subsequent output for 3s" is fragile.** A Claude session analyzing data and printing intermediate output that ends with a question mark (e.g., a progress message like "Found 42 records, filter by date?") will false-positive as a clarifying question prompt. The debounce helps, but this pattern is particularly prone to noise. The resulting false relay to Telegram is low-cost, but repeated false positives erode trust in the system.

**The `pendingPromptReply` state is not persisted.** On server restart during an active relay, the `pendingPromptReply` map is lost, but the Telegram message with the reply prompt is still visible. The user's reply will be treated as a new conversation message, not a prompt response. This is mentioned as a known edge case for CallbackRegistry (stale buttons), but the text reply path has the same gap without the same mitigation.

---

## Recommendations

1. **Define time-based log retention.** Add a `logRetentionDays` config field (default: 30). Implement a scheduled cleanup that deletes log entries older than this limit. Remove `summary` from the default log schema or gate it behind `verboseLogging: false`.

2. **Explicitly document the terminal content ephemerality guarantee.** Add a section to the spec (and the eventual user documentation) stating that raw terminal output is analyzed in-memory only and never written to disk by Input Gate. Remove the `raw: string` field from the `DetectedPrompt` interface, or replace it with a hashed fingerprint for dedup purposes only.

3. **Add a data sensitivity mode per topic.** Allow users to mark a topic as "sensitive" in the topic-session registry. Sensitive topics: disable relay to Telegram, disable auto-approve, and only send dashboard alerts. This gives users a safe mode for sessions handling credentials, personal data, or confidential work.

4. **Add relay disclosure to onboarding.** When Input Gate is first enabled, or when a user enables relay for the first time, display a one-time notice: "Prompts from your sessions will be sent through Telegram's servers. Avoid using relay for sessions that handle passwords, personal data, or confidential files."

5. **Add anomaly notifications for borderline auto-approve decisions.** When the classifier makes an auto-approve decision with low confidence or on a borderline case, send an immediate Telegram notification in addition to the session digest. Log the confidence score in the audit record.

6. **Specify log file permissions.** The spec should note that `input-gate-log.jsonl` should be created with mode 600 (owner read/write only) and should not be included in git sync or public backups.

7. **Address `pendingPromptReply` restart resilience.** Either persist the pending state to a file (analogous to how CallbackRegistry should ideally be persisted), or update the Telegram relay message to include explicit instructions: "Reply to this message or use the dashboard to respond." This sets user expectations that a reply in the topic after a restart will become a new message, not a prompt response.

---

## Scalability Assessment

The privacy risks scale with usage volume and session sensitivity:

- **Low-sensitivity sessions** (code generation, file manipulation in isolated project dirs): Current design is acceptable with the recommended fixes applied. The audit log and opt-in defaults provide adequate accountability.

- **High-sensitivity sessions** (email access, credential handling, personal data processing): The current design is insufficient. Terminal content from these sessions should never be relayed to Telegram or stored in plaintext logs. The recommended "sensitive mode" per topic directly addresses this.

- **Multi-agent or multi-user scenarios:** Not in scope for v1, but the spec should note that CallbackRegistry tokens must not be guessable or enumerable by other agents sharing the same server. The current 8-char base62 token (47 bits of entropy) is adequate for a single-user local server but would need to be longer in a shared environment.

---

## Score

**6.5 / 10**

The spec shows real privacy maturity in its opt-in default, CallbackRegistry design, and "default to relay" posture. The critical gaps are around data minimization (raw terminal content in audit logs, the `raw` field on DetectedPrompt), the lack of a defined retention period, and the absence of user disclosure about Telegram content transit. These are solvable — none require architectural rework — but they must be addressed before implementation. The recommended fixes, if applied, would bring the score to approximately 8.5/10.

---

*Review conducted with reference to: GDPR Articles 5, 22, 25, 35; CCPA ADMT Regulations (effective 2026-2027); Telegram Standard Bot Privacy Policy; NIST SP 800-92 Guide to Computer Security Log Management.*
