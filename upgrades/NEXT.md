# Upgrade Guide — v1.0.2

<!-- bump: patch -->

## What Changed

Ships the Skill concept spec, two per-framework rendering specs, and a first concrete parity rule + registry that consumes them. Three categories of work in this release:

**Spec docs (pure docs, no behavior change on their own):**
- `specs/instar-concepts/skill.md` — formal Layer-3 definition of the Skill primitive, framework-agnostic. Carries `review-convergence` and `approved` frontmatter after a 6-of-7 reviewer convergence round on 2026-05-18 (Grok was not available this session).
- `specs/instar-concepts/skill.eli16.md` — plain-English companion.
- `specs/frameworks/claude-code/skills.md` — Claude rendering contract.
- `specs/frameworks/codex-cli/skills.md` — Codex rendering contract (path + sibling `agents/openai.yaml` shape).

**Parity rule + registry (new code, opt-in — no auto-run yet):**
- `src/providers/parity/types.ts` — `ParityRule` contract, `ParityMismatch` shape with reason-code enum, framework slot widened to include `'canonical'` for source-layer issues.
- `src/providers/parity/registry.ts` — minimal `ParityRegistry` holding rules; future `FrameworkParitySentinel` will consume this.
- `src/providers/parity/rules/skillParityRule.ts` — first concrete rule. Strict slug grammar at every entry point (path-traversal safe), `js-yaml` FAILSAFE parsing (fail-loud on errors and git-merge-conflict markers), symmetric verify (canonical → renderings AND renderings → canonical for orphans), `x-instar-stamp` field on rendered files to distinguish user-edits from canonical drift, description sanitization (control chars stripped, length capped at 256 chars), refuses to auto-remediate `user-edit-conflict` cases.

**Hardening surfaced by the convergence round (already applied):**
- C1 path traversal via name — strict slug grammar (`^[a-z0-9][a-z0-9-]{0,63}$`) enforced at every entry point.
- C2 hand-rolled YAML parser — replaced with `js-yaml` (FAILSAFE schema).
- C5 orphan detection — symmetric verify + `listOrphans()` + `removeOrphans()`.
- C7 user-edit destruction — `x-instar-stamp` + `user-edit-conflict` distinction; remediate refuses to overwrite.
- C8 description prompt-injection surface — control-char strip + length cap.
- H1 dir-name vs frontmatter-name authority — dir name authoritative; mismatch is `canonical-read-error`.
- H5 canonical-read error tagging — `framework: 'canonical'` slot added.

**Deferred (tracked in spec, NOT in this release):**
- Backfill migration that scans existing `.claude/skills/` + `.agents/skills/` and populates canonical at `.instar/skills/`. Without this, the parity rule is a structural no-op on existing agents (their canonical dir is empty). The rule works correctly on agents that have canonical content; unit tests synthesize canonical to cover the happy path.
- `allowed-tools` rendering (Claude frontmatter + Codex `dependencies.tools`) — lands with the Tool primitive.
- Atomic-write (tempfile + rename) — narrows the race window further; single-machine + single-sentinel-pass makes the current write-pattern safe enough for v0.1.
- BackupManager default-includes update for `.instar/skills/` — separate PR.
- CLAUDE.md template update referencing canonical path — separate PR.

## What to Tell Your User

- "We've shipped the first piece of a system that keeps your skills in sync across the agent frameworks we support. Right now it works on new skills you create through the canonical path; existing skills won't be touched until a follow-up backfill migration lands."
- "No action needed on your end."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Skill parity rule (programmatic) | Available via `import { skillParityRule } from 'src/providers/parity/registry'`. No automatic run yet — sentinel that consumes the registry is a separate follow-up. |
| Strict slug grammar for canonical skills | Enforced automatically; canonical with invalid names rejected at read time. |
| User-edit-conflict detection | Automatic — rendered SKILL.md carries `x-instar-stamp` and verify distinguishes user-edits from canonical drift. |
| Orphan rendered-skill cleanup | Programmatic via `skillParityRule.removeOrphans(projectRoot, framework)`. |
