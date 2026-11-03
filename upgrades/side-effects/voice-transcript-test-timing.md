# Side effects: voice transcript test timing

Test-only. Seven waits after a 50-60 ms fake transcription went from 100-120 ms to 600 ms, because under full-suite load (a peer verifier, 2026-11-03, PR 2669 run) 100 ms was not always enough. No product code changes. Rollback: revert.

1-8: no runtime surface.

## Class-Closure Declaration

- `unbounded-self-action`: closure `n/a`, test-only.

## Root cause (found 14:32 from the peer verifier log)

The failing test was the queue-ceiling case. It started two transcriptions with Promise.all and assumed the first one reaches the single slot first. Under load the second sometimes got there first. The assertions now accept either order: exactly one ran and timed out, and exactly one waited. The longer waits stay as a margin.
