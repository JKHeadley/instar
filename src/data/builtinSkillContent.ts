/**
 * builtinSkillContent.ts — single source for built-in skill content that BOTH
 * the scaffold path (`installBuiltinSkills` in init.ts) AND the PostUpdateMigrator
 * skill-content migration consume, so the two cannot drift (Integration-R2 M3 /
 * lessons-aware M1: init.ts previously carried an inline copy that diverged from
 * the repo SKILL.md, so new agents scaffolded stale content forever).
 */

export const ITERATIVE_CONVERGING_AUDIT_SKILL_CONTENT = `---
name: iterative-converging-audit
description: Run any "find all instances of X" sweep — security audit, safety audit, code review, research, compliance check — as an iterative loop that does NOT stop at one pass. Audit, fix, RE-audit, repeat until a clean pass returns zero new discoveries. Trigger words: audit, sweep, find all, review everything, comprehensive, thorough, exhaustive, security review, did we get everything, convergence.
metadata:
  user_invocable: "true"
---

# /iterative-converging-audit

A single audit pass is never thorough. The first sweep has blind spots; the fixes themselves reveal or introduce new instances; and "I looked once and stopped finding things" usually means "I got tired," not "there is nothing left." The only honest definition of a complete audit is a CONVERGED one: a re-run that finds zero new discoveries. This enforces the "Iterative Audit to Convergence" constitution standard (docs/STANDARDS-REGISTRY.md). It applies to ANY find-all task — security audits, safety audits, code reviews, research sweeps, compliance checks, dead-code hunts.

## When to use
- Any "find all", "audit", "sweep", "review everything", "make sure we got everything".
- After fixing a bug, when the same class likely exists elsewhere ("where else do we do this?").
- A security/safety audit where a missed instance is dangerous.
- Whenever you catch yourself about to say "I checked, looks clean" after ONE pass.

## The loop (do not skip steps)
0. FRAME — write down: the target pattern (be precise), the search surface (where instances could live — your first list is always incomplete), the classification buckets, the fix policy per bucket, and the convergence criterion (usually: a full re-sweep finds nothing not already in the ledger).
1. AUDIT (round N) — sweep the surface; record EVERY finding with location + behavior + bucket. Cast wide (false positives are cheap to classify out; missed instances are the failure mode). Use multiple search angles — by-name AND by-content AND by-structure; one angle is blind to what the others catch.
2. FIX — remediate each finding, OR classify it accepted with a written reason (an accepted finding is a DECISION, not a TODO). Fixing changes the code, which is exactly why you must re-audit.
3. RE-AUDIT (round N+1) — sweep the FULL surface again, not just what you touched. Your surface grew (round N taught you new places), and the fixes may have moved or masked instances. New findings -> back to step 2. Zero new -> CONVERGED.
4. DECLARE convergence honestly — "Converged after K rounds; round K found nothing new. Ledger: X total, Y fixed, Z accepted-advisory (each with a reason)." If you stopped for time/budget/patience, say INCOMPLETE — never dress up an exhausted audit as a thorough one. In a repo carrying scripts/write-audit-convergence.mjs (the instar source tree, or any repo vendoring it), the converged claim is EARNED not asserted: write the canonical report at docs/audits/<slug>.md and run "node scripts/write-audit-convergence.mjs --audit docs/audits/<slug>.md"; the validator refuses the stamp unless the ledger genuinely earns it, and a hand-typed converged: is rejected at commit and re-checked in CI. Elsewhere, still write the canonical report — never fabricate a stamp you cannot earn.
5. STANDING GUARD — where the pattern is CI-expressible, leave a ratchet (a no-* test) so the audit cannot silently un-converge on the next commit. The accepted-findings ledger becomes its allowlist. Name it in the report's standing-guard: field (or record a closed-enum exemption: non-ci-expressible | external-system | one-time-human-review with a real rationale).

## The ledger (the durable artifact) — canonical at docs/audits/<slug>.md
The ledger IS a report at docs/audits/<slug>.md: frontmatter (audit, target-pattern, search-surface, converged [validator-stamped only], standing-guard XOR exemption) + one "## Round N" section per pass, each recording the search angles run, the surface delta, a findings table (location | behavior | bucket | disposition, where disposition is fixed:<ref> | accepted:<reason> | deferred:<ref>), and a "New findings this round: <count>" line. Reference each finding by path+line — NEVER paste secret/credential material into the ledger (the commit gate scans audit reports and blocks). It makes "converged after K rounds" a machine-verifiable claim instead of a feeling; the new-findings-per-round count falling to zero is the convergence signal.

## Anti-patterns this forbids
- "I checked, looks clean" (one pass) — round 1 always has blind spots; re-audit at least once.
- "Fixed the 3 I found, done" — fixes reveal/create new instances; re-sweep AFTER fixing.
- Re-auditing only what you touched — new instances hide in untouched code; re-sweep the FULL surface.
- An accepted finding treated as a TODO — it rots silently; every accepted finding carries a written reason.
- Calling it "thorough" when you stopped for time/budget — say "incomplete", never dress it up.
- One search angle — each angle is blind to what the others catch.

The principle: thoroughness is not how hard you looked once — it is whether a fresh look finds anything new. Audit until the fresh look comes back empty.`;
