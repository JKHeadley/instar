# Convergence Report: The worktree reaper recognises a node_modules install that a lockfile can rebuild

## Cross-model review: codex-cli:gpt-6.2-astra

The GPT-tier review ran in all six rounds, through the codex CLI with model gpt-6.2-astra. A clean-door Claude read (claude-code, claude-opus-5-5) also ran each round. That is a second read, not a cross-model opinion.

An internal reviewer checked the design against the code (`agentWorktreeGit.ts`) and against the real installs and `git worktree list` on the Studio, in rounds 1, 3 and at the cap. The Standards-Conformance Gate ran in rounds 1 and 2.

## ELI10 Overview

Some of the agent's working copies carry their own full install of the project's libraries, about 0.7 GB each. The cleanup keeps all of them, because one of those files might have been changed by hand.

This change lets the cleanup prove an install is untouched:
- It builds a reference install from the same list of library versions, offline, and runs no package code.
- It compares every file by content.
- The few files that packages build for themselves are archived first, each distinct file stored once.
- It checks everything again just before and just after the copy is moved to the trash.

Anything it cannot prove keeps the copy. Removal itself stays off until the Chief of Staff decides.

## Original vs Converged

- **No package code runs.** The first draft ran dependency install scripts to build the reference. The converged design runs `npm ci --ignore-scripts --offline` with the scratch `package.json`'s `scripts` removed. Every file a script would write is archived instead.
  - Offline, a GitHub git dependency missing from the cache fails without cloning. A git source on another host is unsupported. The no-scripts setting is also passed through the environment, because npm's inner install for a git dependency does not get the command-line flag (pacote source, read in review).
- **Archive, deduplicated.** Script output goes to a content-addressed store. Identical bytes, such as the 40 MB `cloudflared` binary, are stored once. Non-deterministic native objects (about 1.4 MB) are stored per checkout. Blobs, manifest and their folders are fsynced before the reclaim child's `archived` row.
- **Every link found first.** Review found 10 checkouts under `.instar/worktrees/` linking into `.worktrees/<name>/node_modules`, which the link index never walked. Each of the 176 `git worktree list` roots outside the existing walks now gets a root `node_modules` check. A full walk of those roots measured 44.5 s, too slow. A fresh root-link check also runs at removal.
- **Strict file rules, in a fixed order:**
  - a changed shipped file is `work`, even in a package with install scripts, except an executable under that package's `bin/`;
  - a missing file is `work`;
  - unsupported sources (`file:`, `link:`, remote tarballs, unpinned git) keep the checkout;
  - a git dependency pinned to a commit is archived, never trusted.
- **Change detection at both ends.**
  - Hashing is bracketed by `fstat` on the same descriptor.
  - Every entry is re-stated before the rename, and again after it.
  - A fsynced `verified` row must exist before any trash delete.
  - On a mismatch, the folder is renamed back or held.
- **Fits the existing flow.** A verdict memo is written once per pass by whoever evaluates it: the worker in dry-run, the child when live. A new class, `node-modules-residue`, is archived by `listArchivable`. The `isCleanExceptRootNodeModules` predicate is named. Every non-passing outcome maps to `work`.
- **Honest numbers.** Measured: 62 real installs, about 13 new a day, 726 MB and 16,317 files each. Hashing takes 4 s, the re-stat 1.5 s and the delete 4.1 s, so about 14 s per removal. The 62 drain in about 16 hourly runs. The creation side is filed as fb-05ffd85c-a83.

## Iteration Summary

| Round | Standards-Conformance Gate | Material / design findings | Outcome |
|---|---|---|---|
| 1 | ran (10 flags) | internal material (10 unwalked links); codex 4 design; cc 4 design | no install scripts; content-addressed residue; full re-check; missing = work; backoff; widened link walk; bin rule; memo |
| 2 | ran (11 flags) | codex 4 design; cc 2 design | `.package-lock.json` archived; residue commit point; scratch cleanup; per-kind time measured |
| 3 | not run | internal no material; codex 4; cc 1 | fresh root-link check; fstat bracket; directory fsync; child computes the verdict when live; named predicate |
| 4 | not run | codex 4; cc 2 | `node-modules-residue` class; pinned-source rule; deep-link re-read; post-rename re-stat with rename-back |
| 5 | not run | codex 3; cc 2 | root-only check for extra roots (measured 44.5 s for a full walk); `verified` row; restore direction; classification order |
| 6 (cap) | not run | codex 3; cc 2 | unsupported sources keep; daily retry for cache misses; `verified` required for every delete. The internal confirmation read pacote's source: an offline GitHub git dependency fails without cloning, but a cached one with scripts is packed by an inner `npm install` that does not get `--ignore-scripts`, and other hosts always clone. Fixed: `npm_config_ignore_scripts` and `npm_config_offline` in the environment, and git only from known hosts |

## Proportion

Tier 2: an irreversible removal rule. All 6 of 6 rounds were used. Each round's findings got narrower, from what the proof is (round 1) to crash ordering and the git `prepare` path (round 6).

## Left behind (accepted, with reason)

- **The registry dependence.** Regenerating registry files depends on the public npm registry, as any fresh clone does. Integrity pins make republished bytes impossible.
- **After the disk steward prunes the npm cache,** keys read `reference-unavailable` until sessions refill it, usually within a day. They are retried daily and the cause is reported. Going online would let git dependencies clone and run `prepare`, so the builder stays offline.
- **Links nobody's tooling makes:**
  - a hand-made link inside another checkout's `node_modules`;
  - a link from outside every listed root (`/tmp`, scratchpads, sibling agent homes; a search to depth 5 found none);
  - a deep link made in `.instar/lanes` or `.worktrees-deps` within the same pass.
- **A writer with a file already open** in the milliseconds after the post-rename check. This is the same residual as PR 3480's.
- **pnpm and partial installs stay kept** (3 of 62).
- **Fixed limits.** The reference build gets 6 minutes, a 3 GB free floor and a 2 GB scratch ceiling, with one build per pass and 14-day manifest retention. Each is derived from a measurement, each fails safe, and they are re-tuned at the maturation review.

## Full Findings Catalog

Round-by-round findings and what each changed are in the stewardship notes for 2026-11-18 (`.instar/stewardship/disk-leak-1118-evening.md`, the "Spec reaper-node-modules-regenerable" section).

## Convergence verdict

Converged at the round cap (6). Every design finding from rounds 1-6 changed the spec. The items left behind are stated residuals or fail-safe limits, not paths that lose data. The spec is ready for the Chief of Staff's review and approval.

## Approval

Approved by the Chief of Staff, 2026-11-18 21:27 PT (msg 8282ada7), as a maintainer decision rather than a constitution change. Build it on top of the approved removal change, with removal off. The condition, added to the spec: a hard cap on kept references (30 manifests; the scratch install is never kept), removal of references no checkout needs, and their size in the dry-run numbers.
