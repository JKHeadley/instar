# Side-Effects Review — ELI16 overview required for every approved spec

**Version / slug:** `eli16-overview-required-gate`
**Date:** 2026-05-13
**Author:** echo
**Second-pass reviewer:** not required (structural gate; deterministic; small surface)

## Summary of the change

Adds a third structural check to the `/instar-dev` precommit gate and to `/spec-converge`'s convergence-tag writer: every approved spec must ship with a plain-English ELI16 overview at `docs/specs/<slug>.eli16.md` (or a path declared via the spec's `eli16-overview:` frontmatter field). The overview must be at least 800 characters of trimmed content — stubs are refused. Files touched: `scripts/eli16-overview-check.mjs` (new shared module), `scripts/instar-dev-precommit.js`, `skills/spec-converge/scripts/write-convergence-tag.mjs`, `skills/instar-dev/SKILL.md`, `skills/spec-converge/SKILL.md`, `skills/instar-dev/templates/eli16-overview.md` (new template), `tests/unit/eli16-overview-check.test.ts` (new unit test).

## Decision-point inventory

- `scripts/instar-dev-precommit.js` Step 7 (new) — **add** — refuses a commit if the spec referenced by the trace has no ELI16 companion or the companion is a stub. Pure file-existence + length check; deterministic; no LLM judgment.
- `skills/spec-converge/scripts/write-convergence-tag.mjs` (new pre-check) — **add** — refuses to stamp `review-convergence` on a spec without an ELI16 companion. Same deterministic check.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **Bootstrap exceptions remain intact.** The existing bootstrap-trigger logic for the precommit gate (which lets the gate's own first-ship pass) is upstream of the ELI16 check; bootstrap commits already exit before any spec-tag verification runs. So no over-block on bootstrap.
- **Out-of-scope commits remain unaffected.** The ELI16 check runs only after `inScopeFiles.length > 0` and after the spec-tag verification, so docs-only or release-note commits never hit it.
- **Existing approved specs with shipped work.** Forward-only — old specs whose work has already merged are not re-committed against, so the gate doesn't fire on them. If a contributor wants to amend an old spec post-ship, they'll need to add an ELI16; this is the intended behavior.

## 2. Under-block

**What failure modes does this still miss?**

- An ELI16 file that satisfies the length requirement but contains low-quality / jargon-heavy / non-ELI16 prose. The gate checks file existence and length, not reading-level. This is intentional: deterministic check, no LLM judgment in a precommit hook. Reading-level enforcement happens at the human-review step (the user reads the overview before applying `approved: true`).
- An ELI16 file that's pure boilerplate copied from the template. The 800-char floor reduces this risk but doesn't eliminate it. Mitigation: the template's section headers are themselves substantive prompts requiring real content; copying without filling-in is hard to disguise at 800+ chars.

## 3. Level-of-abstraction fit

**Is this at the right layer? Should a higher or lower layer own it? Does a smarter gate already exist?**

Yes — this is at the same layer as the existing review-convergence and approved tag checks. Same deterministic-file-check shape, same precommit + convergence-write hook points, same shared concern (spec quality at handoff time). No smarter gate exists for "is the spec readable by the decider"; the existing gates verify that review *happened*, not that the spec is *legible*.

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic, or does it produce a signal?**

Authoritative, deterministic, structural. The check is file-existence + content-length — both verifiable, both stable, no LLM/regex/parsing surprises. This is the canonical shape for blocking authority per `docs/signal-vs-authority.md`: structural gates are allowed to block; brittle/heuristic gates produce signals for a smarter gate.

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, race?**

- **Order in precommit:** runs after spec-tag verification (`review-convergence`, `approved: true`). If either of those fails, the ELI16 check is never reached — single source of error at a time.
- **Order in spec-converge:** runs BEFORE the convergence tag is written. Prevents the asymmetric state where a spec is tagged converged but has no overview.
- **Duplicate check on commit:** both `write-convergence-tag.mjs` (at convergence time) and `instar-dev-precommit.js` (at commit time) verify the ELI16. This is intentional belt-and-suspenders — a spec that lost its ELI16 between convergence and commit (file deleted) is still caught at commit.
- **No race conditions.** Both checks are synchronous read-only file checks.

## 6. External surfaces

**Does it change anything visible to other agents, other users, other systems?**

- Other agents using `/instar-dev` against the instar repo will see the new check fire on any commit referencing a spec without an ELI16. Error message is explicit about how to fix (add a sibling file or declare via frontmatter).
- Users handed a spec by an agent will receive an ELI16 overview by default — this is the user-visible improvement that motivated the gate. Topic 3079 (2026-05-13) was the trigger.
- No timing dependencies, no conversation state, no runtime conditions. The check sees the filesystem at commit time, period.

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Single-line revert in each of two files: comment out the `checkEli16Overview` block in `scripts/instar-dev-precommit.js` (Step 7) and in `skills/spec-converge/scripts/write-convergence-tag.mjs` (pre-check). No data migration. No state mutation. No effect on already-tagged specs. The shared module `scripts/eli16-overview-check.mjs` becomes dead code until removed, but that's harmless. The template at `skills/instar-dev/templates/eli16-overview.md` remains as documentation. The next release picks up the revert automatically — no schema or wire-format change to coordinate.

## Trust elevation

Not applicable — no autonomy profile change, no new trust-level surface.

## Side-effects on adjacent systems

- `husky/pre-commit` calls `instar-dev-precommit.js`; no change to husky config.
- The release-cut publish gate is unaffected: ELI16 enforcement is at commit-time, not at release-cut time. Spec authors get the error at the point of authorship, where it's fastest to fix.
- Backup/sync: no new state files. The ELI16 companion is a regular spec sibling, gitignored or not per the repo's existing `.gitignore`.
