# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Chief of Staff reports the last verified merge, full test pass, or completed checklist item for projects with evidence it can read. It checks active project evidence about once an hour. It shows a six-hour stall only when the latest check could read the relevant sources. Its coverage view lists registry projects waiting for a binding or missing a conversation and flags duplicate memberships.

## What to Tell Your User

Open the Chief of Staff view to see what moved, what the project is waiting for, and where a project has stalled. A project whose evidence could not be checked shows that status. A recent conversation or growing diff does not reset the verified progress clock.

## Summary of New Capabilities

`GET /chief-of-staff` reports project coverage, the last verified progress timestamp and kind, named waits, and the calculated stall time.

## Evidence

Before the change, the Chief of Staff status response omitted verified progress and registry coverage. With the same project fixture, the production-route HTTP test now reports the merge timestamp and named wait. When the evidence source fails, a fresh read reports that evidence is unavailable and leaves the stall time empty. The lifecycle test exercises the startup wiring.
