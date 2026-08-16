# Synthesis: PR #30 iMessage Adapter

**Date:** 2026-03-31
**Reviewers:** 8 (Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing)

---

## Aggregate Scores

| Reviewer | Score |
|----------|-------|
| Architecture | 8/10 |
| Marketing | 8/10 |
| Scalability | 7/10 |
| DX | 7/10 |
| Security | 6.5/10 |
| Business | 6/10 |
| Privacy | 5/10 |
| Adversarial | 5/10 |
| **Average** | **6.6/10** |
| **Min / Max** | **5 / 8** |

---

## Overall Status: NEEDS WORK

All 8 reviewers gave CONDITIONAL approval. The architecture and marketing fundamentals are strong, but security, privacy, and adversarial resilience have significant gaps that must be addressed before merge.

---

## Consensus Findings (3+ reviewers)

### 1. Startup lookback replays 50 messages on every restart (7 reviewers)
**Flagged by:** Security, Scalability, Business, Architecture, Adversarial, DX, Privacy (implicitly)
`lastRowId` and the dedup set are in-memory only. Every server restart re-processes up to 50 messages, causing duplicate session injections. **Fix:** Persist `lastRowId` to disk (e.g., `.instar/imessage-poll-offset.json`); use 50-message lookback only on first run.

### 2. Session name collision from 6-char truncated suffix (6 reviewers)
**Flagged by:** Security, Scalability, Architecture, Adversarial, DX, Privacy
`im-${sender.slice(-6)}` collides easily (e.g., two phone numbers ending in the same 6 digits). Collision silently misroutes messages between senders. **Fix:** Use a hash of the full sender string (SHA-1 truncated to 8+ chars).

### 3. `/tmp/instar-imessage` temp files are world-readable and never cleaned up (5 reviewers)
**Flagged by:** Security, Scalability, Privacy, Adversarial, DX
Bootstrap and injection temp files contain full conversation history and PII, written with default umask (644), never deleted. On macOS `/tmp` is RAM-backed, so this is also a memory leak. **Fix:** Write with mode `0o600`, delete after consumption, create directory with mode `0o700`.

### 4. Port default mismatch: script says 4040, server runs on 4042 (4 reviewers)
**Flagged by:** Security, Architecture, DX, Scalability (implicitly)
`imessage-reply.sh` defaults to port 4040. Every deployment without explicit `INSTAR_PORT` silently fails outbound logging and stall-clearing. **Fix:** Change default to 4042.

### 5. Reply endpoint does not validate recipient against authorizedSenders (3 reviewers)
**Flagged by:** Security, Adversarial, Privacy
`POST /imessage/reply/:recipient` allows any authenticated caller to log fabricated outbound messages and clear stall tracking for arbitrary senders. **Fix:** Add `isAuthorized(recipient)` guard returning 403.

### 6. Prompt injection via unsanitized message content in bootstrap (3 reviewers)
**Flagged by:** Security, Adversarial, Business (implicitly)
Raw iMessage text is injected verbatim into Claude session bootstrap. Authorized senders can craft messages that override session instructions or inject shell metacharacters. **Fix:** Escape shell metacharacters; wrap history entries in structural delimiters.

### 7. `imsg` CLI is a single-maintainer third-party dependency (3 reviewers)
**Flagged by:** Security, Business, Marketing
Unverified binary from a personal Homebrew tap in the critical send path. No hash check or code signature verification. **Fix:** Pin binary path via config; document verification steps; consider AppleScript native fallback.

---

## Unique Findings (single reviewer)

| Finding | Reviewer | Severity |
|---------|----------|----------|
| Mass ingestion of ALL messages before auth filtering -- data minimization failure. Push sender filter into SQL. | Privacy | HIGH |
| Plaintext PII in JSONL log, never purged, potentially git-synced | Privacy | HIGH |
| Chat history API endpoints expose ALL contacts, not just authorized senders | Privacy, Adversarial | MEDIUM |
| No consent/disclosure mechanism for iMessage senders | Privacy | MEDIUM |
| `maskIdentifier` fails on short emails (e.g., `jo@icloud.com`) | Privacy | LOW |
| `setOnStall` is never wired in wireIMessageRouting | Architecture | MEDIUM |
| `cliPath` config declared but never read | Architecture | LOW |
| `getConnectionInfo()` returns `new Date()` on every call, not actual connect time | Scalability, DX | LOW |
| Hash collision in djb2 topicId (32-bit) cross-contaminates stall tracking | Architecture | MEDIUM |
| Full Disk Access failure gives cryptic `SQLITE_CANTOPEN` with no guidance | DX | MEDIUM |
| `imsg` stderr suppressed (`2>/dev/null`) -- send failures give no reason | DX | MEDIUM |
| No README/docs updates in the PR | Marketing | MEDIUM |
| Synchronous SQLite on event loop may cause 10-100ms stalls on large chat.db | Scalability | LOW |
| E.164 phone number normalization missing -- silent auth rejections | Security | MEDIUM |
| `sed` fallback for JSON encoding is incomplete and unreliable | Security | HIGH |

---

## Conflicts

No direct conflicts between reviewers. All 8 agree on conditional approval. The variation is in severity weighting:

- **Architecture** (8/10) and **Marketing** (8/10) view the design as fundamentally sound with minor fixes needed
- **Privacy** (5/10) and **Adversarial** (5/10) view the data handling and injection surface as serious blockers
- The gap reflects different threat models: Architecture evaluates structural correctness (which is strong); Privacy evaluates data minimization and consent (which is weak)

---

## Prioritized Action Items

Ordered by (reviewer count x severity). Items above the line are **blockers**; below are **should-fix before merge**.

### Blockers

| # | Action | Reviewers | Severity |
|---|--------|-----------|----------|
| 1 | **Persist `lastRowId` to disk** to prevent 50-message replay on restart | 7 | HIGH |
| 2 | **Fix session name collision** -- use hash of full sender, not `slice(-6)` | 6 | HIGH |
| 3 | **Fix temp file permissions** -- mode 0o600, cleanup after use, dir mode 0o700 | 5 | HIGH |
| 4 | **Fix port default** in `imessage-reply.sh` from 4040 to 4042 | 4 | HIGH |
| 5 | **Validate recipient** in reply endpoint against `authorizedSenders` | 3 | HIGH |
| 6 | **Sanitize message content** before injection into Claude sessions | 3 | HIGH |
| 7 | **Push auth filter into SQL** to avoid reading all messages into memory | 1 | HIGH |
| 8 | **Hash or exclude PII** from JSONL log; exclude from git-sync | 1 | HIGH |

### Should-Fix

| # | Action | Reviewers | Severity |
|---|--------|-----------|----------|
| 9 | Filter chat API endpoints to authorized senders only | 2 | MEDIUM |
| 10 | Add E.164 phone normalization for sender matching | 1 | MEDIUM |
| 11 | Wire `setOnStall` or document as Phase 2 | 1 | MEDIUM |
| 12 | Remove `sed` JSON fallback; fail with warning if python3 unavailable | 1 | MEDIUM |
| 13 | Add FDA pre-check with actionable error message | 1 | MEDIUM |
| 14 | Stop suppressing `imsg` stderr | 1 | MEDIUM |
| 15 | Fix djb2 hash collision risk -- use sender string as direct key | 1 | MEDIUM |
| 16 | Add consent/disclosure config option for iMessage senders | 1 | MEDIUM |
| 17 | Add README/docs for iMessage setup | 1 | MEDIUM |
| 18 | Pin `imsg` binary path; document verification | 1 | LOW |
| 19 | Fix `getConnectionInfo()` to return actual connection time | 1 | LOW |
| 20 | Wire or remove `cliPath` config field | 1 | LOW |
