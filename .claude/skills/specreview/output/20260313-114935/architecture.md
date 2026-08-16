# Architecture Review — Dashboard Quick Paste
**Review ID:** 20260313-114935
**Round:** 1
**Spec:** specs/dashboard-quick-paste.md
**Reviewer:** Echo (systems architect mode)
**Date:** 2026-03-13

---

## Approval Status

**CONDITIONAL APPROVE**

The design is fundamentally sound and integrates well with the existing instar architecture. The core technical choices (file-drop delivery, file-ref notification pattern) are validated by the real codebase — this is exactly how `injectTelegramMessage` already handles large content. There are no blocking architectural flaws. A handful of gaps need resolution before implementation begins, primarily around the delivery notification mechanism and the truncation detection placement.

---

## Score: 7.5 / 10

**Justification:** Pragmatic, well-scoped feature with a delivery model already proven in production (the Telegram long-message path). Score held back by: ambiguity in how the notification reaches the active session, underspecified pending-paste integration with the session-start hook, and a truncation detection section that conflates two different implementation homes without committing to one.

---

## Critical Issues

### 1. Delivery notification is underspecified for the active-session case

The spec says: "Send a notification to the target session: `[paste] User sent 4,832 chars...`"

But it does not specify HOW this notification reaches the session. Looking at the actual codebase (`SessionManager.injectTelegramMessage`), the mechanism is `tmux send-keys` with bracketed paste mode for multi-line content. The spec must commit to one of:

- **A:** Call `SessionManager.injectMessage()` (or a new `injectPasteNotification()` method) directly from the POST route handler. This is the right call — it's synchronous, confirmed, and uses the battle-tested bracketed paste path.
- **B:** Write a notification file that some polling loop picks up. This adds latency and complexity for no gain when Option A exists.

The notification string in the spec (`[paste] User sent 4,832 chars: "error log from prod" — read at .instar/paste/1710345600-error-log.txt`) is good. The plumbing to get it there is absent. The `rawInject` → `injectMessage` path in `SessionManager` is the right primitive.

**Resolution required:** Spec must explicitly state that the POST route calls `SessionManager.injectMessage()` (or equivalent) with the notification string, after writing the file. The `delivered: true` response field only makes sense if this step is synchronous and confirmed.

### 2. Session selection logic is undefined

The spec says "defaults to most recent active session" but does not define what "most recent" means. The `SessionManager.listRunningSessions()` returns all running sessions sorted by `startedAt`. The definition needs to be explicit:

- Most recently **started** session?
- Most recently **active** (last tmux output)? This is harder to compute.
- The session most recently associated with a Telegram topic (from the topic-session registry)?

For a dashboard paste, "most recently started interactive session" is probably correct, but the spec needs to say so. Job sessions (those with `jobSlug`) should likely be excluded from the default target — a user pasting a log file probably wants the interactive session, not a running job.

**Resolution required:** Define the session priority ordering explicitly, and specify whether job sessions are eligible targets.

### 3. The `pending-pastes.json` state and session-start hook integration are underspecified

The spec mentions that pending pastes set "a flag in `.instar/state/pending-pastes.json`" and that the session-start hook picks them up. But:

- What is the schema of `pending-pastes.json`? A list of file paths? A structured queue?
- The session-start hook currently outputs identity orientation context. How does the pending paste notification get appended? Does the hook write to stdout (which becomes session input)? Does it call `injectMessage`? These are different mechanisms with different behaviors.
- The 24-hour expiry needs a TTL check in the hook or a separate cleanup pass. The spec already mentions 7-day cleanup for all paste files, but pending pastes get 24h — two different lifetimes in one directory is confusing.

**Resolution required:** Define the pending-pastes schema and the exact mechanism by which the session-start hook delivers the pending notification. Clarify the 24h vs 7d TTL distinction or unify them.

---

## Recommendations

### R1: Route the notification through the existing injection infrastructure

The Telegram long-message path in `SessionManager` already does exactly what this spec needs:
1. Write content to a file
2. Inject a short reference notification via `send-keys`

The paste delivery should follow the identical pattern. The notification string should be injected via `injectMessage()` (which runs through InputGuard provenance checks). This also means dashboard pastes participate in the same security model as Telegram messages.

The existing `FILE_THRESHOLD = 500` in `injectTelegramMessage` is informative: even "short" content can be above it. A paste of any size should always go to file; the notification is always a short reference. This is cleaner than the spec's implication that very short pastes might be injected directly.

### R2: Add a `paste_id` to the response and use it in the notification

```json
{
  "ok": true,
  "delivered": true,
  "pasteId": "20260313-183000-a4f2",
  "sessionName": "topic-605",
  "contentLength": 4832
}
```

The `pasteId` should be the filename stem (without `.txt`). This lets the dashboard history panel track delivery status by ID, and gives the WebSocket notification event a stable identifier to reference.

### R3: Use the existing WebSocket protocol for delivery confirmation

`WebSocketManager` already has `input_ack` messages. Add a `paste_delivered` event alongside it:

```json
{ "type": "paste_delivered", "pasteId": "20260313-183000-a4f2", "sessionName": "topic-605" }
```

This is emitted after the server-side `injectMessage()` call succeeds. The dashboard UI subscribes via the existing `/ws` connection — no new WebSocket endpoint needed. This is the right reuse of existing infrastructure.

### R4: Truncation detection belongs in the server-side Telegram ingestion path, not in a hook

The spec wavers between placing truncation detection in a PreToolUse hook vs. server-side middleware. The correct answer is the server: Telegram message ingestion already happens in the server before forwarding to a session. Injecting metadata there (`truncationSuspected: true`) follows the existing pattern for how Telegram message enrichment works.

Hooks fire inside Claude Code sessions, not in the Telegram ingestion path. A PreToolUse hook cannot inspect the raw Telegram message that triggered the session — it only sees tool calls within the active turn. The spec's "hook or middleware" framing should be resolved to: **server-side Telegram middleware only.**

### R5: Define a `from` source enum for the paste file frontmatter

The spec shows `from: dashboard` in the frontmatter. Extend this to an enum now before anything else generates paste files:

```
from: dashboard | telegram-relay | api | cli
```

This lets the history panel and any future analytics distinguish how content arrived. It also opens the door for Telegram to use the paste infrastructure for its own long-message delivery (replacing `/tmp/instar-telegram/`) in a future iteration.

### R6: Consider a size cap, not just a warning

The spec says ">1MB: warn user but allow." This is probably fine for v1, but document the implicit limit: `tmux send-keys -l` with bracketed paste mode should handle any size since the content goes to a file and only a short reference is injected. There is no actual tmux buffer concern in the file-drop design. The warning is cosmetic.

However, a hard cap at, say, 50MB is worth adding to prevent accidental pasting of binary blobs or enormous log files that would bloat `.instar/paste/` and slow down any file listing operations. The spec's current "warn but allow" for 1MB is a reasonable starting point for v1 — just make the limit explicit in code, not just prose.

---

## Observations

### The file-drop design is correct and proven

The core architectural choice — write to file, inject short reference — is exactly what `injectTelegramMessage` does for messages over 500 chars, and what `injectWhatsAppMessage` mirrors. This is not a new pattern being introduced; it's a well-worn path in the codebase. The paste feature is essentially promoting this pattern from an internal detail to a first-class user-facing feature. That is architecturally coherent.

### The spec correctly rejects Option B (stdin injection) for large content

The existing `rawInject` method uses bracketed paste mode (`\x1b[200~` ... `\x1b[201~`) specifically to handle multi-line content without triggering macOS TCC permission prompts that would appear if `tmux load-buffer/paste-buffer` were used. The spec's preference for file-drop over direct injection is validated by this history. Large direct injection through tmux send-keys is not a reliability issue (bracketed paste handles it) but a security/permission issue on macOS.

### Audit trail is a genuine differentiator

The file format with frontmatter (label, from, timestamp, delivered, sessionName) creates a useful audit trail that neither Telegram nor WhatsApp message injection currently produces in a structured way. The `/tmp/instar-telegram/` files have no metadata. The `.instar/paste/` approach with structured frontmatter is a step up. Worth preserving and potentially backporting to the Telegram long-message path.

### The 7-day TTL and gitignore exclusion are correct

Paste files should absolutely not sync via git-sync. They may be large, transient, and potentially sensitive. The gitignore exclusion is essential. The 7-day auto-cleanup is appropriate — this mirrors how most ephemeral agent state is handled.

### History panel is useful but raises a minor privacy concern

The paste history panel shows recent pastes with labels and delivery status. If a user pastes a secret (API key, password), the label they gave it ("prod credentials" or similar) will appear in the history panel, visible to anyone with dashboard access. This is not a blocker but worth a note in the spec: the history panel should show labels and metadata only, never the content itself. Content is in the file; the file path reference is sufficient.

---

## Research Findings

### File-Based Message Passing in Agent Systems

File-based message passing is a well-established pattern in agent and workflow systems. Key properties that make it appropriate here:

**Persistence across process boundaries:** Files survive process restarts, making them suitable for the queue-when-offline use case. The spec correctly leverages this for pending pastes when no session is running.

**No coupling between sender and receiver:** The server-side POST route and the Claude Code session are separate processes. A file-drop makes the coupling temporal (the session reads when ready) rather than synchronous (the session must be ready now). This is the right model for an agent that may be in the middle of a long operation when a paste arrives.

**Audit trail and observability:** Files are trivially inspectable with standard tools. The structured frontmatter the spec proposes follows the same pattern used by instar's handoff notes and session state files.

**The existing `DropPickup` module** (`src/messaging/DropPickup.ts`) implements the instar standard for file-based inter-agent messaging: HMAC verification, deduplication, structured envelopes, automatic cleanup. The paste system is a simpler version of this pattern (no cross-agent trust needed, single-agent context), so it correctly omits the HMAC complexity while retaining the structural approach.

### Dashboard Architecture and Real-Time Delivery Confirmation

The existing `WebSocketManager` implements a solid real-time delivery pattern:

- Heartbeat ping/pong (30s interval) ensures dead connections are detected
- `input_ack` messages provide synchronous confirmation of tmux send-keys success
- Session list broadcast (5s interval) keeps UI state fresh without long-polling

The spec's mention of "WebSocket notification when paste is delivered" fits naturally into this protocol by adding a `paste_delivered` event type. The existing infrastructure handles all the authentication, reconnection, and multi-client broadcast concerns — no new WebSocket machinery is needed.

The application-level acknowledgment pattern (client sends paste, server responds with `paste_id`, WebSocket later broadcasts `paste_delivered`) is the right design for confirmable delivery. It matches how file transfer and message queue systems handle at-least-once delivery semantics.

### tmux send-keys with Large Payloads

The tmux manual does not document explicit buffer limits for `send-keys`. However, the instar codebase already resolved the practical concern: bracketed paste mode (`\x1b[200~` wrapper) prevents macOS from intercepting the paste as a permission-requiring clipboard access event. The `rawInject` implementation in `SessionManager` uses this technique with a 5-second timeout per `execFileSync` call.

For the Quick Paste feature, this is moot: the file-drop design means `send-keys` only carries a short reference string (~100 chars), never the paste content itself. There is no payload size concern in the chosen design.

### Truncation Detection Heuristics

The near-limit detection heuristic (message within 50 chars of 4096 + unclosed delimiter) is pragmatically sound. Research into Telegram bot API behavior confirms the silent truncation/rejection behavior: messages over 4096 UTF-16 code units are silently dropped at the client layer before the bot API receives them, so server-side detection of the full message is not possible.

The spec's three heuristics (near-limit truncation, rapid multi-part, structural incompleteness) are defensible but should be treated as probabilistic signals, not facts. The "one nudge per conversation thread" rule is essential to prevent the detection system from becoming annoying. The correct implementation location is server-side Telegram message ingestion — not hooks.

---

## Scalability Assessment

**Current scale:** Single agent, single user, single machine. The file-based design is appropriate and slightly over-engineered for this scale in a good way — it handles the offline case, provides an audit trail, and avoids the complexity of an in-memory queue.

**Multi-session growth:** As the number of concurrent sessions grows, the target session picker becomes more important. The spec handles this with a dropdown, which is correct. The selection default (most recent interactive session) should be clearly defined.

**Multi-user growth:** If multiple users access the dashboard (via tunnel), the paste history panel will show everyone's pastes to everyone with dashboard access. The PIN-gate is the only access control. This is acceptable for the current single-user model but worth documenting as a v2 consideration.

**Content volume:** The 7-day TTL and auto-cleanup prevent unbounded growth. For typical usage patterns (a few pastes per day), `.instar/paste/` will remain small. For heavy usage (CI integration piping logs), the directory could grow large between cleanup runs. A size-based cleanup trigger (delete oldest when directory exceeds N MB) alongside the TTL would be more robust, but this is a v2 concern.

**Extension to other delivery channels:** The `from:` field in the frontmatter is the right extension point. Future: Telegram could use the paste infrastructure for its long-message delivery instead of `/tmp/instar-telegram/`, unifying the two patterns and giving Telegram messages the same audit trail.

---

## Pre-Implementation Checklist

Before implementation begins, resolve in the spec:

- [ ] Confirm delivery notification uses `SessionManager.injectMessage()` directly from the POST route handler
- [ ] Define session priority ordering (what "most recent" means, whether job sessions are excluded)
- [ ] Define `pending-pastes.json` schema and the mechanism by which session-start hook delivers pending notifications
- [ ] Clarify 24h (pending) vs 7d (all) TTL distinction — consider unifying
- [ ] Commit to server-side Telegram middleware (not hooks) for truncation detection
- [ ] Add `pasteId` to API response schema
- [ ] Specify `paste_delivered` WebSocket event type
- [ ] Document that history panel shows metadata only, never paste content
