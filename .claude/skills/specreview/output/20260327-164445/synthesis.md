# SpecReview Synthesis: Instar SlackAdapter

**Review ID**: 20260327-164445
**Date**: 2026-03-27
**Round**: 1
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing
**Spec**: SLACK-ADAPTER-SPEC.md

---

## Overall Assessment

**Status**: NEEDS WORK
**Average Score**: 6.75 / 10
**Score Range**: 5.5 - 7.5

| Reviewer | Status | Score | Key Finding |
|----------|--------|-------|-------------|
| Security | BLOCKED (3 critical) | 5.5/10 | Prompt injection completely unmitigated; token storage insufficient; setup wizard scrapes credentials unsafely |
| Scalability | CONDITIONAL | 6.5/10 | Channel history hook will exhaust rate limits under moderate load; reconnection logic can self-lock |
| Business | CONDITIONAL | 7.0/10 | Competitive threat from Slack's native AI unacknowledged; setup wizard has no maintenance plan |
| Architecture | CONDITIONAL | 7.5/10 | files.upload API broken for new apps; Socket Mode silent failure risk underspecified |
| Privacy | CONDITIONAL | 6.5/10 | No retention policy for local message logs; workspace members receive no notice of bot presence |
| Adversarial | CONDITIONAL | 6.5/10 | AuthGate defaults fail-open; bot tokens captured in browser screenshots; prompt injection via channel/sender name |
| DX / API | CONDITIONAL | 7.5/10 | Socket Mode needs hardening beyond spec's "No Lifeline Needed" claim; port bug in relay script |
| Marketing | CONDITIONAL | 6.5/10 | No product name; no competitive differentiation from OpenClaw; setup wizard undersold |

---

## Consensus Findings

*Issues that 3+ reviewers independently identified:*

1. **`slack-reply.sh` defaults to port 4040 instead of 4042**: Identified by Security, Scalability, Architecture, Adversarial, Business, DX
   - Summary: The relay script hardcodes `PORT="${INSTAR_PORT:-4040}"` but instar runs on 4042. This is a day-one operational bug that will silently break message delivery for every user.
   - Recommended action: Change default to 4042. Five-second fix, zero risk.

2. **Prompt injection attack surface is unmitigated**: Identified by Security, Adversarial, (Privacy tangentially)
   - Summary: Messages from Slack channels are injected verbatim into Claude sessions. The channel context hook injects 30 messages as raw context. User-controlled fields (display names, channel names) can break injection tag boundaries. No sanitization, no trust boundary, no content classification.
   - Recommended action: Add input sanitization layer. Use structured (JSON) injection format instead of bracket tags. Consider content classification before injection. Document the risk explicitly.

3. **`authorizedUserIds: []` defaults to fail-open**: Identified by Security, Adversarial, DX
   - Summary: Empty array means "any workspace member can command the agent." In shared workspaces, this exposes the agent to all colleagues. Setup wizard has a code path where the list may never be populated.
   - Recommended action: Make `authorizedUserIds` required. Fail closed (deny all) if empty. Populate during setup wizard.

4. **OAuth scope manifest is over-permissioned**: Identified by Security, Privacy, Architecture
   - Summary: 17-19 scopes requested as a single bundle. DM scopes included despite DMs being deferred. `files:write` not needed in Phase 1. Private channel access is a significant privacy escalation. `channels:write` is deprecated (should be `channels:manage`).
   - Recommended action: Define minimal Phase 1 scope set. Document which scope enables which feature. Make DM and private channel scopes opt-in. Update deprecated scope names.

5. **Setup wizard token extraction is unsafe**: Identified by Security, Adversarial, Privacy
   - Summary: Playwright scrapes `xoxb-` tokens from rendered DOM via regex. Screenshots during these steps capture tokens in plaintext. CLI fallback passes tokens as command arguments (visible in shell history and `ps aux`). No workspace validation after extraction.
   - Recommended action: Suppress screenshots on token extraction steps. Validate token workspace via `auth.test` immediately. Use stdin for CLI token input. Clear temporary artifacts.

6. **Socket Mode reconnection logic is underspecified**: Identified by Scalability, Architecture, DX
   - Summary: Immediate reconnect on close without backoff can exhaust `apps.connections.open` rate limit and lock the app out for 60 seconds. Silent connection death (socket open but not delivering messages) is a known production issue. `too_many_websockets` disconnect reason not handled.
   - Recommended action: Apply exponential backoff from first reconnect attempt. Read `approximate_connection_time` for proactive rotation. Handle `disconnect` event with `reason` field. Implement active heartbeat that validates message flow.

7. **Channel history hook will hit rate limits**: Identified by Scalability, DX
   - Summary: `slack-channel-context.sh` makes a live `conversations.history` API call on every user prompt. Under moderate load (10+ messages/min across sessions), this saturates the Tier 3 budget and blocks all other Slack API operations.
   - Recommended action: Maintain in-memory ring buffer populated from Socket Mode events. Hook reads from cache — zero API calls per prompt.

8. **`files.upload` API is broken for new apps**: Identified by Architecture
   - Summary: `files.upload` was deprecated and is unavailable for apps created after May 2024. Setup wizard creates new apps — file uploads will fail immediately. Correct flow is `files.getUploadURLExternal` -> PUT -> `files.completeUploadExternal`.
   - Recommended action: Document and implement the three-step upload flow.

---

## Critical Issues (Blockers)

| # | Issue | Reviewer(s) | Severity | Suggested Fix |
|---|-------|-------------|----------|---------------|
| 1 | Prompt injection completely unmitigated — channel messages injected verbatim into Claude sessions | Security, Adversarial | CRITICAL | Add sanitization layer, structured injection format, content classification, trust boundary markers |
| 2 | Token storage insufficient — `xoxb-`/`xapp-` tokens in plaintext config.json, no rotation, no expiry | Security | CRITICAL | Add `xapp-` to redaction patterns, document rotation, elevate encrypted storage from optional to recommended |
| 3 | Setup wizard captures tokens in screenshots and shell history | Security, Adversarial | CRITICAL | Suppress screenshots during token steps, use stdin for CLI input, validate workspace, clear artifacts |
| 4 | AuthGate defaults fail-open — empty `authorizedUserIds` allows any workspace member | Security, Adversarial, DX | CRITICAL | Make required, deny-all if empty |
| 5 | No retention policy for JSONL message logs containing personal data | Privacy | CRITICAL | Add `logRetentionDays` config, implement purge on removal, document personal data content |
| 6 | Workspace members receive no notice of AI bot reading and logging their messages | Privacy | CRITICAL | Bot posts pinned notice in channels, display name identifies as AI, dedicated workspace default |
| 7 | `files.upload` broken for newly created apps | Architecture | HIGH | Implement three-step `getUploadURLExternal` flow |

---

## Conflicts

### Conflict 1: Socket Mode Production Readiness

- **Architecture** says: Socket Mode is "the only viable option" for local-first use case; needs hardening but is fundamentally correct
- **DX** says: Spec's claim "No Lifeline Needed" is incorrect per Slack's own docs; needs a Slack Lifeline process or active heartbeat
- **Scalability** says: Socket Mode's 30-minute delivery buffer is "genuinely superior to Telegram's long-polling" — architecture decision is correct
- **Tension**: Agreement that Socket Mode is the right choice, but disagreement on how much production hardening is needed before v1 ships
- **Resolution**: Consensus leans toward Socket Mode being correct but requiring more hardening than the spec acknowledges. The "No Lifeline Needed" claim should be retracted. Active heartbeat validation (not just socket state) should be a Phase 1 requirement.

### Conflict 2: Dedicated Workspace vs Existing Workspace as Default

- **Business** says: Consider existing workspace as primary for enterprise users (paid plans get unlimited history + apps)
- **Privacy** says: Dedicated workspace should be strongly recommended — "only you in this workspace, privacy considerations substantially simpler"
- **Business** says: Channel sprawl in shared workspace is the primary UX concern — dedicated workspace should be near-mandatory default
- **Tension**: Business sees enterprise value in existing workspaces; privacy and UX favor dedicated workspaces
- **Resolution**: Default to dedicated workspace (privacy and UX win), but ensure existing workspace path is well-documented for enterprise users who understand the tradeoffs.

### Conflict 3: DM Support Priority

- **DX** says: DM support should be the default entry point — it's the natural first instinct for users
- **Architecture** says: v1 should ignore threads and support DMs (recommending DMs)
- **Spec** says: DMs are deferred (Phase 2+), but DM scopes are included in Phase 1 manifest
- **Tension**: DX and Architecture favor DMs sooner, but spec defers them while requesting the scopes anyway
- **Resolution**: Either add DM routing to Phase 1 (since scopes are already requested) or remove DM scopes from Phase 1 manifest to comply with least-privilege.

### Conflict 4: Thread Support

- **DX** says: "Every AI-in-Slack integration uses threads. Without them, session channels become unreadable. Take a position now."
- **Architecture** says: "v1 ignores threads" — recommends deferring thread support
- **Tension**: DX sees threads as table stakes for Slack UX; Architecture sees them as complexity to defer
- **Resolution**: Needs spec author decision. DX reviewer makes a strong case that Slack users expect threads. Consider at minimum supporting thread replies in session channels even if cross-channel thread monitoring is deferred.

---

## Recommendations (Prioritized)

| Priority | Recommendation | Source Reviewers | Effort | Impact |
|----------|---------------|-----------------|--------|--------|
| P0 | Fix `slack-reply.sh` default port from 4040 to 4042 | Security, Scalability, Architecture, Adversarial, Business, DX | Low | High |
| P0 | Make `authorizedUserIds` required, fail closed if empty | Security, Adversarial, DX | Low | High |
| P0 | Add prompt injection mitigation — sanitize inputs, structured injection format | Security, Adversarial | Medium | High |
| P0 | Suppress screenshots during token extraction wizard steps | Security, Adversarial | Low | High |
| P0 | Implement three-step file upload flow (getUploadURLExternal) | Architecture | Medium | High |
| P1 | Add `xapp-` prefix to token redaction patterns | Security, Architecture | Low | Medium |
| P1 | Update `channels:write` to `channels:manage` (deprecated scope) | Scalability, Architecture | Low | Medium |
| P1 | Define minimal Phase 1 scope set, remove unused DM/file scopes | Security, Privacy | Low | High |
| P1 | Wrap all reaction calls in fire-and-forget (non-fatal) | Scalability | Low | High |
| P1 | Add exponential backoff from first reconnect attempt | Scalability, Architecture, DX | Medium | High |
| P1 | Add configurable `logRetentionDays` with purge on removal | Privacy | Medium | High |
| P1 | Bot posts pinned notice in channels it joins | Privacy | Low | Medium |
| P1 | Implement in-memory ring buffer for channel history (replace live API calls) | Scalability | Medium | High |
| P1 | Add `wsUrl` to log redaction patterns | Adversarial | Low | Medium |
| P1 | Fix `action_id.split('_')` — use `split('_', 2)` or different separator | Adversarial | Low | Medium |
| P2 | Implement global rate limit token bucket with priority queues | Scalability | High | Medium |
| P2 | Add proactive WebSocket rotation using `approximate_connection_time` | Scalability | Medium | Medium |
| P2 | Add setup wizard health check job and resumable state tracking | Business, DX | High | Medium |
| P2 | Add channel creation pacing (15/min limit) at startup | Scalability | Low | Low |
| P2 | Validate token workspace via `auth.test` immediately after extraction | Security, Adversarial | Low | Medium |
| P2 | Use stdin for CLI token input instead of command arguments | Security | Low | Medium |
| P2 | Add competitive differentiation strategy (vs Slack native AI, vs OpenClaw) | Business, Marketing | Medium | Medium |
| P3 | Choose a product name (recommendation: "Instar Presence") | Marketing | Low | Medium |
| P3 | Handle `disconnect` event with `reason` field for graceful rotation | Scalability | Low | Low |
| P3 | Add Block Kit 50-block guard for Prompt Gate | Scalability | Low | Low |
| P3 | Document or remove `voiceProvider` config field | DX | Low | Low |

---

## Scalability Summary

| Phase | Assessment | Key Risks | Reviewers Agree? |
|-------|-----------|-----------|-----------------|
| **MVP** (1 user, 1 workspace) | Low risk — works as designed | Port bug (day-one break), reaction failures blocking message processing | Yes (all 8) |
| **Growth** (5+ sessions, active use) | Medium risk — latent issues surface | Rate limit exhaustion from channel history hook, concurrent caller budget conflicts, reconnection storms | Yes (Scalability, Architecture, DX) |
| **Scale** (continuous operation) | High risk without fixes | Channel history hook causes rate limit failures under moderate load, Socket Mode silent death, unbounded log growth | Yes (Scalability, DX, Privacy) |
| **Viral spike** | N/A — DIY model means independent deployments | Setup wizard breakage affects all users simultaneously when Slack UI changes | Yes (all reviewers) |

---

## Gaps

1. **Monitoring and observability**: No reviewer deeply covered how operators detect and diagnose adapter failures in production. Error reporting, health dashboard integration, and alerting thresholds are unaddressed.

2. **Graceful degradation when Slack is down**: The spec doesn't address behavior when Slack's API is unavailable (outage, maintenance). Does the agent fall back to Telegram? Queue messages? The adapter's failure mode during Slack outages is unspecified.

3. **Migration path from Telegram**: For existing instar users on Telegram, there's no documented migration story — how to move conversations, preserve channel mappings, or run both adapters simultaneously during transition.

4. **Testing strategy**: No reviewer covered how the adapter will be tested. Unit tests for the adapter, integration tests against Slack's API (sandbox workspace?), and end-to-end test scenarios are absent from the spec.

5. **Accessibility**: No consideration of screen reader compatibility, keyboard navigation for Prompt Gate interactions, or alt text for any visual elements the bot produces.

6. **Internationalization**: Channel naming conventions assume ASCII. Workspace names, user display names, and message content in non-Latin scripts are not addressed.

7. **Multi-adapter coordination**: If a user runs both Telegram and Slack adapters simultaneously, how do sessions, attention queue items, and job notifications route? The spec is silent on coexistence.

---

## Name Analysis (from Marketing Reviewer)

**Current name**: SlackAdapter
**Assessment**: Grade D. Class name from source code. "Adapter" is enterprise middleware vocabulary with zero memorability. Not suitable for external communication.
**Alternatives suggested**:
1. **Instar Presence** (recommended) — Captures what the feature does; resonates with Slack's presence API; generalizes to other platforms
2. **Instar Reach** — Communicates capability expansion
3. **Instar Wire** — Connotes communication, speed, infrastructure
4. **Instar Bridge** — Established integration vocabulary
5. **Instar Channels** — Leverages Slack's vocabulary but very generic

---

## Convergence Status

| Metric | Value |
|--------|-------|
| Reviewers in agreement (APPROVE) | 0 / 8 |
| Conditional approvals | 7 / 8 |
| Blockers | 1 / 8 (Security) |
| Open conflicts | 4 |
| Resolved conflicts | 0 |

**Convergence**: CONVERGING

All 8 reviewers agree the architecture is fundamentally sound (DIY model, Socket Mode, zero-SDK). Disagreements are on implementation details and prioritization, not direction. The Security reviewer's BLOCK status is driven by concrete, fixable issues (prompt injection, token handling, auth defaults) — not architectural objections. Resolving the P0 items would likely move all reviewers to APPROVE.

---

## Next Steps

- [ ] Address 7 critical issues before proceeding (especially the 3 Security BLOCKers)
- [ ] Resolve 4 open conflicts via spec author decision (Socket Mode hardening level, workspace default, DM timing, thread support)
- [ ] Implement all P0 recommendations (6 items, mostly low-effort fixes)
- [ ] Consider P1 recommendations for Phase 1 scope (11 items, mix of low and medium effort)
- [ ] Re-run review for affected areas: `/specreview SLACK-ADAPTER-SPEC.md --round 2 --reviewers security,adversarial,privacy`

---

*Generated by SpecReview multi-agent analysis.*
