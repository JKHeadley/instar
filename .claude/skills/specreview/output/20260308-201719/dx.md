# DX & API Design Review: Serendipity Protocol (Round 2)

**Spec:** Serendipity Protocol — Sub-Agent Opportunity Capture (v2)
**Review ID:** 20260308-201719
**Round:** 2
**Reviewer lens:** Developer Experience & API Design

---

## Approval Status: APPROVED

**Score: 9/10**

The v2 spec addresses every critical DX issue from Round 1 and does so with good design taste. The helper script approach is the right call, the worktree mechanism is concrete, the schema is simplified, and the sub-agent prompt fits the token budget. One point deducted for a gap in the helper script specification (see New Issue 1 below) — but this is a minor implementation detail, not a design flaw.

---

## Round 1 Issue Resolution Status

### Issue 1 (CRITICAL): No helper for sub-agents to write discovery files correctly
**Status: RESOLVED — Excellently**

The helper script (`.instar/scripts/serendipity-capture.sh`) is now the primary interface for sub-agents. It handles JSON construction, UUID generation, HMAC signing, atomic writes, rate limiting, directory creation, and secret scanning. The sub-agent prompt is reduced to a single CLI invocation with named flags. This is exactly what I asked for. The sub-agent no longer needs to construct JSON, generate IDs, or know the file format. Correctness is shifted from the LLM to the tool.

The prompt is clean:
```
.instar/scripts/serendipity-capture.sh --title "..." --description "..." --category <enum> --rationale "..." --readiness <enum>
```

This is the kind of interface where a sub-agent can succeed on the first attempt.

### Issue 2 (CRITICAL): Worktree isolation unresolved
**Status: RESOLVED — Adequately**

The worktree section now has a concrete four-step mechanism: (1) helper script detects worktree mode and writes locally, (2) parent copies findings during worktree teardown, (3) failure handling with manual recovery path, (4) HMAC validity preserved across copy-back. This is integrated into the implementation plan as Step 4 with a 1-hour estimate.

One subtlety worth noting: the spec says "the helper script detects worktree mode" but does not specify HOW. The standard detection (`git rev-parse --show-toplevel` vs `git rev-parse --show-superproject-working-tree`) is straightforward, but should be mentioned. Not a blocker — any implementer will figure it out.

### Issue 3 (Recommendation): Add a concrete end-to-end example
**Status: RESOLVED — Planned**

Step 8 in the implementation plan explicitly allocates 30 minutes for writing a concrete walkthrough. The lifecycle is now clearly documented in the status state machine and the triage decision tree. Good enough at the spec level — the example belongs in the implementation, not the spec itself.

### Issue 4 (Recommendation): Error handling and validation absent
**Status: RESOLVED**

The spec now addresses:
- Invalid JSON → schema validation with `additionalProperties: false`, moved to `invalid/` directory
- Missing fields → strict schema validation
- Directory creation → lazy creation by helper script on first use (explicitly stated)
- Concurrent writes → atomic write-to-temp-then-rename in helper script
- Triage failures → circuit breaker with 3 retries, then auto-dismiss with log

This is comprehensive. The `invalid/` directory with 30-day retention is a nice touch for debugging.

### Issue 5 (Recommendation): Status field serves two masters
**Status: RESOLVED — Implicitly**

The status lifecycle is now formally documented as a state machine: `pending → processing → proposed | dismissed | triage-failed`. The spec is clear that sub-agents always write `pending` and the `.processing` extension prevents concurrent triage. The write-only drop-box semantics are implicit in the helper script approach — sub-agents never read the directory, they only write via the script.

### Issue 6 (Recommendation): Token budget exceeds stated limit
**Status: RESOLVED**

The prompt injection is now ~80 tokens (by my count: closer to 75). The success criterion still says "<100 tokens" and the spec states "~80 tokens." Both are consistent. The helper script approach is what made this possible — the prompt is just a CLI invocation pattern plus enum values.

### Issue 7 (Recommendation): Self-assessment creates perverse incentives
**Status: RESOLVED — Exactly as recommended**

Self-assessment is now limited to `readiness` only. The spec explicitly states: "Value, effort, and risk are assessed independently by the parent during triage. This eliminates the perverse incentive for sub-agents to overstate value and understate risk." This is the right call.

---

## New Issues Introduced by v2

### New Issue 1 (Minor): Helper script error reporting to sub-agents

The helper script enforces rate limits (exits with error after 5th finding) and scans for secrets. But the spec doesn't describe what the sub-agent sees when these fire. If the script exits with a non-zero code and an error message, the sub-agent LLM will see the stderr output and potentially try to work around it (e.g., writing the JSON manually to bypass the script). The script should output a clear, unambiguous message like:

```
SERENDIPITY: Rate limit reached (5/5 findings this session). Additional findings will not be recorded.
```

And the sub-agent prompt should include a note: "If the script reports an error, do not attempt to write findings manually."

**Severity:** Low. This is an implementation detail, not a design flaw. But it matters for the first 5 minutes — a sub-agent that gets a cryptic error and tries to work around it defeats the whole helper-script-as-correctness-layer approach.

### New Issue 2 (Minor): Sidecar patch file creation is under-specified

The sub-agent prompt says: "For code changes, save a unified diff to a temp file and pass `--patch-file <path>`." But how does a sub-agent produce a unified diff of changes it noticed but didn't make? If the sub-agent is in `idea-only` or `partially-implemented` readiness, there may be no diff to capture. If `implementation-complete`, the changes are presumably in the worktree but not committed — so `git diff` would capture them, but those changes will also be in the primary work output.

The interaction between "don't inline out-of-scope changes into primary work" and "save a patch file of your changes" needs a sentence of clarification. Likely answer: the sub-agent creates the patch from its uncommitted changes, then reverts the out-of-scope changes from its working tree, keeping only the primary task changes. But this should be explicit.

**Severity:** Low-medium. A sub-agent encountering this ambiguity will either skip the patch (safe, just loses context) or leave out-of-scope changes in its primary diff (the exact problem the protocol exists to solve).

---

## Observations

### What improved significantly

- **The rename to "Serendipity Protocol"** is a good call. "srdp-" as a prefix is greppable, distinctive, and won't collide with anything. The naming section explaining why "Discovery" was dropped shows good awareness of the ecosystem.

- **Security model as a first-class section** (not an afterthought) changes the character of the spec. The HMAC signing, content isolation, and no-auto-apply rules are clearly stated before the architecture. This is how security-sensitive protocols should be written.

- **Sidecar patch files instead of inline JSON diffs.** This was not in my Round 1 review but is exactly right. LLMs reliably fail at escaping multi-line code inside JSON strings. Moving diffs to sidecar `.patch` files eliminates an entire class of malformed-output bugs.

- **Configuration section.** Clean, minimal, with sensible defaults. `serendipity.enabled: false` as a kill switch is the right granularity. The configurable limits (`maxPerSession`, `maxPatchSizeKB`, `retentionDays`, `pendingTTLDays`) give operators control without requiring them to think about it on day one.

- **The observability section.** Six concrete metrics, each tied to a specific decision ("too many low-value findings = noisy prompt"). This is the kind of feedback loop that makes protocols self-correcting.

### What the spec gets right about DX

The core DX insight of v2 is: **the helper script is the API surface, not the JSON schema.** Sub-agents never see JSON. They see a CLI with named flags and enum values. This means:

1. Schema changes don't require prompt changes (just update the script)
2. Validation happens at write time, not triage time
3. The sub-agent prompt is a usage example, not a specification
4. New features (HMAC, rate limits, secret scanning) are invisible to sub-agents

This is the correct abstraction boundary. The JSON format is an internal implementation detail. The CLI is the contract.

### Remaining edge case: `--patch-file` in worktree mode

If a sub-agent in a worktree passes `--patch-file /tmp/my-changes.patch`, the patch file lives in `/tmp/` (outside the worktree). During worktree teardown, the copy-back step copies `.json` and `.patch` files from the worktree's serendipity directory — but the patch file referenced by `--patch-file` might not have been copied into the serendipity directory by the helper script. The spec should clarify that the helper script copies the patch file into `.instar/state/serendipity/` as `<finding-id>.patch` (which the file format section implies, since `patchFile` is just a filename not a path, but the helper script behavior should be explicit).

---

## Summary

v2 is a well-executed revision. Every critical and recommended DX issue from Round 1 has been addressed, most of them in exactly the way I suggested (helper script, readiness-only self-assessment, token budget via script offloading). The new issues are minor — implementation details about error reporting and patch file handling that any competent implementer will resolve naturally.

The protocol is now ready for implementation from a DX perspective. A sub-agent encountering this for the first time will see a clear CLI interface, understand the constraints (max 5, primary task first, don't inline out-of-scope), and succeed on the first attempt. That's the bar, and v2 clears it.
