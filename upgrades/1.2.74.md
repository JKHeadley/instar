# Upgrade Guide — one ranked working set across the memory stores

<!-- bump: minor -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->

## What Changed

**The memory stores now feed one ranked reading list instead of three separate ones.**

Topic-intent (conversation facts + task frame), Playbook (tagged context items),
and semantic/episodic memory each had their own read path and ranking. This unifies
the **reading**: the existing working-memory assembler — already a token-budgeted
multi-source context builder — now also draws from topic-intent and Playbook, and
ranks everything together by relevance blended with a recency-decay factor (so
fresher, more-relevant context floats up; stale context sinks but isn't deleted and
re-warms on reference).

The important design choice (ratified): this unifies the **reading, not the
storage**. The three stores keep their own backends and write paths; the assembler
is the single unified read. That makes it additive and reversible — and it's
guarded by a regression pin: **when the new sources are empty, the assembled
context is byte-for-byte what it was before.** Playbook is read straight from its
manifest files (no Python invoked in the hot assembly path), and every new source
is degrade-safe — a missing or erroring source contributes nothing and never
breaks assembly.

The result shows up as a "Working Set" section in the assembled context
(`GET /session/context/:topicId`), drawing from all sources under one budget, with
per-source contribution visible in the response's `sources`.

**Evidence**: 11 new tests (8 unit — blended ranking, both source adapters,
degrade-safety, and the regression pin; 3 boot-path route tests confirming the
unified read path is alive and surfaces topic-intent in a Working Set section, and
that a ref-less topic is unchanged). The existing 49 assembler + working-memory
tests stay green (the regression pin, confirmed). `tsc` + lint clean.

Spec: `docs/specs/cwa-unify-stores.md` (approved; Claude-authored + manual review —
this is the most architectural rung, fuller multi-model review advisable, caveat
ratified). ELI16: `docs/specs/cwa-unify-stores.eli16.md`. Side-effects:
`upgrades/side-effects/cwa-unify-stores.md`.

## What to Tell Your User

- **One sorted view of what matters**: "I used to keep 'what's relevant right now'
  in three separate notebooks that didn't talk to each other. Now they feed one
  ranked reading list, so when we pick something up I get a single sorted view —
  freshest and most-relevant first — instead of three half-answers."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Unified working set in assembled context | Automatic — `GET /session/context/:topicId` now includes a "Working Set" section drawing from topic-intent + Playbook + memory |
| Blended relevance×recency ranking across sources | Automatic (the assembler ranks all sources together) |

## Evidence

Not a bug fix — a new capability over the existing assembler. Verified by 11 new
tests including 3 that boot the real AgentServer and confirm the assembled-context
route surfaces a topic-intent ref in a "Working Set" section, plus a regression pin
(unit + the unchanged existing 49-test suites) proving the assembled output is
identical when the new sources are empty. `tsc` + lint clean.
