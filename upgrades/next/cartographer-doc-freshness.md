<!-- bump: minor -->

## What Changed

Adds **doc-freshness enforcement** to the Cartographer doc-tree (spec #2 of the cartographer-conformance project, building on spec #1's `CartographerTree`). Three tiers, all dark-by-default behind `cartographer.freshnessSweep.enabled` (and gated again behind a separate `egressAcknowledged` consent flag):

- **Tier 1 — inline refresh**: one new authenticated write route `POST /cartographer/node/refresh {path,summary}` so an agent that just edited code can refresh that node's summary itself. Full path validation (including encoded traversal), the same deterministic quality bar as the sweep (the summary must name a real symbol in the code), instruction-shaped-content neutralization, and a write-rate bound.
- **Tier 2 — the sweep**: a new in-process `CartographerSweepPoller` + reusable `CartographerSweepEngine` that authors stale/never-authored summaries on a **light model routed OFF Claude**. A runtime routing PROBE refuses to author rather than silently spend Anthropic quota. It is lease-gated (only one machine authors — no multi-machine N× burn), bounded per pass by BOTH node count and estimated spend, CPU-pressure-aware (curtails/breaks mid-tick), and self-throttling (a breaker that backs off + reports once, then re-escalates if it stays unable to author). The quality bar is a deterministic symbol-presence check (not a weak model grading itself); credential-bearing files are excluded by deny-glob + a content tripwire and are never sent to the model.
- **Tier 3 — CI ratchet**: `scripts/cartographer-freshness.mjs` keeps aggregate freshness from regressing (and surfaces the un-authored/quarantined backlog so a green ratio can't hide rot).

Behavior-preserving refactor: the host CPU+memory pressure computation is extracted from the SessionReaper into a shared `HostPressureSampler` both now use. Changes nothing for an agent that leaves the feature off (the default).

## What to Tell Your User

- **The code map now keeps itself fresh (groundwork, off by default)**: "The self-maintaining map of this project can now author and re-author its own summaries in the background, on a cheaper model that runs off my main Anthropic quota — and it refuses to run on that quota rather than spend it by surprise. It's still turned off by default while the project finishes; I'll let you know before switching it on, because turning it on means sending source files to that model's provider, which is a separate consent step."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Inline node-summary refresh | POST /cartographer/node/refresh {path,summary} (opt-in; 503 unless the sweep is enabled) |
| Background freshness sweep (off-Claude, lease-gated) | `cartographer.freshnessSweep.enabled` + `egressAcknowledged` in `.instar/config.json` |
| Freshness health + backlog | GET /cartographer/health (now includes the `freshness` ratio + un-authored/quarantined backlog) |
| CI freshness ratchet | `node scripts/cartographer-freshness.mjs --check` |
