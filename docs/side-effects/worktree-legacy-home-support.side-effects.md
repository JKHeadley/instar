# Side-effects review — registry-path-verified legacy agent homes

## What changes

`resolveAgentHome` (src/core/InstarWorktreeManager.ts) gains ONE new acceptance
path: a candidate outside `~/.instar/agents/` is accepted iff the agent
registry's recorded `entries[].path` (realpath-resolved) equals the candidate
and the entry name passes the existing charset clamp. Agent name then comes
from the registry entry. No other behavior changes.

## Over-accept risk (the direction this change moves)

- The new evidence is the registry — written only by agent servers
  (registerAgent on boot + heartbeat). An attacker who can forge the registry
  can already do far worse (it drives port routing and lifecycle). Planted
  files inside the candidate directory (.instar/AGENT.md, config.json) are
  explicitly non-evidence — pinned by a new test.
- A symlinked registration matches via realpath equality — same canonical
  anchoring the compliant path uses.
- Hostile entry names (charset violations) never resolve — they skip to the
  existing refusal.

## Over-block surface (unchanged)

Every existing refusal is preserved verbatim: planted AGENT.md (existing test
passes unchanged), non-direct-child under the root, unregistered names, name
pattern violations, missing AGENT.md walk-up failure.

## Hermeticity

The legacy matcher NEVER consults the on-disk registry when the caller seamed
the registry in any form (registryLookup or registryEntriesLookup) — a
name-only seam means "no path entries". This keeps every existing test (and
any future test using the old seam) from silently reading the developer's
real ~/.instar/registry.json — the exact real-config test-isolation leak class
being hunted on the dev agents this week.

## Blast radius

Single function + one helper; consumers (worktree create CLI, scaffold,
migrator) see either an identical result or a successful resolution where they
previously threw. Worktrees for legacy homes land at <legacyHome>/.worktrees/,
inside the agent's own granted territory. No migration needed: behavior
activates only for agents whose registry entry already records an
outside-the-root home (live fixture: instar-codey).
