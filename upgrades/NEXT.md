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

---

## What Changed — Mentor Autonomous-Fix Loop ("just be Echo")

**The Framework-Onboarding mentor can now do the WHOLE dogfooding loop
automatically, on an Opus model — not just observe-and-log.**

Until now the mentor heartbeat only watched: it sent the mentee a check-in
(written by a small model), read the mentee's signals, and logged findings to a
read-only ledger. It never FIXED anything — the "watch the experience and fix
what's broken as shipped code" half was always done by a developer by hand.

A new dark switch, `mentor.autonomousFix.enabled`, turns the heartbeat into a
GUARDIAN: each tick it checks four gates (enabled → budget → single-instance →
min-interval) and, if they pass, keeps ONE full-tool **Opus** session — an Echo
clone — alive on the manual loop: health-check the mentee (recover it if down) →
assign one real task over Telegram → observe the UX + the mentee's internals →
FIX any issue as a proper fleet PR through the full ship gate → report, then
exit. The guardian starts the next cycle on its own heartbeat.

The single-instance gate is the load-bearing one: a cycle outlives many
heartbeats, so it stops the 15-minute tick from spawn-storming expensive Opus
sessions. Budget + min-interval add two more bounds.

## What to Tell Your User

Only relevant if you run the (off-by-default) Framework-Onboarding mentor. The
mentor can now optionally fix issues it finds — fully autonomously, on Opus —
instead of only logging them. It ships OFF; enable per agent with
`mentor.autonomousFix.enabled: true`. Watch it via `GET /mentor/status`
(`lastResult.reason` = `spawned` / `loop-active` / `budget` / …) and the PRs it
opens.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Autonomous-fix mentor loop (Opus) | `.instar/config.json` → `mentor.autonomousFix.enabled: true` (default false) |
| Single-instance + budget + min-interval gating | Automatic — never more than one loop session; never idle-burns or spawn-storms |
| Status visibility | `GET /mentor/status` → `lastResult.reason` (`spawned`, `loop-active`, …) |

## Evidence

- 48 mentor tests green across all three tiers: unit guardian (every gate, both
  sides, gate-order, spawn-failure surfacing, goal-prompt assembly) + runner
  branch; integration `/mentor/tick` routes to the guardian over HTTP; E2E proves
  the REAL production wiring spawns with the OPUS model + full tools + the real
  dogfooding-loop prompt (via a spy SessionManager — no real spawn).
- Migration-parity unit tests: an existing mentor block gains the dark
  `autonomousFix` on update, idempotently.
- `tsc --noEmit` clean.
- Spec: `docs/specs/MENTOR-AUTONOMOUS-FIX-LOOP-SPEC.md` (+ ELI16).
- Side-effects review:
  `upgrades/side-effects/mentor-autonomous-fix-loop.md`.
