# ELI16 — Witness index no longer blocks boot

## What changed

The replicated-store witness index used to scan every own and peer journal twice while the server was still booting. A large journal could keep the server from listening long enough for its supervisor to terminate and restart it forever.

The reader constructor now performs zero journal reads. The server starts the rebuild only after it is listening. Rebuild and parity still stream fixed-size chunks, but yield to the event loop after every chunk. Until both passes finish and agree, witness lookups use the established legacy path.

## Why it is safe

No partial candidate index is ever trusted. A durable append increments a generation fence; if anything changes while either pass is running, that candidate is discarded and a new rebuild is queued. A parity mismatch still logs loudly and keeps the legacy path active.

## Evidence

A regression test creates a multi-megabyte journal and proves reader construction performs zero journal reads and returns promptly. Unit, integration, and e2e tests cover legacy-before-ready behavior, async publication, O(1) lookup after publication, and rebuild from own plus peer streams.
