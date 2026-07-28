# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The External Operation Gate action vocabulary is now consistent across the
endpoint, generated hook, generated guidance, and docs. The canonical successful
action is `proceed`; `allow` is retained only as a legacy hook compatibility
alias. Unknown action values from the gate now block external write/delete MCP
operations instead of being permitted through fallthrough.

## What to Tell Your User

- **External operation safety is clearer**: "When I gate an external-service action, the documented decision words now match the live evaluator. Allowed operations say proceed, risky ones ask for a plan, and malformed gate responses stop instead of slipping through."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| External Operation Gate vocabulary alignment | Automatic for generated hooks and evaluator responses |

## Evidence

Before the change, live evaluation returned `proceed` while generated docs
described the allowed action as `allow`, and the hook accepted `proceed` only by
falling through unrecognized actions. After the change, focused unit tests cover
core vocabulary and hook behavior, integration tests cover representative
evaluator route outcomes, and an e2e HTTP lifecycle verifies `proceed`,
`show-plan`, and `block` outcomes through AgentServer.
