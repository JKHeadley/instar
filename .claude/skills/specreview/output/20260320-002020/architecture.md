# Architecture Review: Input Gate (Session Prompt Bridge)

**Review ID:** 20260320-002020
**Spec:** `specs/session-prompt-bridge.md`
**Reviewer Role:** Systems Architect
**Round:** 2
**Date:** 2026-03-20

---

## Approval Status

**CONDITIONAL APPROVE**

The R2 spec represents a meaningfully improved design over R1. The three critical architectural deficiencies called out in prior reviews â callback data overflow, ANSI preprocessing, and missing audit schema â are all addressed. The added CallbackRegistry component is the right architectural response to the 64-byte Telegram constraint. Auto-approve opt-in is the correct default. The overall structure (five components with clear single responsibilities, clean data flow, phased delivery) is sound.

Two architectural concerns remain that should be resolved before Phase 3 implementation begins: the hook-availability question (the business reviewer raised this and it is unresolved in R2) and the coupling between InputDetector and WebSocketManager's capture loop. Neither is a blocker for Phases 1-2. Conditional approval with mandatory resolution before Phase 3 is the right call.

---

## Research Findings

### Claude Code Hooks API â What's Actually Available

Instar already has a working HTTP hook receiver (`HookEventReceiver.ts`) and uses it actively. The confirmed hook event types observed in the codebase are: `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SubagentStart`, `TaskCompleted`, `TeammateIdle`, `SessionStart`, `PreCompact`, `InstructionsLoaded`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `Notification`.

The `Notification` hook type is directly relevant. Claude Code fires `Notification` events for user-facing prompts that require acknowledgment â this is exactly the signal Input Gate needs. The business review (R1) noted CCGram uses hooks rather than output parsing; looking at the instar codebase, `Notification` events are already being received (the migration code in `PostUpdateMigrator.ts` references compaction recovery via `Notification` and the migration to `SessionStart`).

**Critical finding:** The `Notification` hook event type is already in the instar hook infrastructure. Whether it fires for tool permission prompts (file creation, bash approval) versus only for informational notifications is the unresolved question. If it does fire for permission prompts, that changes the optimal architecture for InputDetector significantly â hook events are structured JSON rather than parsed terminal output, which is dramatically more reliable.

This must be tested before implementing the pattern-matching approach. If `Notification` fires on Claude Code permission prompts, the InputDetector's pattern catalog becomes unnecessary for that prompt class. Only `question`-type prompts (Claude asking a clarifying question mid-conversation) would still require output pattern matching, since those appear as regular assistant messages rather than tool permission events.

### tmux capture-pane Architectural Position

The existing `WebSocketManager.ts` confirms the 500ms capture loop architecture: `setInterval(() => { ... captureOutput(session, 200) ... }, 500)`. This is real and running. The spec proposes hooking InputDetector into this loop, which is architecturally simple but creates coupling: InputDetector runs only when a dashboard WebSocket client is subscribed to the session. If no dashboard client is present, the capture loop may not run at all for a given session.

Review of `WebSocketManager.startStreaming()` shows the loop only captures output for sessions that have active WebSocket subscriptions (it iterates `subscribedSessions` derived from `client.subscriptions`). This means **InputDetector will not receive captures for sessions with no dashboard subscribers** â which is exactly the condition when Telegram users are the primary interface. This is a gap the spec does not address.

The fix is straightforward: InputDetector should hook into the SessionManager's `captureOutput()` directly via a separate, always-running interval, rather than piggybacking on the WebSocket stream. SessionMonitor already does this pattern correctly â it has its own polling loop independent of dashboard clients.

### Node.js In-Memory Registry Patterns

The CallbackRegistry design (Map + prune on startup + 60s interval prune) is standard and idiomatic for ephemeral server-side state. The one-time-use pattern (`resolve` deletes the entry) is correct â it prevents replay attacks and keeps the map small. The 8-char base62 token provides 62^8 â 218 trillion combinations, making collisions negligible at this scale.

One pattern worth noting: the spec has `CallbackContext` without a `label` field, but the `PromptOption` interface has both `key` (what to send tmux) and `label` (human readable). Storing only `key` in the registry means the resolved context cannot reconstruct the button label for the audit log's `response` field. This is minor but the audit schema example shows `"response": "1"` â a raw key â which matches the current design. No change needed, just documenting the intentional tradeoff.

### Similar Prompt Detection Architectures

Comparable systems (CCGram, tmux-snaglord, claude-code-telegram) converge on one of two approaches:
1. Hook-based detection â register for lifecycle events, receive structured JSON payloads
2. Output parsing â monitor terminal output, strip ANSI, apply patterns

Approach 1 is more reliable when hooks are available. Approach 2 is required as a fallback for prompt types not covered by hooks (e.g., clarifying questions that appear as regular assistant output). The spec currently implements only approach 2. The optimal architecture is hook-primary, pattern-fallback â and the instar infrastructure already supports it.

---

## Technology Choices

**tmux as the I/O substrate:** Correct given the existing architecture. Claude Code sessions run in tmux, so tmux is the only way to observe and inject input. No alternative. Accepted without debate.

**Pattern matching for prompt detection:** Reasonable for v1 but suboptimal when hooks are available. The business review correctly flagged this. The R2 spec addresses the business risk but not the underlying architectural question: can Claude Code's `Notification` or `PreToolUse` hooks fire on permission prompts in a way that can be intercepted before the session blocks? If yes, the InputDetector's pattern catalog is only needed for question-type prompts. This should be validated with a 2-hour test before Phase 1 implementation.

**In-memory CallbackRegistry:** Correct choice. The data is ephemeral (max 5-minute lifetime), small (O(concurrent prompts)), and doesn't need durability. Persisting to disk would add complexity with no benefit. The server-restart resilience design (stale buttons show expiry message) is the right approach.

**JSONL audit log with rotation:** Standard and correct. 10MB rotation threshold with 3 rotations kept is reasonable for this data volume. The schema is now explicitly defined in R2, which resolves the R1 DX criticism.

**No external dependencies:** Consistent with the existing TelegramAdapter design (native fetch throughout). Good.

---

## System Design

### Component Boundaries

The five-component decomposition is clean:

| Component | Responsibility | Coupling |
|-----------|---------------|---------|
| InputDetector | Observe terminal, emit prompts | â SessionManager (captureOutput) |
| InputClassifier | Classify prompts | â Config (project dir, rules) |
| AutoApprover | Inject responses for safe prompts | â SessionManager (sendInput), AuditLog |
| CallbackRegistry | Token â context mapping | None (pure data) |
| TelegramAdapter (ext) | Relay prompts, handle callbacks | â CallbackRegistry, SessionManager |

The boundaries are correct. InputDetector has no knowledge of classification logic. CallbackRegistry has no knowledge of Telegram. The data flows in one direction: Detector â Classifier â (AutoApprover | TelegramAdapter).

**Issue: InputDetector coupling to WebSocketManager's capture loop.**
The spec says InputDetector hooks into "the existing 500ms capture loop in WebSocketManager.ts (line 241)." But that loop only runs for sessions with active dashboard subscribers. For a Telegram-only user with no dashboard open, the capture loop may not iterate the relevant session, meaning InputDetector never fires.

**Required fix:** InputDetector needs its own polling mechanism (or a guaranteed hook into a loop that always runs for active sessions). The cleanest solution is to hook into `SessionManager`'s internal monitoring cycle rather than WebSocketManager. SessionMonitor's design (`private interval: ReturnType<typeof setInterval>`) is the right model.

### Data Flow

The end-to-end flows in Section 4 are clear and complete. The three happy paths (auto-approve, relay + buttons, relay + text) are well-specified. The fallback path (stall safety net) is correctly positioned as a catch-all, not a primary path.

The `pendingPromptReply` state is the trickiest part of the flow. It sits in TelegramAdapter and represents a cross-cutting concern: incoming message routing depends on whether a prompt relay is active. This is the right place to put it (it's a Telegram-specific routing decision), but the race condition acknowledged in Section 5 deserves additional scrutiny.

### Race Condition Analysis

Section 5 addresses the "user sends message + prompt detected simultaneously" case. The analysis is:
- If `pendingPromptReply` is set â treat as prompt response
- If not yet set â treat as normal message injection

The spec argues this is acceptable because "the prompt relay message appears in Telegram BEFORE the flag is set." This is actually the reverse of what you want â the flag should be set *before* the relay message is sent, not after. If the relay message causes the user to respond instantly (unlikely but possible), the response could arrive before the flag is set. The fix is trivial: set `pendingPromptReply` synchronously before calling `relayPrompt()`, not after. The spec should explicitly state this ordering requirement.

---

## API Design

### `InputDetector.onCapture(sessionName, output): DetectedPrompt | null`

Returns at most one prompt per call. This is correct â prompts don't pile up in a single capture; they're stable until answered. The single return value keeps the caller simple.

**Minor gap:** The interface doesn't specify what happens if the same prompt is detected across multiple sessions simultaneously (different session names). The Map-based internal state (`lastOutput: Map<string, string>`) handles this correctly by keying on session name. No change needed, but worth explicit documentation.

### `CallbackRegistry.register/resolve/prune`

Clean, minimal, and correct. One-time-use `resolve` is the right design. The 8-char base62 token fits comfortably in `callback_data: JSON.stringify({ id: token })` at 20 bytes (well under 64-byte limit, even with JSON overhead).

**Gap:** `register()` does not check for token collisions. At 62^8 combinations with O(10) concurrent entries, collisions are astronomically unlikely, but a defensive check (`while (this.registry.has(token)) regenerate`) would make the code production-grade. One-liner addition.

### `AutoApprover.handle(prompt, classification): Promise<boolean>`

The 500ms sleep before injecting the response is pragmatic but introduces a design smell: the delay is to avoid "racing with Claude's render." This implies timing-based coordination, which is inherently fragile. The right fix is to confirm via a post-injection capture that the prompt is gone (output changed). This is a Phase 2 refinement, not a Phase 1 blocker.

### Telegram callback handling

The callback query handler correctly calls `answerCallbackQuery` before injecting input â this removes the loading spinner immediately, giving the user instant feedback. The `editMessageText` after injection is correct UX. The stale button flow (show expiry, don't throw) is robust.

**Gap in the text reply fallback:** The `pendingPromptReply` map is keyed by `topicId`. When a text reply arrives, it consumes the pending state regardless of content â if the user types "what?" instead of an actual answer, that "what?" gets injected into the session. The spec acknowledges this limitation in O5 of the DX review and defers it as acceptable for v1. Acceptable, but should be documented in the spec's edge case section.

---

## Data Architecture

### `DetectedPrompt` Data Model

```typescript
interface DetectedPrompt {
  type: 'permission' | 'question' | 'plan' | 'selection' | 'confirmation';
  raw: string;
  summary: string;
  options?: PromptOption[];
  sessionName: string;
  detectedAt: number;
  id: string;
}
```

This is well-designed. The `id` field enables deduplication and cross-references between the audit log and Telegram messages. The `options` array being optional correctly models the distinction between button-based and text-reply prompts.

**Minor:** No `topicId` on `DetectedPrompt`. The relay step needs to know which Telegram topic to send to. Currently this is resolved by looking up `sessionName â topicId` in the topic-session registry at relay time. That's correct, but the lookup should be guarded â if a session is not Telegram-bound, relay should be skipped entirely. The spec implies this but does not make it explicit in the `relayPrompt` flow.

### `CallbackContext` Data Model

```typescript
interface CallbackContext {
  sessionName: string;
  promptId: string;
  key: string;
  createdAt: number;
}
```

Correct and minimal. The `label` is intentionally excluded (only the tmux key matters for injection). The `promptId` cross-reference to the audit log is valuable.

### Audit Log Schema

The R2 schema is complete and correct:

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
  "relayedToTopic": null,
  "respondedBy": "auto",
  "respondedAt": 1742400000500
}
```

The `respondedBy` and `respondedAt` fields are good additions over the R1 suggestion â they make the audit log genuinely useful for post-hoc analysis. Rotation at 10MB / 3 rotations is correct.

**Gap:** No schema versioning (`"schemaVersion": 1`). When the schema evolves (adding fields for session digest feature, etc.), parsers need to know which version to expect. Trivial addition now; painful omission later.

---

## Integration Points

### Integration with WebSocketManager

As noted above, piggybacking on the WebSocket capture loop is the primary architectural weakness. The fix:

```typescript
// In InputDetector constructor, start independent polling:
private startPolling(): void {
  this.pollInterval = setInterval(() => {
    for (const sessionName of this.watchedSessions) {
      const output = this.sessionManager.captureOutput(sessionName, 50);
      if (output !== null) this.onCapture(sessionName, output);
    }
  }, 500);
}
```

This mirrors how `SessionMonitor` operates and avoids the WebSocket subscriber dependency.

### Integration with SessionManager

`sendInput()` and `sendKey()` are confirmed present in the real `SessionManager.ts` (lines 462, 488 in codebase). The spec's use of `sessionManager.sendInput(sessionName, key)` is correct. The existing `sendKey` variant (which sends key names like 'Enter', 'Escape' without the `-l` literal flag) is the right choice for control key responses.

**Note for implementors:** The spec uses `sendInput` for all cases including Enter/Escape. For control keys, `sendKey` is the correct method. The implementation should route `PromptOption.key` values of "Enter", "Escape" through `sendKey` and text values through `sendInput`.

### Integration with Existing StallDetector

The spec correctly positions Input Gate and StallDetector as complementary: Input Gate for detected-prompt unblocking, StallDetector for timeout-based cleanup. The `stallFallbackSeconds` (60s) interacts with StallDetector's idle threshold (15 minutes in `SessionMonitor`). These are different clocks measuring different things â no conflict.

**But:** When Input Gate sends a relay notification, StallDetector should not also fire a stall notification for the same session. Some coordination is needed to suppress StallDetector notifications when a relay prompt is active. The spec does not address this. A simple fix: when `pendingPromptReply` is active for a topic, suppress StallDetector notifications for the bound session.

### Integration with existing HookEventReceiver

The hook event infrastructure is already running. If the `Notification` hook fires on tool permission prompts (to be validated), InputDetector could receive these events with zero additional infrastructure â just add a handler in the existing `HookEventReceiver.receive()` path. This would complement or replace the capture loop approach for permission-type prompts.

---

## Operational Concerns

### Deployment

No new services, no new processes. Everything runs in-process with the existing instar server. This is the right operational posture â complexity budget for deployment is zero.

### Monitoring

The dashboard dot indicators (Â§6) are the right operational signal for operators monitoring sessions. The four states (pending/auto-approved/relayed/idle) are minimal and sufficient.

**Gap:** No metrics or counters exposed via the instar server API. The audit log is queryable but there's no `/input-gate/stats` endpoint. For Phase 4, add basic counters: total prompts detected, auto-approve rate, relay rate, false-positive rate (if tracked). These would be useful for tuning the 2s debounce and pattern catalog.

### Logging

JSONL audit log with rotation is correct. The log path `.instar/input-gate-log.jsonl` should be added to the dashboard File Viewer allowed paths so operators can inspect it from mobile.

### Backup

No persistent state beyond the audit log (JSONL file). CallbackRegistry is in-memory and intentionally ephemeral. The audit log is covered by instar's existing backup system. No special backup considerations.

---

## Complexity Budget

**Total new lines of code (estimated):**
- InputDetector: ~200 lines (pattern catalog, debounce, dedup, ANSI strip)
- InputClassifier: ~150 lines (rules, config loading)
- AutoApprover: ~80 lines (logging, send, dry-run)
- CallbackRegistry: ~80 lines (register, resolve, prune)
- TelegramAdapter extension: ~200 lines (relayPrompt, callback handler, pendingPromptReply)
- Config schema: ~20 lines

Total: ~730 lines of new TypeScript across 5 files.

This is a moderate feature size. The complexity is justified by the problem being solved (session stalls are the primary Telegram UX failure mode). None of the components are particularly complex individually â the debounce/dedup logic in InputDetector is the most intricate part.

The phased delivery plan correctly manages complexity: Phase 1 (detection only) validates the hardest part (pattern matching accuracy) before any automation is wired up.

**Complexity risks:**
1. Pattern catalog maintenance burden â acknowledged, accepted for v1
2. `pendingPromptReply` state management in TelegramAdapter â adds routing complexity to a file that already has significant responsibility. Consider whether this state belongs in a dedicated `PromptRelayState` class.
3. The 500ms sleep in AutoApprover â timing-based coordination is a code smell, but the alternative (output-diff confirmation) is more complex. Acceptable for v1 with a logged TODO.

---

## Evolution Path

### Can it evolve without rewrites?

**Yes, with one caveat.** The messaging-agnostic core (InputDetector, InputClassifier, AutoApprover, CallbackRegistry) is cleanly separated from the Telegram-specific relay code. Adding a Slack adapter would require implementing `relayPrompt()` in a new `SlackAdapter` class â no changes to core components.

The caveat: `pendingPromptReply` and callback handling are currently baked into `TelegramAdapter`. A proper abstraction for "awaiting user response on a pending prompt" should eventually live in a transport-agnostic layer. A `PromptResponseCoordinator` class that different adapters register with would be the right v2 abstraction.

### Extension Points

**Well-designed:**
- Pattern catalog can be extended via config (`customPatterns` array â from DX R1 recommendation, should confirm this was adopted)
- Per-topic overrides in topic-session registry
- AutoApprove config is granular (per-category enable/disable)
- CallbackRegistry is reusable for any callback-data-constrained token mapping

**Missing:**
- No event emission from InputDetector. Components that want to react to detected prompts must be wired through InputDetector's return value. Adding an `EventEmitter` interface to InputDetector would allow looser coupling and simpler extension (e.g., a future metrics collector that counts prompts without knowing about classification).
- No hook into the classification decision. A future "classification override" mechanism (user says "always auto-approve ls commands") would need to extend InputClassifier's rules. The current design hardcodes rules in the classifier â an extensible rules engine (even just an ordered array of rule functions) would improve evolvability.

### Migration Path

No database migrations. Config additions are additive (new `inputGate` key in `config.json`). The CLAUDE.md / PostUpdateMigrator pattern should be used to add `inputGate` defaults on server start for existing agents. This is straightforward given the existing migration infrastructure.

---

## Critical Issues

### C1: InputDetector Must Not Depend on WebSocket Subscribers

**Severity: High**

The spec hooks InputDetector into WebSocketManager's capture loop, which only runs for sessions with active dashboard subscribers. Telegram-first users (the primary target audience) typically have no dashboard open â their sessions would never be monitored for prompts.

**Required fix:** InputDetector operates its own polling interval against the full set of Telegram-bound sessions, independent of WebSocket subscription state. Use the topic-session registry to identify which sessions are Telegram-bound and require monitoring.

### C2: `pendingPromptReply` Flag Must Be Set Before Relay Message Is Sent

**Severity: Medium**

The spec describes setting `pendingPromptReply` when a prompt is relayed, but the ordering is ambiguous. If the flag is set after the Telegram message is sent, a race exists: a very fast user response could arrive before the flag is set, causing the response to be treated as a new session message.

**Required fix:** Set `pendingPromptReply` synchronously before calling `relayPrompt()`, not after.

### C3: StallDetector Suppression Not Specified

**Severity: Medium**

When Input Gate has relayed a prompt (active `pendingPromptReply`), the StallDetector will independently detect the session as idle and may fire its own notification. The user receives two notifications for the same event.

**Required fix:** When a relay is active for a topic, suppress StallDetector notifications for the bound session. Clear suppression when the relay resolves (response received, timeout, or session death).

---

## Recommendations

### R1: Validate Hook-Based Detection Before Building Pattern Catalog

Before implementing InputDetector's pattern catalog, run a 2-hour test: configure a `Notification` hook in `.claude/settings.json` that POSTs to the instar server, spawn a session, trigger file-creation and clarifying-question scenarios, and observe what fires. If `Notification` fires for tool permission prompts, use it as the primary signal for `permission`, `confirmation`, `plan`, and `selection` types. Reserve pattern matching for `question` type (Claude asking the user something mid-conversation), which won't have a corresponding hook event.

This could halve the pattern catalog maintenance burden and eliminate false positives for the most common prompt types.

### R2: Add EventEmitter Interface to InputDetector

Change InputDetector from a direct-return interface to an EventEmitter. Callers subscribe to `'prompt:detected'` events rather than polling `onCapture()`. This is a minor refactor but makes the component more idiomatic and easier to extend without changing the InputDetector interface.

### R3: Add Token Collision Guard to CallbackRegistry

One-liner defensive addition:
```typescript
register(context: CallbackContext): string {
  let token: string;
  do { token = generateBase62(8); } while (this.registry.has(token));
  this.registry.set(token, { ...context, createdAt: Date.now() });
  return token;
}
```

### R4: Add Schema Version Field to Audit Log

Add `"schemaVersion": 1` to every audit log entry. When the schema evolves, increment the version and handle old entries gracefully in any log-reading code.

### R5: Route Control Keys Through `sendKey`, Not `sendInput`

When injecting a prompt response, check if `PromptOption.key` is a control key name ('Enter', 'Escape', 'Tab', 'Space') and route through `sessionManager.sendKey()` instead of `sendInput()`. This matches the existing API design in SessionManager and avoids injecting the literal string "Enter" into the session.

### R6: Add `inputGate` Defaults to PostUpdateMigrator

Existing agents won't have the `inputGate` config block. Add a migration in `PostUpdateMigrator.ts` that adds the default `inputGate` config block on server start if absent, following the existing migration pattern for other new config sections.

---

## Observations

**O1: The dryRun Flag Is Architecturally Valuable**
Adding `dryRun: false` to AutoApprover config is a good R2 addition that addresses the DX reviewer's O6 recommendation. It makes the feature safely observable before automation is enabled. This should be the first thing new users enable after Phase 2 ships.

**O2: Phase Deliverables Are Architecturally Correct**
Phase 1 (detect + log, no action) is the right way to build confidence in pattern accuracy before any automation fires. Phase 2 (classify + auto-approve) is the right next gate. Phase 3 (relay) builds on validated detection. This sequencing reduces integration risk.

**O3: Pattern Catalog Needs a Home**
The spec describes patterns in prose but doesn't specify where the catalog lives in code. A dedicated `patterns.ts` or `prompts.catalog.ts` file (rather than inline in InputDetector) would make the catalog easier to maintain and test independently. This is a code organization recommendation, not an architectural concern.

**O4: Session Death During Relay Cleanup Is Specified but Incomplete**
The spec says "clean up `pendingPromptReply` for that topic" when a session dies. This cleanup must happen in the session lifecycle events, not just be mentioned in prose. The `SessionManager` emits `beforeSessionKill` â TelegramAdapter should subscribe to this event to trigger cleanup. Otherwise the cleanup only happens when the next capture returns null, which may be delayed.

**O5: Consider Rate-Limiting Auto-Approve Frequency**
The spec doesn't cap how many auto-approvals can fire per minute for a session. If Claude hits 20 file-creation prompts in rapid succession, AutoApprover fires 20 times in ~10 seconds. This is probably fine (that's the intended behavior), but a configurable `maxAutoApprovesPerMinute` guard would be valuable for sessions that enter unexpected loops.

---

## Scalability Assessment

**Per-session overhead:** One additional 500ms polling interval per Telegram-bound session (once C1 is fixed). CPU overhead is negligible â `captureOutput` is a synchronous `execFileSync` call on tmux.

**CallbackRegistry memory:** Bounded by concurrent active relays Ã 5-minute TTL. At 10 concurrent sessions each hitting one relayed prompt, that's 10 entries. The Map will never hold more than O(100) entries under realistic load.

**Audit log I/O:** Append-only writes at prompt frequency. For a busy agent hitting 10 prompts/hour across all sessions, this is ~10 JSONL lines/hour â negligible I/O.

**Pattern matching:** Regex matching on the last N lines of terminal output, 500ms cycle. This is CPU-trivial. The ANSI strip step adds a string allocation per capture but is still O(microseconds).

**Telegram API budget:** Each relay prompt sends 1 message (+ possible edits for supersession, timeout, expiry). The existing 1 msg/s rate limit applies. Well within budget for a single-user agent.

**Bottleneck:** Pattern catalog maintenance, not runtime performance. This is a human scalability problem, not a system scalability problem.

---

## Score

**7.5 / 10**

**Justification:**

The R2 spec is a solid, well-structured architectural design that addresses the three critical R1 findings. The component decomposition is clean, data models are correct, edge cases are comprehensively handled, and the phased delivery plan is architecturally sound. The CallbackRegistry addition is the right solution to the Telegram constraint, and the ANSI preprocessing specification removes a correctness risk from the detection pipeline.

Points held back:
- C1 (WebSocket subscriber dependency) is a correctness gap that would cause the feature to silently not work for Telegram-first users in the most common usage scenario. (-1.0)
- Hook-vs-pattern-matching question remains architecturally unresolved. The R1 business review raised this; R2 did not add a hook validation step to the Phase 1 plan. This is the architectural decision with the highest long-term cost if decided wrong. (-0.5)
- C2 and C3 are medium-severity issues that need explicit spec language before implementation. (-0.5)
- Missing EventEmitter interface makes InputDetector less extensible than the rest of the design implies. (-0.25)
- No schema versioning on the audit log. (-0.25)

A score of 8.5-9 is achievable if C1-C3 are resolved, the hook validation step is added to Phase 1, and the EventEmitter refactor is adopted. The underlying architecture is right â these are specification gaps, not design flaws.

---

*Architecture review by Echo (instar developer agent) Â· Round 2 Â· 2026-03-20*
