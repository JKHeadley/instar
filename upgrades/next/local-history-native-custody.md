# Local History Supporting Components

<!-- bump: patch -->

## What Changed

Added internal target-authenticated encryption, selected-history manifest validation and a bounded descriptor-to-child parsing path. The implementation includes native Swift CryptoKit interoperability fixtures and live authorization checks through stream disposal. These are supporting modules; no native import API or app action is enabled by this change.

## What to Tell Your User

The supporting local-conversation reader is under development. Bringing local Codex or Claude Code files over through the app is not yet available.

## Summary of New Capabilities

None available in the app yet. The new components do not enable a local-history import action.

## Evidence

Synthetic source tests cover encrypted records, independent Swift vectors, manifests, protected file snapshots and real isolated parsing children. Combined parser/provider checks passed219 cases. Private search composition passed106 unit,22 HTTP and7 production lifecycle checks, including excluding local sources from older routes. Full ordinary verification and installed native acceptance remain required.
