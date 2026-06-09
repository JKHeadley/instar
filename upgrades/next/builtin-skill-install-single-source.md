<!-- bump: minor -->
<!-- audience: agent-only -->

## What Changed

Every Instar agent now receives the **developer-skill toolkit** — the skills Instar uses to develop itself: `spec-converge`, `instar-dev`, `systematic-debugging`, `smart-web-fetch`, `knowledge-base`, `instar-scheduler`, `agent-memory`, `agent-identity`, `instar-identity`, `credential-leak-detector`.

These skills were git-tracked under `skills/` but **no code installed them**, and the directory was not in `package.json` `files[]` — so they shipped in no package and installed for no agent, including the main dev agent. That violated **Agent Awareness** ("a capability the agent doesn't know about, it effectively doesn't have") and **Framework-Agnostic** ("one shared source of truth, never hand-maintained per engine").

The fix: an authored `BUNDLED_DEV_SKILLS` allowlist + a generic `installBundledDevSkills()` copy-loop in `init.ts` (install-if-missing, recursive for `scripts/`/`templates/` subdirs); `skills/` added to `files[]` so the sources ship; the three port-hardcoded skill files rewritten to `${INSTAR_PORT:-4040}`; and a ratchet test that locks the "tracked-but-never-shipped" class shut. Existing agents receive the skills through the existing `migrateBuiltinSkills` path on update — no new migrator. `skills/` stays the single source (it is referenced there by `SourceTreeGuard`/`crossModelReviewer`).

This is the bounded, lowest-risk slice; the full single-source consolidation (materialize the inline-dict skills, generator-validates-against-allowlist) is the documented follow-on in the spec.

## What to Tell Your User

Internal capability — nothing to configure. Your agent now has the full set of Instar-development tools — the spec convergence cycle, the instar-dev workflow, structured debugging, and more — so it can help develop and improve Instar with the same tools Instar uses on itself.

## Summary of New Capabilities

| Capability | How to use |
|-----------|-----------|
| The developer-skill toolkit installs to every agent | Automatic on `init` and on update; the skills appear as slash commands in `.claude/skills/` |
| Add a skill to the canonical bundled set | Add the slug to `BUNDLED_DEV_SKILLS` in `src/commands/init.ts`; the ratchet test enforces it ships + installs |

## Evidence

Spec went through a 3-round `/spec-converge` (5 internal reviewers + a gemini cross-model pass) which caught 4 real flaws pre-code; operator-approved. Ratchet test `tests/unit/builtin-dev-skills.test.ts` — 6 assertions (source-present, ships via `files[]`, materializes-on-install, subdirs carried, no bare `localhost:<port>`, idempotent), green. `tsc --noEmit` clean. Convergence report: `docs/specs/reports/builtin-skill-install-single-source-convergence.md`.
