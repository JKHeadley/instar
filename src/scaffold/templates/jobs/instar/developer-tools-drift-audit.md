---
name: Developer Tools Drift Audit
description: Weekly check for drift between Instar developer-local practices and provider-neutral Instar workflows. Off by default; useful for agents actively developing Instar.
schedule: "0 11 * * 1"
priority: medium
expectedDurationMinutes: 8
model: capable
enabled: false
tags:
  - cat:learning
  - audit
  - instar-dev-only
toolAllowlist: "*"
unrestrictedTools: true
---
Run a weekly developer-tools drift audit for Instar development.

This job prevents useful development practices from staying local to one agent
or provider. It is shipped as a built-in template and disabled by default. Echo
is expected to be the first enabled instance because Echo is currently the
primary Instar developer agent, but the template is not Echo-only by design.

The job:

1. Verify context. Continue only if the current environment is a recognized
   Instar source checkout or an approved Instar development worktree. Use the
   existing SourceTreeGuard/coherence surfaces if available. If this is not an
   Instar development context, stay silent.

2. Read the checked-in baseline at `src/data/instar-dev-surface-baseline.json`.
   This is the prior-state contract for provider-neutral development surfaces.

3. Inventory current developer surfaces:
   - `skills/*/workflow.descriptor.json`
   - `skills/*/SKILL.md`
   - scripts referenced by workflow descriptors
   - Instar development gates under `scripts/`
   - built-in job templates under `src/scaffold/templates/jobs/instar/`
   - provider-specific scaffolding that exposes development workflows

4. Compare current surfaces to the baseline. Look for:
   - developer practices present in Echo/local prose but absent from descriptors
   - scripts or gates other agents can trigger but cannot discover how to satisfy
   - Claude-only assumptions in guidance that should be provider-neutral
   - robust project-development practices that should generalize beyond Instar
   - Instar-only mechanics that should remain in the Instar overlay
   - resolved migration candidates that should update the baseline

5. If no actionable drift exists, stay silent. Most weeks should be silent.

6. If actionable drift exists, create a short private report or attention item.
   Lead with the practical gap, then list migration candidates and recommended
   next actions. Keep Telegram output brief and plain-English.

7. This is a guardian job, not a doer. Surface drift and proposed routing. Do not
   autonomously change workflows, gates, or provider surfaces from the job run.

