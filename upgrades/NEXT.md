---
review-convergence: complete
approved: true
approved-by: justin (verbal, topic 2169: "Please proceed as you best to see fit" — my judgment-call to ship lever D next per the post-mortem ordering I proposed)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Pipeline post-mortem lever D: a new unit lint refuses bare `catch {}`
blocks unless they carry the `@silent-fallback-ok` annotation.**

Closes the post-mortem's pattern #4 — "silent failure caught only by
user." Worst recent instance: the **PromptGate $452 incident**, a bare
`catch {}` in a 5-second hot-path detection loop that swallowed every
rate-limit failure for hours, bypassing both QuotaTracker and LlmQueue
spend guards. By the time it surfaced, $452 was gone.

The seven existing offenders on main are annotated in this same PR
(five in `src/paste/PasteManager.ts` for unlink/stat cleanup, one each
for the pending-index reader, the audit-log append, and the tunnel-URL
fallback in `routes.ts`). Each annotation documents WHY the silent
swallow is safe. The ratchet baseline starts at zero so every future
bare catch must be annotated or have a real body before commit.

This lint is COMPLEMENTARY to the existing `no-silent-fallbacks.test.ts`
(which catches catches that produce a degraded value: `return null`
etc.). This new lint catches the shape THAT one misses: catches that
produce no value, no log, no nothing.

This is the last of the small post-mortem PRs (lever B —
real-world-state fixture tests — is bigger and deserves its own
conversation).

## What to Tell Your User

Nothing visible. If you write new code that tries to ship a bare
`catch {}` block, the unit suite will fail with a message naming
PromptGate and the post-mortem context. Fix: either give the catch a
real body, or add `@silent-fallback-ok` with a one-line rationale.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Bare `catch {}` blocks are refused at commit time | Automatic. Add `// @silent-fallback-ok — <why>` on the line above the catch, or `catch { /* @silent-fallback-ok */ }` inside the braces. |
| Annotated existing offenders documented | The 7 sites (PasteManager, routes.ts) carry `@silent-fallback-ok` with rationale per site. |
| Focused PromptGate.ts regression check | Zero-tolerance assertion on the file that gave the post-mortem its poster-child incident — it can never silently regress. |

## Evidence

- 4 new unit tests (files-to-analyze sanity, ratchet baseline, PromptGate
  zero-tolerance, annotation-parser sanity). Verified positive (passes
  on current code) and destructive-negative (adding an unannotated bare
  catch fails the ratchet with a message naming the post-mortem).
- `tsc --noEmit` clean.
- 7 offenders annotated in-PR — `PasteManager.ts` (×5 cleanup, ×1
  pending-index read, ×1 audit-log append) and `server/routes.ts` (×1
  tunnel-url fallback). No functional changes; only annotations.
- Side-effects review:
  `upgrades/side-effects/no-empty-catch-blocks-lint.md`.
