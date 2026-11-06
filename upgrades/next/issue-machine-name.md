## What Changed
Each problem on the health reading (GET /mobile/health-issues) now names the machine it is on, as `machine: { key, name }` on the answer and on every problem row. The key matches the machine's row on GET /mobile/machines. The name is the pool nickname (for example "Mac Studio"), or this computer's own name when there is no pool. The dashboard's Health page shows "On Mac Studio" under each problem's title, and Home's health rows say it too. An agent that can't name its machine sends no field and nothing changes.

## What to Tell Your User
When I tell you something needs fixing, I now say which of your machines it's on, so "someone at this Mac" always comes with the Mac's name.

## Summary of New Capabilities
- Every health problem names its machine, on the phone and on the dashboard.

## Evidence
tests/integration/mobile-health-issues.test.ts: each row and the answer carry the machine; no machine, a null one, or a failing lookup leaves both out and the reading still answers. tests/unit/console-health.test.ts: the Health card and Home's row say "On Mac Studio", and say nothing when no name came. tests/e2e/mobile-health-issues-alive.test.ts: the production AgentServer wiring names a machine on the answer and on a live row.
