---
bump: minor
audience: agent-only
maturity: stable
---

## What Changed

Added the agent-awareness CLAUDE.md capability section for the now-feature-complete
Operator Binding (Know Your Principal) loop. Agents now learn — at the template
level (new agents via `generateClaudeMd`), the migrator level (existing agents via
`migrateClaudeMd`), and the shadow-marker level (Codex/Gemini frameworks) — that
their VERIFIED operator for a topic is bound automatically from the AUTHENTICATED
sender of an authorized message (never a name in content) and auto-injected at
session start; how to read it via the `/topic-operator` routes; and that the
observe-only cross-principal coherence guard exists (dark behind
`monitoring.principalCoherence.enabled`). The underlying feature shipped across
#904/#906/#908/#909/#910; this is the Agent Awareness Standard surface for it.

## What to Tell Your User

Nothing user-facing changes. This makes the agent aware of a security capability it
already has: it now knows its verified operator is established automatically from
the authenticated sender of an authorized message — never from a name typed into a
document or chat — and it knows to treat an unverified name as a question to resolve
rather than a fact to accept. That is the mechanical arm of the Caroline
credential and identity-bleed fix.

## Summary of New Capabilities

- New CLAUDE.md capability section "Operator Binding (Know Your Principal)" in all
  three awareness surfaces (templates.ts, PostUpdateMigrator.migrateClaudeMd, and
  the shadow-capability markers for non-Claude frameworks).
- Documents the `/topic-operator` read routes, the automatic authenticated-sender
  binding, the Know Your Principal disposition, and the dark observe-only
  cross-principal coherence guard.

## Evidence

`tests/unit/feature-delivery-completeness.test.ts` (the three-surface parity gate)
passes with the new section tracked in `featureSections` and present in templates.ts,
the migrator, and the markers[] shadow allowlist (77/77). Clean `tsc --noEmit`; lint
clean; docs-coverage `--check` passes (no new route — route stays at the 55% floor).
