# DX Review: Session Prompt Bridge
**Review ID:** 20260319-150852
**Round:** 1
**Spec:** `specs/session-prompt-bridge.md`
**Reviewer Role:** Developer Experience & API Design Specialist
**Date:** 2026-03-19

---

## Approval Status

**CONDITIONAL**

This is a well-structured spec with clear problem/solution framing and solid engineering detail. The core UX design decisions are sound — but several gaps around configuration onboarding, the auto-approve default posture, and a known hard constraint (callback_data size) need resolution before implementation begins. None of these are blockers that invalidate the architecture, but they are issues that will cause adoption friction or production bugs if left unaddressed.

---

## Research Findings

### Auto-Approve vs Explicit-Approve: The State of the Art

The current landscape makes the tradeoffs in this spec more concrete:

- **Claude Code's permission prompt problem is well-documented.** Developers report ~100 approval prompts per hour for complex tasks, leading to rubber-stamping without reading — which may be worse than no prompts at all. The existence of `--dangerously-skip-permissions` is a symptom of a permission UX that generates too much noise.

- **The emerging best practice is intelligent granular auto-approval, not binary choices.** Tools like agentnanny, Claude Code's Accept Edits mode, and OpenAI Codex's permission profiles all converge on: auto-approve the safe category, surface only the genuinely risky decisions. This spec's approach (default auto-approve for file ops within project dir, relay everything else) is aligned with the state of the art.

- **Developer sentiment is strongly against "always ask."** The YOLO mode feature requests across Claude Code, Kiro, and OpenCode all show the same pattern: power users who trust their agent find constant prompts a flow-breaker. However, there is equally strong sentiment that total skip of all checks creates real risk (production database wipes are cited as real incidents). The spec's graduated approach is the right answer.

- **The open question about opt-in vs opt-out (Section 10, item 1) is the most important UX decision in this spec.** The research is unambiguous that agents configured with `--dangerously-skip-permissions` have implicitly opted into permissive execution. Making auto-approve opt-out for those agents is defensible. For agents without that flag, opt-in is safer and more respectful of the existing permission model.

### Callback Data Size: This is a Real Hard Constraint

The Telegram Bot API 64-byte limit on `callback_data` is confirmed and actively hits real bots in production. The spec correctly identifies this as an open question (Section 10, item 5) and mentions storing context server-side — but this isn't optional. The proposed JSON payload in `relayPrompt()` will exceed 64 bytes for any real session name:

```json
{"action":"prompt_response","sessionName":"emails","promptId":"abc123def","key":"1"}
```

That is already 79 bytes even with a short session name. For longer session names it gets worse fast. The spec treats this as an open question but it should be treated as a known constraint with a defined solution before implementation.

Best practice from the research: store full context server-side keyed by a short token (8-12 char base62 ID), put only the token in callback_data. This is fast (sub-millisecond lookup), proven, and keeps payloads well under the limit.

### Configuration Format

The spec uses JSONC (JSON with comments) for configuration. This is appropriate given the existing `.instar/config.json` convention. JSONC is a reasonable choice for tooling where JSON interoperability matters and the comment support makes inline documentation possible. TOML would be ergonomically superior for human editing, but changing config format mid-project is not worth the disruption.

### Terminal Pattern Matching: False Positive Risk

Research into tmux-based prompt detection shows that ANSI/control character stripping is a prerequisite — raw terminal output includes escape sequences that will corrupt regex patterns. The spec's pattern catalog does not mention this preprocessing step. Tools like tmux-snaglord explicitly implement `strip_ansi_and_control()` as step one. This needs to be called out explicitly in the PromptDetector design.

---

## Critical Issues

### 1. Callback Data Size Is Not an Open Question — It's a Known Bug

The current `relayPrompt()` implementation will fail in production for any session name longer than ~5 characters. The JSON payload:

```typescript
callback_data: JSON.stringify({
  action: 'prompt_response',
  sessionName: prompt.sessionName,
  promptId: prompt.id,
  key: opt.key
})
```

Will exceed 64 bytes. This needs to be resolved in the spec before Phase 3 implementation. The solution is straightforward: store prompt context server-side keyed by a short ID, pass only the ID in callback_data. The spec mentions this approach but marks it as "needs validation" — it does not need validation, it needs to be the defined approach.

**Required change:** Add a `PromptCallbackRegistry` (in-memory map, optionally persisted to `.instar/prompt-bridge-log.jsonl`) that maps short token IDs to full prompt context. `callback_data` becomes `{"id":"xK4mP9q2"}` — 20 bytes, well under the limit.

### 2. ANSI/Control Character Stripping Not Specified

The PromptDetector pattern catalog assumes clean text input. `tmux capture-pane` output contains ANSI escape sequences (colors, cursor movements, bell characters) that will break string matching. The spec does not mention stripping these before pattern matching.

**Required change:** Specify that `onCapture()` preprocesses output through an ANSI strip function before pattern matching. This is a one-liner but must be explicitly specified and tested with the false positive test cases.

### 3. The `pendingPromptReply` Single-Slot Design Is Silently Lossy

Section 5 ("Multiple prompts in sequence") states: "If a new prompt arrives while one is pending, the old one is expired and the new one takes priority." This is correct behavior, but the spec does not say whether the user is notified that the previous prompt was superseded. If Claude asks two questions in rapid succession and the user only sees the second one, they may reply to what they think is the second question and be confused when Claude processes it as the first.

**Required change:** When a pending prompt is superseded, update the Telegram message to show it was superseded (not just "expired"), and notify the user: "Previous prompt superseded by a new one." The new prompt should be sent immediately after.

---

## Recommendations

### R1. Resolve the Auto-Approve Default Posture in the Spec

Open Question 1 ("opt-in or opt-out?") is left open but it drives user trust and safety decisions. The research supports a nuanced answer: make auto-approve opt-out for sessions already using `--dangerously-skip-permissions`, and opt-in for all others. This respects the existing permission model. The spec should commit to this and document the rationale.

### R2. Add a "What Was Auto-Approved" Digest Mode

Open Question 4 asks whether auto-approved actions should surface in Telegram. The answer is: not per-action (too noisy), but as a post-session digest. After a session completes, send a summary: "Session completed. 3 auto-approved actions: created foo.py, edited bar.py, ran ls." This gives transparency without interrupting flow. This is a Phase 4 addition but should be in the spec as a planned feature.

### R3. Make the Pattern Catalog Extensible via Config

The pattern catalog is currently hardcoded in `PromptDetector.ts`. As Claude Code evolves, prompt formats change — and this is explicitly listed as a risk (Section 9, "Pattern drift"). The spec should specify that patterns are loadable from a config section or a separate file, so operators can add custom patterns without code changes:

```jsonc
{
  "promptBridge": {
    "customPatterns": [
      { "regex": "Do you want to .*\\?", "type": "permission" }
    ]
  }
}
```

### R4. Specify the Audit Log Schema Explicitly

The spec says "log to `.instar/prompt-bridge-log.jsonl`" but does not define the schema. Developers looking at this log (or building tooling on top of it) need a defined structure. Specify it in the spec:

```jsonc
{
  "timestamp": 1742400000000,
  "sessionName": "emails",
  "promptId": "xK4mP9q2",
  "type": "permission",
  "summary": "Create gmail-scan.py",
  "classification": "auto-approve",
  "reason": "file-creation-in-project-dir",
  "response": "1",
  "relayedToTopic": null
}
```

### R5. Define Behavior When the Instar Server Restarts During an Active Relay

The Telegram relay pathway requires the instar server to be alive. If the server restarts while a relay is pending, the Telegram buttons become stale (the callback handler won't find context for them). Define cleanup behavior: on server start, scan for any pending callback registrations older than `relayTimeoutSeconds` and mark them expired. This is a resilience concern that should be in the spec.

### R6. Add a Test for ANSI-Heavy Output False Positive Suppression

The test catalog (Section 7) covers false positives for code blocks and progress messages but does not include a test for ANSI-contaminated output. Add: `PromptDetector.falsePositive.ansiOutput` — verify that output containing color codes and cursor movements does not trigger pattern matches.

---

## Observations

### O1. The Stall Safety Net Threshold May Be Too Aggressive

30 seconds for `stallFallbackSeconds` is short for complex operations. A bash command that takes 45 seconds (npm install, a slow network request) will trigger a false stall notification. Consider 60 seconds as the default, or make the threshold context-aware (higher when a long-running tool call was recently detected in output).

### O2. The Dashboard Indicator Design Is Good but Incomplete

The colored dot system (Section 6) is a nice touch. However, there is no indicator for "relay timed out" (distinct from "no active prompt"). A red dot for an expired relay would be useful for operators monitoring sessions. Also: the dashboard already has an interactive button bar — consider linking "relay timed out" prompts directly to the dashboard session view so the operator can respond from there without switching tools.

### O3. Open Question 2 (Non-Telegram Sessions) Should Be an Explicit Non-Goal

The spec notes the design is "messaging-agnostic except for the Telegram-specific relay code." This is worth formalizing. Mark it as out-of-scope for this spec but note that `relayPrompt()` on TelegramAdapter is the right abstraction boundary for future expansion. Future implementors shouldn't have to reverse-engineer where to plug in an alternate transport.

### O4. Phase 1 Deliverable Is Strong — Build Confidence Before Wiring Automation

Delivering detection-with-logging before automation is the right sequencing. Consider making Phase 1 visible to operators from day one: a "detected N prompts in last session, would have auto-approved X, would have relayed Y" summary would build confidence in the classifier without any automation risk. This is a one-line addition to session completion output.

### O5. The Text Reply Fallback for Open-Ended Questions Has Edge Cases

Section 3.4 routes the "next text message" in a topic as the prompt reply when `pendingPromptReply` is active. If the user sends "hold on" followed by the actual answer, only "hold on" is consumed as the reply. The current design is acceptable for v1 — this is a known limitation worth documenting explicitly rather than leaving implicit.

### O6. Consider a "Preview Mode" / Dry Run for the Classifier

For operator confidence during rollout, add a config flag `"dryRun": true` in `promptBridge.autoApprove` that logs what would have been auto-approved without actually sending the key. This lets operators tune confidence before enabling live auto-approval in production. Zero implementation cost for Phase 2, high trust value.

---

## Scalability Assessment

The DX experience holds well at small scale (single agent, single topic) but degrades at scale in specific ways:

**Multiple sessions per topic (Open Question 3):** The single `pendingPromptReply` per topic breaks when multiple sessions share a topic. The spec says "second one waits" — acceptable for v1 but a real pain point for multi-session workflows. A queue rather than a single slot would be the natural v2 evolution.

**Pattern maintenance burden:** As Claude Code's prompt formats evolve, the hardcoded pattern catalog becomes a maintenance liability. The extensibility recommendation (R3) becomes critical at scale. A pattern registry with version tracking would allow operators to deploy pattern updates without server restarts.

**Audit log growth:** `prompt-bridge-log.jsonl` is append-only with no rotation policy defined. At scale (many agents, many sessions), this file grows unbounded. Define a rotation strategy in the spec — rotate at 10MB, keep last 3 rotations.

**Telegram rate limits:** The spec correctly notes 1 msg/s throttling. The timeout + reminder flow (two messages per unresponded prompt) should be explicitly counted against this same rate limit budget to avoid surprises under load.

---

## Score

**7.5 / 10**

**Justification:**

The spec earns high marks for problem clarity, architectural decomposition, phased delivery, and explicit risk/mitigation mapping. The data flow walkthroughs are concrete and testable. The testing strategy is one of the more complete I have seen in a feature spec — most specs skip integration tests entirely. The four end-to-end flow examples (happy paths + fallback) are genuinely useful and rare.

Points deducted for:

- The callback_data size issue left as "needs validation" when it is a known production constraint with a defined solution. This will cause Phase 3 rework if not addressed now. (-0.5)
- ANSI stripping not mentioned — a correctness issue for the core detection mechanism. (-0.5)
- Auto-approve default posture left as an open question despite being the most trust-critical UX decision in the spec. (-0.5)
- Audit log schema undefined despite being cited as a key accountability feature. (-0.25)
- No resilience plan for stale pending callbacks after server restart. (-0.25)

If the three Critical Issues are resolved and folded back into the spec, this would rate 8.5/10 and warrant a full APPROVE on round 2.

---

*Review generated by Echo (instar developer agent) · Round 1 · 2026-03-19*
