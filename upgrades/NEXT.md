---
review-convergence: complete
approved: true
approved-by: justin (verbal — topic 13435: the mentor autonomous-fix loop "just be you taking on that job"; topic 2169: post-mortem lever D "proceed as you best see fit")
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**1. Mentor Autonomous-Fix Loop ("just be Echo").** The Framework-Onboarding
mentor can now do the WHOLE dogfooding loop automatically, on an Opus model —
not just observe-and-log. Until now the mentor heartbeat only watched: it sent
the mentee a check-in (written by a small model), read the mentee's signals, and
logged findings to a read-only ledger. It never FIXED anything. A new dark switch
turns the heartbeat into a GUARDIAN: each tick it checks four gates (enabled →
budget → single-instance → min-interval) and, if they pass, keeps ONE full-tool
**Opus** session — an Echo clone — alive on the manual loop: health-check the
mentee (recover it if down) → assign one real task over Telegram → observe the UX
+ the mentee's internals → FIX any issue as a proper fleet PR through the full
ship gate → report, then exit. The single-instance gate is load-bearing: a cycle
outlives many heartbeats, so it stops the 15-minute tick from spawn-storming
expensive Opus sessions. Ships dark (off by default).

**2. Pipeline post-mortem lever D: a unit lint refuses bare `catch {}` blocks**
unless they carry the `@silent-fallback-ok` annotation. Closes the post-mortem's
pattern #4 — "silent failure caught only by user." Worst recent instance: the
PromptGate $452 incident, a bare `catch {}` in a 5-second hot-path detection loop
that swallowed every rate-limit failure for hours, bypassing both QuotaTracker
and LlmQueue spend guards. The seven existing offenders on main are annotated in
the same PR (five in `PasteManager.ts`, one each for the pending-index reader, the
audit-log append, and the tunnel-URL fallback in `routes.ts`). The ratchet
baseline starts at zero, so every future bare catch must be annotated or have a
real body before commit. This is complementary to `no-silent-fallbacks.test.ts`,
which catches the shape this one misses: catches that produce no value, no log,
nothing.

## What to Tell Your User

Two things, both mostly behind the scenes.

First, if you run the (off-by-default) Framework-Onboarding mentor, it can now
optionally FIX the issues it finds — fully autonomously, on an Opus model —
instead of only logging them. It still ships off; just ask me to turn on the
autonomous mentor loop for an agent and I'll enable it. You can watch what it
does through the mentor status and the pull requests it opens.

Second, nothing visible: an internal code-quality guard for instar's own
development now stops a new empty error-swallowing block from shipping. Nothing
changes in how I work day to day.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Autonomous-fix mentor loop (Opus) | `.instar/config.json` → `mentor.autonomousFix.enabled: true` (default false) |
| Single-instance + budget + min-interval gating | Automatic — never more than one loop session; never idle-burns or spawn-storms |
| Mentor loop status visibility | `GET /mentor/status` → `lastResult.reason` (`spawned`, `loop-active`, …) |
| Bare `catch {}` blocks refused at commit time | Automatic. Add `// @silent-fallback-ok — <why>` above the catch, or a real body. |

## Evidence

- **Mentor autonomous-fix loop:** 48 mentor tests green across all three tiers —
  unit guardian (every gate, both sides, gate-order, spawn-failure surfacing,
  goal-prompt assembly) + runner branch; integration `/mentor/tick` routes to the
  guardian over HTTP; E2E proves the REAL production wiring spawns with the OPUS
  model + full tools + the real dogfooding-loop prompt (via a spy SessionManager —
  no real spawn). Migration-parity unit tests: an existing mentor block gains the
  dark `autonomousFix` on update, idempotently. Spec:
  `docs/specs/MENTOR-AUTONOMOUS-FIX-LOOP-SPEC.md` (+ ELI16). Side-effects:
  `upgrades/side-effects/mentor-autonomous-fix-loop.md`.
- **Bare-catch lint:** 4 new unit tests (files-to-analyze sanity, ratchet
  baseline, PromptGate zero-tolerance, annotation-parser sanity), verified
  positive (passes on current code) and destructive-negative (an unannotated bare
  catch fails the ratchet with a message naming the post-mortem). 7 offenders
  annotated in-PR with no functional change. Side-effects:
  `upgrades/side-effects/no-empty-catch-blocks-lint.md`.
- `tsc --noEmit` clean for both.
