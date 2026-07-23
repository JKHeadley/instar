# Feature Maturation Discipline — plain-English overview

## What this changes

Instar often ships risky features switched off or in observation mode first. That is the safe way to release, but “off by default” can become a permanent hiding place: a feature may never receive realistic evidence, never become trustworthy, and never graduate. This change makes every new feature spec explain its route out of darkness before the spec can be considered complete.

Every maturation plan uses the same three rungs. First the feature is dark or observe-only. Next it is fully live on a designated test agent—the mentee—while an overseer exercises it as the user across realistic scenarios. Only after that live evidence meets the declared graduation criterion can the feature become eligible for fleet rollout. The plan must also state how long the dark phase is allowed to last.

## What v1 actually builds

V1 is deliberately small and structural. It adds a required `## Maturation plan` shape to the spec-convergence tool, adds the rule to Instar’s Standards Registry, and updates existing installations so they receive the same tool as fresh installations.

The new checker looks for one exact maturation-plan section and five exact rows: dark, live-on-mentee, fleet, graduation criterion, and dark-window. It rejects duplicate or spoofed structure as a finding. At first, however, it runs in WARN mode: incomplete plans produce a clear “would refuse” warning, but the convergence stamp is still written and the command still succeeds. This lets the rule collect real evidence before it gains blocking authority.

The checker includes a tested veto capability, but v1 does not activate it. Moving from warning to refusal is a separate operator-approved maturation step after the mentee soak is clean.

## What v1 does not build

V1 does not create a stuck-dark database or dashboard status. It does not connect the live-testing harness to the apprenticeship program. Those are explicitly named v2 and v3 projects with their own future specs and approvals. Their intended direction remains important: mandatory live testing on a mentee, with an overseer acting as user, is the middle rung every feature must declare now.

## Safety and rollout

The checker is deterministic and bounded. Code examples cannot fake compliance, duplicate sections are findings, diagnostics contain only fixed row names, and existing specs are never blocked during WARN. Existing customized copies of the spec-convergence script are preserved during migration; only a recognizable stock copy is replaced. Fresh and updated installations are tested for equivalent behavior.

There is no runtime agent behavior, database, external API, user message, or cross-machine state added in v1. Rollback is a normal code revert. The decision for this release is simply whether this WARN-first structural discipline is the right foundation for later live maturation enforcement.
