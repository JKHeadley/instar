# Side-Effects Review — Cartographer Project-Aware Navigation

**Version / slug:** `cartographer-project-aware-navigation`
**Date:** `2026-08-02`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** not required by the `instar-dev` trigger list; independent PR review pending

## Summary

This change is the live Item 11B-2 consumer boundary. It replaces production's
single `config.projectDir` Cartographer tree with a registry that selects roots
from existing topic/project provenance, assesses them through
`CartographerRootAuthority`, isolates their state, populates every eligible root
at boot, reports the selected identity, and revalidates before paid writes. One
resolved object supplies reporting, reads, navigation, and authoring for each
operation, preventing a report/read split.

## Decision-point inventory

- `CartographerRootRegistry.resolve` — **add** — selects, assesses, caches for one
  boot, mints the isolated tree, and records the decision durably.
- `CartographerRootRegistry.authorizePaidAuthoring` — **add** — revalidates the
  root identity and boot-pinned revision before a trusted write.
- `CartographerRootRegistry.populateOnBoot` — **add** — enumerates explicit
  bindings (plus the declared project for project-bound agents), deduplicates
  identities, and structurally populates each eligible root.
- Cartographer route resolver — **replace** — resolves once per request; all
  Cartographer and conformance reads use the resulting tree and response report.
- Inline refresh — **tighten** — requires live root authority; the legacy
  singleton is read-only and cannot authorize a write.
- Background sweep — **tighten** — requires an unambiguous root and revalidates
  before/after every awaited authoring boundary.
- Navigator result filter — **tighten** — visited zero-score siblings remain in
  traversal accounting but are no longer returned as navigation results.

## 1. Over-block

- Standalone callers that omit `topicId` now receive `409` with
  `topic-binding-required`; they no longer read or author against agent home.
  This is the intended removal of the observed wrong-root fallback.
- A topic binding to a missing, nested, remote-mismatched, or revision-mismatched
  checkout is refused. A legitimate checkout with stale binding metadata must be
  corrected at the binding rather than guessed around.
- An unborn/unreadable HEAD cannot use inline or background summary authoring,
  even if its structural files are useful. The structural map remains available.
- Background sweep on a standalone agent has no request topic and therefore does
  not start. This change does not invent a global “current topic” or pick one of
  several bindings.

## 2. Under-block and known limits

- A topic binding without `gitRemote` can verify from the checkout's observed
  remote or common Git directory. The binding is still the selection authority;
  host compromise and forged local Git configuration are out of scope.
- Root identity is not semantic correctness. The known-present query control
  proves the selected tree contains the intended target at the unchanged
  200-node ceiling; summary quality remains separately governed.
- A binding added after boot resolves to the correct isolated root immediately,
  but its first structural population is guaranteed at the next boot. Until then
  read routes honestly return `indexState: not-built` rather than falling back.
- Per-root index directories are regenerable caches, not history. At boot the
  registry removes only authority-shaped namespaces that no live binding selects,
  and only after at least one current root positively verifies. An empty/corrupt
  binding view never becomes delete-all. Unrelated files and active root caches are
  untouched. A failed prune is reported and does not block current-root population.

## 3. Level-of-abstraction fit

The registry is the single live consumer of the typed authority. Routes do not
reimplement Git verification, and `CartographerTree` still knows only a canonical
project directory and opaque authority namespace. Existing `ScopeVerifier`
topic bindings remain the provenance registry; no bare directory config knob or
second binding store was added.

## 4. Signal vs authority

This is deterministic authority over enumerable filesystem/Git invariants, not
a brittle judgment over conversational meaning. Explicit selection, canonical
path, repository identity, revision, and equality are mechanically testable.
Missing proof degrades to structural-only; contradictory proof refuses. Every
assessment and revalidation is recorded before its outcome may be used.

The live decision log is local, mode-restricted, and bounded: a 5 MiB active file
plus two rotated archives. Rotation failure propagates through the required
recorder and fails the authority outcome closed.

## 4b. Judgment-point check

No competing-signals judgment is delegated to static logic here. Root selection,
canonical repository identity, exact revision, and equality are enumerable hard
invariants. Missing proof produces the explicitly weaker structural-only posture;
contradictory proof refuses. The mechanism does not interpret conversational
intent, rank plausible projects, or override an explicit binding with a guess.

## 5. Interactions and races

- **Shadowing:** production passes only `cartographerRoots`; the old singleton is
  retained solely as a read-only isolated-test compatibility seam.
- **Double-fire:** boot population deduplicates by authority root identity, so two
  topics bound to one checkout rebuild one tree, not two.
- **Accumulation:** the decision trail has a fixed active/archive byte bound, and
  inactive namespaced root caches are pruned at boot. Active cache cardinality is
  the current binding set rather than an append-only history of past topics.
- **Read/report split:** each route resolves once and passes the same tree/report
  pair through snapshot, node, health, navigation, conformance, and response code.
- **Revision races:** assessments pin one revision for the boot lifetime. Inline
  writes revalidate synchronously before work. The sweep revalidates at admission,
  after worker detection, before each node, and after every model await before
  persistence. A mid-pass refusal retains prior valid work and stops further work.
- **Main-thread work:** request paths perform cached selection and O(1) tree reads;
  topic bindings are read from `ScopeVerifier`'s live in-memory map. Structural
  scans remain chunked boot work and detect remains worker-backed.
- **Cost:** population has no router, queue, model, or egress dependency. Paid
  sweep configuration is not enabled or mutated by this change.

## 6. External and operator surfaces

Authenticated Cartographer responses gain additive `rootAuthority` metadata.
Standalone callers must provide a valid topic id. Existing topic-binding APIs are
the operator control; no new setting or UI is required. Decision rows contain
local canonical paths and Git identity, so they stay machine-local and are not
published or replicated.

## 6b. Operator-surface quality

No dashboard, approval, grant, destructive-action, or new configuration surface
is introduced. The only operator-visible change is honest additive provenance on
existing authenticated responses and an explicit refusal for ambiguous standalone
requests. Errors use stable reason codes and do not expose raw stacks or ask the
operator to repair filesystem state manually.

## 7. Multi-machine posture

Machine-local by design. Canonical paths, worktrees, revisions, indexes, and
decision logs describe one machine's checkout. A topic moved to another machine
is re-selected and populated from that machine's binding and filesystem. The
response's root identity/revision provides honest per-machine provenance rather
than asserting a fleet-global path. This change emits no user notices, creates no
URLs, and replicates no canonical-path evidence. Its durable cache and decision
evidence are machine-local and regenerable; moving a topic does not strand user
state because bindings and repository contents remain the source, while the new
machine rebuilds its own namespace on boot.

## 8. Rollback and data

Rollback restores the legacy singleton wiring. Existing legacy Cartographer state
is untouched, so it becomes readable again immediately. New active namespaced root
directories and the bounded authority log are regenerable machine-local cache and
evidence; rollback need not delete them. Inactive authority-shaped caches are
removed only during a later authority-enabled boot. No user content, repository file, topic
binding, paid-sweep flag, or Git state is migrated.

## Conclusion

The intended compatibility break is narrow and explicit: ambiguous standalone
requests stop falling back to agent home. The highest-risk boundary—paid writing
against a different or moved checkout—is fail-closed at both inline and background
seams. Structural-only degradation, cross-topic isolation, unchanged navigation
ceiling, decision-log bounds, and every-boot refresh all have executable controls.

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: {
enforcementType: ratchet, citation: tests/unit/cartographer-sweep-engine.test.ts,
howCaught: the existing Cartographer poller-to-sweep control-loop edge keeps its
per-pass node and spend bounds, lease check, idle cadence, and zero-progress
breaker; this change adds root-authority refusal before every paid boundary, so
sustained stale authority performs zero writes and settles by opening the existing
breaker rather than minting new allowance }`.

The engine tests pin both per-pass ceilings and refusal before admission, after
detection, before node work, and after an awaited model result before persistence.
`tests/unit/cartographer-sweep-poller-breaker.test.ts` drives repeated refused
passes and proves the breaker opens. The standing controller convergence ratchet
remains `tests/unit/self-action-convergence.test.ts`; this increment adds no new
cadence, retry edge, notification, or recursive trigger.

## Evidence pointers

- Complete Cartographer authority/routes/navigation/sweep/lifecycle matrix:
  190/190 passing across all 20 Cartographer test files after final hardening.
- Repository-wide aggregate: 47,469 passing assertions. All 16 non-external
  failures from the ambient run passed on a controlled 83/83 rerun; the two
  remaining live-Gemini assertions require a metered credential this host
  deliberately does not have and were not armed for this change.
- Full repository lint and TypeScript typecheck: passing.
- Production build: passing (the known no-local-signing-key transition remains
  an explicit warning, not a build failure).
- `git diff --check`: passing.
