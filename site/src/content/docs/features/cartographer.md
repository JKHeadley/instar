---
title: Cartographer — Doc-Tree, Freshness & Conformance
description: A self-maintaining, hierarchical semantic map of the codebase — plus a freshness sweep that keeps it true and a registry-wide audit that checks the constitution's own enforcement. Each ships dark, off by default.
---

The **cartographer-conformance** project gives an agent a living, structured
understanding of its own codebase: a tree of plain-language summaries (one per
directory and significant file), a background sweep that keeps those summaries
honest as the code drifts, and an audit that measures whether the project's
constitutional standards are actually guarded by structure. Every piece ships
**dark** (off by default) behind the `cartographer` config block.

## Spec #1 — The doc-tree (`CartographerTree`)

`CartographerTree` builds a hierarchical map of the repository: one node per
directory and per significant source file, each carrying a plain-English `summary`
and a git object-id fingerprint (`codeHash`) captured when the summary was authored.
Staleness is **derived, never stored** — a single batched `git ls-tree` compares each
node's stored fingerprint to the code's current oid, so the tree can report exactly
which summaries have drifted from the code they describe, at near-zero cost. The
shared directory skip-set lives in `skipDirs`. Read surfaces:

- `GET /cartographer/tree` — the full doc-tree (compact form is just the index).
- `GET /cartographer/node?path=…` — a single node.
- `GET /cartographer/stale` — nodes whose summary has drifted from the code.
- `GET /cartographer/health` — node count, authored count, staleness + freshness backlog.

### Verified project roots (`CartographerRootAuthority`, `CartographerRootRegistry`)

On a standalone agent, Cartographer no longer assumes the agent's home directory is
the project a request means. `CartographerRootRegistry` resolves the request's topic
through the existing project binding, asks `CartographerRootAuthority` to verify the
checkout's canonical repository identity and exact revision, and opens an isolated
tree namespace for that root. Every Cartographer response reports that selected
identity and revision, so the tree being described is the tree that was actually
read. A request without an unambiguous topic binding is refused instead of falling
back to a noisy or stale checkout.

Structural population remains free and runs for every eligible bound root at boot.
If a checkout has no readable Git revision yet, it receives a structural-only tree
but cannot authorize paid summaries. Inline refreshes and the background sweep
revalidate the pinned revision before trusted writes; revision drift stops the write
rather than letting evidence about one checkout authorize another.

## Spec #2 — The freshness sweep (`CartographerSweepEngine`, `CartographerSweepPoller`)

A fresh tree is all "never-authored," and as code changes summaries rot. The
freshness sweep authors and re-authors summaries without becoming a token-burn or
CPU-starvation load source. `CartographerSweepEngine` is the reusable per-pass author
loop with every brake baked in: lease-gating (only one machine authors — no
multi-machine N× burn), a routing **probe** that refuses to author on the default
framework rather than silently spend Anthropic quota, deepest-first ordering, a dual
per-pass bound on node count AND estimated spend, a mid-tick CPU break, a per-node
quarantine, a self-throttling breaker, and an idempotent within-tick cursor. A
deterministic symbol-presence quality bar (in `cartographerSummary`) gates every
authored summary — no weak model grading itself — and credential-bearing files are
excluded by deny-glob plus a content tripwire. `CartographerSweepPoller` drives the
cadence with idle-aware backoff. The host CPU+memory pressure read it shares with the
session reaper lives in `HostPressureSampler`. Tier-1 affordance:

- `POST /cartographer/node/refresh` — an agent that just edited a subsystem refreshes
  that one node's summary itself (the same deterministic quality bar as the sweep).

A CI ratchet (`scripts/cartographer-freshness.mjs`) keeps aggregate freshness from
regressing and surfaces the un-authored/quarantined backlog.

## Spec #3 — The enforcement-coverage audit (`StandardsEnforcementAuditor`)

The constitution (`docs/STANDARDS-REGISTRY.md`) declares its own enforcement: nearly
every standard names the mechanism that guards it (a test, a lint, a gate, a route).
Nothing verified those claims — a standard whose guard was renamed or removed is
silently a wish wearing the costume of a guarantee. The enforcement-coverage audit
closes that gap. `StandardsRegistryParser` reads the registry into structured
articles; `StandardEnforcementExtractor` pulls the enforcement references each
standard's prose names; and `StandardsEnforcementAuditor` verifies each reference
actually exists on disk and classifies the standard's enforcement strength (a CI
ratchet beats a gate beats a lint beats a design doc beats nothing). It surfaces the
**gaps** (standards with no verifiable guard) and, loudest, **dangling references** (a
standard citing a guard that no longer exists). It is "Structure beats Willpower" made
measurable.

The parser reads complete article blocks through a closed enforcement-heading list,
not every bold section indiscriminately. Guard headings such as **Applied through**,
**Enforced by (structure, not willpower)**, and **Full spec(s)** are included;
provenance such as **Earned from** and **Traces to the goal** is deliberately excluded,
as are explicitly enumerated explanatory headings. The report's
`registry.enforcementScope` names those boundaries and lists any unrecognized article
headings, so an unread section cannot masquerade as an article with no guard.

The core is fully deterministic — local file reads only, zero token cost, zero egress,
identical output every run. An optional language-model enrichment pass for fuzzy cases
is a structural stub, off by default; the deterministic coverage is always the
authority. Read surfaces (owner-gated):

- `GET /conformance/coverage` — the full per-standard coverage map (filters by
  `family`, `kind`, `status`).
- `GET /conformance/coverage/health` — counts by enforcement kind, the enforced ratio,
  the gap list, the dangling-ref count, and the parser's enforcement-heading scope.

A CI ratchet (`scripts/standards-coverage.mjs`) holds an enforced-ratio floor and a
hard zero ceiling on dangling references.

## Spec #5 — Subtree navigation (`CartographerNavigator`)

The doc-tree was built so a sub-agent could be scoped to the *relevant* code instead
of the whole repo. `CartographerNavigator` is the piece that does it: given a task or
query, it walks the tree's summaries top-down (a bounded frontier, not every node),
scores each node by relevance (distinctive code identifiers outweigh common words),
and returns the **minimal relevant subtree** — the smallest set of paths whose union
covers the relevant code, collapsing a directory into one path when most of its
visited children are relevant and keeping individual files when relevance is
scattered. The core is fully deterministic (local reads only, zero token cost, zero
egress); an optional language-model re-rank for close calls ships off by default.
Every emitted summary is rendered as quoted, neutralized data — a summary was authored
by a model over untrusted code, so the navigator declaws instruction-shaped text
before a downstream sub-agent reads it. Read surface:

- `GET /cartographer/navigate?query=…` — the scoped manifest: `relevantPaths` (scope a
  sub-agent here) + the scored nodes + `summaryCoverage` (honesty about how much of the
  ranking was summary-informed vs path-only on a not-yet-swept tree).

## Architecture at a glance

| Layer | Core modules | Read surface |
|-------|-------------|--------------|
| Doc-tree + verified roots (spec #1 / Item 11B) | `CartographerTree`, `CartographerRootAuthority`, `CartographerRootRegistry`, `skipDirs` | `/cartographer/tree`, `/cartographer/node`, `/cartographer/stale`, `/cartographer/health` |
| Freshness sweep (spec #2) | `CartographerSweepEngine`, `CartographerSweepPoller`, `HostPressureSampler`, `cartographerSummary` | `/cartographer/node/refresh` |
| Conformance audit (spec #3) | `StandardsRegistryParser`, `StandardEnforcementExtractor`, `StandardsEnforcementAuditor` | `/conformance/coverage`, `/conformance/coverage/health` |
| Subtree navigation (spec #5) | `CartographerNavigator` | `/cartographer/navigate` |

`CartographerTree` is the substrate every layer reads; `CartographerRootRegistry`
selects its verified project namespace; `CartographerSweepEngine` authors against
it; `StandardsEnforcementAuditor` audits the constitution's enforcement, never the
code itself; `CartographerNavigator` scopes a sub-agent to the relevant subtree.
The root authority can refuse an ambiguous or drifted trusted operation; the
conformance and navigation layers remain observe-only.

## Enabling

Each layer is off by default. Enable the doc-tree with `cartographer.enabled`, the
freshness sweep with `cartographer.freshnessSweep.enabled` plus a separate
`egressAcknowledged` consent gate (the sweep transmits source to an off-Claude model),
and the conformance audit with `cartographer.conformanceAudit.enabled`. The freshness
and conformance audits never block anything — they emit signals, and a gap is a guard
worth building, surfaced not auto-fixed.
