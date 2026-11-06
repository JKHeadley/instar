# Correct coverage inventory boundaries

## What Changed

Coverage enumerates validated local model definitions through their canonical producer, without reading advisory placement/availability classifications. Foreign, unreadable and truncated inputs stay unknown or incomplete; observed-empty is distinct. The unavailable-coverage warning offers its own action without pointing elsewhere.

## What to Tell Your User

A model appearing in the inventory means it has a recorded definition. It does not mean it can run this task. Missing inventory sources remain visible.

## Summary of New Capabilities

None; correction to the pending read-only coverage view.

## Evidence

Both full-verifier failures were reproduced, then102focused unit checks,22board-route integration checks and6production-AgentServer checks passed. New cases use real validated projections, including empty, truncated and foreign origins. Full verification and deployment remain pending.
