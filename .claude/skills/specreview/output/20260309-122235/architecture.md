# Architecture Review: Response Review Pipeline

**Review ID**: 20260309-122235
**Round**: 1
**Reviewer**: Systems Architect
**Spec**: `/Users/justin/.instar/agents/echo/specs/response-review-pipeline.md`

---

## Approval Status: APPROVED WITH CONDITIONS

The architecture is fundamentally sound. The gate-then-fan-out pattern is the right call, the thin-hook-to-server split is clean, and the cost/latency analysis is honest. Three conditions must be addressed before implementation begins (detailed under Critical Issues).

**Score: 7.5 / 10**

---

## Research Findings

### Claude Code Stop Hook Mechanics

From official documentation (code.claude.com/docs/en/hooks) and source inspection of existing hooks:

1. **Stop hooks receive JSON on stdin** with `session_id`, `transcript_path`, `cwd`, `stop_hook_active`, and `last_assistant_message`. The `last_assistant_message` field gives direct access to the response text without parsing transcripts.

2. **Decision control uses JSON stdout**, not exit codes. The spec's reference to "exit 2 with feedback" is a legacy/alternative pattern. The documented approach is: exit 0, print `{"decision": "block", "reason": "..."}` to stdout. Exit code 2 is the older mechanism where stderr is fed back as an error message. The JSON approach is more structured and should be preferred.

3. **`stop_hook_active` is the official loop-prevention flag.** When true, Claude is already continuing from a previous Stop hook block. The existing `claim-intercept-response.js` correctly checks this and exits 0 immediately. However, `stop_hook_active` is a boolean --- it does not carry a retry count. Retry tracking must be external (the spec correctly proposes server-side tracking).

4. **Stop hooks do not support matchers.** They fire on every occurrence. The hook itself must decide whether to act based on the input context. This means the hook cannot be scoped to only Telegram responses at the matcher level --- channel filtering must happen inside the hook or server-side.

5. **Multiple Stop hooks run sequentially.** The existing settings.json already has two Stop hooks (claim-intercept-response.js, scope-coherence-checkpoint.js). Adding a third creates a sequential chain. If the new pipeline hook blocks, the other hooks never fire for that turn. If the pipeline hook passes, the other hooks still run. This ordering dependency needs explicit management.

### LLM-as-Judge / Parallel Reviewer Patterns

Research into LLM-in-the-loop validation architectures confirms several patterns the spec employs:

- **Gate/triage before expensive evaluation** is standard practice. The "LLM-as-a-Judge" literature consistently recommends confidence-based routing to reduce cost. The spec's gate reviewer serves this purpose.
- **Multiple specialized evaluators in parallel** (as opposed to one monolithic judge) is the recommended approach for multi-dimensional quality assessment. Each evaluator can be calibrated independently.
- **Fail-open with logging** is the correct posture for quality layers (as opposed to security layers). The spec correctly identifies this.
- **Feedback loops** (adjusting reviewer sensitivity based on agent disagreement) are identified as important in the literature but correctly deferred in the spec.

### Existing Hook Ecosystem

The agent already runs 5 PreToolUse hooks, 5 PostToolUse hook groups, 2 Stop hooks, and hooks on 4 other lifecycle events. The response review pipeline would replace 2-3 of these (claim-intercept-response.js, parts of convergence-check.sh, external-communication-guard.js) while adding one new Stop hook. Net effect is roughly neutral on hook count, but significantly more expensive per invocation (LLM calls vs. regex/file checks).

### Server-Side Orchestration for Parallel API Calls

The proposed `Promise.all` fan-out for specialist reviewers is the standard Node.js pattern. Key considerations:
- Each Haiku call is an independent HTTP request to the Anthropic API.
- Rate limits on the Anthropic API could become a bottleneck if the agent is generating many responses in quick succession (e.g., during job execution).
- `Promise.allSettled` would be more resilient than `Promise.all` --- a single reviewer timing out shouldn't block the verdict.

---

## Critical Issues

### 1. Stop Hook Output Contract is Misspecified

**Severity**: High --- will cause implementation bugs.

The spec describes the Stop hook blocking mechanism as "exit 2 with feedback as reason (agent revises)" and references `stop_hook_active` for loop prevention. However, the spec also shows `JSON with decision: "block"` in the feedback composition section. These two mechanisms are different:

- **Exit code 2**: stderr text is fed to the agent as an error message. No structured JSON.
- **Exit 0 + JSON stdout**: `{"decision": "block", "reason": "..."}` is the structured approach. Claude reads the reason field.

The existing `claim-intercept-response.js` uses a hybrid: it writes JSON to stdout AND exits with code 2. Based on the official docs, the correct approach for Stop hooks is exit 0 with JSON `{"decision": "block", "reason": "..."}`. The spec should pick ONE mechanism and document it precisely. I recommend the JSON approach since it aligns with the structured feedback the pipeline produces.

**Additionally**, the spec says on line 179: "When `stop_hook_active` is true (agent is already revising from a previous block), skip the full pipeline." But then on line 497: "Pipeline runs again but with retry count incremented." These contradict. If you skip when `stop_hook_active` is true, you never get retries. The actual design needs to be: when `stop_hook_active` is true, check server-side retry count. If under max, run the pipeline. If at max, pass through. The `skipWhenHookActive` config option should be renamed to something like `skipReviewOnRetry` and its semantics clarified.

### 2. Hook Ordering Creates a Fragile Dependency

**Severity**: Medium --- works initially but creates maintenance burden.

Adding the response-review Stop hook alongside the existing claim-intercept-response.js and scope-coherence-checkpoint.js creates three sequential Stop hooks. The spec says the pipeline "replaces" claim-intercept-response.js, but there is no migration plan for the transition period.

More importantly, if the response-review hook blocks and the agent revises, the scope-coherence-checkpoint.js fires on the revised response. If that ALSO blocks, the agent is now in a double-block situation. The `stop_hook_active` flag is shared across all Stop hooks --- it tells you "some Stop hook already blocked," not "which one."

**Recommendation**: The implementation plan should include:
- Phase 2 must explicitly disable claim-intercept-response.js when the pipeline is active (not "after" --- at the same time).
- Document the expected hook execution order and what happens when multiple Stop hooks want to block.
- Consider whether the pipeline should be the ONLY Stop hook, subsuming scope-coherence-checkpoint.js as another reviewer dimension.

### 3. Reviewer Prompts Lack Conversation Context, Making Key Reviewers Unreliable

**Severity**: Medium-High --- undermines the Claim Provenance and Settling Detection reviewers.

The spec acknowledges this in Open Question #2 but treats it as optional. It is not. The Claim Provenance reviewer is asked to detect "URLs that look constructed rather than retrieved from tools" and "specific numbers without attribution." Without seeing the tool output that preceded the response, this reviewer is guessing. It can catch obvious patterns (project name -> URL fabrication) but cannot verify whether a specific number was actually returned by a tool call.

Similarly, the Settling Detection reviewer flags "no data available" responses, but without knowing what queries the agent ran, it cannot distinguish genuine thoroughness failure from legitimate "I searched three places and found nothing."

**Recommendation**: Pass a truncated recent-tool-output summary (last 3-5 tool results, capped at ~500 tokens) to at least the Claim Provenance and Settling Detection reviewers. The token cost increase is modest (~150 tokens per reviewer) and the accuracy improvement is substantial. The `transcript_path` is already available in the Stop hook input --- the server can parse recent entries.

---

## Recommendations

### R1. Use `Promise.allSettled` Instead of `Promise.all`

The spec says reviewers run via `Promise.all`. If one reviewer's Haiku call times out or errors, `Promise.all` rejects the entire batch, potentially losing verdicts from reviewers that completed successfully. `Promise.allSettled` lets you collect all results, treat errors as "no opinion" (consistent with fail-open), and still produce a verdict from the reviewers that succeeded.

### R2. Add a Reviewer Result Cache for Revision Cycles

When the agent revises and the pipeline runs again, all reviewers re-evaluate from scratch. This is wasteful if only one reviewer flagged an issue. Consider caching passing reviewer results (keyed by reviewer + message hash) and only re-running the reviewers that flagged issues, plus a quick diff-check to confirm the passing dimensions weren't regressed by the revision. This halves the cost of revision cycles.

### R3. Channel-Dependent Reviewer Configuration

The spec mentions `channels` in config but treats all channels the same way. The Appendix identifies channel awareness as a gap (localhost URLs in Telegram). Rather than adding a separate "Channel Awareness" reviewer, extend the existing reviewer prompts with channel context. For example, the URL Validity reviewer should know whether the response is destined for Telegram (flag localhost) or CLI (allow localhost). This is a one-line addition to each reviewer prompt: "This message will be sent via {channel}."

### R4. Define the Gate Reviewer's Value Hierarchy Role More Precisely

The spec says the gate reviewer "receives a summary of the value hierarchy to assess whether the response warrants deeper value-alignment checking." This adds tokens to every gate call (the most frequent path) for marginal benefit. The gate's job is fast triage based on message structure (length, presence of claims, channel). Value alignment is a specialist concern. Keep the gate prompt lean --- it is on the critical path for every response.

### R5. Instrument the Transition Period

When retiring convergence-check.sh and claim-intercept-response.js, run both the old hooks and the new pipeline in parallel for a period. Log when they disagree. This validates that the pipeline catches everything the old hooks caught, and reveals false positives/negatives before the old safety net is removed.

### R6. Rate-Limit Haiku Calls Per Session

During intensive job execution, the agent might generate dozens of responses in quick succession. Each triggers a gate call plus potentially 7 specialist calls. Add a session-level rate limiter (e.g., max 20 full reviews per minute) with automatic pass-through when the limit is hit. This prevents runaway API costs during burst activity.

---

## Observations

### The Appendix A Incident Analysis is Exceptional

The Dawn research section transforms this from a speculative architecture into an evidence-grounded design. Each reviewer maps to real incidents. The coverage gap analysis is honest --- it explicitly identifies what the current 7 reviewers do NOT catch. This is rare in specs and significantly increases confidence in the design.

### The 7-Reviewer Count is at the Upper Bound of Manageable Complexity

Seven parallel Haiku calls is architecturally sound but operationally heavy. The Appendix identifies 8 additional reviewer dimensions (P0-P2). If all were added, that is 15 parallel calls per response --- the latency and cost calculus changes fundamentally. The spec should set a hard cap (e.g., max 10 reviewers) and require that new reviewers replace existing ones or are merged into composite reviewers rather than appended.

### The Value Alignment Reviewer is Architecturally Novel

Most LLM-as-judge systems evaluate against generic quality criteria. Grounding evaluation in a three-tier value hierarchy (agent, user, org) that is loaded from actual config files is a genuinely interesting pattern. This is the reviewer most likely to produce unexpected value --- and also the most likely to produce false positives until its prompts are tuned against real data.

### `failOpen: true` is Correct but Needs Observability

Fail-open means that when the review system is down, every response passes unchecked. This is the right default, but it creates a silent failure mode. The spec includes observability endpoints (`GET /review/history`, `GET /review/stats`), but should also include an alerting mechanism: if the gate reviewer fails N times in a row, queue an attention item so the user knows the quality layer is degraded.

### The Spec Correctly Identifies Notification Spam as Out of Scope

Infrastructure-generated messages (auto-updater, lifeline alerts) bypass the review pipeline because they are not LLM-generated. This is correct --- reviewing them would require a different interception point. However, the spec should note this explicitly as a known gap with a pointer to where infrastructure message quality is handled (or should be).

---

## Scalability Assessment

**Current scale**: ~100 responses/day, ~$1.20/month. The architecture handles this easily.

**10x scale** (1000 responses/day): ~$12/month. Haiku API rate limits become the binding constraint. With 7 parallel calls per reviewed response, a burst of 10 responses in 60 seconds means 70 concurrent Haiku requests. Anthropic's rate limits vary by tier but this could hit them. The `Promise.allSettled` recommendation and rate limiting (R6) address this.

**100x scale** (10,000 responses/day): The architecture does not scale here without caching (R2) and more aggressive gating. At this volume, the gate reviewer should be replaced with a local classifier (regex or small model) to avoid the API call on every response. The server-side design correctly centralizes this --- swapping the gate implementation is a single-file change.

**Multi-agent**: The spec is written for a single agent. If multiple agents share an instar server, the review pipeline needs per-agent configuration and per-agent retry tracking. The `sessionId` key for retry tracking works for this, but the config (`responseReview` in config.json) is global. Consider per-agent overrides.

**Evolution path**: The modular reviewer design (each reviewer is an independent class with a standard interface) makes it straightforward to add, remove, or swap reviewers. The gate-then-specialize pattern is a proven architecture that scales well with additional dimensions. The main evolution risk is reviewer prompt drift --- as prompts are tuned over time, they may overlap or conflict. The stats endpoint (`GET /review/stats`) provides the data needed to detect this.

---

## Summary

This is a well-researched, incident-grounded architecture for a real problem. The gate-fan-out pattern is sound, the cost analysis is realistic, the fail-open posture is correct, and the thin-hook/server-pipeline split is the right separation of concerns. The three critical issues (Stop hook output contract, hook ordering, and missing conversation context for key reviewers) are all addressable without architectural changes --- they are specification gaps, not design flaws. The Appendix A incident analysis elevates this spec significantly above typical designs by grounding every reviewer in documented production failures.

Address the three critical issues and this is ready to build.
