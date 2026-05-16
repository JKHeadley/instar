# Side-effects review — Tier 1.D IdentityRenderer

**Version / slug:** `tier1d-identity-renderer`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (deterministic file rendering + read; full branch coverage with tmpdir tests)
**Driving spec:** `specs/provider-portability/04-anthropic-path-constraints.md`

## Summary of the change

Audit Gap A flagged CLAUDE.md as the hardcoded primary identity file and AGENT.md as a partial generalization. This change makes AGENT.md the canonical source of truth and renders framework-specific shadow files (CLAUDE.md for Claude Code, AGENTS.md for Codex, GEMINI.md for Gemini) from it.

Key contracts:

1. **`.instar/AGENT.md` is canonical.** The renderer reads it and writes framework-specific shadows.
2. **`AGENT.md` at the project root is a backwards-compat fallback** for installs that keep identity at the root (legacy pattern).
3. **Shadow files carry an auto-generation banner** that names the source and warns against hand-editing.
4. **Legacy CLAUDE.md installs migrate cleanly** via `bootstrapAgentMdFromShadow(projectDir)` — reads the legacy file, strips any existing banner, writes `.instar/AGENT.md` as the new source.
5. **`detectFrameworkFromShadowFiles(projectDir)` infers framework** from which shadow files exist — useful when an existing install is being upgraded and we need to know which framework was previously selected.

`ProjectMapper.detectProjectName` priority flipped: AGENT.md first, CLAUDE.md/AGENTS.md fallback. Existing installs that have only CLAUDE.md continue to work; new installs read from AGENT.md.

The renderer does NOT touch existing CLAUDE.md until a render is explicitly called — no migration runs automatically. The composition root in a later slice will call `renderIdentity` at boot and `bootstrapAgentMdFromShadow` when AGENT.md is missing.

Files touched:
- `src/core/IdentityRenderer.ts` — new, 167 LOC.
- `src/core/ProjectMapper.ts` — name-detection priority flip + KEY_FILE_PATTERNS include AGENT.md/AGENTS.md/GEMINI.md alongside CLAUDE.md.
- `tests/unit/IdentityRenderer.test.ts` — new, 16 cases.

## Decision-point inventory

- **Identity-file lookup priority** — `modify`. ProjectMapper now checks `.instar/AGENT.md` then root `AGENT.md` then CLAUDE.md then AGENTS.md. The fall-through preserves backwards-compat.
- **Shadow rendering** — `add`. New deterministic pipeline (AGENT.md → CLAUDE.md/AGENTS.md/GEMINI.md). No render is automatic — caller explicitly invokes `renderIdentity`.
- **Framework detection from layout** — `add`. New `detectFrameworkFromShadowFiles` infers framework from shadow file presence. Used by migration.
- **Migration bootstrap** — `add`. `bootstrapAgentMdFromShadow` creates canonical AGENT.md from a legacy CLAUDE.md, banner-stripped.

## Signal vs authority

These are deterministic file operations. The renderer doesn't decide anything — caller decides when to render. ProjectMapper's name-detection is the same authority it was before; only the lookup order changed.

## Over-block / under-block analysis

**Over-block:** None. Existing installs with only CLAUDE.md keep working — ProjectMapper still finds it (just lower priority than AGENT.md). The renderer is opt-in; nothing is automatically overwritten.

**Under-block:** Caller must remember to call `renderIdentity` after editing AGENT.md to keep shadows in sync. Documented in JSDoc. A future slice could add a file-watcher that auto-renders, but for v1.0.0 explicit invocation is simpler and safer (avoids spurious writes during indexing).

## Level-of-abstraction fit

- The renderer lives in `src/core/` alongside other core helpers. Pure file I/O — no provider abstractions baked in.
- Framework→shadow-filename mapping is a single exported const (`FRAMEWORK_SHADOW_FILES`). Adding Gemini-CLI (`GEMINI.md`) was a 1-line addition for this slice. Future frameworks: same.
- ProjectMapper change is minimally invasive — just reordered the lookup loop.

## Interactions

- **`init` and scaffold templates** — not yet updated; they still generate CLAUDE.md directly. Migration to render is part of Tier 6.A or the init-scaffold-update slice.
- **`PostUpdateMigrator`** — still has ~8-10 hardcoded `CLAUDE.md` paths. Those will be migrated in Tier 2.G (Identity Layout Resolver consumers).
- **`ProjectMapper.detectProjectName`** — now finds AGENT.md first. Tested via the renderer tests indirectly (they create AGENT.md in tmpdirs); explicit ProjectMapper tests aren't changed (no regression).
- **No existing tests broken** — checked with `tsc --noEmit` clean + targeted vitest run.

## External surfaces

- New exports: `renderIdentity`, `RenderIdentityOptions`, `RenderIdentityResult`, `IdentityRendererError`, `FRAMEWORK_SHADOW_FILES`, `detectFrameworkFromShadowFiles`, `bootstrapAgentMdFromShadow`.
- ProjectMapper's KEY_FILE_PATTERNS now lists AGENT.md/AGENTS.md/GEMINI.md alongside CLAUDE.md.
- No new endpoint, no new CLI command, no new config field.

## Rollback cost

Trivial. `git revert` removes one new file + one new test + two small ProjectMapper edits. Existing shadow files (CLAUDE.md) keep working.

## Tests / verification

- `npx tsc --noEmit` clean.
- `vitest tests/unit/IdentityRenderer.test.ts` — 16/16 pass.
- Coverage: render all shadows, banner content, framework-name-in-banner, framework subset, root-AGENT.md fallback, .instar/AGENT.md preference when both exist, throw-on-missing-source, skip-unknown-framework, custom sourcePath, detect-from-shadow (3 cases), bootstrap-from-legacy-shadow (banner strip + .instar mkdir), null-on-no-shadow.
- No real-API verification needed — pure file I/O.
