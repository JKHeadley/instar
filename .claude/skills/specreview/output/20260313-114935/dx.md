# DX & API Design Review — Dashboard Quick Paste
**Review ID**: 20260313-114935
**Round**: 1
**Reviewer Role**: Developer Experience & API Design Specialist
**Date**: 2026-03-13
**Spec**: `/Users/justin/.instar/agents/echo/specs/dashboard-quick-paste.md`

---

## Approval Status

**CONDITIONAL**

The spec describes a well-conceived feature that solves a real problem elegantly. The file-based delivery approach is sound, the UX flow is clear, and the truncation detection heuristics are genuinely clever. However, there are a handful of DX and API design issues that should be addressed before implementation — primarily around endpoint naming, error response structure, queuing UX clarity, and the absence of a retry/recovery path. None are blockers on their own, but together they represent polish gaps that will matter in day-to-day use.

---

## Critical Issues

### 1. Endpoint Name Violates REST Conventions
`POST /dashboard/paste` uses a verb as the resource name and embeds the UI context (`dashboard`) in the API path. REST best practice is to use plural nouns to identify resource collections and let HTTP verbs express the action.

**Recommended**: `POST /pastes`

This is cleaner, makes the resource addressable (e.g., `GET /pastes` for history, `GET /pastes/:id` for a single paste), and doesn't couple the API to a specific UI surface. If the dashboard is the only consumer today, that's fine — but the API should not know that. The `/dashboard/` prefix also implies it's a UI-only route, which could cause implementors to gate it behind a dashboard middleware rather than the standard auth layer.

### 2. Response Does Not Include a Paste ID
The success response is:
```json
{ "ok": true, "delivered": true, "sessionName": "topic-605", "contentLength": 4832 }
```

There is no `pasteId` or `pasteRef` in the response. This means:
- The dashboard history panel can't link to the specific paste
- The client can't poll for delivery status on a specific paste if the WebSocket drops
- There's no way to reference or retrieve a paste programmatically after creation

Every resource creation endpoint should return an identifier. Minimum addition: `"pasteId": "1710345600-abc123"`.

### 3. No Error Response Structure Defined
The spec defines the happy path response but says nothing about error responses. What does the client receive if:
- Content exceeds a server-enforced size limit?
- The target session doesn't exist?
- The auth token is invalid or expired?
- The `.instar/paste/` directory is not writable?

Without a defined error shape, implementors will ad-hoc it and the dashboard will have inconsistent error display. At minimum, define:
```json
{ "ok": false, "error": "session_not_found", "message": "No session matching 'topic-999'" }
```

Machine-readable `error` codes + human-readable `message` is the standard. Pastebin's text-only errors ("Bad API request, api_paste_code was empty") are a cautionary tale — they're clear to humans but painful to parse programmatically.

### 4. "Content Will Be Queued" UX Is Underspecified
When no active session exists, the dashboard shows "No active session — content will be queued." This surfaces a queue concept to the user without explaining:
- How long will it wait?
- What triggers delivery?
- Can they see/cancel queued pastes?
- What if a new session starts but is for a different topic?

The spec mentions a 24h expiry and session-start hook injection, but the UI surfaces none of this. A user who pastes something and sees "queued" has no idea whether to wait 5 seconds or 24 hours. The confirmation message needs to set expectations: "Saved — will be delivered when a session starts (expires in 24h)."

---

## Recommendations

### R1: Rename the Endpoint to `/pastes` (Resource-Oriented)
Use `POST /pastes` for creation. This unlocks natural REST expansion:
- `GET /pastes` — paste history (backing the history panel)
- `GET /pastes/:id` — retrieve a specific paste
- `DELETE /pastes/:id` — cancel a queued paste

This is a small change with significant long-term DX payoff. The current `/dashboard/paste` name will cause confusion the first time someone tries to use the API from a script or integration.

### R2: Add `pasteId` to the Success Response
Return the filesystem filename (or a derived ID) so clients can reference the paste:
```json
{
  "ok": true,
  "pasteId": "1710345600-error-log-abc123",
  "delivered": true,
  "sessionName": "topic-605",
  "contentLength": 4832,
  "expiresAt": "2026-03-20T18:30:00Z"
}
```
Including `expiresAt` in the response is especially useful when `delivered: false` (queued state) — the UI can display it directly.

### R3: Define a Standard Error Response Shape
Add an "Error Responses" section to the spec:
```json
{
  "ok": false,
  "error": "<machine_readable_code>",
  "message": "<human_readable_description>"
}
```
Define at least: `session_not_found`, `content_too_large`, `storage_unavailable`, `unauthorized`.

### R4: Character Count Should Show Both Count and Estimated Tokens
The spec calls for a live character count. For an AI agent context, token count is more meaningful than character count — users want to know if they're sending something the model will struggle with. Consider showing both: `4,832 chars (~1,200 tokens)`. This is a small addition that directly serves the use case (sending content to an AI agent).

### R5: The Label Field Should Persist (Auto-Suggest)
The optional label field is a good idea, but users will repeatedly paste the same kinds of things (error logs, config files, spec drafts). Storing recent labels in `localStorage` and surfacing them as autocomplete suggestions on the label field dramatically reduces friction on second and subsequent uses. This is a pure front-end enhancement.

### R6: Session Picker Should Show Session Health
The target session dropdown shows "active sessions (default: most recent)" but doesn't indicate session health. A session that's actively processing something is different from one that's idle waiting for input. Consider showing a simple status indicator (idle / working / stalled) alongside session names. Users need to know if their paste will be received and acted on, or will sit waiting.

### R7: Clipboard Paste Shortcut (`Cmd+Shift+V` or Auto-Focus)
The primary use case is literally pasting from clipboard. The textarea should auto-focus when the tab is activated, so the user can open the tab and immediately hit `Cmd+V` with no click required. This is a one-line JS change that cuts 1-2 seconds from the critical path and makes the mobile experience on tunnel access significantly faster.

### R8: The Delivery Notification Message to the Agent Is Underdeveloped
The notification sent to the session is:
> `[paste] User sent 4,832 chars: "error log from prod" — read at .instar/paste/1710345600-error-log.txt`

This works but misses an opportunity. The agent has to read the file path and manually call a Read tool. Consider embedding a short preview (first 200 chars) in the notification message itself, with the full content available at the file path. This means simple pastes (short code snippets that happen to exceed Telegram's limit but are under 200 chars) get delivered inline without the agent needing a round-trip file read.

---

## Observations (Nice-to-Have)

**O1: Paste History Panel Needs an Empty State**
The spec mentions a history panel but doesn't define the empty state (first use). "No pastes yet — paste something above to get started" prevents a blank panel on first use.

**O2: Binary/Non-UTF8 Detection Should Happen Before Submit, Not After**
The spec says "Accept but warn" for non-UTF8 content. The warning should appear before the user hits Send (on paste, not on submit) — otherwise they've already committed the action when they see the warning. A `paste` event listener can check `!isValidUTF8()` and surface the notice immediately.

**O3: The 7-Day Auto-Cleanup TTL is Undocumented in the UI**
Users should be told files expire. Not prominently — a tooltip on the history panel ("Pastes are retained for 7 days") is sufficient. Without this, users might rely on paste history for long-term reference and lose content unexpectedly.

**O4: WebSocket Confirmation Is Listed as a Dashboard Change But Not in the API Section**
"WebSocket notification when paste is delivered" appears only under Dashboard Changes. The API section should reference this: when `delivered: true` arrives asynchronously (e.g., paste was queued, session started, paste was injected), push a WebSocket event. Define the event shape so front-end and back-end teams align.

**O5: Consider a "Send and Watch" Mode**
After sending a paste, if the dashboard has a Sessions tab with terminal streaming, consider a "Send and Watch" button that sends the paste AND switches to the session's terminal view. Users sending large inputs usually want to monitor the response in real time. This is a UI-only enhancement (one extra JS navigation step) but closes the feedback loop elegantly.

**O6: The Truncation Detection Heuristics Are Excellent but Need Suppression Logic**
The spec correctly notes "one nudge per conversation thread." This should be per-topic, not per-session, and the suppression window should be at least 10 messages (not just "last N"). If a user was already told about Quick Paste and chose to split their message anyway, re-suggesting it after 10 messages is mildly annoying. Consider a longer window or a "don't show again for this topic" flag.

---

## Research Findings

### Paste/Text Input UX Best Practices
Research into established patterns reveals several conventions this spec follows well and a few gaps:

**What the spec gets right:**
- Auto-expanding textarea is standard in modern developer tools (GitHub PR description, Linear comments, Notion)
- Optional label/description field matches GitHub Gist's file naming pattern
- Live character count is expected by users who work near limits
- File-based delivery with notification is architecturally similar to how CI systems handle artifact handoff — reliable and auditable

**What comparable tools do that this spec misses:**
- GitHub Gist returns a full resource object on creation (including the gist URL/ID) — this spec's response lacks a `pasteId`
- GitHub Gist uses a `truncated` field in responses to signal partial content delivery — useful pattern the spec could adopt for very large pastes
- Pastebin's text-only error messages are widely cited as a DX anti-pattern — avoid replicating this

### API Design Research
REST naming conventions are unambiguous here: `/dashboard/paste` is an RPC-style verb endpoint. The REST standard is plural noun collections (`/pastes`), with HTTP verbs expressing operations. This isn't pedantry — it matters for discoverability, tooling (OpenAPI generators, SDK builders), and future API consumers who aren't the dashboard.

### Real-Time Delivery Confirmation
WebSocket-based delivery confirmation is the right call. The spec already mentions it. The key pattern to implement: assign a `pasteId` at creation time, and push a `paste.delivered` WebSocket event with that ID when the session reads the file. The dashboard can match by ID and update the history panel in real time. Backpressure is not a concern at this message volume.

### Security Considerations
OWASP guidance on large content submissions is applicable here:
- Random suffixes on filenames (the spec mentions this: "timestamp + random suffix") — good
- Storing files outside the webroot — `.instar/paste/` is local-only, not in webroot — good
- Size limit enforcement — the spec mentions ">1MB warn but allow" but doesn't define a hard server-side cap. Recommend defining one (e.g., 10MB) to prevent storage exhaustion. A misconfigured or malicious client shouldn't be able to fill disk via repeated large pastes.
- The spec correctly excludes `.instar/paste/` from git-sync — critical for privacy

---

## Scalability Assessment

**As the platform grows, DX holds up well in most areas:**

- The file-based delivery mechanism scales to any content size without code changes
- The queue-and-deliver pattern works whether the agent is local or remote
- The truncation detection heuristics are stateless and cheap — they'll scale to high message volumes

**Where DX will degrade with scale:**

- **Multi-agent environments**: The `targetSession` selector will become unwieldy as agents proliferate. When a user has 5+ sessions across 3 agents, "most recent" is no longer a safe default. The session picker will need grouping by agent and better default selection logic.
- **Paste history at volume**: If users paste frequently (daily for months), the history panel will become a long unfiltered list. Need search/filter on the history panel before this becomes a UX burden.
- **Concurrent paste submissions**: The spec handles this via unique filenames (good), but the `pending-pastes.json` state file is a write-contention point if multiple sessions or API clients submit simultaneously. Consider an append-only ledger pattern instead of a single mutable JSON file.
- **Endpoint naming debt**: The `/dashboard/paste` name will accumulate integration debt as more API consumers are added (scripts, other agents, mobile apps). Rename now before it's referenced in 20 places.

---

## Score

**7.5 / 10**

**Justification**: The spec demonstrates strong product thinking — it solves a real, specific problem (Telegram length limits) with a pragmatic, reliable mechanism (file-based delivery). The truncation detection heuristics are the standout design element: proactive, non-intrusive, and well-calibrated. The UX flow is clear and the success criteria are concrete and measurable.

The score is held back by the API design issues (verb endpoint name, missing resource ID in response, undefined error shape) which are table-stakes for a well-specified API, and by the underspecified queuing UX which will cause user confusion in a common real-world scenario. These are fixable in a spec revision without architectural changes.

With the critical issues addressed, this would score 9/10 and be ready to implement.
