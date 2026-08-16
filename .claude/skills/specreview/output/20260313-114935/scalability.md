# Scalability Review — Dashboard Quick Paste
**Review ID**: 20260313-114935
**Round**: 1
**Reviewer**: Scalability & Infrastructure Specialist
**Date**: 2026-03-13
**Spec**: dashboard-quick-paste.md

---

## Approval Status

**CONDITIONAL**

The spec is well-scoped for its target context (single-user, self-hosted instar agent) and makes sensible choices for MVP. However, several assumptions baked into the design will cause pain if the deployment model ever changes — particularly multi-user dashboard access, high-frequency paste workflows, or integration into a shared instar hosting environment. The conditions are lightweight and the core design is sound.

---

## Critical Issues

### 1. File System as Message Queue — No Backpressure, No Delivery Guarantees (Hits at ~100 pastes/hour sustained)

The delivery mechanism (Option A, correctly chosen as default) writes paste files to `.instar/paste/` and relies on the target session to poll or react to a notification. This is a file-based message queue pattern. It works fine at low volume but has known failure modes:

- **No atomic delivery guarantee**: Writing the file and sending the notification are two separate operations. If the server crashes between them, the file exists but no notification fires. The session-start hook recovers this, but only on the NEXT session start — which could be hours later. For a user who just pasted critical debug output and is watching the agent, this silent gap is a bad experience.
- **No backpressure**: The endpoint accepts pastes as fast as the client can send them. At sustained high volume (unlikely for a solo agent, but plausible in automation scenarios), the `.instar/paste/` directory fills unboundedly until the 7-day TTL cleanup runs. No rate limiting, no size cap on total accumulated paste storage.
- **No delivery confirmation loop**: `delivered: true` in the file header is set by the server at write time (presumably), not by the session confirming it read the content. The delivery status in the history panel would be misleading — it reflects "write succeeded," not "agent processed."

**Scale this hits**: ~100 pastes/hour sustained is enough to create observability noise. A buggy automation script could fill a disk.

### 2. Paste Storage Grows Without Bound Between Cleanups (Hits at ~1GB with large pastes)

The spec allows pastes ">1MB" and says to "warn but allow." The 7-day TTL cleanup is the only size control. Consider:

- A user pastes a 5MB log file daily: 7 days × 5MB = 35MB. Fine.
- A CI pipeline pastes 10MB build logs on every run (24/day): 7 days × 24 × 10MB = 1.68GB. Not fine.
- The spec mentions `.instar/paste/` is excluded from git-sync, but local disk still fills.

There is no per-paste size limit enforcement beyond the UI warning, no total directory size cap, and no cleanup that runs more frequently than implicitly "on next server start" or "on schedule."

**Scale this hits**: Automated paste workflows at moderate frequency. Single large-file abuse case.

### 3. `pending-pastes.json` Is a Write Contention Point (Hits at concurrent pastes)

The spec notes "concurrent pastes get unique filenames — no conflicts." That's true for the files. But `pending-pastes.json` is a single shared state file that tracks all undelivered pastes. Concurrent `POST /dashboard/paste` requests will race on read-modify-write to this file. Node.js is single-threaded so this is safe within a single process, but:

- If the server ever runs with clustering or workers, this becomes a real race condition.
- Even in single-process Node: if the server restarts mid-write, you get a truncated JSON file and lose the pending paste index. The paste files still exist, but the recovery mechanism (session-start hook) depends on this index.

**Scale this hits**: Low (single-process Node protects you today), but it's a design liability.

### 4. WebSocket Notification on Paste Delivery — No Connection State Tracking

The spec mentions "WebSocket notification when paste is delivered" as a dashboard feature. This assumes:

- The dashboard is open and connected when the paste is sent
- The WebSocket connection maps to the right session context

At single-user scale this is fine. But the spec doesn't address:

- What if the dashboard is open on two devices simultaneously (phone + desktop)? Do both get the notification?
- What if the WebSocket drops and reconnects? Does it replay missed delivery events?
- The server needs to maintain a registry of active WebSocket connections per session, which adds statefulness to what is currently a stateless HTTP server model.

The spec describes the WebSocket notification as if it's already implemented infrastructure — but this is a new capability that needs its own design.

---

## Recommendations

### R1: Add a Size Cap and Rate Limit to the API Endpoint

```
POST /dashboard/paste limits:
- Max content size: 10MB per paste (hard reject above, warn above 1MB)
- Max paste frequency: 10 per minute per auth token (429 response)
- Max total `.instar/paste/` directory size: configurable, default 500MB
```

The rate limit protects against automation accidents. The directory size cap protects against disk exhaustion. Both are one-time additions that save real pain later.

### R2: Add a Pending Paste Recovery Scan (Independent of `pending-pastes.json`)

The session-start hook should scan `.instar/paste/` for files where `delivered: false` in the header, not just check `pending-pastes.json`. This makes the `.instar/paste/` directory the authoritative source of truth and makes the JSON index a performance optimization rather than a correctness requirement. If the JSON is corrupted, recovery still works.

### R3: Differentiate "Written" from "Delivered" in Paste Status

In the paste file header and API response, use three states:
- `written` — file exists on disk
- `notified` — notification sent to session
- `acknowledged` — session confirmed receipt (via a `POST /dashboard/paste/:id/ack` from the session)

This is especially important for the history panel's delivery status display. Showing "delivered" when you mean "written" will confuse users debugging stuck pastes.

### R4: Implement a Cleanup Job with Configurable TTL and Size Policies

Don't rely on ad-hoc cleanup. A scheduled job (or server-startup scan) should:
1. Delete pastes older than TTL (7 days default, configurable)
2. If total directory size exceeds cap, delete oldest delivered pastes first
3. Log cleanup actions to a lightweight audit trail

### R5: Define WebSocket Connection Multiplexing Behavior

Before implementing the WebSocket delivery notification, explicitly define:
- Connection identity: how do you know which WS connection belongs to which user/session?
- Multi-device: should all connected dashboard instances receive the notification?
- Reconnection: does the server buffer recent events for a reconnecting client? For how long?

These decisions are architectural — making them explicit now prevents a silent redesign when the first multi-device user hits a bug.

---

## Observations (Fine Now, Watch Later)

### O1: The Truncation Detection Heuristics Live in the Wrong Layer

Placing truncation detection in the Telegram ingestion path (server-side middleware) is correct. Placing it in a PreToolUse hook or session-start hook is not — those fire in the agent session context, not the message ingestion path, and would only fire after the message is already being processed. The server-side metadata annotation approach described at the end of the spec section is the right pattern. This is an implementation detail but worth flagging so it doesn't get built the wrong way.

### O2: The History Panel Needs a Retention Policy of Its Own

The history panel in the dashboard shows recent pastes. If `pending-pastes.json` grows without pruning (especially if delivered entries are never removed), the panel will eventually be slow to render and bloated. A simple "keep last 100 entries" cap on the display query would suffice.

### O3: `.instar/paste/` in `.gitignore` Is Correct But Needs Enforcement

The spec correctly notes paste files should not be synced via git-sync. But "add to gitignore" is easy to forget. The implementation should add this to gitignore programmatically when the paste directory is first created, not rely on documentation.

### O4: The "No Active Session" Queue Expiry Is 24h in Queue, 7d on Disk — Inconsistent

The spec says queued pastes "expire after 24h if unclaimed" but files are cleaned up after "7 days." These two numbers are in different systems (the JSON queue vs. the file TTL). A paste that expires from the queue at 24h but whose file persists for 7 days is an orphaned file with no delivery mechanism. Align these: either use one TTL for both, or explicitly define what "expired from queue but file persists" means for recovery.

### O5: Binary/Non-UTF8 Detection Should Happen Server-Side, Not Just Client-Side

The spec says "Dashboard can detect non-UTF8." But the API endpoint should also validate and reject (or sanitize) binary content server-side — a curl call directly to `/dashboard/paste` bypasses the client-side check entirely.

---

## Research Findings

### File-Based Message Queue Patterns

File-based queues (write file → notify consumer → consumer reads) are a well-established pattern for low-to-medium throughput, single-machine scenarios. Their scaling characteristics:

- **Strengths**: Zero dependencies, survives process restarts, natural audit trail, handles large payloads without in-memory pressure.
- **Weaknesses**: No built-in backpressure, no atomic multi-operation transactions, filesystem metadata (inode tables, directory entry lists) degrades at very high file counts, and polling for "new files" is expensive compared to proper queue push notification.
- **The inode problem**: At ~10,000+ files in a single directory, `ls` and directory scans become noticeably slow. For a paste directory with 7-day retention, this requires ~1,400 pastes/day to hit. Unlikely for a personal agent, but automation scenarios could reach it.
- **Recovery pattern**: The canonical solution is to treat the file system as the authoritative log and maintain a separate index (like `pending-pastes.json`) as a performance cache — with the index being rebuildable from the files. The spec uses this pattern but doesn't make the rebuild path explicit.

### WebSocket Scaling

From research on WebSocket scaling patterns:

- A single Node.js server can handle 10,000–50,000 concurrent WebSocket connections depending on message frequency and payload size (memory is the primary constraint at ~10KB per connection overhead).
- For a single-user personal agent dashboard, WebSocket scaling is not a concern — the constraint is effectively "1 connection per device the user has open."
- The real WebSocket challenge at this scale is **statefulness**: WebSocket connections are inherently stateful and require sticky routing if you ever run multiple server instances. For instar's single-process model, this is not a concern today.
- **The real risk**: WebSocket connection leaks. If connections are not properly cleaned up when the dashboard tab is closed, the server accumulates dead connections. At single-user scale this is a memory leak of tens of KB — annoying but not catastrophic.

### Pastebin-Style Services at Scale

Pastebin-style services at public internet scale (millions of pastes/day) use object storage (S3/GCS) with database metadata and CDN caching. The lessons applicable to this spec:

- **File system is fine at personal scale**: Up to ~100K pastes total, local filesystem storage is performant and operationally simple.
- **The metadata problem**: At scale, the bottleneck is not storage — it's the metadata queries ("give me all undelivered pastes for session X"). File headers require reading each file to query; a database or index makes this O(1). The `pending-pastes.json` index is the right instinct; make it queryable and rebuildable.
- **Size distribution matters**: Most pastes are small (< 10KB) but a few are large. Design for the common case (fast small writes) without being broken by outliers (1MB+ files).
- **Cleanup is operationally underestimated**: Every pastebin system ever built has had cleanup bugs. The files accumulate faster than expected. Build the cleanup job first, not last.

---

## Scalability Assessment

### MVP Phase (1 user, 1 agent, <100 pastes/week)

**Rating: Excellent.** The design is well-matched to this context. File-based delivery is reliable, simple, and auditable. The queue behavior handles the "no active session" case gracefully. WebSocket notification is a nice UX touch. No scaling concerns at this volume.

**Watch**: The `pending-pastes.json` race condition is theoretically present but practically irrelevant at 1 user.

### Growth Phase (1 user, multiple agents, automated paste workflows, ~1,000 pastes/week)

**Rating: Good with caveats.** Automated workflows start to expose the lack of rate limiting and the blurry "written vs. delivered" status. The paste directory can accumulate meaningful storage if large files are common. The session-start hook for pending paste recovery gets exercised more frequently and its reliability becomes more important.

**Action needed**: Rate limiting, size caps, and the cleanup job should be in place before automated workflows are common.

### Scale Phase (Multi-user instar hosting, shared infrastructure, ~10,000 pastes/week)

**Rating: Requires redesign.** At multi-user or hosted scale:
- The file-based queue needs to move to a proper queue (SQLite table, Redis, or equivalent)
- `pending-pastes.json` becomes a per-user or per-agent index, not a global file
- WebSocket connections need connection identity tied to user/agent context
- Rate limiting becomes essential for abuse prevention

This is not a v1 concern but the architecture should not actively prevent this evolution. The spec's current design does not prevent it — the API contract is clean enough to swap the delivery backend.

### Viral Spike Phase (Not applicable)

This feature is behind auth (dashboard PIN + bearer token) and is not publicly accessible. Viral spikes are not a realistic scenario. A runaway automation script is the closest analog — rate limiting handles this.

---

## Score

**7 / 10**

**Justification**: The spec makes the right core choices: file-based delivery over stdin injection, Option A over Option B, auth-gated access, local-only storage. The UX flow is clear and the truncation detection heuristics are clever. The design is appropriately scoped for a personal agent tool.

Points lost:
- (-1) No rate limiting or total storage cap — an obvious defensive measure not included
- (-1) "Written" vs. "delivered" conflation in status reporting — will cause real confusion
- (-0.5) `pending-pastes.json` as sole recovery mechanism without a file-scan fallback
- (-0.5) WebSocket notification design is underspecified given its statefulness requirements

The score would be 9/10 with R1 (rate limiting + size cap) and R3 (status differentiation) addressed before implementation. These are small additions, not redesigns.
