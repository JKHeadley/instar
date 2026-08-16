# Architecture Review — Instar SlackAdapter Spec

**Review ID**: 20260327-164445 | **Round**: 1 | **Reviewer**: Systems Architect | **Date**: 2026-03-27

## Approval Status: CONDITIONAL APPROVAL

### Score: 7.5/10

Architecture is fundamentally sound. Three issues need resolution before full implementation.

---

## Research Findings

- **Socket Mode in production**: Slack's docs recommend HTTP for production SaaS. For instar's local-first use case, Socket Mode is the only viable option. Known pitfalls: connections can silently stop delivering messages after days. `too_many_websockets` disconnect reason is documented but often unhandled.
- **Zero-SDK validity**: Direct HTTP calls without `@slack/bolt` is viable and consistent with TelegramAdapter. Main risk: re-implementing reconnect handling that SDKs have battle-tested.
- **files.upload deprecation — BREAKING**: Newly created apps (since May 2024) cannot use `files.upload` at all. Sunset passed November 2025. Correct flow: `files.getUploadURLExternal` → `PUT {upload_url}` → `files.completeUploadExternal`. Any file upload following old pattern will fail immediately.
- **MessagingAdapter pattern**: Channel Adapter pattern is textbook EIP. Conformance test suite is correct contract enforcement.

---

## Critical Issues

### 1. Socket Mode Silent Failure Risk (Medium)
Spec mentions 30-minute message loss window but undersells the more serious risk: connections that appear open but silently stop delivering messages. The 60s stale connection detection addresses this but is buried. `too_many_websockets` disconnect reason must be handled explicitly.

**Fix**: Elevate stale connection detection to first-class requirement. Add `too_many_websockets` handling (wait 30s before reconnecting).

### 2. File Upload API Broken for New Apps (High)
`files.upload` is deprecated and unavailable for apps created after May 2024. Setup wizard creates brand new apps — file uploads will fail immediately.

**Fix**: Document three-step `getUploadURLExternal` → PUT → `completeUploadExternal` flow in both feature mapping and implementation sections.

### 3. Post-Acknowledgment Exception Guard (Low-Medium)
Code acknowledges envelope then processes event. If `handleSocketEvent` throws unhandled exception, event is acknowledged (Slack won't redeliver) but was not processed.

**Fix**: Explicit try/catch around `handleSocketEvent` with error logging, separate from acknowledgment path.

---

## Recommendations

1. **Strengthen reconnection spec**: Add `too_many_websockets` handling, connection health check on resume, outbound message queuing during reconnect/backoff.
2. **Take a position on threads vs DMs** before implementation. Thread support requires `thread_ts` awareness in `SessionChannelRegistry`. Recommended: v1 ignores threads, supports DMs.
3. **Rate limit strategy needs method tiering**: Channel management (Tier 1, 1 req/min) vs messaging (Tier 3). Channel ops should be queued non-blocking.
4. **Verify `xapp-` prefix** in `PolicyEnforcementLayer` token redaction list.

---

## Bugs Found

- **Wrong default port in `slack-reply.sh`**: Defaults to 4040, Instar runs on 4042.
- **Deprecated OAuth scope**: `channels:write` was split into `channels:manage` and `channels:write.invites`. Verify current scope names.

---

## What the Spec Does Well

- DIY app model rationale is airtight — comparison table is one of the clearest architectural decision justifications in any instar spec
- Feature parity mapping is honest — explicitly acknowledges lost capabilities
- Channel naming convention is practical and solves sprawl
- Setup wizard detail matches Telegram setup quality
- Shared infrastructure reuse reduces surface significantly
- Relay script pattern is consistent with Telegram

---

## Evolution Path

Clean: thread support, DMs, Block Kit extensions, multi-workspace all have clear paths without interface rewrites. Main evolution risk: channel lifecycle complexity growing into a God Object — consider extracting `SlackChannelManager` before Phase 3.

---

## Scalability Assessment

- **MVP**: Sound. Single-user, single-workspace model works.
- **Growth**: Clean. Each user independent, no shared bottleneck.
- **Scale**: Socket Mode reconnection robustness is the main concern. File upload migration is mandatory.
- **Viral spike**: N/A — DIY model means independent deployments.
