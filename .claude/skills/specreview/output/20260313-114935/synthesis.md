# SpecReview Synthesis: Dashboard Quick Paste

**Review ID**: 20260313-114935
**Date**: 2026-03-13
**Round**: 1
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX/API, Marketing
**Spec**: `specs/dashboard-quick-paste.md`

---

## Overall Assessment

**Status**: NEEDS WORK

**Average Score**: 6.56 / 10
**Score Range**: 5.0 — 8.5

| Reviewer | Status | Score | Key Finding |
|----------|--------|-------|-------------|
| Security | CONDITIONAL | 5.5/10 | Paste endpoint is an agent instruction injection surface, not just a file delivery pipe — CRITICAL unmitigated risk |
| Scalability | CONDITIONAL | 7.0/10 | File-based queue is sound for MVP; missing rate limits and delivery status disambiguation |
| Business | APPROVE | 8.5/10 | Well-scoped fix for a real pain point; fits architecture cleanly; truncation detection is clever |
| Architecture | CONDITIONAL | 7.5/10 | Core design proven; delivery notification plumbing and session selection logic underspecified |
| Privacy | CONDITIONAL | 6.5/10 | No content sensitivity warning, no deletion control, no disclosure at paste time |
| Adversarial | CONDITIONAL | 5.0/10 | Indirect prompt injection is unaddressed — the defining vulnerability of this feature |
| DX / API | CONDITIONAL | 7.5/10 | Endpoint name violates REST conventions; missing paste ID in response; no error response schema |
| Marketing | CONDITIONAL | 6.5/10 | "Quick Paste" undersells the capability; truncation detection is the most shareable element |

---

## Consensus Findings

*Issues that 3+ reviewers independently identified:*

### 1. Prompt/Instruction Injection — Paste Content Enters Agent Context as Trusted Input
**Identified by**: Security, Adversarial, Architecture (implied via provenance tagging requirement)

All three reviewers independently converged on the same fundamental threat: paste content delivered to a Claude Code session running `--dangerously-skip-permissions` with full machine access is not "data" — it is effectively an untrusted instruction stream entering a trusted execution context. The spec treats this as a content delivery problem. It is an execution context injection problem.

- **Security** classifies it CRITICAL: "The spec treats this as a content delivery problem (getting bytes from A to B). It is actually an execution context injection problem."
- **Adversarial** rates it P0, CRITICAL likelihood/impact: "Attack success rates reach 84% in agentic systems. The spec has zero mitigations."
- **Architecture** requires provenance tagging: "Dashboard pastes [should] participate in the same security model as Telegram messages" via InputGuard.

**Recommended action**: Wrap paste content in an explicit delimiter (`<user-paste id="..." label="...">...</user-paste>`) and add a system-prompt-level instruction that treats content within that delimiter as data, not instructions. Route the notification through the existing `SessionManager.injectMessage()` path so InputGuard provenance checks apply. Document that this defense is probabilistic, not cryptographic.

---

### 2. No Rate Limiting or Server-Side Size Cap
**Identified by**: Security, Scalability, Adversarial

All three reviewers flagged the absence of any server-side enforcement on paste volume and size. The spec says ">1MB: warn but allow" — this is client-side guidance with no backend enforcement.

- **Security**: "An attacker with a valid token can POST a 500MB paste body" — DoS and memory exhaustion.
- **Scalability**: "A CI pipeline pastes 10MB build logs 24x/day: 7 days × 24 × 10MB = 1.68GB."
- **Adversarial**: "A script POSTs in a tight loop. A 1MB paste × 1,000 calls = 1GB disk consumed in seconds."

**Recommended action**: Hard cap at 10MB per paste (configurable). Rate limit at 10 pastes/minute per authenticated session (429 response). Total `.instar/paste/` directory size cap (default 500MB) with cleanup enforcement. Pending paste queue cap (10 items max) to prevent context flooding on session start.

---

### 3. Label Field Used in Filename Construction — Path Traversal Risk
**Identified by**: Security, Adversarial

Both security-focused reviewers independently identified that deriving filenames from the user-supplied `label` field is a textbook CWE-22 (Path Traversal) vulnerability.

- **Security**: "`../../config/auth` → writes to `.instar/config/auth.txt`"
- **Adversarial**: "`../../../etc/cron.d/backdoor`" could result in arbitrary code execution.

**Recommended action**: Labels must never appear in filenames. Generate filenames using `timestamp + UUID` only. Store the label in the file's YAML frontmatter exclusively. Canonicalize and validate the final path is within `.instar/paste/` before writing (resolve symlinks, check prefix).

---

### 4. `.instar/paste/` Gitignore Must Be Enforced, Not Documented
**Identified by**: Security, Scalability, Business, Privacy (4 reviewers)

All four reviewers noting this issue independently treated the gitignore requirement as a spec weakness: it is stated as a recommendation but not as an enforcement mechanism. Paste files may contain secrets, PII, and production credentials.

**Recommended action**: The implementation must verify `.gitignore` contains `.instar/paste/` at startup, add it automatically if missing, and fail loudly if paste files are detected in a staged git commit.

---

### 5. "Delivered" Status Is Misleading — "Written" vs. "Notified" vs. "Acknowledged"
**Identified by**: Scalability, Architecture, DX/API

Three reviewers independently flagged that the spec conflates file write success with delivery confirmation.

- **Scalability**: "`delivered: true` in the file header is set by the server at write time, not by the session confirming it read the content."
- **Architecture**: "The `delivered: true` response field only makes sense if [the inject] step is synchronous and confirmed."
- **DX**: "The client can't poll for delivery status on a specific paste if the WebSocket drops" because there is no `pasteId` to reference.

**Recommended action**: Use three states: `written` (file exists), `notified` (notification sent to session via `injectMessage()`), `acknowledged` (session confirmed receipt). Return a `pasteId` in every success response. Emit a `paste_delivered` WebSocket event with the `pasteId` when notification completes.

---

### 6. `pending-pastes.json` Is Underspecified and a Single Point of Failure
**Identified by**: Scalability, Architecture, Adversarial

The pending paste queue mechanism is mentioned but its schema, delivery mechanism, recovery path, and race conditions are not defined.

- **Scalability**: "If the server restarts mid-write, you get a truncated JSON file and lose the pending paste index."
- **Architecture**: "What is the schema of `pending-pastes.json`? A list of file paths? A structured queue? Does the hook write to stdout or call `injectMessage`?"
- **Adversarial**: Poisoning the pending queue creates a persistent injection foothold that fires on the *next* session, potentially days later in a different task context.

**Recommended action**: Define the `pending-pastes.json` schema explicitly. The session-start hook should scan `.instar/paste/` for `delivered: false` files as the authoritative recovery path, treating `pending-pastes.json` as a performance cache (rebuildable, not authoritative). Committed pending pastes require user acknowledgment before injection, not silent auto-injection.

---

### 7. 24h vs 7d TTL Inconsistency
**Identified by**: Scalability, Architecture, Adversarial, Privacy (4 reviewers)

The spec creates two TTL systems: queued pastes expire from the queue at 24h, but paste files persist on disk for 7 days. A paste that expires from the queue has no delivery mechanism, but its file lives as an orphan for the remainder of 7 days.

**Recommended action**: Either unify to a single TTL or explicitly define what "expired from queue but file persists" means. Consider: 24h TTL for all delivered pastes (shorter retention for already-acted-on content), 7d TTL for undelivered/queued pastes (longer retention to allow recovery). The distinction should be surfaced in the UI.

---

## Critical Issues (Blockers)

No reviewer issued an outright BLOCK, but the following issues are flagged as CRITICAL or P0 by multiple reviewers and must be resolved before implementation:

| # | Issue | Reviewer(s) | Severity | Suggested Fix |
|---|-------|-------------|----------|---------------|
| 1 | Indirect prompt injection — paste content enters LLM context as trusted input with no framing | Security (CRITICAL), Adversarial (P0) | CRITICAL | Wrap content in `<user-paste>` delimiters; add system prompt instruction; route through InputGuard provenance checks |
| 2 | Label field in filename construction enables path traversal (CWE-22) | Security (HIGH), Adversarial (P1) | HIGH | Use `timestamp + UUID` for filenames only; store label in frontmatter; canonicalize and validate path prefix |
| 3 | No server-side size cap or rate limiting | Security (HIGH), Scalability (Critical), Adversarial (P1) | HIGH | 10MB hard cap, 10 req/min rate limit, 500MB directory cap, 10-item pending queue cap |
| 4 | Delivery notification mechanism to active session is unspecified | Architecture (Critical Issue #1) | HIGH | Spec must commit to `SessionManager.injectMessage()` call from the POST route handler |
| 5 | Session selection "most recent" is undefined; job sessions not excluded | Architecture (Critical Issue #2) | MEDIUM | Define priority order explicitly; exclude sessions with `jobSlug` from default target |

---

## Conflicts

### Conflict 1: Size Limit Treatment — "Warn But Allow" vs. Hard Cap

- **Business** says: The ">1MB: warn but allow" threshold "deserves scrutiny" but does not call for a hard cap. Suggests surfacing a token count estimate so users self-regulate.
- **Architecture** says: "The warning is cosmetic." There is no actual tmux buffer concern in the file-drop design. A hard cap at 50MB is worth adding to prevent accidents, but v1 can proceed with the warning.
- **Security, Scalability, Adversarial** all say: Hard cap required. No server-side cap is a DoS vector.

**Tension**: Business and Architecture treat large paste size as a UX concern. Security, Scalability, and Adversarial treat it as an operational security concern.

**Resolution**: Security wins. A hard server-side cap (10MB, configurable) is required — the disagreement is about what the cap should be, not whether one is needed. Business's token count display recommendation is additive and compatible with enforcing a cap.

---

### Conflict 2: Paste Content Preview in Notification Message

- **DX/API** recommends embedding a short preview (first 200 chars) in the notification message so simple pastes don't require a round-trip file read.
- **Adversarial** says explicitly: "Do NOT change [the notification] to inline the paste content. The one-level-of-indirection is a meaningful architectural choice. Preserve it."
- **Security** concurs: the file-reference-only notification is safer than inlining content.

**Tension**: DX values reduced latency; Security and Adversarial value content isolation.

**Resolution**: Adversarial and Security have the stronger argument. The file-reference-only notification must be preserved. The DX concern (round-trip file read) is real but minor in an async agent workflow. If the agent is processing a short paste, the file read is one tool call — an acceptable tradeoff for the isolation property.

---

### Conflict 3: Endpoint Naming — `/dashboard/paste` vs. `/pastes`

- **DX/API** (Critical Issue #1): `POST /dashboard/paste` violates REST conventions and should be `POST /pastes`.
- **No other reviewer** raised this issue.

**Tension**: This is uncontested — no reviewer defended `/dashboard/paste`. However, it is a DX concern, not a correctness issue.

**Resolution**: Rename to `POST /pastes` with `GET /pastes`, `GET /pastes/:id`, `DELETE /pastes/:id` as natural extensions. This is low effort, high long-term payoff. No architectural conflict.

---

### Conflict 4: Truncation Detection Placement — Hook vs. Server Middleware

- **Architecture** resolves this explicitly: "server-side Telegram middleware only." Hooks fire inside Claude Code sessions, not in the Telegram ingestion path.
- **Scalability** agrees: "Placing truncation detection in a PreToolUse hook or session-start hook is not [correct]."
- **The spec** wavers between both options.

**Tension**: The spec is internally inconsistent on this point; reviewers agree on the correct answer.

**Resolution**: Server-side Telegram message ingestion middleware only. This is settled — update the spec to remove the hook option.

---

## Recommendations (Prioritized)

| Priority | Recommendation | Source Reviewers | Effort | Impact |
|----------|---------------|-----------------|--------|--------|
| P0 | Add prompt injection framing: wrap paste content in `<user-paste>` delimiters, add system prompt instruction treating content as data not instructions, route notification through `SessionManager.injectMessage()` / InputGuard | Security, Adversarial, Architecture | Medium | Critical |
| P0 | Sanitize label field — use `timestamp + UUID` for filenames only, store label in frontmatter, canonicalize path to verify it stays within `.instar/paste/` | Security, Adversarial | Low | Critical |
| P1 | Add server-side hard cap (10MB/paste, configurable), rate limiting (10/min per token), directory size cap (500MB), pending queue cap (10 items) | Security, Scalability, Adversarial | Low | High |
| P1 | Define and commit to delivery notification mechanism: `SessionManager.injectMessage()` from POST route handler, synchronous, confirmed before response | Architecture | Low | High |
| P1 | Add `pasteId` to API response; define three delivery states (`written`, `notified`, `acknowledged`); emit `paste_delivered` WebSocket event with `pasteId` | Architecture, DX/API, Scalability | Low | High |
| P1 | Define `pending-pastes.json` schema; make `.instar/paste/` directory scan the authoritative recovery path; require user acknowledgment before pending paste injection | Architecture, Scalability, Adversarial | Medium | High |
| P1 | Enforce `.gitignore` programmatically — check/add `.instar/paste/` at startup, fail on staged paste files | Security, Scalability, Business, Privacy | Low | High |
| P1 | Commit truncation detection to server-side Telegram middleware only — remove hook option from spec | Architecture, Scalability | Low | Medium |
| P1 | Rename endpoint to `POST /pastes`; define standard error response shape (`ok`, `error`, `message`) | DX/API | Low | Medium |
| P1 | Resolve 24h vs. 7d TTL inconsistency; define behavior for orphaned (queue-expired, file-persisted) pastes | Scalability, Architecture, Adversarial, Privacy | Low | Medium |
| P2 | Add PIN lockout after N failed attempts (5 recommended); ensure API path always requires Bearer token, never PIN alone | Security, Adversarial | Low | High |
| P2 | Add content sensitivity warning at paste time ("This content is stored locally for 7 days. Avoid pasting secrets."); add disclosure beneath Send button | Privacy | Low | Medium |
| P2 | Add individual paste deletion from history panel; show TTL remaining; redact content from history (metadata only) | Privacy, Architecture, Adversarial | Low | Medium |
| P2 | Add `pasteRetentionDays` to config (default: 7, range: 1–30); consider "delete after delivery" opt-in | Privacy | Low | Low |
| P2 | Add session health indicator to session picker (idle / working / stalled) | DX/API | Low | Medium |
| P2 | Auto-focus textarea when Paste tab activated; show character count + estimated token count | DX/API, Business | Low | Low |
| P3 | Add audit log for paste submissions (timestamp, label, content hash, length, submitting session, target session) | Adversarial | Low | Medium |
| P3 | Define `from` field as enum: `dashboard | telegram-relay | api | cli` | Architecture | Low | Low |
| P3 | Add `paste_delivered` WebSocket event type to existing WebSocket protocol; define connection multiplexing behavior for multi-device | Architecture, Scalability | Medium | Medium |
| P3 | Consider feature renaming — see Name Analysis section | Marketing | Low | Low |
| P3 | Run lightweight injection pattern detection before writing paste file; flag suspicious pastes in notification | Adversarial | Medium | Medium |
| P3 | Add file permissions hardening: create `.instar/paste/` files with `0600` (owner read/write only) | Privacy | Low | Low |
| P3 | Add `expiresAt` to API response; surface "No active session — held for 24h, then deleted if unclaimed" in UI | DX/API, Privacy | Low | Low |

---

## Scalability Summary

| Phase | Assessment | Key Risks | Reviewers Agree? |
|-------|-----------|-----------|-----------------|
| **MVP** (single user, single agent, <100 pastes/week) | Excellent — design is well-matched to this context; file-based delivery is reliable and appropriately scoped | Silent delivery gap if server crashes between file write and notification; `pending-pastes.json` correctness depends on atomic writes | Yes — all reviewers agree MVP is fine with critical fixes applied |
| **Growth** (1 user, multiple agents, automated workflows, ~1,000 pastes/week) | Good with caveats — automated workflows expose rate limiting gap and "written vs. delivered" confusion | Disk accumulation if large files are common; `pending-pastes.json` write contention if clustering ever used; history panel becomes bloated | Partial — Security and Adversarial more concerned than Scalability and Business |
| **Scale** (multi-user hosting, shared infrastructure, ~10,000 pastes/week) | Requires redesign — file-based queue must move to SQLite or proper queue; per-user indexing needed; WebSocket needs user/agent identity | Shared PIN means paste history visible to all users; no per-user audit trail; directory size control becomes critical | Yes — all reviewers flag this explicitly; current design not intended for multi-user |
| **Viral spike** | Not applicable — feature is auth-gated and not publicly accessible. Closest analog is runaway automation script | Rate limiting (P1 fix) handles the automation accident case | Yes |

---

## Gaps

*Areas no reviewer adequately covered, or where the spec itself is silent:*

1. **Accessibility**: No reviewer addressed keyboard navigation, screen reader compatibility, or WCAG compliance for the new dashboard tab. For a feature designed to be used on mobile via tunnel, this could matter.

2. **Internationalization / Unicode handling**: Only the Adversarial reviewer touched on Unicode (bidirectional control characters in labels as a social engineering vector). Neither the spec nor any other reviewer addressed multi-byte character handling for the character count display, which counts UTF-16 code units (Telegram's limit unit) differently from bytes or UTF-8 characters. A 1MB paste of CJK characters is ~500K characters but ~1M bytes.

3. **Agent-initiated paste consumption**: The spec defines how users send content to agents, but no reviewer examined what happens after the agent reads the paste file. Does the agent mark it acknowledged? Is there a mechanism for the agent to request additional pastes? The acknowledged state (P1 recommendation) partially addresses this but the agent-side protocol is not specified.

4. **Session migration**: What happens if the user switches to a different session after queuing a paste? Does the queued paste follow the user's active session, or is it locked to the session selected at paste time? Not addressed by spec or any reviewer.

5. **WhatsApp / other channel parity**: The Business reviewer notes the solution is channel-agnostic, but no reviewer examined whether truncation detection should be implemented for WhatsApp or other channels that Instar supports. If the Telegram path gets truncation detection and WhatsApp does not, there is a feature parity debt.

6. **Error recovery for failed injection**: If `SessionManager.injectMessage()` fails (session crashed mid-injection), what is the recovery path? The notification is lost. The file still exists. Does it go back to pending? No reviewer or the spec addresses this edge case.

---

## Name Analysis

**Current name**: Quick Paste
**Assessment**: 5/10 as a product name. Immediately understood but generic and action-anchored (clipboard metaphor) rather than outcome-anchored (agent communication). "Quick" is one of the most overused qualifiers in software. Does not hint at queuing, history, or intelligent detection capabilities. Competes with Pastebin/clipboard mental models rather than establishing Instar's agent-first positioning. Scales poorly: "paste" becomes inaccurate when file upload and image submission are added.

**Alternatives suggested**:

| Name | Concept | Pros | Cons |
|------|---------|------|------|
| **Drop Zone** | Spatial delivery metaphor | Intuitive, memorable, scales to file upload | Overused in file upload UIs; "drop" implies drag-and-drop |
| **Agent Inbox** | Two-way communication framing | Universally understood; elevates dashboard from monitoring to control | "Inbox" implies receiving, not sending; email connotation |
| **Context Feed** | Content-as-agent-context framing | Developer-resonant; scales to images, files, logs | "Feed" has social media connotations |
| **Relay** | Echoes Threadline naming conventions | Coherent with existing Instar naming; action-oriented; scalable | May conflict with Threadline Relay concept |

**Marketing recommendation**: The truncation detection behavior — agent notices user struggling with Telegram limits and proactively suggests the dashboard — is the most shareable, differentiated moment. The feature name should hint at intelligence, not clipboard operations. "Drop Zone" works for the UI tab; a broader "Context Drop" or "Relay" works for marketing copy. The launch narrative should foreground the truncation detection story over the paste mechanism.

---

## Convergence Status

| Metric | Value |
|--------|-------|
| Reviewers issuing APPROVE | 1 / 8 (Business only) |
| Conditional approvals | 7 / 8 |
| Blockers (BLOCK status) | 0 / 8 |
| Open conflicts | 4 |
| Resolved conflicts | 3 (truncation placement, preview-in-notification, endpoint naming) |

**Convergence**: CONVERGING

All 8 reviewers agree the underlying feature concept is sound and the file-based delivery approach is the right architectural choice. The Business reviewer is the only outright APPROVE because the other reviewers are closer to the security and implementation surface where unresolved issues live. The lowest scores (Security: 5.5, Adversarial: 5.0) reflect the severity of the unaddressed prompt injection issue — a gap that security reviewers treat as a prerequisite while Business and DX reviewers treat as an implementation detail.

The panel will converge to APPROVE once the P0 and P1 items above are addressed. No reviewer wants to kill the feature — all seven CONDITIONAL votes describe fixable issues.

---

## Next Steps

- [ ] Address P0 issues: prompt injection framing and label/filename sanitization — these are prerequisites for implementation
- [ ] Address P1 issues before coding begins: delivery notification mechanism, pasteId in response, rate limiting, gitignore enforcement, TTL alignment, pending paste schema, endpoint renaming, error response shape
- [ ] Resolve 4 open conflicts (size limit hard cap, preview-in-notification [resolved: keep file-ref only], endpoint naming [resolved: rename], truncation placement [resolved: server-side only])
- [ ] Consider name change — Marketing recommendation is non-blocking but worth addressing in spec revision
- [ ] Re-run review for affected areas: `/specreview specs/dashboard-quick-paste.md --round 2 --reviewers security,adversarial,architecture` after P0/P1 fixes
- [ ] Pre-implementation checklist from Architecture reviewer (8 items) should be added to the spec as a gating requirement

---

*Generated by SpecReview multi-agent synthesis | Round 1 | 20260313-114935*
