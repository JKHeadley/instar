## What Changed

Feedback fixes and the green PR watcher now wait for the complete, producer-bound GitHub CI floor before merging. The merge command targets the exact verified head immediately after that check; it no longer leaves native auto-merge armed under a weaker repository rule. Queued or not-yet-registered checks make the feedback executor retry without spending its refusal allowance. That wait has a durable three-hour limit per attempt, followed by the existing one-hour retry path. The executor no longer requires native GitHub auto-merge to be enabled.

## What to Tell Your User

A feedback PR stays open while CI is queued. When the full suite is green, Echo merges the reviewed commit. If checks never arrive, the executor eventually holds the work and reports the merge problem instead of calling a missing suite green.

## Evidence

Focused unit, integration, and E2E tests cover pending checks, a Vercel-first registration window, the full producer-bound floor, head-pinned merging, and the bounded executor retry.
