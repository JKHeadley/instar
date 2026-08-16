# Upgrade Guide — v1.0.8 (the v1.0 milestone)

<!-- bump: patch -->

## What Changed

This is the official v1.0 milestone release. Two things land together because
they are causally linked:

1. **Versioning is now truthful.** The release workflow honors the version in
   `package.json` as the operator's authority for an intended release. It used
   to derive the next version solely from the npm registry and ignore
   `package.json`, which made a deliberate major/minor release structurally
   impossible. That gap is the documented root cause of the 2026-05-19
   deployment misalignment, where v1.0 framework-parity work shipped to npm
   under v0.28.x patch numbers. The release that makes truthful versioning
   possible is, fittingly, the release that stamps v1.0.

2. **The v1.0 milestone is the framework-portability architecture.** Instar is
   no longer tied to Claude Code as a runtime. The eleven Layer-3 primitives
   (skill, hook, agent, tool, memory, instruction-file, session-resume,
   slash-command, outbound-relay, conversational-action, MCP-server) are
   abstracted behind a parity-rule registry. Identity renders per framework
   (Claude Code, Codex, Gemini) from a single canonical source. Session-launch
   builders, the intelligence-provider factory, and the post-update migrator
   are all framework-aware.

The version-resolution policy was extracted from inline workflow scripting
into `scripts/resolve-publish-version.mjs` so it is unit-tested.

## Evidence

Reproduction prior to this change: set `package.json` to a higher version
while npm is behind, merge to main. The workflow published the npm-derived
patch and silently discarded the intended version. This is the documented
root cause in `docs/incidents/2026-05-19-v1-deployment-misalignment.md`.

Observed after this change: a higher `package.json` version than npm publishes
at the intended version (this is how v1.0.8 itself ships). A routine PR that
does not touch `package.json` still resolves to the next patch. A stale lower
`package.json` resolves to npm patch-plus-one, never a downgrade.

Unit verification: `tests/unit/resolve-publish-version.test.ts` — nine cases
covering greater-than, equal, and less-than across each semver field,
operator-intended major and minor bumps, routine patch, stale no-downgrade,
unpublished-package, and a regression replaying the exact 2026-05-19 incident
input and asserting it now resolves to the intended version.

## What to Tell Your User

- "Instar v1.0 is here. The headline is portability: your agent is no longer locked to one runtime. The same agent identity, skills, hooks, and memory now render correctly whether the runtime is Claude Code, Codex, or another supported framework. This release also fixes the versioning process so the published version always matches what we intend to ship."
- "If you are updating an existing agent, there is nothing you need to do. The framework-portability code already reached you through earlier patch updates; this release stamps the milestone and corrects the version number. Six narrow hardening improvements ship as quick follow-up patches over the next few releases."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Truthful versioning | Automatic. The release workflow honors the intended version. Routine patches are unchanged. |
| Framework portability | Automatic. Agent identity and the eleven primitives render per runtime from a single canonical source. |
| Per-framework identity | Canonical identity lives in one place; the runtime-specific shadow file is regenerated on demand. |

## Agent Migration Notes

For an agent updating from any v0.28.x to v1.0.8:

- **Required actions: none.** The framework-portability code shipped
  incrementally under v0.28.122–v0.28.125. This release stamps the milestone
  and corrects the version label. No canonical-file migration is required.
- **What is new on disk after update:** the post-update migrator continues to
  refresh framework-rendered copies of canonical primitives. The
  conversational-action catalog is reachable through its on-demand loaders
  (context segment, knowledge-tree probe, playbook item). No always-loaded
  identity-prompt growth.
- **Verification an agent can run on itself:** confirm the installed version
  reads 1.0.8 or higher; confirm the canonical identity file is the source of
  truth and the runtime shadow carries the auto-generated banner.
- **If an agent runs a non-Claude-Code runtime:** six narrow portability gaps
  (documented in the v1.0.0 cross-framework audit) ship as v1.0.9–v1.0.14
  patches immediately after this release. Until then, dual-framework installs
  are unaffected; the gaps only touch single-runtime non-Claude-Code installs.

## Deferred (Tracked Follow-ups)

- Six audit-flagged portability hardening gaps ship as v1.0.9–v1.0.14 patches:
  init routing through the identity renderer, framework-aware connector-server
  registration, a framework-session-store abstraction, neutral relay-script
  path, post-update-migrator framework guards, and migrator/identity-renderer
  unification. Each has a documented fix from the cross-framework audit.
- The broader deployment-lockdown infrastructure (release-tier config,
  multi-signature for major bumps, major-work branch isolation, hold-signal,
  incident-memory injection) is designed separately and tracked in the
  deployment-lockdown topic. This release is only the version-truth
  prerequisite plus the milestone stamp.
