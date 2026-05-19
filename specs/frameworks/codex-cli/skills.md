---
title: "Codex CLI — Skill rendering"
slug: "frameworks-codex-cli-skills"
framework: "codex-cli"
primitive: "skill"
parent-concept: "specs/instar-concepts/skill.md"
verified-against: "Codex CLI 0.130"
---

# Codex CLI — Skill rendering

## What Codex CLI does

Codex 0.130 discovers and loads skills from two scopes (mirror of Claude's pattern but at different paths):

- **Project-local**: `.agents/skills/<name>/SKILL.md` at the project root. **Note the plural `.agents/`** (with a trailing `s`) — singular `.agent/` is not walked.
- **User-global**: `~/.codex/skills/<name>/SKILL.md` (managed by Codex's own marketplace + installer flows, not by Instar's rendering layer).

Instar renders only to the project-local scope.

## File layout Codex CLI expects

```
.agents/
└── skills/
    └── <name>/
        ├── SKILL.md            ← required
        ├── agents/
        │   └── openai.yaml     ← REQUIRED for UI surfacing
        ├── scripts/            ← optional
        ├── references/         ← optional
        └── assets/             ← optional
```

The `agents/openai.yaml` sibling is required for the skill to appear in Codex's UI lists + chips. Without it, the skill loads (the body is in context when invoked) but the user can't discover it through the UI surface.

## Frontmatter shape (SKILL.md)

```yaml
---
name: string                  # required
description: string           # required
metadata:
  short-description: string   # optional — short form for UI lists
---
```

Note `short-description` is nested under `metadata:` — this is Codex's convention. Claude reads top-level keys only.

## openai.yaml shape (sibling)

Anchored to Codex's own documented spec at `~/.codex/skills/.system/skill-creator/references/openai_yaml.md`.

Minimal:

```yaml
interface:
  display_name: "Human-facing title"
  short_description: "Short UI description (25-64 chars)"
```

Optional additions:

```yaml
interface:
  display_name: "..."
  short_description: "..."
  icon_small: "./assets/icon-small.png"
  icon_large: "./assets/icon-large.svg"
  brand_color: "#3B82F6"
  default_prompt: "Use $skill-name to ..."

dependencies:
  tools:
    - type: "mcp"
      value: "github"
      description: "..."
      transport: "streamable_http"
      url: "..."

policy:
  allow_implicit_invocation: true   # default true
```

Instar's renderer emits the minimal form by default. Optional fields are emitted when the canonical SKILL.md declares them (via `icon-small`, `icon-large`, `brand-color`, `allowed-tools` → `dependencies.tools`, etc.). See "Frontmatter mapping" below.

## Discovery + loading lifecycle

1. **Session start** — Codex scans `.agents/skills/` + `~/.codex/skills/`. For each skill, it reads BOTH `SKILL.md` (for the body's metadata layer) AND `agents/openai.yaml` (for the UI metadata layer). Skills missing `agents/openai.yaml` load into the model's metadata but don't surface in the picker.
2. **Project trust prerequisite** — Codex requires the project to be marked `trust_level = "trusted"` in `~/.codex/config.toml` for skill auto-discovery. Untrusted projects show a prompt instead. This is a Codex-level config, not a skill-level config; Instar doesn't manage it (operator action).
3. **User invocation** — `$<name>` or `/<name>` in chat triggers the skill. Body of `SKILL.md` loads into context.
4. **Bundled resources** — same lazy-load pattern as Claude.

## Rendering from canonical

Per `specs/instar-concepts/skill.md`, the canonical lives at `.instar/skills/<name>/`. The renderer for Codex:

1. **Path**: write `.agents/skills/<name>/SKILL.md` + `.agents/skills/<name>/agents/openai.yaml`.
2. **Frontmatter transform for SKILL.md**:
   - `name` → `name` (verbatim)
   - `description` → `description` (verbatim)
   - `metadata.short-description` → `metadata.short-description` (verbatim if present; otherwise derived from `description` truncated to 64 chars)
   - Other canonical fields (`allowed-tools`, `user-invocable`) → NOT in Codex SKILL.md frontmatter (they go in `openai.yaml` per the mapping below)
3. **openai.yaml emission**:
   - `interface.display_name` ← `name` (humanized: `kebab-case` → `Title Case`)
   - `interface.short_description` ← `metadata.short-description` if present, else `description` truncated to 64 chars
   - `interface.icon_small` ← canonical `icon-small` (verbatim, as relative path)
   - `interface.icon_large` ← canonical `icon-large` (verbatim)
   - `interface.brand_color` ← canonical `brand-color` (verbatim)
   - `dependencies.tools` ← derived from canonical `allowed-tools` (each tool entry mapped; MCP tools emit MCP server config)
4. **Body**: SKILL.md body verbatim copy.
5. **Sibling subdirs** (`scripts/`, `references/`, `assets/`): mirrored byte-for-byte from canonical.

## Known quirks

- **Plural `.agents/` matters**: writing to `.agent/openai/skills/` (singular `.agent/`, with an `openai/` segment) doesn't work. This was the PR #249 fix.
- **`agents/openai.yaml` location is per-skill**: `.agents/skills/<name>/agents/openai.yaml` — NOT a single project-root `agents/openai.yaml`. Each skill has its own sibling YAML.
- **`trust_level="trusted"`** is a Codex per-project config, not part of any skill's YAML. Belongs in `~/.codex/config.toml` under `[projects."<absolute-project-path>"]`. Not Instar's responsibility to set.
- **YAML field naming**: Codex uses `snake_case` (`display_name`, `short_description`); SKILL.md frontmatter uses `kebab-case` for some fields (`short-description`). The renderer handles the conversion.
- **Skill name → invocation surface**: both `$<name>` and `/<name>` work in Codex chat. The `$` form is the documented preferred form per Codex's skill-creator docs.
- **Frontmatter `name` vs YAML `display_name`**: `name` is the slug used in the invocation surface and file path. `display_name` is the UI-facing human-readable title. Renderer derives `display_name` from `name` if canonical doesn't provide one explicitly.
- **`dependencies.tools` with MCP**: only `type: "mcp"` is supported per the documented spec as of Codex 0.130. Other tool types may not parse.
- **`policy.allow_implicit_invocation: false`**: equivalent to Claude's `user-invocable: false` — the skill is not auto-injected into context but can still be invoked explicitly.

## Parity verification

For each canonical skill at `.instar/skills/<name>/`, the parity rule verifies:

1. `.agents/skills/<name>/SKILL.md` exists.
2. SKILL.md's frontmatter `name` matches canonical `name`.
3. SKILL.md's frontmatter `description` matches canonical `description`.
4. SKILL.md's body matches canonical body byte-for-byte.
5. `.agents/skills/<name>/agents/openai.yaml` exists.
6. openai.yaml's `interface.display_name` matches the canonical-derived value.
7. openai.yaml's `interface.short_description` matches the canonical-derived value.
8. `scripts/`, `references/`, `assets/` subdirs (if present in canonical) are mirrored.

On any mismatch: emit `parity:drift` with `{primitive: 'skill', skillName, framework: 'codex-cli', mismatchReason}`. Remediation: re-render from canonical.

## Version + verification status

- **Verified against**: Codex CLI 0.130.0.
- **Last live verification**: 2026-05-18 (PR #249 scaffolder path correction; on-disk format inspected against installed Codex skills under `~/.codex/skills/.system/`).
- **Risk surface**: Codex's skill discovery + openai.yaml format are documented in skill-creator's own `references/openai_yaml.md`, which is a Codex-shipped artifact. Format drift would surface there first.
