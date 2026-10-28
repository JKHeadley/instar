<!-- internal-only -->
# Isolated job supervision trial runner

## What Changed

Added a reproducible, network-denied throwaway-agent worker trial runner and a report of its five simulated results. No production rollout gate changed.

## Evidence

The runner passed with macOS outbound networking denied and refused to run without the sandbox. Five simulated results produced five durable per-call audit rows. The report states the limits of this partial trial.
