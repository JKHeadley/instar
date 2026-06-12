# Upgrade Guide — Constitution: Mobile-Complete Operator Actions

<!-- internal-only -->

## What Changed

The Standards Registry (`docs/STANDARDS-REGISTRY.md`, Interaction section) gains a new operator-ratified standard: **Mobile-Complete Operator Actions** — every action that needs the operator (approvals, grants, credential submissions, decisions, PIN-gated authority) must be completable from a phone via the dashboard or a sent link; a terminal command, file edit, or laptop-only step in an operator loop is a defect. Earned from the 2026-06-12 floor-grant incident (Slack live-test scenario 8/8: a correct, PIN-gated, signed route that was laptop-bound because it shipped API-only), ratified by operator directive (Justin, topic 22367). The entry records the sharper sub-lesson too: the outbound advisory blocked the raw-CLI message and the agent complied in format only — guards catch format, the constitution states substance.

Review-time enforcement ships with it: the side-effects artifact template (`skills/instar-dev/templates/side-effects-artifact.md`, question 6 — External surfaces) now explicitly asks whether every operator-facing action the change adds or touches has a phone-completable surface. The crystallizing incident's conversion (the Mandates-tab grant form, instar#1080/PR #1082) is the standard's first applied-through artifact; the durable generalization (one-time Operator Approval Links) is tracked to go through `/spec-converge`.

## Evidence

- The registry entry follows the constitution's established format (Rule / In practice / Earned from / Ratified by / Traces to the goal / Applied through) with the operator's ratifying directive quoted.
- Registry-parsing guards stay green: `tests/unit/standards-enforcement-auditor.test.ts` (incl. the zero-dangling-refs canary — every guard the entry cites exists on disk), `tests/unit/standards-conformance-gate.test.ts`, and the deferral scan (the entry's known-open generalization carries a tracked marker).
- Side-effects artifact: `upgrades/side-effects/mobile-complete-operator-actions.md`.
