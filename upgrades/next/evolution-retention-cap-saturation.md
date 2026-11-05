# Evolution retention preserves full memory at saturation

## What Changed

All four evolution stores now handle zero terminal allowance correctly. New soft total
retentionTargets settings preserve legacy max settings and active work. Finished records
are durably preserved in the existing archive before hot-list eviction; archive copies
remain locally readable across peer outages after synchronization. Retention counts report
the actual retained population, including overflow and unknown measurements.

## What to Tell Your User

Finished work and applied lessons remain available in the archive when they leave a work
list. Open work stays visible even when it exceeds the target. I can inspect the archive
and report pressure without cancelling commitments to make a number look smaller.

## Summary of New Capabilities

Authenticated archive pagination and retention reports expose full preserved records,
per-machine pressure and explicit unavailable peers. Old record numbers remain reserved.

## Evidence

EVO-022 / CMT-1124. Regression boundaries across all four stores; full archive/replica custody,
HTTP integration and production server restart tests. Normal Local Verify and safe-merge
must pass on the exact PR head before main confirmation and real queue proof.
