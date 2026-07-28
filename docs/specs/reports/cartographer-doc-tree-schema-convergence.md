# Convergence Report — Cartographer Doc-Tree Schema (spec #1)

Spec: `docs/specs/CARTOGRAPHER-DOC-TREE-SCHEMA.md`
Project: `cartographer-conformance` (spec #1 of 5)
Converged: 2026-06-09T02:15:29Z · iterations: 2 (round 1 review → v2 → round 2 check + external)

## ELI10 Overview

We're giving Instar a living "map" of its own codebase. Today it can list which
folders exist, but it can't tell you what each part is *for*, and it has no way to
notice when a description has gone out of date because the code changed. This spec
defines that map's structure: every folder and important file becomes a "node"
with a plain-language summary of what it does, a timestamp, and a tiny git
fingerprint of the code as it looked when the summary was written. Later, to check
if a note is stale, we ask git for the code's *current* fingerprint and compare —
no AI calls at all, just comparing short strings. The clever part the review
hardened: that staleness check runs as **one** git command for the whole tree, not
one command per node, so it stays cheap even on a big repo. The map is stored as
plain files (an index plus one file per node) so a helper agent can read just the
node it cares about, and a background job (a later spec) can refresh one note
without rewriting the whole map. This spec is only the foundation — it ships turned
off and becomes useful when the next specs fill in the notes and use them.

## Original vs Converged

The original draft had the right shape but four load-bearing gaps the review
closed:

- **Staleness was a footgun.** The first draft said "for a dir node, run
  `git rev-parse HEAD:<path>`" — read literally, that's one git subprocess *per
  node* (~1,200 on instar) every time you scan for staleness. The converged spec
  mandates **one** `git ls-tree -r -t HEAD` that returns every directory and file
  object-id in a single call, then compares in memory. This is the difference
  between the freshness sweep being cheap (the whole point) and being a load
  source.
- **The on-disk filename scheme was unsafe.** The draft turned a path into a
  filename by replacing `/` with `__`, which lets two different paths collide
  (`a/b` vs a file literally named `a__b`) and invites `../../` traversal through
  the `?path=` web parameter. The converged spec hashes the path into an opaque,
  collision-free filename and validates the web parameter against the in-memory
  index — user input never builds a filesystem path.
- **It would have reached no existing agent.** The draft didn't say how the
  feature ships to already-running agents or how agents would even know the new
  routes exist. The converged spec adds the config default + `migrateConfig`, the
  CLAUDE.md template block + `migrateClaudeMd`, and the dark-by-default gate.
- **The "is it alive" test was hollow.** The converged spec spells out a concrete
  end-to-end test: start the server, author a node, see it fresh, change the file,
  see it go stale.

It also added safety bounds (max depth, symlink-loop guard, submodule handling),
an atomic write protocol for the index + node files, a precise deterministic
dirty-working-tree fallback, and an explicit trust boundary (summaries are hints,
not ground truth — downstream specs must re-ground against the code).

## Iteration Summary

| Iteration | Reviewers | Material findings | Spec changes |
|-----------|-----------|-------------------|--------------|
| 1 | internal: adversarial+security, scalability, integration, lessons-aware | 5 critical/high + 6 medium | batched `git ls-tree`; collision-free slug + path validation; migration-parity section; agent-awareness section; concrete Tier-3 lifecycle; concurrency/atomicity; dirty-tree fallback; submodule/symlink/maxDepth guards; 503 convention; shared skip-set util; trust boundary; `.gitignore` |
| 2 | internal convergence-check + external **Gemini** (cross-model) | 0 material (1 low slug-ambiguity, resolved; 2 minor Gemini notes, acknowledged) | committed to sha256 slug + index-as-reverse-lookup; acknowledged non-transactional `setSummary` + index caching |

## Full Findings Catalog

**Round 1 (material, all resolved in v2):**
- *Scalability — CRITICAL:* per-node `git rev-parse` spawn avalanche → mandated one batched `git ls-tree -r -t -z HEAD`; staleness is an in-memory hash-map compare. Git semantics (`-t` returns tree oids) independently confirmed by the convergence-check and Gemini.
- *Security/adversarial — CRITICAL:* `/`→`__` slug collision + `?path=` traversal → sha256 slug; `?path=` validated against the index, never interpolated into a git CLI string (`SafeGitExecutor` arg-form).
- *Migration Parity (lessons-aware + integration) — CRITICAL:* no `migrateConfig`/`migrateClaudeMd` → added Migration & Deployment section.
- *Agent Awareness (lessons-aware + integration) — CRITICAL:* routes undocumented → added the CLAUDE.md template block, shipped same-PR via `migrateClaudeMd`.
- *Testing Integrity — HIGH:* hollow Tier 3 → concrete author→mutate→stale lifecycle, `nodeCount ≥ 1`, wiring-integrity.
- *Mediums (all addressed):* concurrency/atomicity (atomic temp+rename, node-before-index ordering); precise deterministic dirty-tree fallback; submodule pointer-node + symlink-loop guard + maxDepth cap; 503-not-501; shared exported skip-set util; summary trust boundary; `.instar/cartographer/` gitignored.

**Round 2 (no material findings):**
- *Convergence-check:* verified all 7 round-1 areas genuinely resolved; flagged one LOW slug-encoding ambiguity (sha256 vs percent-encode) → resolved by committing to sha256 with the index as the authoritative reverse lookup.
- *External / Gemini:* "no material findings · CONVERGED." Two minor notes acknowledged in the spec: `setSummary`'s two-file update is non-transactional (benign self-healing lag); the index may be cached in-process while `staleNodes()` always re-reads live git oids.

## Convergence verdict

Converged at iteration 2. No material findings in the final round from either the
internal convergence-check or the external cross-model (Gemini) review. The spec is
ready for implementation and user review/approval. (Externals available this run:
Gemini + GPT CLIs; Gemini used. Grok/Codex CLIs not installed on this host —
abbreviated per the spec-converge external-availability allowance; the mandatory
lessons-aware pass ran in round 1.)
