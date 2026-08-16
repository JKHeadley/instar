# GPT 5.4 Review: discovery-protocol.md (Round 2)

**Model**: gpt-5.4
**Date**: 2026-03-08
**Focus**: full document
**Round**: 2 (revised spec)

---

## Raw Model Response

## 1. Overall Assessment

- **Score**: **8/10**
- **Status**: **CONDITIONAL**

This is a strong revision that meaningfully addresses most Round 1 concerns: naming collision is resolved, the security model is substantially improved, worktree handling is explicit, inline JSON diff fragility is fixed via sidecar patches, and the helper-script approach makes the protocol much more implementable in practice. The spec is now coherent, opinionated, and close to build-ready for an MVP. The remaining concerns are mostly around operational correctness and edge-case rigor rather than core design. In particular, HMAC provenance assumptions, file lifecycle/concurrency semantics, config/schema consistency, and copy-back collision handling should be tightened before implementation.

---

## 2. Critical Issues (Must Fix)

### Issue 1: HMAC provenance model is underspecified and may not provide the security guarantee claimed
- **What**: The spec says HMAC signatures "verify provenance," using the agent `authToken` from `.instar/config.json` as the root key. But if sub-agents can read that token or invoke the helper script, then any compromised/malicious sub-agent can generate valid HMACs. That means HMAC verifies integrity from "someone with local token access," not trustworthy authorship.
- **Why it matters**: This is the central security claim in the protocol. If overstated, implementers may treat signed findings as more trustworthy than they are. It also affects threat modeling: HMAC here mainly protects against accidental corruption/tampering after write, not hostile sub-agent fabrication.
- **Suggested fix**: Reframe the guarantee explicitly: HMAC confirms file integrity and origin from the local session environment, not semantic trustworthiness. If stronger provenance is needed, derive a per-sub-agent capability token issued by the parent/session spawner and scoped to one session/worktree, or have the parent create a write-only envelope/token for the helper script. At minimum, update language from "verify provenance" to "verify local-session authenticity/integrity."
- **Section reference**: **Security Model**, **HMAC implementation**, **Design Principles #6**

### Issue 2: File state transitions are not fully atomic and leave room for race conditions / duplicate processing
- **What**: Triage says parent lists `*.json`, validates, then renames to `.processing`. But there is no precise locking protocol for multiple parent processes, repeated session-start hooks, or teardown copy-back occurring concurrently with triage. Also, it's unclear whether status inside the JSON must match filename/state.
- **Why it matters**: Without a precise atomic lifecycle, the same finding can be triaged twice, moved while being copied, or left in a mismatched state (`status: pending` inside a file sitting in `processed/`).
- **Suggested fix**: Define the file lifecycle as the source of truth and make rename atomic transitions mandatory:
  - `pending/<id>.json` → `processing/<id>.json` via atomic rename
  - on success → `processed/<id>.json`
  - on validation failure → `invalid/<id>.json`
  - on retryable error → back to `pending/` with retry counter in metadata or sidecar state
  Also specify that only files in `pending/` are eligible for triage, and session-start validation must not touch `processing/`.
- **Section reference**: **Phase 2: Triage**, **Status lifecycle**, **Session-start hook integration**

### Issue 3: Worktree copy-back collision and idempotency behavior is missing
- **What**: The spec says the parent copies `.json` and `.patch` files from worktree to main tree during teardown. It does not define what happens if:
  - the same finding ID already exists in the main tree,
  - copy-back is retried,
  - only JSON copies successfully but patch copy fails,
  - two worktrees somehow produce the same short ID,
  - teardown happens after triage has already started in another process.
- **Why it matters**: This is a high-risk operational path because worktree isolation is a primary execution mode. Incomplete or duplicate copy-back can orphan findings or create broken references to missing patch files.
- **Suggested fix**: Define copy-back as transactional and idempotent:
  - use full UUIDs or longer IDs to reduce collision risk,
  - copy to a temp name in main tree, verify HMAC and patch presence/size, then atomically rename,
  - if target exists with same HMAC, treat as duplicate and skip,
  - if JSON exists but patch is missing, mark invalid or triage-failed with explicit reason,
  - log a structured copy-back result.
- **Section reference**: **Worktree Isolation**, **Phase 1: Capture**

### Issue 4: Config model is inconsistent with retention policy definitions
- **What**: The retention section defines multiple retention classes: processed = 90 days, invalid = 30 days, pending TTL = 30 days. But config only exposes `retentionDays` and `pendingTTLDays`; there is no `invalidRetentionDays`, and it's not clear whether `retentionDays` applies only to processed findings or all retained artifacts.
- **Why it matters**: Ambiguous config leads to divergent implementations and makes operations harder. Cleanup logic in hooks will be inconsistent.
- **Suggested fix**: Expand config to explicitly match policy:
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
  Then state defaults and precedence clearly.
- **Section reference**: **Retention and Cleanup**, **Configuration**

### Issue 5: JSON schema and truncation behavior conflict
- **What**: The security model says fields exceeding limits are truncated during triage. But triage also says strict schema validation occurs before processing. It is unclear whether overlong fields are considered valid input that gets normalized, or invalid input that gets moved to `invalid/`.
- **Why it matters**: This affects deterministic behavior, security posture, and implementation simplicity. Silent truncation can alter signed content and break HMAC assumptions unless done after verification only for display. If persisted back, it changes signed payload semantics.
- **Suggested fix**: Separate "storage validity" from "display normalization":
  - schema validation should include max lengths where feasible,
  - files exceeding limits should be invalidated or marked triage-failed,
  - if truncation is desired, it should apply only to the parent's display context after HMAC verification and never overwrite the original signed file.
- **Section reference**: **Security Model #4**, **Phase 2: Triage**

### Issue 6: Retry semantics for `triage-failed` are not implementable as written
- **What**: The state machine says `triage-failed` then "retry up to 3x, then auto-dismiss with log," but there is no field for retry count, no trigger for retry, and no distinction between transient failures (API unavailable) and permanent ones (bad patch reference).
- **Why it matters**: This will lead to ad hoc implementations and possibly infinite retry loops or premature dismissal.
- **Suggested fix**: Add explicit metadata:
  ```json
  "triage": {
    "attempts": 1,
    "lastError": "...",
    "nextEligibleAt": "..."
  }
  ```
  Define retryable vs non-retryable failures, and specify which hook/process performs retries.
- **Section reference**: **Phase 2: Triage**, **Status lifecycle**, **Implementation Plan Step 5**

---

## 3. Strengths

1. **Round 1 security concerns were substantially addressed**
   - The addition of a dedicated **Security Model** is the strongest improvement in v2.
   - In particular, **no auto-application of code** is the right call and removes the biggest architectural risk from v1.

2. **The protocol is now much more implementable**
   - The **helper script** is an excellent design choice. It removes brittle LLM JSON generation, centralizes signing/validation/rate limiting, and lowers prompt complexity.
   - This is a practical "convention over configuration" implementation move.

3. **Worktree awareness is explicit instead of hand-waved**
   - The **Worktree Isolation** section acknowledges the real execution model and gives a plausible integration point in teardown.
   - This directly addresses one of the most likely real-world failure modes.

4. **Separation of capture vs evaluation is well-designed**
   - The spec correctly limits sub-agent self-assessment to **readiness** only.
   - That is a strong anti-gaming design decision and much better than asking sub-agents to estimate value/risk/priority.

5. **Use of sidecar patch files is a strong correction**
   - Replacing inline diffs in JSON with `.patch` sidecars is aligned with known LLM failure modes.
   - This is one of the best concrete design decisions in the document.

6. **The disposition requirement is excellent**
   - "The parent MUST NOT silently discard findings" is a strong behavioral invariant.
   - Requiring **dismissed-with-reason** creates accountability and auditability.

7. **Evolution pipeline integration is appropriately conservative**
   - Routing all actionable findings through **evolution proposals with mandatory review** is exactly the right trust boundary.
   - This avoids turning serendipity into a covert auto-change channel.

8. **Prompt footprint discipline is good**
   - The prompt injection section is concise and realistic.
   - The protocol does not depend on large instruction payloads.

9. **Retention, observability, and disablement are included**
   - These are often omitted in early specs; including them improves operational maturity.
   - The **What This Doesn't Solve** section also shows healthy scope discipline.

---

## 4. Gaps & Missing Elements

### A. Missing directory structure specification
The spec refers to root directory plus `invalid/` and `processed/`, but doesn't formally define the on-disk layout. It should specify whether `pending/`, `processing/`, `processed/`, and `invalid/` are subdirectories or whether extensions are mixed in one directory.

### B. No explicit schema for disposition metadata
A sample disposition object is shown, but there is no formal field table for:
- `disposition.processedAt`
- `processedBy`
- `action`
- `reason`
- `proposalId`
- triage attempt metadata

This should be part of the schema if it is persisted.

### C. Patch-file integrity is not independently protected
The HMAC signs `id`, `createdAt`, `discovery`, and `source`, but the spec does not clearly state that patch-file content or even patch-file hash is included in the signed payload. If the patch is unsigned, JSON can be authentic while the patch is tampered with.
- This is an important gap.

### D. Secret scanning behavior is too vague
The helper script "warns on detection," but:
- does it block write or only warn?
- what patterns are checked?
- are false positives acceptable?
- does parent re-scan before proposal filing?

Given the privacy rationale, warning-only may be too weak.

### E. Session identity assumptions are unclear
`source.sessionId` is optional, but HMAC derivation uses session ID. What happens if session ID is unavailable? Is there a fallback derivation? Is the finding unsigned? The spec implies session-derived uniqueness but also says session ID may be absent.

### F. No migration/compatibility story for schemaVersion > 1
`schemaVersion` exists, which is good, but there is no rule for:
- whether unknown versions are invalid,
- whether hooks ignore newer versions,
- how backward compatibility is handled.

### G. No rollback / feature-flag rollout strategy
There is config disablement, but no operational rollout plan:
- can this be enabled only for some agent types?
- can triage be enabled after capture is already writing files?
- what happens if the evolution API is unavailable during rollout?

### H. Parent triage UX is underspecified
The spec says "a script or skill (`/triage-findings`)" but not whether triage is:
- interactive,
- automatic recommendation + human confirmation,
- mandatory at end of each sub-agent run,
- session-start only.

The UX matters for adoption and actual disposition rates.

### I. No handling for orphaned `.processing` files
If triage crashes mid-run, how are stale `.processing` files recovered? There should be a timeout or recovery rule.

### J. ID generation is a bit weak
`uuidgen | cut -c1-8` gives short identifiers that are fine for small scale but not ideal if findings accumulate over time across many sessions/worktrees. Collision risk is still low, but unnecessary.

---

## 5. Industry Comparison

### Compared to existing solutions in the same space
This resembles a lightweight local analogue of:
- issue capture/inbox systems,
- code-review "suggestion queues,"
- agent memory/task spillover systems,
- deferred work proposal pipelines.

Its strongest differentiator is that it is **filesystem-native** and works in constrained execution contexts. That is a good fit for agentic tooling where API access is not guaranteed.

### Compared to industry best practices
**Aligned with best practices:**
- explicit trust boundary for machine-generated content,
- no automatic execution of untrusted artifacts,
- immutable-ish append/capture before evaluation,
- audit trail via proposal system,
- lazy creation / low overhead when unused,
- retention policies and observability.

**Less aligned / weaker areas:**
- HMAC is being used more as an authenticity/provenance signal than it can reliably support in a same-host trust model,
- file-based workflows need stronger locking/state semantics,
- patch integrity should be cryptographically bound to metadata,
- warning-only secret scanning is weaker than standard DLP-style controls for potentially sensitive content.

### Known patterns and anti-patterns

**Good patterns present:**
- inbox/outbox pattern,
- capture-now-triage-later separation,
- sidecar artifact pattern,
- mandatory review gate for untrusted code,
- bounded rate limiting.

**Potential anti-patterns:**
- conflating integrity with trust,
- relying on hooks for too much background maintenance,
- storing workflow state partly in filenames and partly in JSON without defining a single source of truth,
- using local-only state without a robust recovery model for machine/user/environment changes.

Overall, the architecture is directionally strong and more mature than many agent protocol drafts, but it still needs some hardening to match production-grade workflow systems.

---

## 6. Scalability Assessment

### Phase 1 (MVP, 10-50 users): Will it work?
**Yes, likely.**
At this scale, the file-based design is appropriate. The helper script, local state directory, and session-start awareness should work well. Low finding volume means simple `ls`/scan approaches are acceptable. Most remaining issues are edge cases rather than blockers for basic functionality.

### Phase 2 (Growth, 50-500 users): What breaks?
A few things will start to strain:

1. **Operational inconsistency** — Different environments may implement triage and cleanup slightly differently unless schema/state rules are tightened.
2. **Concurrency edge cases** — More sessions/worktrees means more chances of duplicate triage, stale processing files, and copy-back races.
3. **Observability fragmentation** — Since findings are local-only and gitignored, aggregate metrics become harder unless separately reported.
4. **Retention/cleanup load** — Session-start hooks doing validation and cleanup may become noisy/slower if directories accumulate many files.
5. **User compliance** — "Mention the finding in your return message" plus helper-script usage may still be inconsistently followed without better UX.

### Phase 3 (Scale, 500-5000 users): Architecture changes needed?
Yes. At this scale, the current local-file architecture becomes a capture edge, not the system of record.

Likely changes needed:
- a centralized findings service or append-only queue,
- structured event emission instead of session-start directory scans,
- stronger identity/provenance model per sub-agent,
- centralized metrics and retention enforcement,
- dedupe and indexing,
- more automated triage assistance.

### Spike handling: What happens under sudden load?
For sudden spikes in sub-agent activity:
- per-session rate limiting helps locally,
- but session-start hooks and teardown copy-back may become hotspots,
- evolution proposal API could become the bottleneck,
- local directories may accumulate many pending files if triage lags.

The system degrades reasonably in the short term because capture is decoupled from triage. That's a good property.

---

## 7. Recommendations (Prioritized)

1. **Tighten the security claims and cryptographically bind patch files** — Clarify that HMAC provides local-session integrity/authenticity, not semantic trust. Include `patchSha256` in the signed payload.

2. **Define a precise, atomic file lifecycle and locking model** — Move from ad hoc extensions to explicit state directories or a rigorously defined rename protocol. Add stale `.processing` recovery and retry metadata.

3. **Make worktree copy-back transactional and idempotent** — Specify collision handling, duplicate detection, partial-copy recovery, and verification before publish into the main tree.

4. **Resolve config/schema inconsistencies and formalize persisted metadata** — Align configuration with all retention classes. Add formal schema for disposition and triage metadata. Clarify max-length handling vs validation.

5. **Strengthen operational safeguards around secrets and failure recovery** — Decide whether secret detection blocks capture or requires explicit override. Define fallback behavior when session ID is unavailable, evolution API is down, or triage crashes mid-processing.

---

### Round 2 Verdict
**Most Round 1 issues appear meaningfully addressed.** The revision is materially better: safer, clearer, and more implementable. The new concerns are mostly second-order production hardening issues introduced by moving from concept to concrete design. That's a good sign. I would not block this on architectural grounds, but I would require the must-fix items above before calling it implementation-ready.

---

## Subagent Analysis

Brief notes on the quality and specificity of the model's response:

- **Was the review substantive?** Yes, highly substantive. GPT 5.4 provided 6 critical issues, 10 gaps, and 5 prioritized recommendations. The review demonstrates strong engagement with the revised spec and specifically evaluates how Round 1 issues were addressed rather than repeating them.

- **Did it evaluate Round 1 resolution?** Yes. The strengths section explicitly acknowledges which Round 1 issues were fixed (security model, worktree handling, sidecar patches, self-assessment simplification). The Round 2 verdict confirms most issues were meaningfully addressed.

- **Any notable gaps in the model's analysis?** The scalability section again uses a user-count framing (10-50, 50-500, 500-5000) that doesn't quite match the domain -- this is an agent-internal protocol, not a user-facing service. The scaling dimension is sub-agent invocations per session, not users. This was noted in Round 1 as well and persists unchanged. The model also does not deeply engage with the token budget constraint or evaluate whether the ~80-token prompt injection is realistic.

- **Unique insights this model provided?** The HMAC provenance reframing (Issue 1) is the standout finding -- the observation that HMAC verifies "someone with local token access" rather than "trustworthy authorship" is a sharp and actionable distinction that the spec should address. The patch-file integrity gap (Gap C) is also important: the signed payload excludes patch content, meaning JSON authenticity doesn't guarantee patch authenticity. The truncation-vs-HMAC conflict (Issue 5) is a subtle but real problem -- truncating signed content invalidates the signature, so the spec needs to decide whether overlong fields are invalid or display-normalized post-verification.

- **Score stability across rounds:** Score held at 8/10 (same as Round 1), status remained CONDITIONAL. This is reasonable -- the spec improved substantially but introduced new second-order concerns that warrant another pass before implementation.
