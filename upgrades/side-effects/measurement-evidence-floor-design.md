# Side-effects review — evidence-floor design publication

## Summary

Tier1 documentation-only publication of a reviewed Tier2 implementation proposal: spec, ELI16 overview and review report. No runtime source, flag, move behavior, data format, scheduler or constitutional article changes. Three design rounds used cap6; native and CLI reviewers bothGPT-family, honestly disclosed. Operator approval absent.

## Decision points

This publication adds no decision point. The proposed future managed-move floor requires separate Tier2 approval and implementation evidence. Existing services and review instructions continue.

## 1. Over-block

No runtime input is rejected by this documentation. The design intentionally describes holding managed moves lacking proof; it is not deployed.

## 2. Under-block

Documentation does not enforce the proposed floor. Existing direct config writes and semantic improvement claims remain with existing authorities. No universal coverage claim.

## 3. Level of abstraction

Extend current MaturationLadderService/D7/owner collector, not a new registry or authority. This is a proposal for that existing seam.

## 4. Signal vs authority

Per docs/signal-vs-authority.md, raw proof and schema checks support the existing managed-move authority. This publication changes neither signals nor authority.

## 5. Interactions

None at runtime. Spec depends on runtime2847's outcome/archive/independent owner increments, including malformed owner collision repair. No approved tag is forged.

## 6. External surfaces

Reviewable prose only. Overview states effects and limits; no misleading installed/live claim.

## 6b. Operator-surface quality

Plain-language overview explains what waits, what remains running and the first-start tradeoff. Review report prominently discloses same-family review and three precision limits.

## 7. Multi-machine posture

No state surface introduced by publication. Proposed implementation uses exact executing-origin evidence through existing unified pool views; no new machine-local exception or credential replication.

## 8. Rollback cost

Revert documentation; no service, data or configuration repair.
