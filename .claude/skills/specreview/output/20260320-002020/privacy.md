# Privacy & Ethics Review: Input Gate (Session Prompt Bridge)

**Review ID:** 20260320-002020
**Spec:** `specs/session-prompt-bridge.md`
**Reviewer Role:** Privacy & Ethics Specialist
**Round:** 2
**Date:** 2026-03-20

---

## Approval Status

**CONDITIONAL APPROVE**

The spec has meaningfully improved since Round 1. Auto-approve is now opt-in, the audit log schema is defined, ANSI stripping is specified, and a log rotation policy is in place. These were the most significant privacy and safety gaps from the prior round. What remains are structural gaps rather than blockers: the audit log records terminal content without a disclosure mechanism, Telegram message data persists with no defined retention policy, and the auto-approve classifier relies on path heuristics that can be circumvented. None of these prevent shipping, but all of them accumulate privacy debt that will be harder to address post-launch than pre-launch.

---

## Research Findings

### GDPR / Data Protection Requirements for AI Agents and Audit Logs

GDPR compliance for AI agents in 2026 is increasingly concrete. Audit logs must be immutable (write-once), retained for a minimum of 12 months under typical accountability requirements â but the personal data within those logs must be deleted when it is no longer justified, which is a separate and shorter clock. GDPR caps most operational logs at 90 days unless a longer period is specifically justified. The EU AI Act's 10-year documentation retention applies to system-level technical documentation, not to raw data logs containing personal information.

For AI agents handling user data, the key requirements are: (1) automated retention enforcement (manual deletion is insufficient), (2) encryption at rest for logs containing personal data, (3) data minimization â log only what is necessary to demonstrate accountability, not everything available, (4) user rights: individuals must be able to request deletion of their data from logs.

The spec's log rotation policy (rotate at 10MB, keep 3 rotations) is defined in terms of size, not time. This does not satisfy GDPR-aligned time-based retention. It also does not address encryption at rest or user deletion rights.

### Terminal Output Monitoring: The Keystroke-Adjacent Problem

Monitoring terminal output â including raw prompt text â is functionally adjacent to keystroke logging when the terminal contains sensitive content. The ethical and legal framework for keystroke/terminal monitoring is: (1) explicit consent is required; (2) transparency about what is captured is mandatory; (3) under GDPR, capturing content that may include credentials, personal data, or confidential information requires specific legal basis. The `raw` field in `DetectedPrompt` stores the raw terminal text of the prompt. If the terminal contains sensitive content (passwords, tokens, PII in filenames or paths) at the time a prompt is detected, that content is captured and logged.

The spec does not address what happens when the terminal contains sensitive content at detection time, nor does it implement any scrubbing before the `raw` field is stored.

### Telegram Bot Data Handling Requirements

Telegram Bot Platform Developer Terms of Service require: (1) bots must have an accessible privacy policy detailing what data is stored and why; (2) user data must not be shared with third parties without explicit authorization; (3) developers must comply with applicable privacy laws including GDPR; (4) failure to comply can result in permanent bot ban. The spec routes user decision responses (button taps, text replies) through Telegram â this makes the bot's data handling an in-scope compliance concern, not a third-party responsibility.

User Telegram messages captured as prompt replies are currently handled transiently (in-memory `pendingPromptReply` map), but the audit log records what was relayed and what response was received. If the user's reply contains personal data (e.g., "use caroline@example.com"), that data appears in the audit log with no defined retention limit beyond the size-based rotation.

### AI Agent Auto-Approve: Ethical Consensus in 2026

The current ethical and governance consensus (Anthropic's own research, IBM, WEF, EU regulatory guidance) is: autonomous action must be calibrated to risk; high-risk decisions require human-in-the-loop; retrospective audit is necessary but not sufficient for governance; the degree of autonomy should be surfaced clearly to users so they understand what their agent can do without asking. Anthropic's research on agent autonomy shows that as users gain experience, auto-approve usage increases from ~20% to ~40% â meaning users relax oversight over time. This is a predictable trajectory that the spec's design should account for: features designed for cautious adoption tend to be used permissively in practice.

The "file creation in project dir" auto-approve category sounds safe but depends entirely on the correctness of path boundary detection. One path traversal in the classifier (or in the session's working directory state) means auto-approving file creation outside the intended boundary. This is not a theoretical risk â it is the class of bug that makes graduated trust dangerous.

---

## Data Collection

**What is collected:**

1. `DetectedPrompt.raw` â raw terminal text at the moment a prompt is detected. This may include filenames, paths, partial command output, error messages, or any other content present in the terminal at detection time.
2. `DetectedPrompt.summary` â a human-readable one-liner derived from the raw text.
3. The audit log schema (`input-gate-log.jsonl`) includes: sessionName, type, summary, classification, reason, response (the key sent to tmux), relayedToTopic, respondedBy, respondedAt.
4. `pendingPromptReply` â the user's text reply to a relayed prompt, transiently held in memory and then injected into the session. The response is also written to the audit log.
5. Callback registry entries â sessionName, promptId, and the response key, held in memory until consumed or pruned.

**Data minimization assessment:**

The `raw` field is the primary concern. Storing raw terminal text goes beyond what is needed for an audit log. The `summary` field (a human-readable one-liner) is sufficient to demonstrate what was detected and why a decision was made. The `raw` field should either be dropped, or scrubbed for known sensitive patterns (tokens, passwords, PII) before storage. Currently, this field is stored without any sanitization.

The `response` field in the audit log stores the exact key or text sent to the session. For button-based responses this is typically "1", "y", or similar. For text-reply responses, this is the user's verbatim text â which may contain personal data (email addresses, account names, file paths). This is the most likely field to accumulate personal data in the audit log with no defined retention horizon.

**Disclosure:**

There is no user-facing disclosure of what is captured and logged. A Telegram user tapping a button or sending a text reply has no indication that their response is being recorded in an audit log. This is a transparency gap that affects informed consent.

---

## Consent

**Is consent obtained?**

The spec treats the Telegram user as the agent owner â the same person who configured instar. This is a reasonable assumption in the current deployment model (single-user agent). However, the spec does not explicitly state this assumption, and the design does not prevent multi-user scenarios where a second Telegram user in the topic could send a text reply that is consumed as a prompt response and logged.

For the single-user case: the agent owner has implicitly consented to instar's operation by deploying it. But implicit consent for "instar monitors my sessions" does not automatically extend to "instar logs the exact text of my terminal prompts and my verbatim replies." These are meaningfully different data scopes.

**Is consent granular?**

No. The current config allows `inputGate.enabled: true/false` â an all-or-nothing toggle. There is no way to enable relay-to-Telegram without also enabling audit logging, or to enable auto-approve without logging. Users who want the session-unblocking benefit but do not want verbatim text logging have no option.

**Is consent withdrawable?**

Turning off `inputGate.enabled` stops future collection. However, there is no mechanism to delete historical audit log entries. The user cannot purge their own logs through the instar interface.

---

## Data Storage and Access

**Storage location:** `.instar/input-gate-log.jsonl` â local filesystem within the agent's state directory.

**Encryption:** Not specified. The audit log is stored as plaintext JSONL. If the filesystem is unencrypted (common on developer machines), this log is accessible to any process with read access to the state directory. If the log contains sensitive terminal content via the `raw` field or personal data in `response` fields, this is a meaningful exposure.

**Access control:** Not specified. The spec does not restrict which processes or users can read the log.

**Retention:** Log rotation at 10MB with 3 rotations kept. This is size-based, not time-based. A low-volume deployment might keep entries for years. A high-volume deployment might rotate through all 3 rotations in days. This policy does not translate to a predictable privacy guarantee about how long data is retained.

**Deletion:** No mechanism defined. Users cannot request deletion of specific entries. There is no automated time-based expiration.

**CallbackRegistry:** In-memory only. Pruned on a 60-second interval and on server restart. This is appropriate â transient data should stay transient.

**pendingPromptReply map:** In-memory only. Cleared on use or session death. Appropriate.

---

## Data Sharing

**Telegram:** User prompt content and responses transit through Telegram's servers. The message text ("Your agent has a question: 'What email address should I use for the sender filter?'") is transmitted to Telegram and stored according to Telegram's own retention policies, which are outside instar's control. This is an inherent consequence of using Telegram as the relay channel, not a flaw unique to this spec â but it means data subjects have no ability to delete relayed prompt content from Telegram's servers via instar.

**Third parties:** No other third-party data sharing is specified.

**De-anonymization risk:** The audit log entries include `sessionName` (which typically maps to a project or task context) and `summary` (a description of the operation). Together with timestamps, this creates a behavioral profile of the agent's activities. For a personal-use agent this is low-risk. If instar is ever used in a multi-tenant or shared infrastructure context, this profile data requires additional protection.

---

## Fairness and Bias

**Classifier bias by path structure:**

The InputClassifier's auto-approve boundary is "file creation in the agent's project directory" and "edits to files the agent created in this session." This heuristic disadvantages agents that work across multiple directories or in shared filesystem structures. It also creates an uneven experience: two operations that are functionally identical in risk (creating a small script) may be auto-approved or relayed based purely on filesystem location, not actual risk.

**Asymmetric relay burden:**

When auto-approve is disabled, all prompts are relayed to Telegram. If a task requires many permission prompts (e.g., a scaffolding operation that creates 20 files), the user receives 20 separate Telegram messages. There is no batching, deduplication across a task, or rate-limiting of relay messages in the spec (other than a 1 msg/s API limit). Users with slower response patterns or those in different time zones will experience disproportionate session stalls compared to users who are immediately available on Telegram. This is a usability-fairness issue rather than a discrimination concern, but worth noting.

**No bias in AI components:** The spec does not use any ML classifiers â classification is rule-based. This eliminates the risk of trained-in bias in the classification step.

---

## AI-Specific Ethics

**Auto-approve and the erosion of oversight:**

The spec makes auto-approve opt-in, which is correct. However, Anthropic's own research shows that users progressively relax oversight as they build familiarity with a system. The `dryRun` mode helps during initial setup but does not address this drift. The spec has no mechanism to detect when auto-approve is being used to bypass what would otherwise be significant decisions, and no mechanism to prompt the user to periodically review what is being auto-approved.

**Scope creep in classification:**

The "auto-approve" category includes "non-destructive bash commands (ls, cat, grep, curl to localhost)." The `curl to localhost` boundary is particularly important: localhost includes other services running on the developer's machine. An agent auto-approving `curl http://localhost:8080/admin/reset` is not obviously safe. The current classifier relies on string matching the prompt text â Claude Code's prompt says "Run curl..." not "Run curl to localhost" â meaning the safe/unsafe distinction for localhost curls must be made by parsing the command arguments from the prompt text. This parsing is not specified, and if it is not implemented, the classifier may auto-approve external curl requests if Claude's prompt format does not make the distinction obvious.

**Power imbalance in relay:**

The relayed prompt message format ("Your agent is waiting â approve or decline") creates a subtle urgency that may lead users to approve requests without reading them carefully, particularly when they see "Your agent has a question" on mobile. This is a design nudge that pushes toward approval. The spec does not include any mechanism to slow down or flag high-stakes relay decisions for extra scrutiny.

**Agent autonomy boundary:**

The spec correctly positions InputDetector + AutoApprover + Classifier as operator-controlled infrastructure, not a standalone autonomous agent. The human retains meaningful control through the relay pathway. The main risk is that the auto-approve category expands over time (via config changes or classifier updates) without the user realizing the scope has grown.

**Terminal content as surveillance surface:**

The 500ms capture loop is designed for session monitoring. Extending it to capture and pattern-match terminal content for prompt detection is a meaningful expansion of the surveillance surface. The spec correctly strips ANSI codes before matching, but the `raw` field in `DetectedPrompt` still captures terminal content. If that content includes credential material, API keys, or PII (which legitimately appears in terminal output during software development), the capture loop becomes a credential-logging mechanism. This is not the intent, but it is a consequence that should be explicitly addressed.

---

## Regulatory Compliance

**GDPR exposure:**

The spec operates on a developer's local machine. If the operator is an EU-based individual using the system for their own work (most likely), GDPR's household exemption may apply â GDPR Article 2(2)(c) exempts "purely personal or household activity." However, if instar is used in any professional capacity, or if the Telegram topics involve other data subjects (clients, collaborators), GDPR applies.

Key GDPR gaps in the current spec:
1. No time-based retention policy for audit logs (size-based rotation does not satisfy GDPR data minimization)
2. No encryption at rest for audit log data
3. No user deletion mechanism for audit log entries
4. No privacy notice for Telegram users interacting with the relay
5. The `raw` field stores terminal content with no scrubbing â potential GDPR Article 25 (data protection by design) violation if that content includes personal data

**CCPA:** If the operator is in California and uses instar in any business context, CCPA's right-to-delete requirements apply to any personal information in the audit log. Same structural gap as GDPR.

**EU AI Act:** The Input Gate does not appear to fall under high-risk AI system categories as defined in Annex III of the EU AI Act. It is a developer tool for agent session management, not a biometric system, employment decision system, or critical infrastructure. No immediate EU AI Act compliance obligations are identified.

**Telegram ToS compliance:**

The spec creates a bot that relays agent prompts and user responses. Telegram Bot Platform Terms require a bot privacy policy. The spec does not mention one. If this is a production deployment, a privacy policy that covers what data the bot processes and for how long is a ToS requirement, not just a good practice.

---

## Dual-Use Concerns

**The monitoring surface as a keylogger:**

The most significant dual-use concern is that InputDetector, running at 500ms intervals and capturing raw terminal output, is functionally a terminal monitor. In its intended use, it detects prompts and routes them to the user. In a misuse scenario (compromised instar instance, malicious extension of the pattern catalog, or unintended broadening of the `raw` capture), the same infrastructure captures everything that passes through the tmux pane. The spec does not discuss this dual-use risk.

**Safeguard gap:** There is no mechanism to limit what InputDetector captures to only the last N lines of output (where prompts appear). The spec says "We don't need to parse the entire buffer â prompts always appear at the bottom" but the `raw` field in `DetectedPrompt` stores "the raw terminal text of the prompt" without specifying that this is limited to the matching lines, not the full captured output.

**Callback registry as a replay surface:**

The CallbackRegistry stores session names and response keys with an 8-char token as a handle. The token is transmitted through Telegram. If a third party obtains a valid token before it is consumed (e.g., by monitoring Telegram traffic), they could submit the token to the callback endpoint and inject input into the agent's session. The token is one-time-use, which mitigates replay, but the window between token creation and consumption is a real attack surface. The spec does not mention HTTPS enforcement for the local server or authentication on the callback endpoint.

---

## Critical Issues

### 1. `raw` Field Captures Unscoped Terminal Content

The `DetectedPrompt.raw` field stores "the raw terminal text of the prompt." Terminal output routinely contains credential material, API keys, file paths with PII, error messages with personal data, and other sensitive content. There is no scrubbing, truncation, or scope-limiting defined for this field. Every auto-approved or relayed prompt persists this content in the audit log indefinitely (within the size-based rotation window).

**Required fix:** Either (a) drop the `raw` field from the audit log schema and rely on `summary` for accountability, or (b) specify that `raw` is limited to the exact lines that matched the prompt pattern (not the surrounding terminal context) and implement a scrubbing pass for known sensitive patterns (tokens with entropy thresholds, email addresses, common secret formats) before the field is written.

### 2. Audit Log Has No Time-Based Retention

The log rotation policy (10MB, 3 rotations) is size-based. A low-activity deployment can retain audit log entries for years. A high-activity deployment may lose entries within days. Neither serves the dual purpose of GDPR-aligned data minimization and forensic utility.

**Required fix:** Add a time-based retention field to the config:
```jsonc
"logRetentionDays": 90
```
A background cleanup routine (or a check on server startup) prunes entries older than this threshold. This satisfies GDPR data minimization without requiring significant implementation effort.

### 3. No Disclosure to Telegram Users That Responses Are Logged

Users responding to relayed prompts via Telegram â whether by button tap or text reply â have no indication that their response is recorded in an audit log. This is a transparency gap that affects informed consent under GDPR Article 13 (information to be provided at collection time).

**Required fix:** The relay message format should include a brief disclosure footer. Example: "Your response will be logged for session audit purposes." This can be a single line below the prompt text and button row. For text-reply prompts, the message format should include the same line.

---

## Recommendations

**R1. Drop or scope-limit the `raw` field in the audit log.**
The `summary` field captures what matters for accountability. The `raw` field captures everything that matters for a data breach. If the `raw` field is retained, limit it to the lines that matched the detection pattern (not the full terminal buffer) and implement entropy-based scrubbing before write. Priority: HIGH.

**R2. Add time-based log retention (default: 90 days).**
Replace or supplement the size-based rotation with a configurable `logRetentionDays` field. Implement automated time-based expiration. 90 days is a defensible default under GDPR. Priority: HIGH.

**R3. Add a one-line disclosure to all relay messages.**
"Responses are logged for session audit." One line, below the buttons or prompt text. Satisfies GDPR Article 13 minimum transparency requirement. Zero UX impact. Priority: MEDIUM.

**R4. Tighten the `curl to localhost` auto-approve category.**
Either remove `bashSafe` auto-approval for curl commands entirely, or specify that the classifier parses the hostname from the curl command and only auto-approves `localhost` or `127.0.0.1` with no path that matches known admin patterns. Relying on Claude Code's prompt text alone is insufficient. Priority: MEDIUM.

**R5. Add a minimum-entropy scrubbing pass before prompt summary and raw storage.**
Use a simple entropy check (e.g., strings with Shannon entropy > 4.5 and length > 20) to detect likely API keys or tokens in prompt text and redact them before logging. This is not a complete solution but catches the most common credential formats. Priority: MEDIUM.

**R6. Specify callback endpoint authentication.**
The callback endpoint (`answerCallbackQuery` handler) should require the instar auth token for any HTTP-accessible path. If the instar server is exposed via Cloudflare tunnel, an unauthenticated callback endpoint is a remote code injection surface (an attacker with a valid token can inject arbitrary text into an active session). Priority: MEDIUM.

**R7. Add an audit log viewer with per-entry deletion.**
The dashboard should surface the audit log as a browsable list with the ability to delete individual entries. This satisfies user deletion rights without requiring users to manually edit JSONL files. Priority: LOW (Phase 4).

**R8. Add a periodic auto-approve review nudge.**
When auto-approve is enabled, include a monthly summary message to Telegram: "In the last 30 days, your agent auto-approved N actions. Here are the top categories: [list]. Review your auto-approve settings here." This counters the documented drift toward accepting auto-approve decisions without reading them. Priority: LOW (Phase 4).

---

## Observations

**O1. The opt-in auto-approve decision is the most important privacy improvement from Round 1.** The risk of unintended autonomous action is materially lower with this default. The Round 1 business and DX reviewers both recommended it; it was implemented. This is the right call.

**O2. The audit log is the privacy artifact, not the relay channel.** Telegram messages are transient from the user's perspective. The audit log is the record that persists. The privacy analysis of this spec should be primarily about the log, not the relay. The spec currently has more design attention on the relay pathway than on the log's lifecycle.

**O3. The single-user assumption is implicit but load-bearing.** The entire consent and data handling analysis depends on the Telegram user being the same person as the instar operator. If that assumption breaks (shared topics, team setups, delegated access), the privacy model breaks with it. This should be an explicit stated assumption in the spec, not an implicit one.

**O4. The `pendingPromptReply` text routing creates a covert channel for data injection.** When a relay is active, any text sent to the Telegram topic is routed to the session without appearing in the session's normal message log. A user who forgets a pending relay is active might send a message intended as a new instruction and have it injected directly into the terminal as a prompt response. This is a UX issue, but it also means session state can be affected by user input that bypasses the normal instar message handling pipeline â with no record of the bypass in the session log. The audit log should record when a text reply is consumed via `pendingPromptReply`.

**O5. Log rotation filename convention creates a predictable exposure surface.** `input-gate-log.jsonl`, `input-gate-log.1.jsonl`, etc. are predictable filenames. Any process that can read the `.instar/` directory can enumerate and read all rotations. This is acceptable for a single-user local deployment but worth flagging if instar is ever used in a shared filesystem environment.

---

## Scalability Assessment

The privacy posture of the Input Gate scales poorly in two dimensions:

**Data volume:** More sessions, more auto-approvals, more relayed prompts means faster log growth and faster accumulation of sensitive content in `raw` fields. Size-based rotation without time-based expiration means the retention problem grows with usage. A time-based retention policy must be implemented before the system is used at any meaningful volume.

**User scope:** Adding a second Telegram user to the same topic breaks the single-user consent model. The spec does not address this. Multi-user support would require explicit consent collection from each user, a per-user data map in the audit log, and per-user deletion capabilities. This is a significant privacy architecture change and should be a documented non-goal for v1 rather than an open question.

**Deployment scope:** If instar is deployed with a Cloudflare tunnel (as the spec supports), the callback endpoint is reachable from the internet. The callback handler currently has no explicit authentication check specified. At single-user local scale this is low-risk (the token must be known). At internet scale this becomes a meaningful attack surface.

---

## Score

**6.5 / 10**

**Justification:**

The spec earns credit for: auto-approve opt-in (+1), defined audit log schema (+0.5), ANSI stripping (+0.5), log rotation policy (+0.5), one-time-use callbacks (+0.5), and explicit stale-button handling (+0.5). These are all meaningful improvements over a Round 1 baseline that would have scored in the 4-5 range.

Points deducted for: `raw` field storing unscoped terminal content without scrubbing (-1), size-only log retention without time-based expiration (-0.5), no Telegram relay disclosure (-0.5), `curl to localhost` auto-approve boundary underspecified (-0.5), no callback endpoint authentication specified (-0.5), no user deletion mechanism for audit log data (-0.5).

A score of 8/10 is achievable in Round 3 if the three Critical Issues are addressed. The core architecture is privacy-respecting in intent; the gaps are implementation-level decisions that were not fully specified, not fundamental design flaws.

---

*Review generated by Echo (instar developer agent) Â· Round 2 Â· 2026-03-20*
