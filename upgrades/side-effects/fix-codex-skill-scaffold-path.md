# Side-Effects Review — Codex skill scaffold path correction

**Version / slug:** `fix-codex-skill-scaffold-path` (v1.0.1)
**Date:** 2026-05-18
**Author:** Echo

## Summary of the change

Two corrections to `src/providers/adapters/openai-codex/integration/providerScaffolder.ts`:

1. Skill bundles installed under `.agents/skills/<name>/` (Codex 0.130's project-scope discovery path) instead of `.agent/openai/skills/<name>/` (the prior path, which Codex never walked).
2. Each installed skill now also gets a sibling `agents/openai.yaml` file inside its own directory, generated from skill frontmatter (`display_name` derived from `name`, `short_description` sourced from `metadata.short-description` with fallback to `description`, truncated to 64 chars). This file is required by Codex to surface the skill in UI lists.

Provider-config tree (`AGENTS.md`, `config.toml`, `hooks.json` under `.agent/openai/`) is unchanged. `uninstall()` now removes both trees to match install footprint.

**Files changed (source):**
- `src/providers/adapters/openai-codex/integration/providerScaffolder.ts` — skill-path correction + YAML sibling emission + frontmatter parser

**Files changed (tests):**
- `tests/unit/providers/adapters/openai-codex/providerScaffolder.test.ts` — 14 new tests

**Files changed (release notes):**
- `upgrades/NEXT.md` — v1.0.1 release notes
- `package.json` — version bump 1.0.0 → 1.0.1

## Decision-point inventory

- **Skill path: `.agents/skills/<name>/` vs `.agent/openai/skills/<name>/`** — fix (move to the path Codex 0.130 actually walks). Verified against Codex's on-disk skill layout at `~/.codex/skills/.system/<name>/` and Codex's own `skill-creator` documentation at `~/.codex/skills/.system/skill-creator/references/openai_yaml.md`.
- **YAML sibling location: `agents/openai.yaml` inside each skill dir vs at project root** — fix as per-skill sibling (matches Codex's installed-skill layout; the prior summary that said "project root" was wrong).
- **YAML format: minimal vs full** — minimal. Only `interface.display_name` and `interface.short_description` are emitted. Optional fields (icons, brand color, default_prompt, dependencies, policy) are NOT emitted — they require per-skill content the scaffolder doesn't have. Skills can override by including their own `agents/openai.yaml` in their bundle (current scaffolder always overwrites; a follow-up could respect an asset-provided yaml).
- **`trust_level="trusted"` in the YAML** — NOT emitted. Despite earlier verification notes suggesting it was required, inspection of real installed Codex skills shows no `trust_level` field in `agents/openai.yaml` (it's a project-level config in `~/.codex/config.toml`, not skill-level). Emitting it from the scaffolder would be incorrect.
- **Provider-config tree path** — unchanged. `.agent/openai/AGENTS.md`/`config.toml`/`hooks.json` continues to live where Instar puts it. Whether Codex reads `AGENTS.md` from project root vs from `.agent/openai/` is a separate question not in scope for this fix.

---

## 1. Over-block

None. The change is additive at the new location and silent-removal at the wrong location. No previously-working behavior is blocked.

## 2. Under-block

None. The scaffolder is not a gate — it's an installer. There is no decision boundary being widened or narrowed.

## 3. Level-of-abstraction fit

Correct. The fix lives entirely in the `ProviderScaffolder` adapter layer for openai-codex. Generic `ProviderScaffolder` contract is unchanged; only the codex-specific implementation's on-disk layout is corrected. Other framework adapters (anthropic-headless) are untouched.

## 4. Signal vs authority

Not applicable — no LLM gate, no policy decision. Pure scaffolding logic.

## 5. Interactions

- **Consumers of `bundledAssets`** (instar init, setup wizard, migration code): No interface change. Same `ScaffoldAsset` input; output paths change. Callers that hard-coded the old path would break — `grep` confirms no such callers in src/ or tests/.
- **Other adapters**: Anthropic-headless ProviderScaffolder is unchanged. Its `.agent/anthropic/` tree is unaffected.
- **Conformance suite**: Shape-only; not affected by path changes.
- **IdentityRenderer**: Renders AGENTS.md to project root for Codex sessions independently of scaffolder; not affected.

## 6. External surfaces

- **Public API**: `ProviderScaffolder` interface unchanged.
- **CLI surface**: None directly. Scaffolder is invoked programmatically.
- **On-disk surface (the actual side-effect)**: Two paths change for Codex-using agents installing skills via the scaffolder:
  - Created: `.agents/skills/<name>/SKILL.md` (+ `agents/openai.yaml`)
  - Not created: `.agent/openai/skills/<name>/SKILL.md`

No agent today depends on the wrong-path skills being present (Codex never saw them), so no migration is needed for skills that were "installed" under the bad path — they were dead files. Operators may want to manually delete any leftover `.agent/openai/skills/` directories in existing projects. Documented as a follow-up; not blocking this PR.

## 7. Rollback cost

Trivial. Revert the commit:
- `git revert` brings back the old (broken) path.
- Existing `.agents/skills/<name>/` directories created post-fix would remain on disk but become orphaned (Codex's auto-cleanup or operator action handles).
- No data loss; SKILL.md content is identical, only location differs.

## Tests

- New: `tests/unit/providers/adapters/openai-codex/providerScaffolder.test.ts` — 14 tests covering correct path, legacy wrong path absence, YAML sibling location, display_name derivation, short_description sourcing + fallback + truncation, SKILL.md verbatim writing, provider-config tree coexistence, no `.agents/` dir when no skills bundled, `created[]` reporting, multi-skill install, uninstall removing both trees, install idempotency, YAML escape of double quotes in string values.
- Full openai-codex adapter suite: 78/78 passing.
- Typecheck (`tsc --noEmit`): clean.

## Evidence

The bug was reproducible: bundling a skill via the scaffolder produced a `.agent/openai/skills/<name>/SKILL.md` file that no Codex session could see. The on-disk layout of Codex's own installed skills at `~/.codex/skills/.system/<name>/` was confirmed to follow the corrected layout (SKILL.md + agents/openai.yaml as a sibling subdirectory). YAML format anchored to Codex's documented spec (`~/.codex/skills/.system/skill-creator/references/openai_yaml.md`).

Live end-to-end verification with a running Codex agent is queued as a follow-up — local `codex exec` smoke tests against ChatGPT-subscription auth failed with model-availability errors unrelated to this fix. The unit tests + on-disk format match against real installed skills + adherence to documented YAML spec provide structural confidence; full end-to-end depends on a healthy Codex session.
