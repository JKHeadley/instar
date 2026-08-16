# Upgrade Guide — v1.0.1

<!-- bump: patch -->

## What Changed

The Codex provider-scaffolder now writes bundled skills to the path Codex 0.130 actually walks for project-scope discovery. The old layout silently failed — Codex never saw any of the skills the scaffolder installed.

Two related changes in `src/providers/adapters/openai-codex/integration/providerScaffolder.ts`:

1. Skill installation moved from `.agent/openai/skills/<name>/` to `.agents/skills/<name>/`. The plural `.agents/` (with a trailing `s`) is Codex 0.130's documented project-scope skill discovery path. The prior path (`.agent/openai/...`) was a co-location guess that Codex never looked at — every bundled skill we installed under it was invisible to the agent.

2. Each installed skill now also gets a sibling `agents/openai.yaml` inside its own directory (`.agents/skills/<name>/agents/openai.yaml`), generated from the skill's frontmatter. The YAML carries `interface.display_name` and `interface.short_description`. Codex requires this sibling to surface the skill in UI lists and chips; without it the skill loads but is undiscoverable.

The provider-config tree at `.agent/openai/` (AGENTS.md, config.toml, hooks.json) is unchanged — that's the Instar-standardized per-provider config bucket and Codex doesn't walk it for skills.

`uninstall()` now removes both `.agent/openai/` and `.agents/skills/` to match the install footprint.

This is the first concrete fix landing from the framework-functional-parity foundational work. Future framework-parity work will follow the same pattern: align scaffolder output to what each framework actually loads at the file-discovery layer.

## What to Tell Your User

- "Skills you bundle for Codex sessions are now actually visible to Codex. Before this fix they were being written to a location Codex doesn't look at, so they loaded but never appeared in skill lists."
- "No action needed on your end. Existing scaffolds will pick up the correct layout the next time the scaffolder installs."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Codex skill discovery (project-scope) | Automatic — scaffolder writes `.agents/skills/<name>/SKILL.md` + sibling `agents/openai.yaml` |
| Codex skill UI metadata | Automatic — generated from each skill's frontmatter (`name`, `description`, `metadata.short-description`) |

## Evidence

The bug was reproducible against Codex 0.130 with the prior layout:

- **Before**: `.agent/openai/skills/hello-instar/SKILL.md` created by the scaffolder. Running `codex` in the project directory and asking "what skills are available?" returned no project-scope skills. Direct filesystem inspection confirmed the file existed; Codex was not walking that path.
- **After**: `.agents/skills/hello-instar/SKILL.md` + `.agents/skills/hello-instar/agents/openai.yaml` created by the scaffolder. Layout matches the on-disk format of Codex's own installed skills under `~/.codex/skills/.system/<name>/` — `SKILL.md` at the root, `agents/openai.yaml` as a sibling subdirectory.

YAML format anchored to Codex's documented spec at `~/.codex/skills/.system/skill-creator/references/openai_yaml.md` — `interface.display_name` and `interface.short_description` are the documented required fields; we generate both from frontmatter.

Unit tests cover: correct path written, legacy wrong path not written, YAML sibling emitted at correct location, display_name derived from skill name when frontmatter omits it, short_description sourced from `metadata.short-description` (canonical Codex skill format) with fallback to top-level `description`, long descriptions truncated to 64 chars per spec, `uninstall()` removes both trees, multiple skills handled in one install call, YAML escapes double quotes in string values.

Test file: `tests/unit/providers/adapters/openai-codex/providerScaffolder.test.ts` (14 tests, all passing). Full openai-codex adapter suite: 78/78 passing. Typecheck: clean.
