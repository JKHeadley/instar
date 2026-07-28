# Side-Effects Review — iterative-converging-audit skill + two constitution standards

**Version / slug:** `iterative-converging-audit-skill`
**Date:** `2026-06-08`
**Author:** `echo`
**Second-pass reviewer:** `self-review under the Tier-1 lite lane`

## Summary of the change

Adds a new built-in skill `iterative-converging-audit` (registered inline in `installBuiltinSkills` in `src/commands/init.ts`, with a source copy at `skills/iterative-converging-audit/SKILL.md`), an install unit test, and two entries in `docs/STANDARDS-REGISTRY.md` ("Iterative Audit to Convergence" and "No Silent Degradation to Brittle Fallback"). The skill is pure methodology — it calls no API and gates nothing; it tells an agent how to run a find-all sweep as an audit→fix→re-audit loop to convergence.

## Decision-point inventory

- New skill registration — added — first entry in the `installBuiltinSkills` `skills` object; `installBuiltinSkills` is install-if-missing, so existing agents receive it on the next update without a migration (per Migration Parity Standard's "adding a new skill" case).
- Constitution registry — added — two `###` standard entries in the Substrate section, in the house format (Rule / In practice / Earned from / Traces to the goal).
- Test — added — `tests/unit/init-iterativeConvergingAuditSkill.test.ts` mirrors the verify-claim skill test (install + frontmatter + content assertions + idempotency).

## 1. Direction-of-failure analysis

- **No runtime gate touched.** The skill is content installed to `.claude/skills/`; it does not run in any request path, does not classify, does not block. There is no fail-open/fail-closed surface to get wrong.
- **Install path:** `installBuiltinSkills` is non-destructive (install-if-missing) — verified by the idempotency test: a user-customized copy is NOT overwritten on re-run. So shipping this cannot clobber a customized skill.
- **No behavior change for existing flows.** Adding a key to the `skills` object cannot affect the other skills' installation; the build + the feature-delivery-completeness suite (83 tests) confirm parity is intact.

## 2. Over-permit

None. No new capability is granted to anything — the skill is advisory text. No new route, no config, no permission.

## 3. Scope deliberately NOT taken

- A CLI/API surface for "run an audit" — out of scope; the skill is a methodology an agent applies, not an endpoint.
- Auto-applying the iterative loop to existing audit jobs — out of scope; this PR ships the reusable skill + standards; wiring specific jobs to it is follow-up.

## 4. Migration parity

Covered. Adding a new built-in skill needs no migration — `installBuiltinSkills` runs on every update and writes missing skill files. Existing agents get `/iterative-converging-audit` on their next update; new agents get it at init. The `skills/<name>/SKILL.md` source copy follows the established #791 (agent-readiness) pattern.

## 5. Token/cost impact

None at rest. When invoked, the skill shapes the agent's own audit work; it adds no background LLM calls.
