# Spec review checks the user's experience
<!-- bump: patch -->

## What Changed
The required lessons-aware spec review now checks the user's intended outcome and ordinary journey, including repeated permission requests and assumptions of permission unsupported by the record. Reports record evidence and limits.

## What to Tell Your User
Design reviews now explicitly check whether the proposed experience helps you complete the task, as well as whether it follows existing rules. This implements the approved review-lens follow-up without changing the constitution.

## Summary of New Capabilities
Existing installations receive the review prompt through the update path for canonical, Claude and Codex skill copies. No new permissions or setup are needed.

## Evidence
Focused migration tests exercise canonical, Claude and Codex copies, real framework parity, custom rendering conflicts and interrupted-write recovery. Full-suite verification remains with the merge line. See upgrades/side-effects/spec-experience-review.md.
