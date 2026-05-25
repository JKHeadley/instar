# Upgrade Guide — messaging refresh (pain-leveraged positioning)

<!-- bump: patch -->
<!-- patch = bug fixes, performance improvements, no API changes -->

## What Changed

**The user-facing pitch was rewritten around the pain users actually report.**

Instar has been converging on a clearer identity — coherence infrastructure
for self-evolving agents, engine-agnostic, fractal — but the forward-facing
copy still led with category language ("identity, memory, continuity") that
every other framework also claims. Research into what users actually complain
about with the popular agent frameworks today surfaced one universal word:
**amnesia**. They say their agent forgot what they told it three sessions ago,
contradicted its own past decisions, lost the thread when the window filled,
broke on the next framework update, shipped with ALLOW-ALL defaults.

The refresh leads with that pain in users' own words, then maps each pain to
the specific shipped Instar code that answers it — Coherence Gate, Migration
Parity Standard, CompactionSentinel, CommitmentTracker, layered safety gates,
cross-platform identity resolution, Evolution System.

Updated surfaces:

- **Landing page** (`instar.sh`): new hero h1 ("Coherence infrastructure for
  your self-evolving agent"), amnesia-led subhead, NEW pain-vs-cure section
  (8 rows, side-by-side, each cure annotated with the shipped class name),
  thesis beat ("Most AI agents are hobbled at birth. Instar is the scaffolding
  that un-hobbles them."), trust strip reframed around the four positioning
  pillars (engine-agnostic, subscription-native, self-evolving).
- **README**: tagline and opening rewritten with pain-first framing plus the
  same 8-row pain-vs-cure table.
- **Docs introduction** (`instar.sh/introduction`): leads with the pitch,
  rewrites "The Problem" with user-language quotes.
- **`package.json` description**: now "Coherence infrastructure for
  self-evolving AI agents — on the Claude Code or Codex subscription you
  already have."

No runtime or API changes; no migrations needed.

## What to Tell Your User

- **Positioning**: "Instar's pitch now leads with the pain users actually
  complain about — agents that forget, contradict themselves, and break on
  updates — and shows the specific architecture that answers each."

## Summary of New Capabilities

No new capabilities — this is a copy refresh on `README.md`,
`site/src/pages/index.astro`, `site/src/content/docs/introduction.md`, and
`package.json`'s npm description.

## Evidence

Built clean (`npx astro build` on the site → 48 pages, no errors). No code
behavior changed; surface diff verified row-by-row against current shipped
class names (CompactionSentinel, CommitmentTracker, PromiseBeacon, Migration
Parity Standard, Coherence Gate's 9 reviewers, cross-platform identity
resolution, Evolution System) so every cure mapped on the page corresponds to
real shipped code in `src/`.
