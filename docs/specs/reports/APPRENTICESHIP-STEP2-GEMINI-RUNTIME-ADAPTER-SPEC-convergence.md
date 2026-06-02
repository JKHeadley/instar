# Convergence Report — Apprenticeship Step 2: Gemini CLI Runtime Adapter

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's installed codex CLI (`gpt-5.5`, `status:ok`)
in round 2 — the clean RAN state. The internal Claude panel (security+adversarial, integration,
lessons-aware) ran round 1, grounded in the live codebase.

## ELI10 Overview

Step 2 builds the "runtime adapter" that makes the Gemini CLI a real Instar agent — the plumbing
(process spawn, one-shot completion, session resume, the hook contract, framework registration)
that the *gemini meta-lesson* says is the actual work of onboarding a framework. It's the
apprenticeship's keystone.

This convergence is the apprenticeship thesis validating itself. The first draft built its plan by
reading the **codex adapter's directory** — and the reviewers caught that this is exactly the
mistake the apprenticeship exists to prevent: it should have built its plan from the **Step-0
harvest's landmine list**. By skipping the harvest, the draft was about to *silently re-open the
most expensive bugs of the codex onboarding* — the resume-map (`ThreadResumeMap.jsonlExists`), the
`RateLimitSentinel`, and the `CompactionSentinel` are all hardcoded "claude-or-codex" branches with
**no gemini path**, and (because they're runtime `if` branches, not type switches) the compiler
would never catch it: every gemini session would silently look expired and every recovery check
would silently fail. The keystone spec for "learn from the last onboarding" had failed to learn
from the last onboarding. Convergence caught it before a line of code.

## Original vs Converged

- **Originally:** the framework-registration surface was mapped from `ls openai-codex/` and claimed
  "adding to the `IntelligenceFramework` union forces the rest at compile time." **After:** a new
  §4.0 enumerates the framework-monitoring surfaces the codex onboarding had to fix (resume-map,
  both sentinels, the process/activity signal maps) with a **drift canary** that fails CI when a new
  framework has no jsonl/rollout resolver — converting silent failures into test-forced ones; and a
  §4.3 hand-audit list of the ~10 parallel hardcoded unions the compiler does NOT catch.
- **Originally:** the registry-adapter path was treated as the live path. **After:** corrected —
  the registry adapter is dormant (matches codex; server.ts registers none), the alive proof flows
  through `buildIntelligenceProvider` → a `GeminiCliIntelligenceProvider` class (promoted to a
  blocking prerequisite).
- **Security:** the one-shot transport hard-pins `--approval-mode default` at the call site, gates
  `yolo` as capability-only, unconditionally deletes the known Google/Gemini billing env vars
  (mirroring codex's Rule-1a), caps output bytes, and treats `gemini hooks` as observe-only.
- **Honest scope (round 2):** the acceptance floor is split — MANDATORY (one-shot + registration +
  the provider class + safety + the framework-blind resolver fixes) vs CONDITIONAL (hooks /
  compaction / full session-layout, shipped only if their live contract is characterized in Step 2,
  else tracked in `programNeeds`). The native loop-driver (the codex task-#28 landmine) is tracked
  as `need-gem-002` (a Step-4 prerequisite, gemini needs it to be a mentee).

## Iteration Summary

| Iteration | Reviewers | Material findings | Spec changes |
|-----------|-----------|-------------------|--------------|
| 1 | security+adversarial, integration, lessons-aware | 1 BLOCKING + 3 HIGH/CRITICAL + several MED | §4.0 framework-monitoring + drift canary; §4.3 hand-audit list; registry-dormancy + GeminiCliIntelligenceProvider prerequisite; yolo pin + credential floor + output cap; hook-contract canary; loop-driver tracked |
| 2 | cross-model codex (gpt-5.5) | 4 minor (no blocking) | MANDATORY/CONDITIONAL floor split; one canonical argv + injection test; drift canary asserts resolver OUTPUT not branch identity; ACP rationale |
| — | (converged) | trajectory BLOCKING→minor | none material remaining |

## Convergence verdict

Converged after round 2's refinements. The finding severity drops sharply (round 1's BLOCKING
apprenticeship-self-violation, caught before code → round 2's minor scope/clarity refinements). The
spec now engages the codex harvest's landmines explicitly and adds a drift canary so the *next*
framework can't silently re-open them — which is the apprenticeship working as designed. Cross-model
posture: clean `codex-cli:gpt-5.5`. Justin pre-approved the build for this overnight run.
