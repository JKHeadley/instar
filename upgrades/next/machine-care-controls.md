# Skip a machine's restart, or change its window

<!-- bump: patch -->

## What Changed

Each machine now keeps its owner's choices for its weekly clean restart. "Skip once" means no restart for the next 72 hours. "Change window" sets which hours of the night the restart may use (at least 2 hours). Every agent on the machine follows the same choice. A restart already announced keeps its time. These controls can only make a restart later or move it; they never start one. The status shows the skip and the window in use.

## What to Tell Your User

- **Machine care controls**: "You can skip a machine's next restart, or move its restart to different night hours. The Machine care page that shows these controls comes next."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Skip a restart / change the window | The Machine care page, coming next (needs a dashboard PIN unlock) |

## Evidence

- Unit: `tests/unit/machine-maintenance-controls.test.ts`; integration: `tests/integration/machine-maintenance-route.test.ts`.
