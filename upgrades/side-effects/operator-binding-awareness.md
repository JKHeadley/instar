# Side-effects review — Operator Binding agent-awareness CLAUDE.md section

## What this change does
Adds the Agent Awareness Standard surface for the now-feature-complete Operator
Binding (Know Your Principal) loop (shipped across #904/#906/#908/#909/#910). It is
PURE DOCUMENTATION — a new CLAUDE.md capability section, no logic/behavior/data
change. Wired into all three required awareness surfaces so the parity gate stays
green:

- `src/scaffold/templates.ts` (`generateClaudeMd`): the `**Operator Binding (Know
  Your Principal)**` section for NEW agents, inserted before the Commitments section.
- `src/core/PostUpdateMigrator.ts` (`migrateClaudeMd`): the SAME section for EXISTING
  agents, appended only when absent (content-sniffed on `**Operator Binding (Know
  Your Principal)**`), idempotent, with a `result.upgraded.push`.
- `src/core/PostUpdateMigrator.ts` (`migrateFrameworkShadowCapabilities` markers[]):
  the `**Operator Binding (Know Your Principal)**` marker so Codex/Gemini agents
  learn it too (no improvised weaker workaround).
- `tests/unit/feature-delivery-completeness.test.ts`: the `featureSections` entry
  (the `**`-wrapped form, matching the migrator guard + markers like Session Boot
  Self-Knowledge) so the three-surface parity is enforced going forward.

## Blast radius
- **Additive, idempotent, no behavior change.** The migrator branch only appends
  when the heading is absent; re-running migration is harmless. No config key, no
  route, no class, no dependency.
- **Migration parity satisfied by construction** — this change exists BECAUSE of the
  Migration Parity Standard: new agents (templates.ts) + existing agents (migrator)
  + shadow frameworks (markers) all get the section. The parity gate
  (feature-delivery-completeness) fails CI if any surface is missing — it passed
  (77/77) after the `**`-wrapped featureSections fix (the auto-detect captures the
  migrator's content-sniff string verbatim, so the tracked entry must match it
  exactly — same precedent as `**Session Boot Self-Knowledge**`).

## Content accuracy (verified against the merged feature)
- `/topic-operator`, `/topic-operator/:topicId`, `/topic-operator/session-context`
  routes exist (merged #906). POST refuses a blank/unverifiable uid with 400 (#904
  establishOperator). Auto-bind from authenticated sender on inbound (#909). The
  observe-only guard writes `state/principal-coherence.jsonl` behind
  `monitoring.principalCoherence.enabled`, signal-only (#910). The CLAUDE.md text
  describes exactly these — no aspirational claims.

## Framework generality
The documented capability is framework-agnostic (HTTP routes + an identity
disposition), which is why it carries a shadow marker. Codex/Gemini agents get the
same awareness; nothing here is Claude-specific.

## Migration parity
This IS the migration-parity work. Covered: templates.ts (new), migrateClaudeMd
(existing), markers[] (shadow). No `.claude/settings.json`/hook/config changes.

## Tests
- `tests/unit/feature-delivery-completeness.test.ts` — the three-surface parity gate,
  77/77 (the section is tracked in featureSections and present in templates.ts, the
  migrator, and markers[]). Clean `tsc --noEmit`; lint clean; docs-coverage `--check`
  passes (no new route); repo-invariants hold.

## Rollback
Revert the templates.ts section, the migrator section + marker, and the
featureSections entry. The on-disk CLAUDE.md of already-migrated agents is inert
extra documentation; no data to unwind.
