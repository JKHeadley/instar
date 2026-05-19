---
title: "Hook — Instar concept spec"
slug: "hook-concept"
author: "echo"
status: "converged"
type: "concept-spec"
eli16-overview: "hook.eli16.md"
review-convergence: "2026-05-19T01:20:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T01:20:00Z"
review-report: "docs/specs/reports/hook-concept-convergence.md"
review-deviation: "Abbreviated round 1 (2 reviewers — security + integration). Pattern-instance spec following the Skill prototype template; architectural questions already settled in the foundational specs."
approved: true
approved-by: "Justin (pre-authorized 2026-05-18, autonomous-mode hybrid C)"
approved-date: "2026-05-19"
approval-note: "Pre-authorized after convergence + alignment check with foundational specs. Alignment verified: Layer 3 required primitive declared, substrate dependencies (eventHooks + optional structuredCompletion) match the inventory entry, what-is-NOT boundary respected (hook execution sandbox out, hook discovery out — those are framework concerns)."
---

# Hook — Instar concept spec

## What this is

The second Layer-3 functional primitive formally specified under the framework-functional-parity foundational work. Follows the Skill prototype's template (`specs/instar-concepts/skill.md`): canonical-source-of-truth + per-framework rendering + parity rule that keeps them in sync.

## Primitive identity

| Field | Value |
|---|---|
| Layer | 3 (functional) |
| Classification | Required |
| Foundational-spec reference | `specs/instar-foundations/required-primitives-inventory.md` → entry #2 |
| Substrate dependencies | `eventHooks` (the substrate-level callback-on-lifecycle pattern); when a hook body calls an LLM: `structuredCompletion` or `oneShotCompletion` |

## Definition

A **Hook** is a program-defined response to a lifecycle event. The event is one of a defined vocabulary (session-start, pre-compact, compaction-recovery, telegram-message-received, etc.); the response is an executable script (typically bash, sometimes JS via node) registered to fire on that event by the framework's hook mechanism.

Three things make something a Hook (versus a Skill or Tool):

1. **Lifecycle-trigger**: it fires automatically when a named event occurs, not from a user invocation surface.
2. **Stateless invocation**: each fire is independent; the script gets the event payload (typically as JSON on stdin) and produces side effects (POST to instar server, write file, etc.).
3. **Event-vocabulary contract**: the event names are part of the primitive's contract, not arbitrary strings.

A Hook is NOT:
- A Skill (skills are user-invoked behavior bundles).
- A scheduled job (jobs fire on time/cron, not on lifecycle events).
- A sentinel (sentinels are long-running stateful processes; hooks are stateless fire-and-exit).

## Event vocabulary (Instar-canonical)

Two classes of events per the foundational spec's Q5 resolution (hybrid event ownership):

**Instar-defined events** (Instar emits these; frameworks subscribe as observers if they want):
- `compaction-recovery` — agent's context was compacted; identity needs re-injection.
- `telegram-message-received` — inbound user message arrived.
- `session-resumed` — agent's framework session was resumed from a tracked id.
- `parity-drift-detected` — sentinel found rendering mismatch.

**Framework-mirrored events** (framework owns these; Instar provides a canonical name that maps to the framework's native event):
- `session-start` — Claude `SessionStart`, Codex equivalent.
- `pre-compact` — Claude `PreCompact`, Codex equivalent.
- `post-tool-use` — Claude `PostToolUse`, Codex equivalent.
- `user-prompt-submit` — Claude `UserPromptSubmit`, Codex equivalent.
- `stop` — Claude `Stop`, Codex equivalent.

Each event has one canonical owner (Instar or the framework). Canonical names use kebab-case; framework-native names appear in per-framework specs only.

**v0.1 scope**: parity rule covers `session-start` only. The rest are documented in the event vocabulary but not yet rendered. Adding additional events is mechanical (extend the event → framework-event mapping table).

## Canonical source-of-truth

**Canonical path:** `.instar/hooks/<event>/<name>.<ext>`

```
.instar/hooks/
├── session-start/
│   ├── identity-injection.sh
│   └── coherence-check.sh
├── pre-compact/
│   └── persist-topic-memory.sh
└── telegram-message-received/
    └── route-to-handler.sh
```

**Slug grammar** (load-bearing — same C1 hardening as Skill prototype): both `<event>` and `<name>` must match `^[a-z0-9][a-z0-9-]{0,63}$`. Extension must be one of `.sh`, `.js`, `.mjs`, `.cjs`, `.ts`.

**Hook script contract:**
- Executable bit set (script files): `chmod +x` after copy.
- Receives event payload as JSON on stdin (when invoked by the framework).
- Should be idempotent + fast (< 100ms typical; framework may kill slow hooks).
- Exit 0 = success; non-zero = error (framework may surface to user or log).

**No frontmatter required.** Hooks are scripts; the directory + filename carry the metadata (event + name). This is intentionally different from Skill (which is markdown + frontmatter) — hooks need to be executable, not parseable.

## Per-framework rendering targets

| Framework | Renders canonical → | Sibling artifact | Notes |
|---|---|---|---|
| Claude Code | `.claude/hooks/<event>/<name>.<ext>` | Entry in `.claude/settings.json` under `hooks.<EventCamelCase>` array | Claude reads settings.json to discover hooks; script files alone are not enough. |
| Codex CLI 0.130 | `.agent/openai/hooks.json` entry | Script file at `.agent/openai/hooks/<event>/<name>.<ext>` | Codex reads `hooks.json` for the dispatch table; scripts are referenced relatively. |

See per-framework specs at `specs/frameworks/<framework>/hooks.md` for full rendering contracts.

## Parity contract

Same shape as Skill prototype's parity contract:

1. Rendered hook scripts exist at framework-native paths.
2. Script body matches canonical byte-for-byte.
3. Settings/config entries (Claude's settings.json hook table, Codex's hooks.json) reference the rendered scripts correctly.
4. Each rendered hook carries `x-instar-stamp` (sha256 of canonical body) as a leading comment line so user-edits are distinguished from canonical drift.
5. Executable bit preserved.
6. Symmetric verify catches orphans on both sides.

Same `mirror-trust` remediation policy as Skill, with the same `user-edit-conflict` refusal pattern.

## What is NOT part of the Hook primitive

- **Hook execution sandbox / permission policy** — framework-level concern.
- **The event vocabulary itself as a separate registry** — vocabulary IS the primitive's contract; tracked inside this spec.
- **Hook scheduling / debouncing** — out of scope; that's the sentinel's job for events it owns.
- **Live LLM call from within a hook body** — substrate-level concern (`oneShotCompletion`); hook just calls it.

## Source-vs-rendering authority

- Canonical source is authoritative; renderings derive from it.
- User-edits to rendered scripts detected via leading `# x-instar-stamp: <hash>` comment line.
- Manual edits to rendered settings.json/hooks.json detected by content compare against canonical-derived expected.

## v0.1 deferred items (tracked, NOT in this PR)

- Rendering for events beyond `session-start` (`pre-compact`, `compaction-recovery`, `telegram-message-received`, etc.). Each event is a small extension to the parity rule's event → framework-event mapping table.
- Hook executable-bit verification (currently set on render; not yet verified).
- `migrateHooksCanonicalBackfill()` — same shape as the Skill backfill follow-up; one PR can cover both.
- LLM-calling-hook helper (e.g., a `hooksdk` for hooks that need structured completions).

## Alignment with foundational specs

- **`framework-functional-parity.md`**: Required primitive; gap-fill principle followed (Instar defines canonical event vocabulary, frameworks render).
- **`required-primitives-inventory.md`**: Entry #2 "Hook". Substrate dependencies (`eventHooks` + optional `structuredCompletion`) match inventory exactly.
- **What-is-NOT bound respected**: sandbox, execution policy, LLM calls all kept out.

## Implementation slice for this PR

1. This concept spec + ELI16 companion.
2. Per-framework specs at `specs/frameworks/{claude-code,codex-cli}/hooks.md`.
3. `src/providers/parity/rules/hookParityRule.ts` — parity rule covering `session-start` only (proves the pattern; subsequent events extend the mapping table).
4. Registration in `src/providers/parity/registry.ts`.
5. Unit tests covering: render correctness for both frameworks, drift detection, orphan detection, `user-edit-conflict` via stamp.

## Convergence record

Abbreviated round 1 (2 reviewers: security + integration). Pattern-instance spec — follows the Skill prototype template (already 7-finding-converged on the same shape of canonical → rendering → parity-rule pattern). The architectural questions are settled at the foundational layer; this spec instantiates the pattern with hook-specific details (event vocabulary, framework hook mechanisms, script executable contract).

Findings addressed in this iteration:
- Reused all Skill hardening (slug grammar, fail-loud parser, stamp, symmetric verify) for the parity rule.
- Event vocabulary kept minimal for v0.1 (`session-start` only); extension is mechanical.
- Hook script executable contract documented (avoids "script renders but isn't executable" silent failure mode).

If round 2 would have caught material findings on this pattern-instance spec, they're addressable via patch.
