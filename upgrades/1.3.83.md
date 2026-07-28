# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Project Map now includes a concise related-worktrees section when an agent has source worktrees in its conventional workspace. This fixes a dogfood issue where Codey's map was technically fresh and accurate for the small wrapper project, but omitted the Instar source worktrees where the real development work was happening. The headline file count also now skips hidden state/worktree directories consistently with the visible directory breakdown, so aged agents with large transcript/state folders do not get noisy inflated totals.

## What to Tell Your User

Project Map now gives me better spatial awareness when I’m developing through nearby source worktrees, and its headline file count is less likely to be inflated by hidden runtime state.

## Summary of New Capabilities

| Area | Capability |
| --- | --- |
| Project Map | Compact and markdown maps can show related agent worktrees when they exist. |
| Spatial awareness | Development agents can see nearby source worktrees without scanning the whole machine. |
| Count accuracy | Hidden state and worktree directories no longer inflate the headline project file count. |
| Refresh safety | Agents without related worktrees keep the existing compact map behavior. |

## Evidence

- Unit coverage: `tests/unit/ProjectMapper.test.ts` verifies related worktree discovery and compact/markdown rendering.
- Integration coverage: `tests/integration/coherence-routes.test.ts` verifies the Project Map API routes still serve JSON, markdown, compact, and refresh responses.
