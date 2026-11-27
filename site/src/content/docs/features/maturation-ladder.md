---
title: Maturation Ladder
description: Every switched-off feature has numbers it must hit for each step, with on-by-default as the last step. Numbers raise a feature for a decision; they never flip it.
---

Instar ships new features switched off until they are proven. That is safe, but a feature with no path stays off forever. The maturation ladder gives every switched-off feature numbers it must hit, records good enough to judge it, and something that notices when it gets there.

## What it does

- **One registry.** `src/data/feature-ladders.json` holds each feature's thresholds per rung. A flag the code reports as switched off (`maturationUniverse`) with no entry fails the build.
- **The real stage.** `deriveLadderRung` reads what ships and what runs here: `dark`, `dry-run`, `dev-agent-live` or `fleet`. No one writes a stage by hand.
- **Evidence.** A feature calls `featureEvidence.record('<id>', { kind, reason, context })`, which writes to `logs/feature-evidence.jsonl` through `FeatureEvidenceLog`. Features with a good log of their own just point to it. `LadderEvidenceReader` reads logs off the event loop, and a read that cannot be trusted gives no number rather than a pass.
- **One scorer.** `MaturationLadderService` adds these features to the existing readiness scorer. A rung needs a metric showing the feature ran and one showing how it did.
- **Raising, not flipping.** When a feature holds its numbers long enough it is raised to the recurring review as a commitment, and the review's model decides. `POST /maturation/moves` applies that decision behind floors that can only refuse. A move to everyone stays a reviewed code change.

## Reading it

```bash
curl -H "Authorization: Bearer $AUTH" "http://localhost:4040/maturation/ladder?id=<feature>"
```

| State | Meaning |
|---|---|
| `ready-to-advance` | Its numbers have held for the whole soak; waiting on the review |
| `soaking` | Numbers met, still holding them |
| `hold` | Enough data, and a number is off target |
| `collecting` | Not enough data yet, or a read could not be trusted |
| `no-data` | It is not recording anything |
| `no-opportunity` | It fires only on incidents and has not had one |
| `not-started` | Nothing runs it yet |
| `harmed` | Got worse, or went silent, after its last move |
| `held` | This agent's operator is holding it |
| `at-final` | On by default, or kept off by a recorded preference |

## Other routes

- `GET /maturation/moves`: what was raised, each rung change, and every move with its evidence.
- `POST /maturation/moves/:moveId/revert`: undo a move, only if what it wrote is still there.
- `POST /maturation/evidence`: a job or hook reports what a feature did, or grades a past event.

## Configuration

`maturation.ladder.enabled` is omitted by default: live on a development agent, off on the fleet. `maturation.ladder.reviewTopic` says where a review reads what is raised; with none set, the agent raises nothing. `maturation.ladder.holds` lets an operator hold a feature on this agent, with a reason.
