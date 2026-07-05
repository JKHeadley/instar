---
kind: "spec"
id: "intelligent-working-set-lazy-sync"
title: "Intelligent Working-Set Lazy-Sync (agent-artifact scope)"
summary: "Make AGENT-PRODUCED conversational artifacts under the existing `.instar/` working-set jail follow a conversation across machines, and ground the agent on them at session start. Layered on the EXISTING computed working-set engine (`WorkingSetManifest.computeWorkingSet` + `WorkingSetPullCoordinator` + `POST /coherence/fetch-working-set`) — this spec adds ONE new manifest source (a durable record of INTERACTIVE, non-autonomous-run agent writes the computed engine misses) + session-start grounding. It is DELIBERATELY SCOPED to the engine's existing `.instar/`-rooted jail; syncing git-tracked project files (docs/src/tests) is a SEPARATE operator-gated initiative (see F10)."
status: draft
author: Echo
date: 2026-07-03
risk-class: "additive — a new manifest source + session-start grounding over the existing engine, inside the engine's existing security jail (no jail widening). The one behavior-changing step (session-start context injection) is guarded so an absent/empty/oversized manifest degrades to no-block. The bigger-blast-radius option (project-file sync) is explicitly OUT of scope and gated to an operator decision + its own security review (F10)."
parent-principle: "Working-Set Handoff (files follow the conversation) + Goal B + no-clobber replicated-store discipline + Know-Your-Data (a cross-machine manifest is UNTRUSTED) + Migration Parity + verify-existing-behavior-before-asserting-it (round-1 lesson: the foundation is computed-not-declared and `.instar/`-jailed — do NOT assume)."
lessons-engaged:
  - "Foundation reality (round-1, verified against source): the engine is COMPUTED-NOT-DECLARED (`WorkingSetManifest.computeWorkingSet`) — it DELIBERATELY superseded declaration-driven manifests. Its sources are the `autonomous/<topic>.*` convention dir + jailed `artifactPaths` on `autonomous-run` journal entries; its jail roots are `[conventionDir, serverRecordDir, stateDir]` (`.instar/`-rooted, NOT the project repo). Real caps: maxFileBytes 4MB, headlineFileBytes 16MB, maxFiles 64, maxTotalBytes 32MB, 64MB hash ceiling. Pending-pull TTL 7d; `PendingPullLedger` attempt-cap 6. `WorkingSetPullCoordinator.onTopicAccepted` ALREADY fires the fetch non-blocking on topic-move with single-flight + (topic,epoch) dedupe. This spec BINDS to all of that verbatim and adds ONE source + grounding."
  - "The real GAP this closes: the computed engine sees autonomous-RUN artifacts + the convention dir, but NOT files an agent writes INTERACTIVELY (a conversational report/analysis under `.instar/` with no autonomous run). That interactive-write case is the entire net-new value."
  - "multimachine-project-sync-gap (memory): project repos are git-synced, NOT agent-synced — deliberately. Landing `.from-<machine>` copies of git-tracked files inside a worktree fights git-as-source-of-truth + SourceTreeGuard. So project-file sync is OUT of scope here (F10), not a config default."
  - "132MB-flood + bounded-state: the new artifact record is (path, producerMachineId)-KEYED (latest hash wins within a producer row) + tombstoned on delete + GC'd; never an append-per-edit log."
  - "Live-verify-multimachine: the cross-machine E2E needs the real pair; the Laptop is offline, so that phase is a named BLOCKER."
review-convergence: "2026-07-04T01:29:44.798Z"
review-iterations: 3
review-completed-at: "2026-07-04T01:29:44.798Z"
review-report: "docs/specs/reports/intelligent-working-set-lazy-sync-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 1
contested-then-cleared: 1
approved: true
approved-by: "Justin (operator, telegram-7812716706) — standing blanket build approval for the 29836 autonomous run (2026-07-04 yes you drive this)"

---

# Intelligent Working-Set Lazy-Sync (agent-artifact scope)

**Status:** DRAFT (re-scoped to narrow after round 1; broad project-file sync deferred to operator — F10) <!-- tracked: topic-29836 -->
**Owner:** Echo
**Created:** 2026-07-03
**Goal Alignment:** Goal B (Seamless agent across machines)

## Problem

An agent-produced artifact from a conversation (a report/analysis it wrote under `.instar/` 20 minutes ago) does not follow the conversation when the topic moves machines — UNLESS it happened to be produced by an autonomous run (which the computed engine records via `artifactPaths`). A file the agent wrote **interactively** (no autonomous run) is invisible to the engine, so after a topic-move the receiving machine can't fetch it and the agent isn't grounded that it exists elsewhere. Goal B wants agent artifacts to follow the conversation transparently.

## Non-negotiable foundation (verified round-1, binding)

BINDS to `docs/specs/WORKING-SET-HANDOFF-SPEC.md` + the live engine, whose real behavior (verified against source, NOT assumed) is:
- **Computed-not-declared:** `WorkingSetManifest.computeWorkingSet` DERIVES the manifest from the `autonomous/<topic>.*` convention dir + `artifactPaths` on `autonomous-run` journal entries. It deliberately superseded live "artifacts-updated" declarations. **Jail roots = `[conventionDir, serverRecordDir, stateDir]` (`.instar/`-rooted).**
- **Transport:** verified 1MB resumable slices, SHA-256 hash-verify (mismatch → drop, never land), NEVER-overwrite (divergent local kept; incoming lands as `<base>.from-<sender>-<hash8><ext>`), refusal of `secretFlagged`/`tooLarge`/still-being-written files, durable deferred pull via `PendingPullLedger` (7d TTL, attempt-cap 6) when the producer is offline.
- **Caps:** maxFileBytes 4MB, headlineFileBytes 16MB, maxFiles 64, maxTotalBytes 32MB, 64MB hash ceiling.
- **Auto-trigger:** `WorkingSetPullCoordinator.onTopicAccepted` ALREADY fires the fetch non-blocking on topic-move (single-flight, `(topic,epoch)` op-key dedupe, load-aware defer, `nomineeCap`). Reflex route `POST /coherence/fetch-working-set` → `FetchOutcome { topic, scheduled, skipReason, reports, cappedNominees }`.

**This spec MUST NOT re-implement, widen the jail of, or weaken any of the above.** It adds exactly: (1) a new manifest SOURCE for interactive agent writes under the existing jail, (2) session-start grounding. A change that duplicates the fetch engine, widens the jail, or lowers a cap is a defect.

## Design

### Layer 1 — Interactive-artifact record (the one new source)
A durable per-topic record of files the agent writes INTERACTIVELY under the existing `.instar/` jail (the case the computed engine misses).

**Replication carrier — the WS2 replicated-store path (round-2, integration+codex #3), NOT an `autonomous-run`-style journal kind.** Register a replicated store `working-set-artifact` on the existing **`ReplicatedKindRegistry` + `ReplicatedRecordEnvelope`** machinery. That path ALREADY provides — for free — exactly this spec's design: a **recordKey** cross-machine identity, **`op: put|delete` tombstones** with `hlc/origin` delete-propagation, and **append-both-and-flag on concurrent divergent edits** to the same recordKey (the no-clobber "both versions coexist" requirement). The `autonomous-run` append-log path is WRONG here: it has none of that machinery AND a missing `JournalSyncApplier` apply branch silently REJECTS the kind (suspect-flags the peer, halts replication — the known 2026-06-30 bug). **Alternatives considered:** a content-addressed manifest index (rejected — no per-producer identity/tombstone) and extending `autonomous-run` (rejected — above). The WS2 store is the minimal correct carrier.

**The path-payload / envelope path-jail collision (round-2, M1 — this kind is the FIRST replicated kind whose payload is legitimately a path).** The envelope STRUCTURALLY auto-jails path-shaped fields (recordKey/origin rejected if path-shaped; declared string fields containing `/` jailed to null — `KnowledgeReplicatedStore` jails a path-shaped `url` to null). So:
- **recordKey = `sha256(jailedRelPath) + ':' + producerMachineId`** — a NON-path-shaped derivation (never the raw path), so it survives envelope validation and still gives the `(path, producerMachineId)` identity (divergent producers coexist; latest-hash-wins only WITHIN a producer row).
- **`relPath` lives in a store field explicitly carved OUT of `pathSensitiveFields`** (so it may hold a path) but is STRICTLY validated on RECEIVE at the replication boundary — `isSafeRelPath` semantics (relative-only; reject abs / drive / UNC / `..`-after-decode / **NUL** / empty), length-capped — because the filesystem serve-jail is DOWNSTREAM and an `invalid`/suspect verdict happens FIRST. This deliberately breaks the "envelope carries identifiers, never artifact paths" invariant; the receive-side relPath validation is the compensating control, called out explicitly.
- `producerMachineId` ≡ the applier's authenticated `entry.machine` (verified first-hop sender), never a separate content field.

Record shape: `{ relPath, contentHash?, lastWrittenAt, producerMachineId, state }`. **Row states (round-3, codex #3 — content-identity is explicit, not muddy):** `pendingHash` (recorded, hash deferred) → `ready(hash)` (hashed, in scope) → terminal `tooLarge` / `secretFlagged`. **ONLY `ready` rows enter fetch nominees** — a `pendingHash` row is not yet fetchable (no stale-hash race into nomination), and the serve-boundary hash-verify remains the authority (a row's stored hash is advisory until the pull re-reads live). `computeWorkingSet` gains a third source (the store's `ready` rows for the topic) unioned at the same serve boundary, re-jailed + credential-scanned there exactly like the other two sources. **Path validation is ONE canonical shared validator (round-3, codex #5):** a single `jailValidateRelPath(relPath)` module is used at ALL sites (record, replication-receive, serve-jail) so the realpath/O_NOFOLLOW/abs-`..`-NUL/containment rules can't drift between callers.

**Record guards:**
- **Jail = the engine's existing `.instar/` roots** (NO widening). A recorded path is canonicalized (realpath every component, reject absolute / `..`-after-decode / NUL, O_NOFOLLOW per component) and must resolve under a jail root; else dropped + logged.
- **Credential fail-CLOSED:** the `secretFlagged` classifier runs at record time; a classifier error/timeout/UNKNOWN verdict DROPS the row (never records). "Best-effort" = best-effort-to-DROP. Re-record re-runs the classifier on current content (no cached verdict).
- **Exclude conflict artifacts:** the engine's `<base>.from-<sender>-<hash8><ext>` alongside pattern is NEVER recorded (it's a conflict copy, not user work — recording it would promote it to authoritative + loop).
- **Exclude git-tracked files:** anything under a `.git` worktree is NOT recorded (project files are git-synced; F10). Reinforces the `.instar/`-only scope + avoids fighting SourceTreeGuard.
- **Deletion tombstone:** a delete emits a tombstone that propagates (matching the replicated-store discipline), so a user-deleted artifact stays gone on peers instead of resurrecting.
- **Latency:** recording is fire-and-forget at the hook boundary (detached POST, hook returns immediately — the `compaction-recovery.sh` backgrounded-curl pattern); hashing is DEFERRED to the serve boundary / a bounded async worker and lazy-skipped above the 64MB hash ceiling. No per-Write/Edit latency.
- **Authentication:** a record replicated from a peer is honored ONLY from a mesh-authenticated peer; `producerMachineId` is verified against the authenticated journal sender, never trusted from content.

### Layer 2 — Fetch (BIND verbatim, no new code)
Topic-move already fires `onTopicAccepted` non-blocking; the union'd manifest now includes the interactive records, so those files fetch through the existing engine (slices, SHA-256 verify-or-drop, no-clobber, `secretFlagged`/`tooLarge` refusal, deferred pull on offline producer). The fetch report is the real `FetchOutcome` shape. New pulls file into the existing `PendingPullLedger` so they inherit its attempt-cap-6 breaker + 7d-retention-exhaustion escalation (no bespoke retry loop).

### Layer 3 — Session-start grounding (UNTRUSTED-data-safe)
At session boot, inject an implicit (never-user-shown) working-set block: what synced / what's a divergent `.from-<machine>` conflict (rendered as an UNRESOLVED conflict naming BOTH paths, neither authoritative until the operator picks — never "here is the file") / what's deferred. Manifest paths render inside the existing named `<replicated-untrusted-data>` envelope (bind to it, don't invent), charset-clamped to a printable allowlist (strip/escape the envelope delimiter + newlines + controls), per-path length-capped, row-count-capped (≤ the engine's maxFiles 64), and total-block byte-bounded with honest truncation. "Deferred" status aligns to the 7d pending-pull TTL — a row past that renders "stale — no longer fetching," not "syncing." **The grounding block is ADVISORY, not authoritative (round-2, codex #4):** replicated metadata may be stale/partial/adversarial, so the block explicitly frames itself as "what MAY exist where, as of last sync" — the agent RE-VERIFIES against the live local filesystem before acting on any path (a listed file may be absent; an absent listing doesn't mean the file can't exist locally). It grounds attention, never substitutes for a real read. **The grounding block is the SECONDARY surface, not the mechanism (round-3, codex #4):** the same working-set state is exposed deterministically at `GET /coherence/working-set?topic=N` (rows + states + synced/deferred/stale per machine) — a status command/UI a build or the agent can query without depending on the LLM "noticing" advisory text. The core behavior (files fetched on move) is the deterministic engine; the session-start block is a convenience layer over the API, never the source of truth.

## Multi-machine posture

- **Interactive-artifact record** — **unified / replicated** via the WS2 `working-set-artifact` replicated store (`ReplicatedKindRegistry` + envelope — a REAL carrier that provides recordKey/tombstone/append-both, verified round-2). Concurrent divergent edits: both producer rows (distinct recordKeys) coexist; both versions fetch; no-clobber lands the second as `.from-<machine>`. **Dual-registry rule honored:** the kind is registered in BOTH the `ReplicatedKindRegistry` AND a store consumer (a kind registered without a consumer advertises `stateSyncReceive=true` yet serves/applies nothing — a silent no-replication; this spec names both halves in Migration Parity).
- **Fetched artifact files** — **machine-local BY DESIGN** (`machine-local-justification: hardware-bound-resource` — bytes live on the disk that fetched them; the record is the unified index).
- **Deferred-pull queue** (`PendingPullLedger`) — **machine-local** (each machine tracks what IT still needs); pool-scope read merges by machine.

## Frontloaded Decisions

1. **F1 — Bind, don't rebuild:** reuse the engine's slice/verify/no-overwrite/refusal/deferred-pull + `onTopicAccepted` trigger verbatim; add only the `artifact-record` source + Layer 3.
2. **F2 — Non-blocking:** the existing `onTopicAccepted` is already non-blocking + producer-offline-deferred; nothing new blocks a swap.
3. **F3 — Record key + lifecycle:** recordKey `sha256(relPath)+':'+producerMachineId`; latest hash wins WITHIN a producer row; GC purges rows older than the record TTL (**default 30 days**, config `coherenceJournal.workingSet.recordTtlDays`) — distinct from the engine's 7d pending-pull TTL, and the session-block "deferred" status uses the 7d pull TTL, not the 30d record TTL. **Tombstone authority (round-2, codex #1) — OWNER-ONLY:** only the PRODUCER of a row (the machine whose `producerMachineId` matches the authenticated `entry.machine`) may tombstone (delete-propagate) that row — so a user deleting the ORIGINAL on the producer erases it everywhere. A RECEIVER deleting its FETCHED local copy is a **machine-local suppression**, NOT a cross-peer delete — a peer can never tombstone another producer's artifact (that would be a remote-delete authority hole). **Suppression storage (round-3, codex #1):** machine-local state keyed `{topic, recordKey, contentHash}`, expiring no later than the record TTL, and CLEARED when the producer's hash changes (a new version IS re-fetched — suppression is per-content, not per-path). This resolves both "receiver-delete resurrects" (suppression stops re-fetch of the same content) and "any peer can remote-delete" (owner-only).
4. **F4 — Jail = the engine's existing `.instar/` roots, NOT widened.** Canonicalize + O_NOFOLLOW + reject abs/`..`/**NUL** (the recorder MUST `value.includes('\0')`-reject at record AND the relPath receive-validator must reject NUL — round-2 M2: `isSafeRelPath` doesn't catch NUL, which would otherwise throw uncaught in the write path; fail-clean, don't throw); re-jail the derived `.from-<machine>` path (confirmed the engine already does `isContained(stateDir, alongsidePath)` + `sanitizeBasename`).
5. **F5 — Credential fail-CLOSED** at record (drop on error/UNKNOWN); re-classify on re-record.
6. **F6 — Caps = the engine's** (4MB/file, 16MB headline, 64 files, 32MB total, 64MB hash ceiling). This spec does NOT set its own 50MB cap (that was wrong) and does NOT raise the engine caps.
7. **F7 — Untrusted render:** bind Layer 3 to the existing `<replicated-untrusted-data>` envelope + byte-bound + row-cap; a manifest is never authoritative about intent.
8. **F8 — Cross-framework recording (recorder contract, round-2, codex #2):** on emitting frameworks (claude-code), a NEW built-in PostToolUse hook fires on `Write`/`Edit` tool-success; required payload = the tool's resolved absolute file path + success status (the hook derives relPath vs the jail; a failed tool-call records nothing). Deletes are NOT inferred from Write/Edit — a delete is recorded only via the explicit owner-only tombstone path (F3), so an editor/temp file churn never emits phantom rows. On a NON-emitting framework (codex/gemini/pi), a bounded session-yield diff: roots = the `.instar/` jail ONLY (NOT a whole-repo walk), maxFiles/maxDepth = the engine caps, baseline = the last recorded snapshot for the topic, and — because a diff can't tell agent writes from incidental build/cache output (round-3, codex #2) — an **artifact ALLOWLIST** governs what a diff-recorder may record (subpaths/extensions for real agent artifacts: `.instar/reports/**`, `.instar/autonomous/**`, `*.md`/`*.json`/`*.txt` under the artifact dirs — NOT cache/lock/tmp), on top of the F5 exclusions (conflict artifacts, git-tracked, secretFlagged). The hook-based path (claude-code) is precise (real tool events) and does not need the allowlist; the allowlist is the diff-recorder's compensating precision. A file changed since baseline (and allowlisted) upserts; a file gone → owner-only tombstone. Concurrent NON-agent writes (a build step) under `.instar/` are accepted-as-is (hashed at serve, `unstable`-marked by the engine if mid-write) — the recorder does not attempt to distinguish agent vs non-agent authorship, only jailed-`.instar/`-vs-not.
9. **F9 — P19:** new pulls file into `PendingPullLedger` (attempt-cap 6 + 7d-retention-exhaustion → one deduped attention item); no bespoke retry loop.
10. **F10 — SCOPE (broad = operator-gated future):** syncing git-tracked project files (`docs/`, `src/`, `tests/`) is OUT of scope. It would require (a) reversing the engine's computed-not-declared decision, (b) WIDENING the security jail from `.instar/` to the whole repo (a real blast-radius expansion needing its own TOCTOU/symlink security review), and (c) reconciling with `multimachine-project-sync-gap` (project repos are git-synced by design). **This is a separate initiative requiring an explicit operator architectural decision + a dedicated security spec** — surfaced to the operator, NOT chosen autonomously. This narrow spec ships the safe, additive `.instar/`-artifact value now.

## Open questions

*(none)*

## Blocking dependency (honest)

The cross-machine E2E (interactive artifact on machine A → move topic → present + grounded on machine B) needs the **real Mini+Laptop pair; the Laptop is offline**, so that live-verify is a named BLOCKER. The single-machine record/tombstone/jail/credential-fail-closed/untrusted-render/GC logic is fully unit+integration testable now.

## Migration Parity

- New WS2 `working-set-artifact` replicated store → BOTH halves (dual-registry rule): (a) the `ReplicatedKindRegistry` registration + `StoreFieldSchema` (declaring `relPath` carved OUT of `pathSensitiveFields` with its receive-validator, `contentHash`/`lastWrittenAt`/`producerMachineId` typed), AND (b) the replicated-store CONSUMER + the `computeWorkingSet` read-back that unions the store's rows for the topic; plus the `multiMachine.stateSync.workingSetArtifact` flag + its advert-flag wiring. (Naming only one half = the silent no-replication trap.)
- `migrateConfig()` adds `coherenceJournal.workingSet.recordTtlDays` (default 30, existence-checked) + `multiMachine.stateSync.workingSetArtifact` (ships dark: enabled:false, per the replicated-store rollout ladder).
- New PostToolUse Write/Edit recorder hook → `migrateHooks()` (built-in `instar/` hook, always-overwrite per standard) + `migrateSettings()` patch to `.claude/settings.json`.
- Auto-record **kill-switch**: `coherenceJournal.workingSet.recordInteractive: false` (recording is local + useful pre-replication, so it can't ride `replication.enabled`).

## Test Plan

**Tier 1 (Unit):** `(path,producerMachineId)` upsert (two producers coexist; same producer re-edit updates); tombstone stops resurrection; jail rejects abs/`..`/NUL/symlink-escape; credential path never recorded (+ classifier-error fails closed); `.from-*-<hash8>` never recorded; git-tracked path never recorded; GC purge; untrusted-render of a markup filename; caps = engine caps.
**Tier 2 (Integration):** interactive Write under `.instar/` records + unions into `computeWorkingSet`; `onTopicAccepted` fetches the record's files; producer-offline defers via `PendingPullLedger`; real `FetchOutcome` shape; new PostToolUse hook installs via migration.
**Tier 3 (E2E, real pair — BLOCKED on Laptop):** write a `.instar/` report on Laptop in a topic → move to Mini → present + session-start-grounded; divergent edit → `.from-<machine>` + conflict flagged (neither authoritative); a `secretFlagged` file NEVER syncs.

## Success Criteria

- [ ] An interactive agent artifact under `.instar/` is recorded (`(path,producerMachineId)`-keyed) + unions into the computed manifest.
- [ ] Topic-move fetches it via the existing non-blocking engine; producer-offline defers.
- [ ] Session context grounds the agent (untrusted-safe, never user-shown); conflicts shown as unresolved.
- [ ] No jail widening; no cap lowering; a `secretFlagged`/git-tracked/conflict-artifact file is NEVER recorded.
- [ ] Deleted artifact does NOT resurrect (tombstone).
- [ ] Migration installs the new journal kind + hook for existing agents.
- [ ] Live-verified on the real pair (GATED on Laptop online).

## Failure Modes

- **Producer offline** → deferred pull (existing ledger), swap unblocked.
- **Divergent versions** → `(path,producerMachineId)` coexist → both fetch → no-clobber `.from-<machine>` + unresolved-conflict grounding.
- **Credential/secret leak** → fail-closed record + engine `secretFlagged` refusal (defense in depth).
- **Resurrection of deleted file** → tombstone.
- **Conflict-artifact loop** → `.from-*-<hash8>` excluded from recording.
- **Project-repo/git fight** → git-tracked files excluded (F10 scope).
- **Record growth** → `(path,producerMachineId)`-keyed + tombstone + GC.
- **Prompt injection via filename** → `<replicated-untrusted-data>` envelope + charset clamp + byte/row bound.

---

**Related specs:** WORKING-SET-HANDOFF-SPEC (foundation, binding), llm-seamlessness-orchestrator, mesh-self-heal-graduation.
