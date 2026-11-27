---
title: "Maturation Path amendment: default-on is the last rung, with measured thresholds"
slug: "maturation-path-amendment"
author: "echo"
parent-principle: "Maturation Path — Test Agent → Development Agent → Fleet"
parent-spec: "docs/specs/feature-maturation-ladder.md (§12)"
eli16-overview: "maturation-path-amendment.eli16.md"
---

# Maturation Path amendment

## Problem statement

Justin's directive of 2026-11-03 17:11 PST, topic 136110, sets default-on as the final rung unless a feature is specifically determined to stay off by user preference, with clear thresholds and rich tracking. The article says "ships dark is a starting state", but has no final rung, no measured thresholds and one enumerated exit. Three of its four clauses have no mechanical check. `docs/specs/feature-maturation-ladder.md` builds the mechanism. Changing the article needs the operator.

## Proposed change

The change is to `docs/STANDARDS-REGISTRY.md`, in *Maturation Path*:

**Rule, added:**

> Default-on for the fleet is the last rung of every staged feature, unless a recorded user-preference decision keeps it off. Every rung has machine-checkable thresholds against the feature's own logged behaviour, and when they are met the feature is raised to the recurring review, whose model must decide. A threshold met is a floor, never an instruction: structure measures and raises, and the mind decides. A fleet default stays a reviewed code change, which the review opens itself once two independent readings agree that the feature should move (a different model family, or on a single-provider agent a fresh context of the same provider, disclosed as such).

**In practice, added:**

> (e) THE LADDER IS THE MACHINE FORM OF THE PLAN. `src/data/feature-ladders.json` holds every staged feature's thresholds. A flag the code reports as switched off (`src/monitoring/maturationUniverse.ts`) with no entry fails the build. (f) The rung is derived from what ships, never written by hand. (g) A USER-PREFERENCE FINAL IS A RECORDED DECISION, with a named decider, reason, date and reference, each one visible on the board. The decider is the operator, or the review's two independent readings agreeing that the choice belongs to each user, in a named class: opt-in cost, a personal account, or personal taste. A preference final closes only the step to default-on: the feature still earns its lower rungs, stays available to any user who turns it on, and keeps its thresholds. It says nothing about a critical path that depends on it, which stays with *A Dark Feature Guards Nothing*.

**Applied through, changed:** the coverage test enforces clause (e), the parser gives clause (b) a structural floor, and clauses (c) and (d) stay named as unenforced under their countdown. It says plainly what is not certified: that a logged record is true, that a threshold is any good, or that a decision reached the track on the day it was made.

## Decisions for the operator

1. Agree with the Rule wording, especially that the mind decides every move, rather than a met number flipping a feature by itself. All reviewers and *The Body and the Mind* pushed that way; your directive says thresholds "indicate when it can mature".
2. Agree that an agent review can record a preference final for a named class (opt-in cost, a personal account, personal taste), rather than only you. Each one is visible on the board. 13 candidates are named in the registry today, none applied.

## Decision points touched

| Decision point | Class | Justification |
|---|---|---|
| The preference final | judgment-candidate | Floor: named decider, reason, date, reference. Arbiter: operator, or two independent readings. Default: stays default-on. |

## Multi-machine posture

Unified: a constitution text change, repo-tracked. No runtime surface.

## Frontloaded Decisions

1. Scope is this 1.x article only. Master rule 72 in the 2.0 rule book is not edited here; the report to the operator names the gap.

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** not applicable: a text change with no flag.
- **dev-agent-live:** not applicable: a text change with no flag.
- **fleet:** applies at merge, after sign-off.
- **graduation criterion:** the operator signs off the wording.
- **dark-window:** none; a text change.
- **ladder:** maturation.ladder
