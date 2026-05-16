# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

Tier-3 step two of the self-healing remediator is live. The Dashboard now has a Remediation Proposals view, and three new HTTP endpoints back it.

What lands today:

- A list endpoint that surfaces every pending NovelFailureReviewer proposal on disk. Up to three appear in the visible section; any extras sit silently in the queued section per the outstanding-three cap. Bearer auth and an `X-Instar-Request` header are required, matching the convention used by other user-authoritative endpoints.
- A detail endpoint for a single proposal. At the collaborative trust level the full LLM forensic record and raw reason text come through. Below collaborative trust the route strips the untrusted fields before they reach the response — the dashboard always renders the LLM-summarized portion inside an "Untrusted LLM-summarized content" frame, prefixed `[REVIEW NEEDED]` per the spec rendering rule.
- A dismiss endpoint that lets a collaborative-trust user clear a proposal from the outstanding-three cap. Each principal is limited to ten dismissals per hour. Dismiss is idempotent — re-dismissing a proposal returns the current state instead of erroring.
- A standalone dashboard page at `/dashboard/proposals.html` that reads from the three endpoints. The page can be linked from the existing Remediation tab once Tier-2 lands; until then it stands on its own.

## What to Tell Your User

Your agent can now show you which novel failures it has noticed but does not yet know how to fix. From this release on, when the NovelFailureReviewer runs and finds a recurring un-recognized error, it writes a proposal to disk. You can review those proposals in your dashboard at the new Remediation Proposals page, and dismiss the ones that turn out to be noise.

The visible list shows three at a time so you are never asked to review a wall of items. Anything beyond three sits silently in the queued section and is shown once you clear space. Dismissing requires the collaborative trust level — the same level you set for other write-side dashboard actions.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Pending-proposal list at `/remediation/proposals` | Bearer auth + `X-Instar-Request: 1`. |
| Proposal detail at `/remediation/proposals/:id` | Same auth shape; full fields shown only at collaborative trust. |
| Proposal dismiss at `/remediation/proposals/:id/dismiss` | Collaborative trust + bearer + `X-Instar-Request: 1`. Ten dismissals per hour per principal. |
| Dashboard Proposals page at `/dashboard/proposals.html` | Open in a browser, paste your bearer token, click Refresh. |

## Evidence

Twelve new integration tests in `tests/integration/remediation-proposals-routes.test.ts` cover the nine spec-required cases plus three bonus checks (404 on unknown id, 400 on invalid id format, three-visible cap with queued overflow). All twelve pass. The full TypeScript build passes clean (`tsc --noEmit` returns zero).

Side-effects review for this slice is in `upgrades/side-effects/s2-dashboard-proposals.md`. Second-pass review was marked not-required by the spec gate procedure — the routes are read-mostly with one write path (dismiss) whose authority is gated through `TrustElevationSource.hasCollaborativeTrust()`, the same gate used by S-1's in-process dismiss path.

The new route file is `src/server/routes/remediation-proposals.ts` (about three hundred sixty lines). Wiring into `AgentServer.ts` adds eight lines guarded by a try/catch so a misconfigured trust source cannot prevent the server from starting. A one-line visibility change to `TrustElevationSource.hasCollaborativeTrust()` makes the existing private method public so route handlers can consult it directly — this is the same change S-1 makes on its branch, deliberately duplicated so either order of merge produces a clean rebase.

## What is outstanding

The Remediation tab itself is not yet on main — it ships with a separate Tier-2 slice. Until then the proposals page lives at its own URL rather than nested inside the tab. The dashboard navigation will gain a Remediation entry pointing at this page once the parent tab lands.

The route file mounts the trust source from `config.autonomyProfile` directly. Once the Remediator bootstrap is wired into `AgentServer`, the routes should consume that shared instance instead, so config-flip events take effect without a server restart. That swap is mechanical and tracked in the same Tier-3 follow-up that wires the rest of the Remediator into the server lifecycle.
