# Side-Effects Review: Codex parity P2 — asdf binary detection + dashboard model badge

## Change
Two independent, low-risk fixes from the APPROVED master spec (`docs/specs/codex-full-parity-fixes.md`, approved by Justin 2026-05-24 23:21 PDT):

1. **`src/core/Config.ts` `detectFrameworkBinary`** — now searches asdf shims (`$ASDF_DATA_DIR/shims/<name>` or `~/.asdf/shims/<name>`) and probes `asdf which <name>`, before the final PATH fallback. Fixes the portability bug where a CLI installed only via asdf (very common) was invisible to instar because the launchd/login PATH excludes the shims dir — so `detectCodexPath()` returned null and a Codex agent couldn't spawn.

2. **`src/core/SessionManager.ts` + `src/core/types.ts`** — session records now store the framework-RESOLVED model (`resolveModelForFramework(framework, model)`) instead of the raw tier alias, and carry a new `framework` field. Fixes the dashboard model-badge gap: a Codex-only agent's sessions showed "haiku"/"sonnet" (Claude tier aliases) because the record stored the caller's tier, not the gpt-5.x the launcher actually resolved.

## Why
- **asdf**: live-proven on codey — codex 0.133 lives only at `~/.asdf/shims/codex`; with a launchd-style PATH (`which codex` fails), `detectFrameworkBinary('codex')` now returns the shim. This is the durable fix for the manual `frameworkBinaryPaths` override that unblocked codey earlier.
- **Model badge**: visually confirmed on codey's dashboard (badges "haiku"/"opus" while Codex's own TUI showed gpt-5.5). The engine resolves the model correctly at launch (frameworkSessionLaunch.ts:64-66); only the stored/displayed value was wrong.

## Scope / blast radius
- `detectFrameworkBinary`: pure runtime function; the asdf branch only adds candidates + one `asdf which` probe (silently skipped if asdf absent / name unmanaged). No behavior change on machines without asdf. Preserves the existing contract (returns an existing absolute path or null). NO migration needed — core runtime code ships with the new dist on update.
- Model badge: `resolveModelForFramework` is a pure mapping (haiku→gpt-5.2 etc. for Codex; pass-through for Claude). For claude-code agents the stored model is unchanged (passes through), so zero behavior change there. New `framework` field is optional (`framework?:`), undefined on legacy records — backward compatible. Affects NEW session records only; existing records age out.

## Signal vs Authority
- Unchanged. Neither fix touches any gate's signal/authority split. detectFrameworkBinary is detection; the model/framework fields are display metadata.

## Over-block / autonomy risk
- None. No gating logic touched.

## Migration parity
- detectFrameworkBinary: runtime code, ships with dist (no agent-installed file).
- Session model/framework: runtime record-writing; no migration of existing records needed (forward-only; legacy records simply lack the field, which the dashboard tolerates).

## Known follow-ups (tracked, not orphaned)
- Interactive Codex sessions with no explicit model still leave `model` undefined; the dashboard's frontend badge defaults such records to a Claude tier ("opus"). Now that the record carries `framework`, a small frontend tweak can show the engine instead. Tracked under codex-full-parity P2. <!-- tracked: codex-full-parity -->
- `spawnTriageSession` is a Claude-only internal path (uses `--permission-mode`/`--allowedTools`); not given a framework field this round. Tracked. <!-- tracked: codex-full-parity -->

## Rollback
- Revert the Config.ts asdf block and the SessionManager/types edits. No data migration, no config change, no on-disk artifact.

## Tests
- `tests/unit/detectFrameworkBinary.test.ts`: +2 (asdf shim resolution via ASDF_DATA_DIR; source-level guard that the asdf dir is searched). 8 green.
- `tests/unit/session-manager-behavioral.test.ts`: +1 (Codex session records resolved gpt-5.2 for `haiku`, not the alias; framework field set) and the existing claude test now also asserts framework='claude-code'. 23 green.
- Live test-as-self: asdf detection proven on codey (shim resolved under asdf-less PATH); model-badge live-proof batched with the rest of the build before merge.

## Publish
- Feature branch `echo/codex-parity-audit` (rebased onto JKHeadley/main before PR). Patch release on merge.
