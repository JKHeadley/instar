# DX & API Design Review — Input Gate (Session Prompt Bridge)
**Review ID:** 20260320-104716
**Round:** 2
**Reviewer:** DX & API Design Specialist
**Spec:** `specs/session-prompt-bridge.md`
**Date:** 2026-03-20

---

## Approval Status

**CONDITIONAL APPROVE** — The spec has matured significantly since Round 1. The core architecture is sound, the opt-in decision is correct, and the CallbackRegistry solution to the 64-byte Telegram limit is clean. The gaps that remain are operational: a user enabling this feature today would hit friction in discovery, config validation, per-topic override access, and audit log introspection. None of these are blockers for implementation, but they need to be tracked as deliverables, not afterthoughts.

---

## Research Findings

### Telegram Inline Keyboard UX

Telegram Bot API caps inline keyboard arrays at 100 buttons total and 64 bytes per `callback_data`. The spec correctly addresses this with the CallbackRegistry token approach. Additional findings relevant to this spec:

- Answering every `callback_query` is mandatory. Unanswered queries show a loading spinner on the button for up to a minute — a poor UX for a prompt that has already been handled or expired. The spec handles this correctly with `answerCallbackQuery` in both the success and stale-token paths.
- Button layout performance: fewer rows mean faster client rendering. The spec uses "rows of 3" as a default — this is reasonable but the spec doesn't account for prompts that may have only 1-2 options, where a single-row layout is clearly better than padding to 3.
- Emoji in button text costs 4 bytes per character. The spec's example buttons use plain text — good practice that should be maintained as a guideline in the implementation, not left to chance.

### Auto-Approve Configuration Design

Research from Anthropic's own measurements of Claude Code usage shows that as users gain confidence, they shift from per-action approval to monitoring + intervention. This validates the spec's opt-in posture: users need to build trust in detection quality before enabling automation. The design correctly gives them a `dryRun` mode to preview behavior.

The risk the research highlights is visibility: effective agent oversight requires "trustworthy visibility into what agents are doing, along with simple intervention mechanisms." The spec's audit log satisfies the visibility requirement. The intervention mechanism (disabling auto-approve mid-session, or overriding a specific decision) is not addressed.

### Audit Log Viewer Design

Best-practice audit log viewers share these characteristics:
1. **Filter by actor, event type, and time range** — the spec has all the data fields needed but doesn't define a query interface
2. **Exportable via API** — the spec mentions a "dashboard audit log viewer" but no API endpoint is specified
3. **Retention policy is documented and configurable** — the spec defines log rotation (10MB, last 3), but this is an internal implementation detail, not a user-configurable parameter
4. **Immutability** — `.jsonl` append-only is the right format; the spec correctly uses it

### Terminal Prompt Detection

`tmux capture-pane` with the `-e` flag includes ANSI escape sequences verbatim. Without `-e`, output is cleaner but some formatting information is lost. The spec mandates ANSI stripping before pattern matching, which is correct. Additional finding: `capture-pane -p` without `-e` still includes some control sequences depending on the application. The spec should specify which tmux capture flags it uses, as this affects the stripping burden.

---

## Critical Issues

### 1. No First-Run Experience Defined

**Severity: HIGH**

The spec defines a JSON config schema but doesn't describe how a user discovers or enables Input Gate. There is no:
- Default config insertion behavior (added on first server start? On first Telegram message? Never?)
- `instar` CLI command or API endpoint to enable/configure it
- Dashboard control panel for the feature
- Specification of what happens if `inputGate` is absent from `config.json`

A user reading the spec today would need to manually edit `.instar/config.json` to add the `inputGate` block. That is not a 5-minute onboarding — it is a friction wall for non-technical users and a correctness risk (invalid JSON, wrong field names, no validation feedback).

**Recommendation:** Define either a CLI command (`instar config set inputGate.enabled true`) or a dashboard toggle as the canonical enable path. The raw JSON path should be documented as secondary, not primary.

---

### 2. Per-Topic Override Has No Access Path

**Severity: HIGH**

Section 6 describes per-topic overrides stored in the topic-session registry:

```jsonc
"topicOverrides": {
  "42": {
    "autoApproveAll": false,
    "relayAll": false
  }
}
```

But the spec defines no mechanism for a user to set these. No API endpoint, no CLI command, no dashboard control, no conversational command. The data model exists; the access path does not.

This matters because the most natural user behavior — "I want this agent fully autonomous in one topic, but I want to approve everything in another" — maps directly to per-topic overrides. Without an access path, the feature is invisible even to users who want it.

**Recommendation:** Define at minimum one access path. The most friction-free for mobile users would be a conversational command that Echo parses and applies ("auto-approve everything in this topic"), with an API endpoint as the underlying mechanism.

---

### 3. Config Schema Has Underdefined Semantics

**Severity: MEDIUM**

The `autoApprove` sub-keys (`fileCreation`, `fileEdits`, `planApproval`, `bashSafe`) are booleans that only take effect when `autoApprove.enabled` is `true`. The two-level boolean structure is fine, but:

- The meaning of "project directory" in `fileCreation` is not defined in the config schema. What directory? The agent's working directory at session start? A hardcoded path? What if the session `cd`s?
- `bashSafe` says "non-destructive bash" but defines this only via examples (ls, cat, grep, curl to localhost). The actual classifier rules that make a bash command "safe" are not exposed to the user. A user enabling `bashSafe` cannot predict what will and won't be auto-approved.
- The interaction between `autoApproveAll: true` (per-topic override) and the granular sub-keys (global config) is unspecified. Does `autoApproveAll` bypass all global restrictions, or just set all sub-keys to true?

**Recommendation:** Add a comment block to the config schema (or a dedicated docs section) that defines "project directory," "safe bash," and override precedence explicitly.

---

### 4. Text Reply Intercept Has a Usability Hole

**Severity: MEDIUM**

Section 3.4 defines `pendingPromptReply`: when a relay prompt is active, the next text message in the topic is treated as the prompt response. This is clean, but it has a silent failure mode:

**Scenario:** A user sees the prompt notification, doesn't immediately know what to respond, sends "hold on" or "what was the original task again?" — that message gets silently routed as the prompt response, feeding "hold on" into Claude's terminal. The user has no idea this happened.

The spec's message format for question-type prompts says "Reply to this message with your answer," which implies Telegram's native Reply feature. But the `pendingPromptReply` intercept doesn't check whether the message is a reply-to the prompt message — it intercepts ANY text in the topic.

**Recommendation:** Either (a) require that the user's response be a Telegram Reply to the specific prompt message (check `message.reply_to_message.message_id` against the tracked message ID), or (b) add an immediate visible acknowledgment: "Sending your reply to the session..." when a message is intercepted, so the user knows their text was consumed as a prompt response.

---

## Recommendations

### R1: Validate Config on Load

The spec defines a JSON schema but doesn't address what happens when the config is malformed (`relayTimeoutSeconds: "five minutes"`, missing keys, unknown keys). The server should validate the `inputGate` block on startup and emit a clear error with field name and expected type. Silent fallback to defaults is acceptable for missing optional fields; invalid types should be loud.

### R2: Expose Audit Log via API

The spec mentions a dashboard viewer but defines no API endpoint for the audit log. At minimum, define:

```
GET /input-gate/log?limit=50&offset=0&session=emails&classification=auto-approve
```

This enables dashboard rendering without filesystem access, CLI inspection, and future programmatic use (alerting on unexpected auto-approvals). Without an API, the audit log is a file only developers can interrogate.

### R3: Dashboard Indicators Need Interaction

The spec defines colored dots for prompt state, but these are static indicators. A user who sees a blue dot (prompt relayed, waiting for response) should be able to click it and see what the prompt is. The spec should define the interaction: what does clicking the dot do? Links to the Telegram topic? Opens a response input? For users without Telegram access, there needs to be a response input path on the dashboard. The spec currently treats the dashboard as read-only for prompt state.

### R4: Define "Project Directory" Authoritatively

The classifier's `fileCreation` rule uses "agent's project directory" as the trust boundary. This needs a single authoritative source:
- Is it the `cwd` of the spawned session?
- Is it the agent's repo root (detected via `.git`)?
- Is it configurable?

The implementation will make an implicit choice. Make it explicit in the spec to avoid security boundary confusion later.

### R5: First Auto-Approval Notification

The spec resolves the per-action notification question with "post-session digest." This is the right call for high-frequency workflows, but consider one intermediate option: a lightweight notification for the first auto-approval in a session.

Example (sent to Telegram when first auto-approval fires in a new session):
```
Auto-approving session actions — I'll summarize when done.
```

This teaches the user the feature is active without creating per-action noise. Subsequent auto-approvals in the same session are silent. One notification makes auto-approve visible without being annoying.

### R6: Specify tmux Capture Flags

The spec says "strip ANSI before pattern matching" but doesn't specify whether `capture-pane` is called with `-e` (include escape sequences) or without. Recommend: use `-p` without `-e` and document this as the canonical capture mode. Note that the ANSI stripper is a defensive measure for residual sequences, not the primary sanitization mechanism.

---

## Observations

**The debounce + fingerprint dedup design is solid.** 2 seconds of stable output before confirming a prompt is a good balance between responsiveness and false-positive resistance. Fingerprint cache clearing on new output is a correct and clean approach to resetting state.

**The CallbackRegistry one-time-use design is correct.** Consuming the token on first resolution prevents double-injection if a user taps the button twice. The race condition where two taps arrive simultaneously is safe in a single Node.js process (single-threaded event loop), but if the server is ever clustered, the registry needs to be shared state. Worth a note in the spec.

**The stall fallback notification wording is vague.** "Your agent paused and is waiting for you — tap here to respond" implies a tappable link. What does tapping do? Links to the dashboard? Opens a reply flow? This needs to be specified before implementation.

**The "Superseded" prompt flow is well-designed.** Updating the old message to "Superseded" before sending the new one is exactly the right UX. Users won't have stale buttons that still appear active.

**The timeout graduated response (reminder at 1x, expiry message at 2x) is good.** One gap: after expiry, the session stays alive (correct), but there is no mechanism for the user to re-trigger the relay. If they return after the message expired, they need to know they can still respond via dashboard. The expiry message should include this.

**Implementation phasing is excellent.** Each phase has a testable deliverable. Phase 1 (detect only, no action) is particularly good — it lets the team validate detection quality against real workloads before enabling any automation.

---

## Scalability Assessment

**Detection pipeline:** Hooking into the existing 500ms capture loop is correct. The added overhead per cycle is ANSI strip + regex match on last N lines + fingerprint lookup — all O(n) on bounded output size. No scalability concern for single-agent deployments.

**CallbackRegistry:** In-memory Map is appropriate for single-machine deployments. For multi-machine setups, this becomes a shared state problem. The spec correctly documents server-restart behavior but doesn't flag the multi-machine limitation. Add a note.

**Audit log:** JSONL append-only with 10MB rotation is correct for the expected write volume. A single auto-approval entry is ~300 bytes. At 10MB, that is ~33,000 entries before rotation — plenty of headroom. No concern here.

**Per-topic override storage:** Embedding overrides in the topic-session registry file is fine for the expected number of topics (tens, not thousands). If the registry grows very large, JSON file I/O could become a bottleneck. Not a v1 concern.

---

## Score

**7.5 / 10**

Round 2 has resolved the major architectural questions from Round 1. The implementation is well-structured, the phasing is correct, and the safety posture (opt-in, audit log, stall fallback) is sound. The score is held back by operational gaps: no defined onboarding path, no per-topic override access mechanism, and an audit log that exists only as a file. These are the difference between a feature that works and a feature that users can actually operate. They should be addressed in the spec before implementation of Phase 3-4, not retrofitted afterward.

---

## Summary for Implementation

**Must address before Phase 3:**
1. Define the enable/configure path (CLI or dashboard toggle)
2. Define the per-topic override access path (API endpoint minimum)
3. Define the audit log API endpoint

**Must address before Phase 4:**
4. Specify `pendingPromptReply` intercept behavior (reply-to check vs. any-message)
5. Clarify dashboard indicator interactions (what does clicking do? is there a dashboard response path?)
6. Define "project directory" authoritatively in spec

**Can defer to post-v1:**
- Multi-machine CallbackRegistry considerations
- Config schema validation error messages
- First-auto-approve session notification
- tmux capture flag specification
