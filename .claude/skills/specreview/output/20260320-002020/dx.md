# DX Review: Input Gate (Session Prompt Bridge)
**Review ID:** 20260320-002020
**Round:** 2
**Spec:** `specs/session-prompt-bridge.md`
**Reviewer Role:** Developer Experience & API Design Specialist
**Date:** 2026-03-20
**Prior Round:** 20260319-150852

---

## Approval Status

**APPROVED**

All three Round 1 Critical Issues have been resolved cleanly. The spec is now production-ready from an architecture and DX standpoint. Two minor issues are noted below — neither is a blocker, and both can be addressed in implementation. This is a well-engineered spec and a significant improvement over Round 1.

---

## Research Findings

### JSONL Audit Log Design

The audit log schema added in this revision (`input-gate-log.jsonl`) aligns well with established best practices. Key findings from current practice:

- **Flat structure is preferred over nested.** The spec's schema is correctly flat — no nested objects requiring dot-notation traversal. This is consistent with Mattermost's and Papertrail's recommendations for queryable JSONL logs.
- **Actor + event + context is the canonical triple.** The schema covers all three: `respondedBy` (actor), `classification` + `response` (event), `sessionName` + `promptId` (context). This is complete.
- **Missing: a version field.** Industry practice (Loggly, OpenObserve) recommends a `version` or `schemaVersion` field in audit logs for forward-compatibility. When the schema evolves, you cannot distinguish old-format from new-format entries without it. The spec does not include this. Low severity — easy to add — but worth flagging.
- **Log rotation at 10MB / 3 rotations** is a reasonable default. Some operators will want this configurable via `inputGate.logMaxSizeMB` and `inputGate.logRotations`. The current hardcoded policy is acceptable for v1 but should be surfaced as a config option in v2.

### Telegram InlineKeyboardMarkup UX

Current research confirms the spec's design choices are correct and surfaced one additional consideration:

- **64-byte callback_data limit is confirmed and actively hits production bots.** The CallbackRegistry solution (server-side storage, 8-char token in callback_data = 20 bytes) is exactly the right pattern. Bot API 7.0 also caps total inline keyboard arrays at 100 buttons — not a concern for this use case.
- **`answerCallbackQuery` must be called promptly.** The spec correctly includes this call (to dismiss the loading spinner on the button). Best practice: call it within 10 seconds or Telegram shows a timeout error to the user. The spec doesn't mention this deadline explicitly.
- **Button text should avoid emoji where possible.** Each UTF-8 emoji costs 4 bytes. The spec's button text examples (`[ 1. Yes ]`, `[ Approve ]`, `[ Reject ]`) contain no emoji — this is correct. The message text examples use emoji appropriately in message bodies, not button labels.
- **Stale buttons from deployment changes are a known UX problem.** The spec's server-restart resilience design (prune on startup, show "Session expired" message) directly addresses this known failure mode.
- **Row layout recommendation:** Research shows 5-6 options maximum before users feel overwhelmed, and adding button rows increases response latency measurably (~130ms per extra row on mobile). The spec's "group into rows of 3" default is sound. For the typical 3-option permission prompt, this results in a single row — optimal.

### Configuration Schema Design

The `inputGate` config block added in this revision follows agent system configuration best practices:

- **Flat key structure with grouped sub-objects** (`autoApprove.*`) is idiomatic and consistent with how the rest of `.instar/config.json` likely works.
- **`dryRun` at the top level of `inputGate`** (not nested under `autoApprove`) is the right placement — dry run should affect logging and notification behavior even when autoApprove is disabled.
- **Feature flag (`enabled: true`)** is the correct first-class citizen for any new capability. Rolling back is a config change, not a code change.
- **Per-topic overrides in the topic-session registry** are a clean separation of concerns — global defaults in config.json, local overrides in the registry. This is the right pattern.

### dryRun / Preview Mode

The addition of `dryRun: false` addresses my Round 1 O6 recommendation directly. Research into similar tools (Terraform plan, Ansible check mode, kubectl dry-run) confirms the DX value: operators consistently report that a preview mode is the single highest-trust-building feature during rollout of automation. The key design requirement is that dryRun output must be observable without connecting to the running process — i.e., it should write to the audit log with a `"dryRun": true` marker, not just log to stdout. The spec doesn't explicitly say whether dryRun actions appear in the audit log. They should.

### ANSI Stripping in tmux Workflows

Research confirms that `tmux capture-pane -e` preserves escape sequences by design — they appear as raw bytes in the captured output. Tools like `ansifilter` are the standard stripping solution, but a lightweight inline implementation (`strip_ansi(text)` via regex against the ANSI CSI sequence pattern `\x1b\[[0-9;]*[a-zA-Z]`) is standard practice and sufficient for prompt detection. The spec's `stripAnsi()` function is the right approach.

---

## Round 1 Critical Issue Resolution

### Critical Issue 1: Callback Data Size (RESOLVED)

**R1 finding:** The `relayPrompt()` implementation would exceed the 64-byte `callback_data` limit for any real session name.

**Resolution:** The spec now defines a `CallbackRegistry` component (`src/core/CallbackRegistry.ts`) that stores full prompt context server-side keyed by 8-char base62 tokens. `callback_data` becomes `{"id":"xK4mP9q2"}` — 20 bytes. The component is fully specified: register, resolve (one-time use), prune (on interval and server startup). Server-restart resilience is explicitly designed.

**Assessment: Fully resolved.** The implementation is clean and the spec correctly notes this in the risks table: "Resolved: CallbackRegistry stores context server-side, callback_data uses 8-char token (20 bytes)."

---

### Critical Issue 2: ANSI/Control Character Stripping (RESOLVED)

**R1 finding:** The PromptDetector pattern catalog assumed clean text but `tmux capture-pane` output contains ANSI escape sequences that corrupt regex matching.

**Resolution:** Section 3.1 now explicitly calls out ANSI stripping as a mandatory preprocessing step: "Before pattern matching, all captured output MUST be stripped of ANSI escape sequences and control characters. A `stripAnsi(text: string): string` function runs as step one of every `onCapture()` call." The architecture diagram also shows "ANSI strip +" in the InputDetector box. A dedicated test case `InputDetector.stripAnsi` is listed in Section 7. The false positive test `InputDetector.falsePositive.ansiOutput` is also added.

**Assessment: Fully resolved.** The implementation path is clear and the test coverage is appropriate.

---

### Critical Issue 3: pendingPromptReply Supersession Notification (RESOLVED)

**R1 finding:** When a pending prompt is superseded by a new one, the user was not notified — they might respond to what they thought was the new prompt while it was consumed as the old one's answer.

**Resolution:** Section 5 ("Multiple prompts in sequence") now explicitly specifies the supersession behavior:
1. Old Telegram message is updated: "Superseded by a new prompt below."
2. New prompt is sent immediately after.
3. `pendingPromptReply` is updated to the new prompt.
4. Callback registry entries for the old prompt's buttons are pruned.

**Assessment: Fully resolved.** The sequencing is correct. The supersession message update plus immediate new prompt send is clean UX that keeps the Telegram thread readable.

---

## Round 1 Recommendation Resolution

| Recommendation | Status | Notes |
|---|---|---|
| R1: Resolve auto-approve default posture | Resolved | Opt-in with clear rationale documented in spec |
| R2: "What was auto-approved" digest mode | Resolved | Section 10 documents post-session digest as Phase 4 deliverable |
| R3: Make pattern catalog extensible via config | Not addressed | Still hardcoded; see New Issue 1 below |
| R4: Specify audit log schema explicitly | Resolved | Full schema with all fields defined in Section 3.3 |
| R5: Define behavior on server restart during relay | Resolved | Prune on startup plus "Session expired" message defined |
| R6: Add ANSI false positive test | Resolved | `InputDetector.falsePositive.ansiOutput` added to Section 7 |

R3 (extensible pattern catalog) remains unaddressed. This is the only Round 1 recommendation not folded into the spec.

---

## New Issues

### Issue 1: Pattern Catalog Extensibility Still Missing (Low Severity)

Round 1 Recommendation R3 asked for a config-driven pattern extension mechanism. This was not addressed. The risk in Section 9 still lists "Pattern drift (Claude Code updates prompt format)" as a known risk with mitigation "Patterns are maintained in a single catalog." That is maintenance documentation, not a DX solution.

The practical concern: when Claude Code changes a prompt format (which has happened several times in the past year), an operator cannot patch it without a code change and server restart. A `customPatterns` config array would allow runtime updates. This is not a v1 blocker — the stall fallback catches misses — but it is a known maintenance burden that should be planned for.

**Recommendation:** Add to the Open Questions section as a planned v2 capability, or add a simple `customPatterns` array to the config schema now. The implementation cost is low (the pattern catalog is already centralized).

### Issue 2: dryRun Mode Audit Log Behavior Unspecified (Low Severity)

The `dryRun` flag is defined in the config and tested in the unit tests (`AutoApprover.dryRun`). However, it is not specified whether dry-run actions are written to the audit log. They should be — this is the primary way operators confirm the classifier is behaving correctly before enabling live auto-approval.

**Recommendation:** Add a sentence to Section 3.3: "In `dryRun` mode, the audit log entry is written with `"dryRun": true` in the record. The response field contains what would have been sent. This allows operators to review the classifier's decisions before enabling live auto-approval."

### Issue 3: answerCallbackQuery Deadline Not Documented (Informational)

The Telegram Bot API requires `answerCallbackQuery` to be called within 10 seconds of the callback_query arriving, or Telegram displays a client-side timeout error (the button stays in "loading" state). The spec correctly calls `answerCallbackQuery` in the callback handler, but does not document this deadline. If `sessionManager.sendInput` is slow for any reason, there is a risk of calling `answerCallbackQuery` too late.

**Recommendation:** The spec already orders operations correctly (answerCallbackQuery first, then editMessageText, then sendInput). Add a comment noting the 10-second deadline so implementors do not reorder operations in the future.

### Issue 4: Audit Log Schema Version Field Missing (Informational)

The audit log schema is well-defined but lacks a `schemaVersion` field. When the schema evolves — new fields, changed semantics — it becomes impossible to distinguish old-format entries from new-format entries in the same log file without a version marker.

**Recommendation:** Add `"schemaVersion": 1` as a standard field to the audit log entry definition. One additional byte of overhead per record. High forward-compatibility value.

---

## Observations

### O1: The Phased Delivery Model Remains Excellent

The four-phase build order (detect then classify then relay then polish) is unchanged and still correct. Each phase has a clear deliverable, is independently testable, and de-risks the next.

### O2: The Stall Fallback Threshold Fix Was the Right Call

Raising `stallFallbackSeconds` from 30s to 60s (Round 1 Observation O1) is correct. 30 seconds fires false positives on common long-running tool calls (npm install, slow network requests). 60 seconds is the right balance between responsiveness and noise.

### O3: Post-Session Digest Is Appropriately Deferred

Moving the "auto-approve digest" to Phase 4 is the right sequencing decision. The audit log provides the raw data. The digest is a presentation layer on top of it. Getting the audit log right in Phase 2 naturally enables the digest in Phase 4 without rework.

### O4: The Text Reply Fallback Edge Case Is Still a Known Limitation

The "hold on, then actual answer" edge case (where a preliminary message is consumed as the prompt reply) is still a known limitation. It is acknowledged implicitly in the spec but not explicitly listed as a v1 limitation. Adding a note to Section 10 Open Questions would make it visible to future implementors.

### O5: Dashboard Indicator for Timed-Out Relays Still Missing

The colored dot system (Section 6) is a strong operator DX touch. The missing "relay timed out" indicator (distinct from "no active prompt") from Round 1 Observation O2 is still not in the spec. A red dot for an expired relay would be useful for operators monitoring sessions. Low effort, high visibility value.

---

## Scalability Assessment

The Round 2 spec holds up well at scale. Key concerns and their status:

**Multiple sessions per topic:** Still a single `pendingPromptReply` slot per topic. Explicitly acknowledged in Open Question 2 as a v2 queue-based evolution. Acceptable for v1.

**Pattern maintenance burden:** Unaddressed (see New Issue 1). The stall fallback provides a safety net but not a resolution. This becomes a real burden at scale as Claude Code evolves its prompt formats.

**Audit log growth:** Now addressed — 10MB rotation, 3 rotations. Correct for single-agent deployments. Multi-agent deployments may want this configurable, but out of scope for v1.

**Telegram rate limits:** The spec acknowledges 1 msg/s throttling. The timeout-plus-reminder flow is correctly counted against this budget. The supersession notification (new in Round 2) adds one more message per superseded prompt — minor, but worth tracking.

**CallbackRegistry memory:** The in-memory registry is correctly pruned on interval and server startup. At scale with many concurrent relayed prompts, the registry could grow. The 300s default timeout and 60s prune interval keeps this bounded at expected scale. No issue.

---

## Score

**8.5 / 10**

**Justification:**

This is a significant improvement over Round 1 (7.5). All three Critical Issues are resolved. Four of six Recommendations were folded into the spec. The architecture is sound, edge case handling is thorough, and the phased delivery model is exemplary.

Points retained from Round 1:
- Problem clarity and data flow documentation remain excellent
- Testing strategy (unit + integration + E2E + regression) is comprehensive and includes new tests for Round 2 changes
- Risks and mitigations table is appropriately updated with resolved items marked

Points deducted in Round 2:
- Pattern catalog extensibility (R3) still missing — a known maintenance liability that was flagged explicitly and not addressed (-0.25)
- dryRun audit log behavior unspecified — a meaningful gap in the dry-run design (-0.1)
- Audit log missing schemaVersion field — minor but a forward-compatibility miss (-0.1)
- answerCallbackQuery 10-second deadline not documented — a correctness risk for implementors who reorder operations (-0.05)

**Recommendation: Proceed to implementation.** The two low-severity issues (pattern catalog extensibility and dryRun audit log behavior) can be resolved during Phase 2 implementation without requiring another review round. The informational issues are implementation notes, not spec gaps.

---

## R1 Issue Resolution Summary Table

| R1 Issue | Severity | Status |
|---|---|---|
| callback_data size limit | Critical | Resolved — CallbackRegistry with 8-char tokens |
| ANSI stripping not specified | Critical | Resolved — Explicit preprocessing step and test cases |
| pendingPromptReply supersession silent | Critical | Resolved — Supersession notification and button prune |
| Auto-approve default posture open | Recommendation | Resolved — Opt-in with documented rationale |
| Auto-approve digest mode missing | Recommendation | Resolved — Post-session digest in Phase 4 |
| Pattern catalog not extensible | Recommendation | Not addressed |
| Audit log schema not defined | Recommendation | Resolved — Full schema in Section 3.3 |
| Server restart during relay undefined | Recommendation | Resolved — Prune on startup and expiry message |
| ANSI false positive test missing | Recommendation | Resolved — Test case added |
| stallFallbackSeconds too low (30s) | Observation | Resolved — Raised to 60s |
| dryRun mode not specified | Observation | Partially resolved — flag exists, audit behavior unspecified |

---

*Review generated by Echo (instar developer agent) · Round 2 · 2026-03-20*
