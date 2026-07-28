# Convergence Report — Cartographer Sweep Event-Loop Safety (fix instar#1069)

## ELI10 Overview

The cartographer keeps a "map" of the codebase — one index card per folder and file. On my real machine that's **366,757 cards** living in a single **67-megabyte** file. When I turned on the background job that fills in stale cards, the server kept dying every 10–15 minutes: to decide *which* cards are stale, the job read that whole 67MB file and looped over all 366k cards **on the server's one main thread** — the same thread that answers "are you alive?" health checks. For ~35 seconds at a stretch the server couldn't answer anything, so the watchdog assumed it was dead and force-restarted it. A kill-loop.

This spec establishes one rule and enforces it structurally: **nothing — not the background job, not any web endpoint — may run a whole-map-sized operation on the server's main thread, ever.** The heavy work moves onto a separate worker thread that hands back only the ~25 cards worth filling plus summary counts (never the full list); the web endpoints serve a saved snapshot instead of recomputing live; and a build-time lint makes the bug impossible to reintroduce by accident.

The biggest thing the review process changed: my first draft would **not have actually fixed the bug.** It closed the one hole I'd diagnosed and left **five others** open — the same freeze reachable through the health endpoint, a revalidation step, the health route's heaviest call, a too-small file buffer, and (buried deepest) the fact that *filling in* each card rewrote the entire 67MB map from scratch. Five review rounds turned a one-hole patch into a complete close of the whole class. The sweep stays **off** until this ships; then I re-enable it and finally deliver the cost-per-pass numbers owed (commitment CMT-1355).

## Original vs Converged

**Originally**, the spec moved a single operation (the sweep's "what's stale?" scan) onto a worker thread and called it done. It named one starvation source, set a 2-minute timeout as the safety bound, and deferred the boot-time map build as "out of scope."

**After convergence**, the spec:

- **Closes all six main-thread freeze paths**, not one. Review proved that closing any subset leaves the kill-loop reachable through a side door, so #1069 is only actually fixed when all six are closed: the sweep scan, a revalidation re-parse, the request-path map rebuild, the health route's heaviest call, a too-small git buffer (which would *crash* on this tree, not just freeze), and the author path that rewrote the whole 67MB map per card.
- **Bounds the worker in memory, not just time.** The first draft claimed the timeout was the safety bound; review showed a timeout *cannot interrupt* a 67MB parse mid-flight. The converged design adds a memory cap + a pre-parse size guard as the real bound, co-sized so the intended tree still succeeds (a too-tight cap would silently disable the feature on the exact tree it's for).
- **Makes the worker testable.** A worker thread can't load TypeScript the way the test suite runs, so the logic moved into a plain importable module (unit-tested in-process) with a trivial worker wrapper, plus one test that runs the real worker from the built output. The test pipeline gains a build step so those tests have something to run against.
- **Fixes the rollback trap.** The "turn the worker off" escape hatch originally would have silently reverted to the old full-map walk — i.e. reintroduced #1069 when you reach for it because the worker misbehaved. It's now pinned to run the *same bounded logic* synchronously, never the legacy walk.
- **Adds the structural guards the constitution requires:** a lint forbidding the heavy calls on hot paths (Structure > Willpower, not "enforced by review"); an interim concretely-specified boot-path bound so the deferral isn't a recurrence risk; migration parity (config defaults, `.gitignore`, the CLAUDE.md template); multi-machine lease-gating; honest snapshot staleness reporting.
- **Makes a decorative config field real.** `freshnessSweep.framework` looked authoritative but was ignored (part of why the bug hid). It's now honored, boot-logged, and tested — including a test that it can never become a backdoor around the "never spend Claude quota" floor.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, lessons-aware | ~22 (4 critical/high convergent: request-path scaffold, revalidate loadIndex, freshnessHealth on /health, worker-untestable) | Full rewrite: 5-starver inventory, worker pure-module split, order-then-bound, memory bounds, env allowlist, snapshot routes, lint, migration, lease-gating, rollback flag |
| 2 | security/adversarial, scalability/integration, lessons-aware | 5 (1 high: rollback re-introduces #1069; +/tree+/node undefined, test pipeline has no build, boot-scaffold underspecified, heap/byte co-sizing) | Rollback pinned to pure module; /tree+/node ceiling; globalSetup build step; concrete boot-scaffold; heap↔byte co-sizing; shared snapshot enum |
| 3 | (split) integration/lessons = CONVERGED; security/scalability | 1 (high: `staleSincePass` anti-starvation counter only in node files, collides with zero-node-file-read invariant) | Added index-schema slice (optional field, coalesce, no rewrite migration) |
| 4 | (split) lessons/integration = converged-with-2-wording; security/scalability | 1 (high: defer-counter + author-path index writes are main-thread 67MB ops; the deleted main loop / two-writer reconciliation) | Added index-write discipline (all 67MB I/O off-thread, two bounded writes/pass, single-writer); 6th starver named; wording fixes |
| 5 | all perspectives (single reviewer) | 0 material (2 stale-count doc fixes + 1 lint-attribution wording) | "five→six" count corrected in invariant + ELI16; lint attribution tightened to the integration test |

## Full Findings Catalog

### Iteration 1 (round-1, ~22 findings)

**Critical/High (convergent across reviewers):**
- **Request-path `scaffold()`** (critical; adversarial/scalability/integration/lessons) — `/cartographer/{tree,stale,node,health}` call `scaffold()` synchronously on a missing index = a 366k walk on the request thread, resurrecting the kill-loop. The spec edited these routes but left the call. → Removed the lazy scaffold/loadIndex preamble; routes serve `absent` immediately.
- **`revalidateSample()` → `loadIndex()`** (high; adversarial) — 67MB parse on the main thread every pass, even after detect moves off-thread. → Folded into the worker payload; no main-thread loadIndex.
- **`freshnessHealth()` on `/health`** (high; scalability) — up to 366k node-file reads on the request thread, heavier than the `health()` call the draft named. → Computed in the worker, served from the snapshot.
- **Worker untestable from TS** (critical; integration) — the test suite runs TS source; a worker can't load `.ts`, so the prod worker path was structurally unverifiable. → Pure module (in-process unit tests) + one dist-backed integration test.

**Medium/High (single-reviewer, material):**
- Worker inherits full secret `process.env` (security) → env allowlist.
- Worker memory unbounded; `terminate()` can't interrupt `JSON.parse` (scalability/lessons) → resourceLimits heap cap + pre-parse byte guard.
- `git ls-tree` buffered at 10MB default → throws on this tree (scalability/adversarial) → explicit ≥64MB maxBuffer + refuse-on-overflow, never "all path-gone".
- `orderCandidates` needs full set / per-node reads (scalability) → order-then-bound from index only, zero node-file reads.
- Snapshot not gitignored + file-viewer exposure (security/integration) → `.gitignore` migration + secret-path filtering.
- detect-timeout → breaker can't reclose + snapshot permanently absent; "not started" vs "failing" indistinguishable (adversarial/integration/lessons) → `lastDetectStatus` + `snapshotStale`.
- Slice 3 routing precedence silently outranks `categories.job` (adversarial/security) → explicit-set-only + boot log + claude-floor test.
- Drift test tautological (adversarial/lessons) → golden-output ordering test.
- Lease-gating: detect spawns on every host / standby serves absent (scalability/integration) → detect gated behind `holdsLease()`.
- scaffold deferral is a recurrence-risking deferral without sign-off (lessons P10) → interim in-PR boot-path bound.
- worker-start failure must set `refused:true` to feed breaker (adversarial) → required + tested.
- Response-shape backward compat (integration) → additive contract, legacy fields preserved.
- Migration parity: detectTimeoutMs via ConfigDefaults applyDefaults backfill; CLAUDE.md template update (integration/lessons).
- Open Q1 (CI ratchet) resolved: ratchet re-derives from git, independent of snapshot. Open Q2 (lint) resolved: ship the lint.

**Counter-findings (confirmed sound):** breaker is signal-only not authority (lessons P2); `allowClaudeFallback` probe is sound; prompt-injection surface unchanged; HTTP auth unchanged + improved.

### Iteration 2 (5 material)
- **Rollback `detectInWorker:false` re-introduces #1069** (high; all three) — "bounded synchronous detect" either didn't exist (reverts to `staleNodes()`) or contradicted order-then-bound. → Pinned to run the shared pure module synchronously, never `staleNodes()`; lint allowlists the pure module so lint+rollback don't contradict; test asserts bounded materialization.
- **`/cartographer/tree` + `/node` left undefined** under the lint forbidding loadIndex (high; scalability) → `maxRequestNodes` ceiling; compact from snapshot; `too-large-for-request` above ceiling.
- **Test pipeline has no build step** (high; scalability/lessons) → integration/e2e `globalSetup` runs `npm run build`; dist test runs against real build output, fail-loud if absent.
- **Interim boot-scaffold underspecified** (medium; all three) → concrete: `AgentServer.start()` queued chunked one-shot, per-yield lag ceiling (not total-duration), P19 brakes (discard partial via atomic rename, boot-cadenced retry).
- **Byte-guard ↔ heap-cap co-sizing** (medium; security) → heap default ≥ maxIndexBytes × 4–6× expansion + headroom; "detect succeeds on large fixture" test.
- Minor: `/stale` snapshot enum aligned with `/health`; shared detect maxBuffer covers rollback path.

### Iteration 3 (1 material)
- **`staleSincePass` anti-starvation counter only in per-node files** (high; scalability) — the "detect reads zero node files" invariant collides with the ordering logic that reads the counter; it's accumulated history (not recomputable), so it must be in the parsed index. → Added as optional index field; coalesce missing→0; schemaVersion bump documentation-only; no 67MB rewrite migration. (Integration/lessons reviewer: CONVERGED.)

### Iteration 4 (1 material)
- **Defer-counter write-back + author-path index write are main-thread 67MB ops** (high; scalability/lessons) — moving ordering to the worker orphaned the main-thread defer loop (which iterated an unbounded deferred set), and `setSummary`/`patchNodeMeta` rewrite the whole 67MB index per node (the sixth starver). → Index-write discipline: all 67MB parse/serialize off-thread; two bounded off-thread writes per pass (detect-phase defer increments before worker exit; author-phase ≤maxNodesPerPass summary deltas via off-thread re-read+apply+write); main-thread defer loop deleted; single-writer via lease + single-flight. Lessons reviewer's two wording fixes (schemaVersion is not a loader gate; pin the write-back to an allowlisted method) folded in.

### Iteration 5 (0 material — CONVERGED)
- Two stale-count documentation fixes ("five → six paths" in the invariant sentence and the ELI16 overview) introduced when the inventory grew this round; one lint-attribution wording tightening (credit the integration test, not the lint, for starver 6). All three applied. Scope judgment: large for a bug fix, but a coherent single PR — the invariant requires all six closed to actually fix #1069; should ship whole.

## Convergence verdict

**Converged at iteration 5.** No material findings in the final round across all five perspectives (security, adversarial, scalability, integration, lessons-aware). The final round's only items were trivial doc-consistency corrections, now applied. The design closes the complete class of main-thread whole-tree operations (all six paths), bounds the worker in both time and memory, is testable end-to-end including the prod worker resolution, enforces the invariant structurally (lint + integration lag harness), ships migration parity for existing agents, and preserves the never-spend-Claude-quota floor. Spec is ready for user review and approval.

**Process note (external reviewers):** internal reviewers (security, scalability, adversarial, integration, lessons-aware) ran in full every round — the lessons-aware pass (the non-skippable circular-convergence defense) ran each round and was the source of the foundation-audit findings (P10 scaffold deferral, the signal-vs-authority confirmation, the schemaVersion-is-not-a-gate catch). External cross-model reviewers (GPT/Grok) could not run on this machine (no codex binary / no API keys in vault), consistent with prior convergences in this project; this is disclosed here and the internal panel ran at full strength.
