# Script result supervision records

## What Changed

Every production script job now writes a durable result record before it runs and records its outcome before releasing its claim. The scheduler compares those records with independent job history at startup and every 30 seconds. A missing or unfinished record is shown as unchecked, and a broken write holds that job's script route for repair. The job report shows the count, status, model-call audit, and gaps. Canary assertions have their own durable log.

The Jev judgment and outage replacement code is installed with its decision gates off. The required live benchmark, one-provider trial, pool roster, and quality evidence must pass before those model decisions are enabled.

## What to Tell Your User

Scheduled script results now have a record that can be checked against the job history. If a result cannot be recorded safely, that script job pauses its cheaper route and raises attention. The new AI result check is still being tested and is not yet handling live job results.

## Summary of New Capabilities

- Review script result coverage and unchecked outcomes through the existing job report.
- See which script jobs are held after a result-recording failure.

## Evidence

Focused scheduler, store, route, integration, and lifecycle tests cover registration before execution, restart recovery, bounded evidence, canary logging, and the report denominator. Synthetic Jev and Luna benchmark results are recorded in the approved design's evidence report; they do not authorize the decision gates.
