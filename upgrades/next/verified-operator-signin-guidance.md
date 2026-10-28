# Verified operator sign-in guidance

<!-- bump: patch -->

## What Changed

The built-in sign-in skill and new/existing agent instructions now honor exact-account unattended repair approval, check already authorized credential sources, and distinguish a warm Google session from proven cold recovery. Agents receive an organizational handoff rule: act under standing grants, prepare the smallest phone-completable operator decision when needed, verify its exact authority, and resume the work. Peer-agent identity and a newly created Threadline topic alone do not prove human approval. This update changes guidance and migrations; it does not add the future cross-agent receipt or delegated-peer verifier.

## What to Tell Your User

Agents should use the account access and approvals you have already granted. If a decision truly requires you, the agent will prepare an easy phone action in its authenticated channel and continue after you approve it. A trusted agent's handoff helps prepare that request but does not silently authorize another agent's action.

## Summary of New Capabilities

- Clearer sign-in guidance across Claude, Codex, and Gemini agents, including existing installations.
- A shared operator-handoff instruction that minimizes user work while preserving exact identity and scope checks.

## Evidence

Build and all 49 lint checks passed. Focused install, migration, and framework-delivery checks passed (227 tests). Independent review concurred after the wording distinguished routing from authorization and marked the cross-agent verifier as unbuilt. Full `npm run test:all` is running for this branch.
