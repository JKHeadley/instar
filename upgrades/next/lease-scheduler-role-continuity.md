# Lease scheduler follows the holder

## What Changed

A machine that gains the lease now starts scheduled jobs through a bounded planned restart. A machine that loses the lease pauses jobs immediately, including when a preferred-machine hint is configured.
