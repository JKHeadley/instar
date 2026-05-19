---
title: "Skill — Instar concept spec"
slug: "skill-concept"
author: "echo"
status: "converged"
type: "concept-spec"
eli16-overview: "skill.eli16.md"
review-convergence: "2026-05-19T01:05:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T01:05:00Z"
review-report: "docs/specs/reports/skill-concept-convergence.md"
review-deviation: "6-of-7 reviewers in round 1 (Grok unavailable, no XAI_API_KEY); round 2 deferred per autonomous-mode hybrid C scope decision documented in the convergence report"
approved: true
approved-by: "Justin (pre-authorized 2026-05-18, autonomous-mode hybrid C)"
approved-date: "2026-05-19"
approval-note: "Pre-authorized auto-approval after convergence + alignment check with foundational specs (framework-functional-parity + required-primitives-inventory). Alignment verified: layered model intact (Layer 3 functional primitive with substrate dependencies on agenticSession + toolAccess + toolAllowlist declared), required-classification correct, what-is-NOT boundary respected (intent classifier kept out, MCP kept out, sandbox kept out)."
---

# Skill — Instar concept spec

## What this is

The **Skill** primitive is the first formally-specified Layer-3 required functional primitive from the framework-functional-parity foundational work. This spec defines what a Skill *is* in Instar terms — independent of any framework's specific file layout, frontmatter convention, or discovery mechanism — so that the per-framework specs (`specs/frameworks/<framework>/skills.md`) and the eventual parity rule (`src/providers/parity/rules/skillParityRule.ts`) have a single source of truth to render from and verify against.

This is the prototype shape every subsequent primitive concept spec (Hook, Agent, Tool, Memory) will follow.

## Primitive identity

| Field | Value |
|---|---|
| Layer | 3 (functional) |
| Classification | Required |
| Foundational-spec reference | `specs/instar-foundations/required-primitives-inventory.md` → entry #1 |
| Substrate dependencies | `agenticSession`, `toolAccess`, `toolAllowlist` |

## Definition

A **Skill** is a reusable behavioral capability — a markdown instruction file plus optional bundled scripts, references, and assets — that the agent can invoke explicitly via a slash-command surface AND that is automatically considered by the model based on a natural-language description.

Three things make something a Skill (versus a plain prompt template or a tool):

1. **Discoverable identity.** It has a stable `name` that maps to a `/<name>` slash command AND a `description` short enough to fit in the model's metadata-loading budget.
2. **Lazy body.** The body of the skill (instructions, references, scripts) is loaded into context ONLY when the skill triggers — either via explicit slash invocation or via the model recognizing the description matches the user's intent.
3. **Bundled resources.** The skill can carry scripts, references, and asset files in sibling subdirectories that the skill body refers to.

A Skill is NOT:
- A single-prompt template (no lazy loading, no bundled resources).
- A tool (a tool is invoked mid-turn by the model; a skill orients the agent toward a workflow).
- A persona (a persona has its own session — an Agent primitive, spec TBD).

## Canonical source-of-truth

Per the foundational spec's gap-fill principle, Instar defines the canonical master format. Each enabled framework's per-framework spec describes how Instar renders that master into the framework's native discovery shape.

**Canonical path (on a deployed agent):** `.instar/skills/<name>/`

**Slug grammar (load-bearing).** Skill `<name>` must match `^[a-z0-9][a-z0-9-]{0,63}$` (lowercase alphanumeric + hyphens, starts with alnum, max 64 chars). The grammar is enforced at every entry point — directory listing, frontmatter parsing, every renderer's path construction. Path traversal (`../etc`, `/abs/path`, names with spaces or capitals) is rejected at the canonical-read layer, before any write ever runs. This makes the `mirror-trust` auto-remediate path safe under attacker-controlled canonical content.

**Directory-name authority.** The on-disk directory name IS the slug. Frontmatter `name:` MUST match the directory name; mismatch is a canonical-read error. This resolves the "which wins?" ambiguity authoritatively.

**Canonical contents:**

```
.instar/skills/<name>/
├── SKILL.md        (required — frontmatter + body)
├── scripts/        (optional — executable resources)
├── references/     (optional — context-load-on-demand docs)
└── assets/         (optional — output resources)
```

**Canonical frontmatter (v0.1 — minimum viable):**

```yaml
---
name: string              # required, slug grammar enforced — maps to /<name>
description: string       # required — natural-language intent matcher
                          # sanitized at parse time: control chars stripped, whitespace collapsed,
                          # capped at 256 chars. Bounds prompt-injection surface.
metadata:
  short-description: string   # optional — UI-display short form
---
```

YAML parsing uses `js-yaml` with FAILSAFE schema (no JS-type coercion). Parse errors fail loud at the canonical-read layer, surfaced as `canonical-read-error`. Git-merge-conflict markers in the file are detected and rejected before parsing.

**Deferred to v0.2 (tracked, NOT in current rendering contract):**

- `allowed-tools: string[]` — will land with the Tool primitive, where the Claude `allowed-tools` frontmatter + Codex `dependencies.tools` mapping is the load-bearing concern. Removing the field from v0.1 closes a spec-vs-code drift gap rather than promising tool-restriction the renderer doesn't enforce.
- `user-invocable: bool` — Claude's framework-native field; v0.1 leaves Claude's default (true) in place.
- `icon-small`, `icon-large`, `brand-color` — Codex-bonus rendering surface; will land in a follow-up when canonical icon-bundling is designed.

Every per-framework rendering MUST honor `name` + `description` faithfully (these are the primitive contract). Optional fields are honored when the framework supports them and silently dropped when it doesn't.

**User-edit detection via stamp.** Every rendered SKILL.md and `openai.yaml` carries an `x-instar-stamp: <sha256-of-canonical-body>` field. On verify, if the rendered body differs from canonical AND the stamp matches the current canonical body hash → the user edited the rendering directly (surfaced as `user-edit-conflict`, NOT auto-overwritten). If the stamp is stale or missing → canonical changed since last render (legitimate `body-content-mismatch`, eligible for auto-remediate). This makes the "rather than silently overwriting" promise in the source-vs-rendering authority section structurally enforced, not aspirational.

## Per-framework rendering targets (current set)

Each framework's spec at `specs/frameworks/<framework>/skills.md` is the authoritative renderer description. Summary:

| Framework | Renders canonical → | Sibling artifact | Discovery scope |
|---|---|---|---|
| Claude Code | `.claude/skills/<name>/SKILL.md` | none required (frontmatter top-level only) | project-local |
| Codex CLI 0.130 | `.agents/skills/<name>/SKILL.md` | `.agents/skills/<name>/agents/openai.yaml` (interface metadata) | project-local |

Future frameworks add a row + their own `specs/frameworks/<framework>/skills.md` describing the rendering contract.

## Parity contract

**Invariant:** for every `(skill × enabled-framework)` pair, the rendered output must:

1. **Exist** at the framework-native path.
2. **Match** the canonical SKILL.md body byte-for-byte (after frontmatter transformation).
3. **Carry** name + description faithfully in the framework's expected location.
4. **Carry** the `x-instar-stamp` hash so user-edits can be distinguished from canonical drift.
5. **Co-locate** all required sibling artifacts (e.g., Codex's `agents/openai.yaml`).
6. **Mirror** bundled subdirectory contents (`scripts/`, `references/`, `assets/`) byte-for-byte (symlinks skipped to prevent tree-escape).

**Symmetric verify (orphan detection).** The parity rule walks BOTH directions:
- For every canonical skill → verify all enabled frameworks have a correct rendering.
- For every rendered skill dir → verify a canonical counterpart exists. Rendered dirs without a canonical → surfaced as `orphan-rendering-found`, eligible for removal.

Drift in any of the six triggers the parity sentinel's re-render action (per the trust-level-mirrored auto-fix policy locked in `specs/provider-portability/13-framework-parity-sentinel.md`). Orphans are remediated by removal, not re-render.

**Refusal conditions.** Auto-remediate refuses to proceed when:
- Canonical violates slug grammar or fails to parse (surfaced as `canonical-read-error`).
- Rendered file is a `user-edit-conflict` (user-edits via direct file edit are not auto-overwritten; operator must resolve).
- Rendered dir name violates slug grammar (orphan-removal is refused for safety, even though detected).

## What is NOT part of the Skill primitive

Per the foundational spec's "What is NOT a functional primitive" framing, these adjacent things are out of scope:

- **The slash-command parser** — that's the Slash-command primitive (#8), which wraps Skill but is its own contract.
- **The intent-classification model** — that's the agent's substrate-level use of `oneShotCompletion`, not a Skill concern. A Skill's `description` is content the classifier reads, not classifier logic.
- **Script execution sandboxing** — that's the substrate's `bashExecution` + `toolAllowlist` capabilities; a Skill just declares which tools it needs.
- **MCP server registration** — separate Layer-3 primitive (#11, bonus).
- **The conversational discovery surface** ("can we install a skill that does X?") — that's the Conversational-action primitive (#10), which uses Skill as one of its action targets.

## Source-vs-rendering authority

- **Canonical source is authoritative.** When the parity sentinel detects drift, the canonical source wins and the rendering is re-derived.
- **Manual rendering edits are conflicts.** If a user edits `.claude/skills/<name>/SKILL.md` directly, the sentinel surfaces the divergence (per the Q3-resolved policy: sibling-files for framework-specific extras, conflict-to-user for body edits) rather than silently overwriting.
- **Framework-specific extras live in sibling files.** If Codex grows a feature that needs additional per-skill state, it goes in `.agents/skills/<name>/<framework-specific>.yaml`, NOT in the canonical SKILL.md.

## Open questions tracked here

- **Bundled-asset rendering for icons** — Codex's `openai.yaml` can reference icon paths (`./assets/icon.png`). If the canonical doesn't declare icons, we don't render the icon fields. If it does, paths must remain relative-to-skill-dir after rendering. Trivial; no spec change needed.

- **User-added skills via conversation** — when a user says "create a skill that does X", the conversational-action primitive (#10) calls the canonical Skill writer, not the per-framework renderers. Per-framework rendering is the parity sentinel's job downstream.

- **Migration of existing `.claude/skills/` content** — agents that already have skills under `.claude/skills/` but no canonical `.instar/skills/` need a one-time backfill. Out of scope for this spec; the parity sentinel design (`specs/provider-portability/13-framework-parity-sentinel.md`) handles backfill via its initial-scan path.

## Alignment with foundational specs

- **`framework-functional-parity.md`**: Required primitive, three-layer model honored (Skill consumes `agenticSession` + `toolAccess` substrate primitives), gap-fill principle followed (Instar defines canonical, frameworks render).
- **`required-primitives-inventory.md`**: Entry #1 "Skill". Per-framework status updates on rendering completion (Codex moved from `partial ⚠️` to `native ✓` after PR #249).
- **What-is-NOT bound respected**: classifier logic, command parser, sandboxing all kept out.
- **Substrate-dependency declaration matches inventory.**

## Implementation slice for the first prototype PR

This concept spec ships alongside:

1. **`specs/frameworks/claude-code/skills.md`** — Claude rendering contract (path, frontmatter shape, what's loaded when, known quirks).
2. **`specs/frameworks/codex-cli/skills.md`** — Codex rendering contract (path, sibling `openai.yaml` shape, trust-level prerequisite, known quirks).
3. **`src/providers/parity/rules/skillParityRule.ts`** — The first concrete parity rule:
   - Strict slug grammar at every entry point (path-traversal safe).
   - YAML parsing via `js-yaml` FAILSAFE schema; fail-loud on parse error.
   - Symmetric verify (canonical → frameworks AND frameworks → canonical for orphans).
   - `x-instar-stamp` field tracking on rendered files; user-edit-conflict distinguished from canonical drift.
   - `verify(projectRoot, name)` returns mismatches with `reasonCode` enum.
   - `remediate(projectRoot, name, framework)` re-renders from canonical; refuses on user-edit-conflict.
   - `listOrphans()` + `removeOrphans(framework)` for the orphan-cleanup leg.
4. **`src/providers/parity/registry.ts`** — Minimal registry that the future `FrameworkParitySentinel` will consume.
5. **Unit tests** covering: slug-grammar enforcement (path traversal rejected, capitals rejected, spaces rejected), canonical-read errors tagged with `framework: 'canonical'`, YAML parse fail-loud, git-merge-conflict marker detection, orphan detection + removal (refused for non-slug names), user-edit-conflict via stamp, description sanitization + truncation, symlink-skip in mirror, render correctness for both frameworks, idempotent re-render.

## v0.1 deferred items (tracked as follow-ups, NOT in this PR)

- **`migrateSkillsCanonicalBackfill()`** — PostUpdateMigrator entry that scans existing `.claude/skills/` and `.agents/skills/`, backfills any unknown skill into canonical at `.instar/skills/`. Without this, the parity rule is a structural no-op on existing agents (their canonical dir is empty). MUST ship before the sentinel auto-runs on real agents.
- **`installBuiltinSkills()` rewrite** — currently writes to `.claude/skills/` directly; should write to canonical + trigger remediation.
- **`BackupManager.DEFAULT_CONFIG.includeFiles`** — add `.instar/skills/`; explicitly exclude `.claude/skills/` and `.agents/skills/` (derived).
- **`templates.ts → generateClaudeMd()`** — update Agent Awareness section to reference canonical path + slash-command surface.
- **`allowed-tools` rendering** — lands with the Tool primitive (separate PR in the roadmap).
- **Atomic write (tempfile + rename)** — single-machine + single-sentinel-pass narrows the v0.1 race window; will add when the sentinel ships.
- **Sentinel per-rule disable knob** — config-side surface for the sentinel, not the rule.

E2E tests against real Claude + Codex sessions are queued as a follow-up that needs healthy sessions on both frameworks; the unit tests against `tmp` filesystem fixtures provide structural correctness pending live verification.

## Convergence-round-1 record

Round 1 (2026-05-18) ran with 6 reviewers in parallel (4 internal: security, scalability, adversarial, integration; 2 external: GPT 5.4, Gemini 3.1 Pro). Grok was not available this session (no XAI_API_KEY configured); deviation from the canonical 7-reviewer set is documented in the convergence report.

Material findings addressed in this iteration:

- C1 (path traversal via name) — strict slug grammar at every entry point.
- C2 (hand-rolled YAML parser) — replaced with `js-yaml` FAILSAFE schema.
- C5 (orphan detection / asymmetric verify) — `listOrphans()` + `removeOrphans()` added; verify walks both directions.
- C7 (user-edit destruction) — `x-instar-stamp` distinguishes user-edit-conflict from canonical drift; remediate refuses to overwrite conflicts.
- C8 (description prompt-injection surface) — control-char strip + length cap at parse time.
- H1 (directory-name vs frontmatter-name authority) — directory name is authoritative; mismatch is `canonical-read-error`.
- H5 (canonical-read errors mis-tagged) — `framework: 'canonical'` slot added to the type union.

Material findings deferred to follow-ups (tracked above): C3 (`allowed-tools` rendering), C4 (backfill migration), C6 (atomic writes), H2/H3 (backup + template updates), H4 (git-sync conflict surfacing — partial; parser fails loud on conflict markers).
