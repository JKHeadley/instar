# Serendipity Protocol — Sub-Agent Opportunity Capture

**Status:** Final (post Round 2 review)
**Author:** Echo
**Date:** 2026-03-08
**Revision:** 2026-03-08 — Addresses Round 1 + Round 2 review findings (11 reviewers across 2 rounds)

## Problem

When a sub-agent is given a focused task, it frequently encounters adjacent opportunities — useful improvements, missing infrastructure, or code patterns worth extracting. Currently, sub-agents have exactly one output channel: file changes + a return message. This creates a forced choice:

1. **Inline the discovery** into the primary changes → pollutes the diff, risks parent revert
2. **Mention it in the return text** → ephemeral, no durability, easily overlooked
3. **Do nothing** → value lost silently

The parent agent's default behavior compounds the problem: out-of-scope changes are reverted to keep the primary work clean. There is no protocol for evaluating, preserving, or scheduling out-of-scope work.

**Real-world example:** A sub-agent was tasked with fixing a one-line bug in `init.ts`. While working in that file, it noticed two missing observability hooks (InstructionsLoaded and SubagentStart tracking) and built them. The parent agent reverted both to keep the diff clean. The work was nearly lost — only recovered because the user questioned the revert.

## Naming

"Serendipity" was chosen over "Discovery" to avoid collision with the A2A protocol and ANP's agent discovery mechanisms, where "discovery" refers to capability advertisement and agent-finding. In this protocol, the concept is serendipitous value capture — unplanned findings during focused work. The name is distinctive, has zero collision in the agent ecosystem, and captures the essence of the feature.

## Design Principles

1. **File-based, not API-based.** Sub-agents may run in worktrees, sandboxes, or contexts without API access. The mechanism must work with nothing more than filesystem writes.

2. **Convention over configuration.** A well-known directory path and file format is all that's needed. No registration, no handshake.

3. **Separate capture from evaluation.** The sub-agent's job is to capture the finding with enough context. The parent's job is to evaluate and route it. These are distinct responsibilities.

4. **Minimal overhead when unused.** If a sub-agent has no findings, nothing happens. Directories are created lazily on first write, not at init time. No polling, no state to clean up.

5. **Build on existing systems.** The evolution proposal system, feedback API, and session-start hooks already exist. This protocol wires them together for a new use case.

6. **Untrusted by default.** All content written by sub-agents is treated as untrusted input. The parent agent evaluates findings in a context that does not permit tool execution. HMAC signatures verify provenance. No code is auto-applied.

## Architecture

### Security Model

Sub-agent output is an **untrusted input boundary**. Even non-malicious sub-agents may produce hallucinated code, leak secrets into diffs, or write malformed JSON. The protocol enforces:

1. **HMAC signing.** Each finding file includes an HMAC signature computed from a session-derived key. The parent verifies the signature before processing. Unsigned or invalid files are moved to `invalid/` and logged.

2. **Content isolation.** During triage, finding content is presented to the parent LLM with explicit `[UNTRUSTED SUB-AGENT OUTPUT]` framing. The evaluation context does not permit tool execution — the parent reads and decides, but cannot be tricked into running commands embedded in finding fields.

3. **No auto-application of code.** Code diffs are never applied directly. Findings with code artifacts are routed through evolution proposals, which require independent review before implementation. The parent independently verifies any code before committing.

4. **Field length limits.** `title`: max 120 chars. `description`: max 2000 chars. `rationale`: max 1000 chars. Sidecar patch files: max 10KB. Fields exceeding limits cause the finding to be rejected (moved to `invalid/`), not silently truncated — truncation would invalidate the HMAC signature.

7. **Patch file integrity.** Sidecar `.patch` files are cryptographically bound to their metadata via a SHA-256 hash stored in `artifacts.patchSha256`. This hash is included in the HMAC-signed payload. During triage, the parent recomputes the hash and rejects findings where the patch content doesn't match.

8. **Symlink and path traversal rejection.** During worktree copy-back and triage, all files are validated as regular files (not symlinks). Patch file diff headers are scanned for `../` path components and absolute paths — any match causes rejection. This prevents sandbox escape (symlink to `~/.ssh/id_rsa`) and Zip Slip-equivalent attacks in downstream patch application.

5. **Rate limiting.** Max 5 findings per sub-agent session (enforced in the helper script). This prevents flooding from misbehaving or compromised sub-agents.

6. **Directory permissions.** `.instar/state/serendipity/` is created with mode 0700 (owner-only access).

**HMAC implementation:**

```
Key derivation: HMAC-SHA256(agentAuthToken, "serendipity-v1:" + sessionId)
Signed payload: JSON.stringify({ id, createdAt, discovery, source, artifacts }) (canonical, sorted keys)
  — artifacts.patchSha256 is included in the signed payload, binding the patch file to the metadata
Signature field: "hmac" at top level of the JSON file
```

The agent's `authToken` from `.instar/config.json` serves as the root key. The session ID provides per-session uniqueness. This matches the pattern already used by the Playbook manifest integrity system.

**What HMAC proves (and doesn't):** HMAC verifies **local-session integrity** — that the finding was written by a process with access to the agent's auth token during a specific session, and that the content has not been modified since signing. It does NOT prove semantic trustworthiness — the sub-agent that wrote the finding may still have produced hallucinated code or poor recommendations. This is why all findings are evaluated as untrusted content regardless of HMAC validity. The signing key is passed to sub-agents via the `SERENDIPITY_SIGNING_KEY` environment variable (derived from auth token + session ID).

### Phase 1: Capture (Sub-Agent Side)

When a sub-agent identifies work that is valuable but outside its assigned scope, it writes a finding using the helper script:

```bash
.instar/scripts/serendipity-capture.sh \
  --title "InstructionsLoaded hook for identity verification" \
  --description "A hook that fires on every CLAUDE.md load, recording which instruction files loaded per session." \
  --category improvement \
  --rationale "While working in init.ts I noticed no tracking for which instruction files actually load." \
  --readiness idea-only \
  --patch-file /tmp/my-changes.patch  # optional
```

The helper script handles:
- JSON construction (no LLM JSON formatting required)
- UUID generation (`uuidgen | cut -c1-8` or `crypto.randomUUID().slice(0,8)`)
- HMAC signing
- Atomic file writes (write to `.tmp`, rename to `.json`)
- Rate limit enforcement (exits with error after 5th finding per session)
- Directory creation (lazy — creates `.instar/state/serendipity/` on first use)

**Location:** `.instar/state/serendipity/<finding-id>.json`

**File format:**
```json
{
  "schemaVersion": 1,
  "id": "srdp-a1b2c3d4",
  "hmac": "hex-encoded-hmac-sha256",
  "createdAt": "2026-03-08T22:15:00.000Z",
  "source": {
    "sessionId": "session-id-if-available",
    "taskDescription": "Fix upgrade guide bug in init.ts",
    "agentType": "general-purpose"
  },
  "discovery": {
    "title": "InstructionsLoaded hook for identity verification",
    "description": "A hook that fires on every CLAUDE.md load, recording which instruction files loaded per session. Enables identity verification.",
    "category": "improvement",
    "rationale": "While working in init.ts I noticed no tracking for which instruction files actually load."
  },
  "artifacts": {
    "type": "code",
    "patchFile": "srdp-a1b2c3d4.patch",
    "patchSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "files": ["src/commands/init.ts"],
    "linesAdded": 35
  },
  "readiness": "implementation-complete",
  "status": "pending"
}
```

**Code diffs use sidecar patch files**, not inline JSON. When a sub-agent has code changes, it writes a standard unified diff to `.instar/state/serendipity/<finding-id>.patch`. The JSON metadata references this file by name. This avoids the well-documented failure mode of LLMs escaping multi-line code inside JSON strings.

**Field details:**

| Field | Required | Description |
|-------|----------|-------------|
| `schemaVersion` | Yes | Always `1`. Enables forward-compatible schema evolution. |
| `id` | Yes | Unique identifier, `srdp-<8-char-uuid>` |
| `hmac` | Yes | HMAC-SHA256 signature for provenance verification |
| `createdAt` | Yes | ISO timestamp |
| `source.taskDescription` | Yes | What the sub-agent was originally asked to do |
| `source.sessionId` | No | Claude session ID if available |
| `source.agentType` | No | The sub-agent type (general-purpose, Explore, etc.) |
| `discovery.title` | Yes | Short description (max 120 chars) |
| `discovery.description` | Yes | Full explanation (max 2000 chars) |
| `discovery.category` | Yes | One of: `bug`, `improvement`, `feature`, `pattern`, `refactor`, `security` |
| `discovery.rationale` | Yes | Why the sub-agent believes this is valuable (max 1000 chars) |
| `artifacts.type` | No | `code`, `config`, `documentation`, `design` |
| `artifacts.patchFile` | No | Filename of sidecar `.patch` file (max 10KB) |
| `artifacts.patchSha256` | If patchFile | SHA-256 hash of patch file content (included in HMAC-signed payload) |
| `artifacts.files` | No | Files that would be affected |
| `artifacts.linesAdded` | No | Approximate scope indicator |
| `readiness` | Yes | `idea-only`, `partially-implemented`, `implementation-complete`, `tested` |
| `status` | Yes | Always `pending` when created by sub-agent |

**Self-assessment is limited to `readiness`** — the one dimension the sub-agent actually has reliable information about. Value, effort, and risk are assessed independently by the parent during triage. This eliminates the perverse incentive for sub-agents to overstate value and understate risk.

**Readiness levels:**
- `idea-only` — Concept identified but no code written
- `partially-implemented` — Some code written but incomplete or untested
- `implementation-complete` — Code written and compiles but not tested
- `tested` — Code written, compiles, and tests pass

**Data safety:** Sub-agents MUST NOT include secrets, credentials, API keys, PII, or other sensitive data in any finding field or patch file. The helper script includes a pattern scan for common secret formats (API keys, tokens, passwords) and **blocks on detection** (exits non-zero, deletes the temp file). Warning-only is insufficient — LLMs frequently ignore stdout warnings, so secrets would still be written to disk. The sub-agent must rewrite the finding without sensitive content.

### Worktree Isolation

Sub-agents running in git worktrees (the primary execution mode) cannot write directly to the main tree's `.instar/state/serendipity/`. The protocol handles this explicitly:

1. **Sub-agent writes to worktree-local path.** The helper script detects worktree mode and writes to `.instar/state/serendipity/` within the worktree copy.

2. **Parent copies findings during worktree teardown.** When the Agent tool completes a worktree-isolated sub-agent, it checks for files in `<worktree>/.instar/state/serendipity/*.json` (and corresponding `.patch` files) and copies them to the main tree's `.instar/state/serendipity/`. Copy-back validates:
   - Files are regular files, not symlinks (rejects symlinks to prevent sandbox escape)
   - `.patch` files are scanned for `../` path components and absolute paths in diff headers (rejects path traversal)
   - File sizes are within limits (10KB for patches, 50KB for JSON)
   - `.patch` files are fully written (fsynced) before the corresponding `.json` is copied — two-phase ordering prevents triage seeing metadata without its patch
   - Duplicate IDs are detected via HMAC comparison — same HMAC means skip (idempotent)

3. **Failure handling.** If copy-back fails (permissions, disk full, validation rejection), the parent logs a warning and includes the worktree path in its return message so findings can be manually recovered. Findings are never silently lost.

4. **HMAC remains valid.** The signing key is derived from the agent's auth token (shared across worktrees) and the session ID, so signatures remain valid after copy-back.

This is implemented in the worktree teardown lifecycle, not as a separate mechanism.

### Phase 2: Triage (Parent Agent Side)

After a sub-agent completes its primary task, the parent checks for findings:

```bash
ls .instar/state/serendipity/*.json 2>/dev/null
```

**Before processing any finding, the parent:**
1. Validates JSON schema (strict, `additionalProperties: false`)
2. Verifies HMAC signature against the session key
3. Checks field length limits
4. Moves invalid/unsigned files to `.instar/state/serendipity/invalid/` with an error log entry

**For each valid pending finding, the parent:**
1. Renames the file to `.processing` extension (prevents concurrent triage)
2. Reads the finding content with explicit `[UNTRUSTED SUB-AGENT OUTPUT]` framing
3. Evaluates in a read-only context (no tool execution permitted during evaluation)
4. Makes a disposition decision:

```
├─ YES, idea worth pursuing → File as evolution proposal (POST /evolution/proposals)
│   └─ Discovery-originated proposals are flagged for mandatory review
├─ YES, but not now → File as evolution proposal with "deferred" status
└─ NO → Dismiss with reason
```

**Critical change from v1:** Findings are never "applied" directly as commits in the current session. All actionable findings route through the evolution proposal pipeline, which provides independent review, scheduling, and audit trail. This eliminates the attack surface of unreviewed code application.

5. Updates finding with disposition metadata:

```json
{
  "status": "proposed",
  "disposition": {
    "processedAt": "2026-03-08T23:00:00.000Z",
    "processedBy": "parent-session-id",
    "action": "proposed",
    "reason": "Valuable identity verification mechanism, filed as evolution proposal",
    "proposalId": "evo-xyz123"
  }
}
```

6. Moves processed finding to `.instar/state/serendipity/processed/`

**Status lifecycle (formal state machine):**

```
pending → processing → proposed | dismissed | triage-failed
                                              ↓
                                        (retry up to 3x, then auto-dismiss with log)
```

Valid statuses: `pending`, `processing`, `proposed`, `dismissed`, `triage-failed`

**Triage-failed retry metadata:** When triage fails (malformed content, evaluation error), the finding is updated with:
```json
{
  "status": "triage-failed",
  "triageAttempts": 1,
  "lastTriageError": "JSON parse error on artifacts field",
  "lastTriageAt": "2026-03-08T23:05:00.000Z",
  "nextEligibleAt": "2026-03-09T23:05:00.000Z"
}
```
After 3 failed attempts, the finding is auto-dismissed with reason "triage-failed-permanent" and moved to `processed/`.

**Orphaned `.processing` files:** The session-start hook checks for `.processing` files older than 1 hour and renames them back to `.json` (pending) for re-triage. This handles crashes during triage.

**Critical rule:** The parent MUST NOT silently discard findings. Every finding gets a disposition: proposed or dismissed-with-reason. The "dismissed-with-reason" requirement forces conscious evaluation rather than reflexive cleanup.

### Phase 3: Awareness (Session Infrastructure)

**Session-start hook integration:**

The session-start hook checks for pending findings and surfaces them (max 5 shown, with overflow count):

```
Pending serendipity findings: 2 items
  - srdp-a1b2c3d4: "InstructionsLoaded hook for identity verification" (ready)
  - srdp-e5f6g7h8: "SubagentStart lifecycle tracking" (idea-only)
Use: ls .instar/state/serendipity/ to review
```

The hook also validates `.json` files on load and moves any malformed ones to `invalid/`.

**Compaction-recovery hook:**

After compaction, pending finding count is included in the recovery context so the agent doesn't lose awareness mid-session.

### Phase 4: Evolution System Integration

When a finding is filed as an evolution proposal, the mapping is:

| Finding field | Evolution proposal field |
|--------------|------------------------|
| `discovery.title` | `title` |
| `discovery.description` + `discovery.rationale` | `description` |
| `discovery.category` | `type` (mapped: improvement→enhancement, etc.) |
| `artifacts.patchFile` (content) | `implementation` (attached as context) |
| `readiness` | `readiness` |
| `source.taskDescription` | `origin` (for traceability) |

**Mandatory review flag:** All evolution proposals originating from serendipity findings are tagged with `"origin": "serendipity"` and flagged for mandatory review. The automated evolution-review job (runs every 6 hours) does NOT auto-implement serendipity-originated proposals — they require explicit approval. This prevents the evolution pipeline from becoming a backdoor for unreviewed code.

### Retention and Cleanup

**Processed findings:** Retained for 90 days, then deleted. A cleanup check runs as part of the session-start hook.

**Invalid findings:** Retained for 30 days for debugging, then deleted.

**Pending findings TTL:** Findings not triaged within 30 days are auto-dismissed with reason "expired — not triaged within TTL" and a summary notification is shown to the parent agent. (They are NOT auto-filed as evolution proposals, since untriaged findings are likely low-value.)

**Git sync:** All of `.instar/state/serendipity/` is added to `.gitignore` by default. Findings are local-only state. The evolution proposals they produce (which DO sync) are the cross-machine path. This satisfies privacy constraints — artifact diffs may contain sensitive context that should not be committed to git.

## Sub-Agent Prompt Integration

For this protocol to work, sub-agents need to know about it. The prompt injection is kept minimal — the helper script handles all complexity.

**Proposed addition to sub-agent system prompts:**

```
## Serendipity Protocol

If you notice valuable improvements OUTSIDE your assigned task:
1. Complete your primary task first
2. Run: .instar/scripts/serendipity-capture.sh --title "..." --description "..." --category <bug|improvement|feature|pattern|refactor|security> --rationale "..." --readiness <idea-only|partially-implemented|implementation-complete|tested>
3. For code changes, save a unified diff to a temp file and pass --patch-file <path>
4. Mention the finding in your return message
Max 5 findings per session. Do NOT inline out-of-scope changes into primary work.
```

**Token budget:** ~80 tokens. The helper script approach keeps the prompt under the 100-token target by offloading JSON construction, signing, and validation to the script.

**Where this goes:**
- In the CLAUDE.md template (so all agents get it)
- Injected into sub-agent prompts by the session spawner when running in an instar project

## Implementation Plan

### Step 1: Helper script and schema (1 hour)
- Write `.instar/scripts/serendipity-capture.sh` with JSON construction, HMAC signing, atomic writes, rate limiting, secret scanning
- Write JSON schema file for validation (`additionalProperties: false`)
- Directories are created lazily by the script on first use (not during init)
- Add `.instar/state/serendipity/` to `.gitignore` template
- Set directory permissions to 0700

### Step 2: Session-start hook update (30 min)
- Modify `session-start.sh` to check for pending findings
- Validate JSON and HMAC on load; move invalid files to `invalid/`
- Surface count and titles (max 5) in session context
- Run retention cleanup for expired processed/invalid files

### Step 3: CLAUDE.md template update (30 min)
- Add Serendipity Protocol section to the CLAUDE.md template
- Add to PostUpdateMigrator for existing agents

### Step 4: Worktree copy-back integration (1 hour)
- Modify worktree teardown in session spawner to check for serendipity files
- Copy `.json` and `.patch` files from worktree to main tree
- Log warning on copy-back failure with worktree path for manual recovery

### Step 5: Parent triage helper (1.5 hours)
- A script or skill (`/triage-findings`) that walks through pending findings
- HMAC verification, schema validation, content isolation
- For each: shows the finding with `[UNTRUSTED]` framing, takes disposition, routes accordingly
- Integrates with evolution proposals API (with `origin: serendipity` flag)
- Circuit breaker: auto-dismiss after 3 triage failures for a single finding

### Step 6: Sub-agent prompt injection (30 min)
- Modify session spawner to include serendipity protocol in sub-agent prompts
- Verify token count stays under 100

### Step 7: Compaction-recovery update (15 min)
- Include pending finding count in compaction recovery context

### Step 8: End-to-end example (30 min)
- Write a concrete walkthrough: sub-agent captures finding → parent triages → becomes evolution proposal → reviewed and implemented
- Include in CLAUDE.md template as reference

### Total estimated effort: ~6 hours

## Configuration

The protocol can be disabled per-agent:

```json
{
  "serendipity": {
    "enabled": true,
    "maxPerSession": 5,
    "maxPatchSizeKB": 10,
    "processedRetentionDays": 90,
    "invalidRetentionDays": 30,
    "pendingTTLDays": 30
  }
}
```

Setting `serendipity.enabled: false` prevents the helper script from writing files and removes the prompt injection from sub-agent prompts.

## Observability

**Metrics to track:**
- Findings created per session / per day
- Triage rate (% of findings triaged within 24 hours)
- Disposition breakdown (proposed vs. dismissed, with reasons)
- Proposal-to-implementation rate (% of serendipity proposals that get built)
- Sub-agent compliance rate (% of sub-agent sessions that use the protocol)
- Invalid/malformed finding rate (indicates sub-agent prompt issues)

These metrics inform whether sub-agents are calibrated correctly (too many low-value findings = noisy prompt; too few = prompt not motivating enough).

## What This Doesn't Solve (Future Work)

- **Cross-agent finding sharing:** Findings from one agent that would benefit others. Could flow through the existing feedback/dispatch system. Requires the data sanitization controls this spec defers.
- **Finding quality scoring:** Over time, tracking which findings actually get implemented vs. dismissed to improve sub-agent judgment about what's worth capturing.
- **Automated triage:** LLM-based evaluation of findings without parent agent involvement. Possible but premature — start with parent-agent-in-the-loop as evaluator.
- **Agent Teams integration:** Claude Code's Agent Teams feature provides shared mailboxes for inter-agent communication. The serendipity protocol could potentially use this as a transport layer, but currently targets file-based capture for maximum compatibility.

## Success Criteria

1. Sub-agents working on focused tasks can capture adjacent opportunities without polluting primary changes
2. Zero findings are silently lost — every one gets a disposition
3. High-value findings flow into the evolution pipeline with mandatory review
4. The protocol adds <100 tokens to sub-agent prompts
5. Worktree-isolated sub-agents can capture findings that survive teardown
6. All finding content is treated as untrusted input with HMAC verification
7. No code is auto-applied — all code routes through evolution proposals with review
8. The protocol is disabled cleanly via config when not wanted
