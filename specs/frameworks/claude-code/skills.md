---
title: "Claude Code — Skill rendering"
slug: "frameworks-claude-code-skills"
framework: "claude-code"
primitive: "skill"
parent-concept: "specs/instar-concepts/skill.md"
---

# Claude Code — Skill rendering

## What Claude Code does

Claude Code discovers and loads skills from two scopes:

- **Project-local**: `.claude/skills/<name>/SKILL.md` at the project root.
- **User-global**: `~/.claude/skills/<name>/SKILL.md` in the user's home (managed separately by Claude Code, not by Instar's rendering layer).

Instar only renders to the project-local scope. User-global skills are out of scope for parity (they're per-machine and survive across projects).

## File layout Claude Code expects

```
.claude/
└── skills/
    └── <name>/
        ├── SKILL.md            ← required
        ├── scripts/            ← optional, executable resources
        ├── references/         ← optional, on-demand context
        └── assets/             ← optional, output resources
```

Claude reads only `SKILL.md` at session start to populate the skill metadata layer. The body + bundled resources load lazily when the skill triggers.

## Frontmatter shape

Claude expects YAML frontmatter at the top of SKILL.md with these fields:

```yaml
---
name: string              # required
description: string       # required
user-invocable: bool      # optional, default true — show in /skill picker
allowed-tools: string[]   # optional — restrict which tools the skill can call
---
```

All top-level keys. No nesting.

## Discovery + loading lifecycle

1. **Session start** — Claude scans `.claude/skills/` and `~/.claude/skills/`, reads each `SKILL.md`'s frontmatter (name + description), holds them in its metadata layer.
2. **User invocation** — `/<name>` in chat OR a natural-language intent matching `description` triggers the skill. At that point Claude loads the body of `SKILL.md` into context.
3. **Bundled resources** — the body can instruct Claude to read files from `scripts/`, `references/`, or `assets/`; these load on demand.

## Rendering from canonical

Per `specs/instar-concepts/skill.md`, the canonical lives at `.instar/skills/<name>/`. The renderer for Claude:

1. **Path**: write `.claude/skills/<name>/SKILL.md`
2. **Frontmatter transform**:
   - `name` → `name` (verbatim)
   - `description` → `description` (verbatim)
   - `allowed-tools` → `allowed-tools` (verbatim if present)
   - `user-invocable` → `user-invocable` (verbatim if present)
   - `metadata.short-description` → dropped (Claude doesn't read it)
   - `icon-small` / `icon-large` / `brand-color` → dropped (Claude doesn't read them)
3. **Body**: verbatim copy.
4. **Sibling subdirs** (`scripts/`, `references/`, `assets/`): mirrored byte-for-byte from canonical.

## Known quirks

- **Frontmatter case-sensitivity**: Claude expects lowercase keys (`name`, `description`). `Name` or `Description` are not recognized.
- **No sibling YAML required**: unlike Codex, Claude doesn't need an `agents/openai.yaml` or equivalent. SKILL.md's frontmatter is the metadata source.
- **Settings file interaction**: `.claude/settings.json` controls hooks + permissions but does NOT affect skill discovery. Skills are discovered independently.
- **`user-invocable: false`** suppresses the skill from the `/skill` picker but the skill can still trigger via natural-language description matching. Useful for "internal" skills the user doesn't directly invoke.
- **Skill name → slash command**: the slash command is `/<name>` — no namespace prefix. If two skills have the same `name` (project-local + user-global), project-local wins.

## Parity verification

For each canonical skill at `.instar/skills/<name>/`, the parity rule (`src/providers/parity/rules/skillParityRule.ts`) verifies:

1. `.claude/skills/<name>/SKILL.md` exists.
2. SKILL.md's frontmatter `name` matches canonical `name`.
3. SKILL.md's frontmatter `description` matches canonical `description`.
4. SKILL.md's body matches canonical body byte-for-byte.
5. `scripts/`, `references/`, `assets/` subdirs (if present in canonical) are mirrored.

On any mismatch: emit `parity:drift` with `{primitive: 'skill', skillName, framework: 'claude-code', mismatchReason}`. Remediation: re-render from canonical.

## Version + verification status

- **Verified against**: Claude Code 2.x (specific version varies; behavior has been stable since 1.x).
- **Last live verification**: ongoing — skills are part of Echo's own daily operation, so behavior changes would surface quickly.
