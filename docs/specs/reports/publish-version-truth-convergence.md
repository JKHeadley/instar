# Convergence Report — Publish version-truth

## ELI10 Overview

Instar's release robot used to ignore the version number we write in our own
project file and always just added one to the patch number on npm. That meant
we could never deliberately ship a major version like 1.0.0 — the robot
literally had no way to hear the request. This change makes the robot read our
intended version and honor it when it's higher than what shipped, while keeping
the old patch behavior for everyday releases and refusing to ever go backwards.

## Original vs Converged

The original behavior is the documented root cause of the 2026-05-19
deployment misalignment incident. The converged change extracts the
version-resolution decision into a standalone, unit-tested module
(`scripts/resolve-publish-version.mjs`) and wires the workflow to call it.
Nine tests, including a regression replaying the exact incident inputs.

## Iteration Summary

| Iteration | Reviewers run | Material findings | Spec changes |
|-----------|---------------|-------------------|--------------|
| 1 | Manual lessons-check (autonomous pre-auth, per topic-10873 separation of the broader lockdown) | 0 | None |

## Manual lessons-aware findings

Engaged P1 (code+test not convention), P4 (9-case unit test incl. incident
regression), P6 (full suite green), P10 (all four reconciliation cases ship,
no deferral), L1-equivalent (closes the exact incident root cause), L6
(side-effects sibling), L9 (ELI16 sibling), L10 (release notes same PR). No
contradictions.

## Convergence verdict

Converged at iteration 1. Minimal, incident-driven, fully tested. The broader
deployment-lockdown design (release-tier, multi-signature, branch isolation,
NEXT.md-hold, incident-memory) is deliberately out of scope and tracked
separately in topic 10873.

## Deviation note

Tactical prerequisite running under autonomous-mode pre-authorization
("proceed as you best see fit. We'll work on the lockdown work after our v1.0
work is done"). Manual lessons-check applied transparently in the spec body.
This unblocks the v1.0.0 cut; it does not substitute for the lockdown spec.
