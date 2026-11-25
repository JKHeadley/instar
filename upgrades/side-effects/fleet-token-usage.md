# Side-Effects Review — Fleet Token Usage

## Summary

Adds a default-off, read-only operator view. It adds two routes under the existing usage capability and uses each configured agent's existing pool summary. The operator unlock remains the authority for release of the combined result.

## Decision-point Inventory

Status reads make no cross-agent requests. A scoped dashboard operator session is checked before collection and again before the result is returned. The owner explicitly opens the section. One collection runs at a time with a bounded request per unique configured pool. Each pool receives only its configured authorization header and existing recipient identity. No redirect is followed. No remote identity, raw response, or credentials are exposed in the result. The operator verifies each deployment origin out of band.

Every peer reads the same UTC start day. A one-machine fallback, warming or unreachable peer, or missing token fields marks the subtotal partial. A failed read stays unavailable. A measured zero counts. No persistence, external write, or background retry is added.

## 6b. Operator-surface Quality

The section provides a single Show fleet token usage action with the standard PIN flow. It shows the UTC start date, a combined total and per-agent coverage. The action is available only when configured on, and unresolved data is shown in words. The implementation is generic and assumes no person, agent or machine name.

## Multi-machine posture

A host administrator supplies `INSTAR_FLEET_USAGE_ENABLED=true` and `INSTAR_FLEET_USAGE_SOURCES` as a JSON list with a unique `id`, exact Instar `agentId` (project name), a human `label` and a verified HTTPS `origin` per independent pool. Include the current agent if its usage belongs in the total. Use one origin per pool. Each credential is provisioned separately as `INSTAR_FLEET_USAGE_TOKEN_<id>` in the collector service secret environment. Never put a credential in the JSON or send it through chat. Browser callers cannot supply URLs, credentials or source IDs. Inventory setup and activation are a separate operator action.

## Rollback

Unset the enable switch to stop cross-agent requests. Revert the patch to remove the UI and routes. No request journal or stored result needs cleanup.

## Class-Closure Declaration

No agent-authored-artifact defect and no new scheduled controller.

## Independent Review

fleet_usage_review independently concurred after recipient binding, UTC bucket alignment and partial coverage were corrected.
