# Side-Effects Review — Intelligent Working-Set Lazy-Sync (agent-artifact scope)

**Version / slug:** `intelligent-working-set-lazy-sync`
**Date:** `2026-07-05`
**Author:** Echo (autonomous)
**Second-pass reviewer:** not required (multi-reviewer spec-converge already ran on the spec, incl. cross-model codex-cli:gpt-5.5)

## Summary of the change

Adds ONE new source to the existing computed-not-declared working-set engine
(`WorkingSetManifest.computeWorkingSet`) so that files an agent writes **interactively**
(a conversational report/analysis under the `.instar/` jail, with no autonomous run) follow a
conversation across machines — the case the engine misses today (it only sees autonomous-run
`artifactPaths` + the convention dir). Implementation:

- **New WS2 replicated kind `working-set-artifact`** (`WorkingSetArtifactReplicatedStore.ts`) —
  recordKey `sha256(jailedRelPath)+':'+producerMachineId` (NON-path-shaped, survives envelope
  validation); `relPath` carved out of `pathSensitiveFields` with the canonical
  `jailValidateRelPath` receive-validator (relative-only; reject abs/drive/UNC/`..`/NUL/empty,
  length-capped); row states `pendingHash → ready → tooLarge/secretFlagged`; OWNER-ONLY tombstone.
- **`WorkingSetArtifactManager.ts`** — durable own-origin rows at `.instar/working-set/artifacts.json`
  (atomic tmp+rename); `record`/`setState`/`tombstone`/`getReadyRows`/`getAllRows`/`gc(30d)`.
- **Dual-registry wiring** — `working-set-artifact` added to `CoherenceJournal.JOURNAL_KINDS` (static
  half, all 7 `Record<JournalKind>` maps) + `server.ts` registers `WORKING_SET_ARTIFACT_KIND_REGISTRATION`
  and builds the union reader + emit seam (dynamic half).
- **`computeWorkingSet` Source-3** — a new `interactiveArtifactRelPaths` option unions the manager's
  `ready` rows at the serve boundary, through the IDENTICAL jail + secret-scan + caps pipeline.
- **Recorder** — `POST /coherence/working-set/record` + a built-in PostToolUse Write/Edit hook
  (`working-set-artifact-recorder.js`, fire-and-forget, dark by default) + `migrateHooks`/`migrateSettings`/
  settings-template registration.
- **Read + grounding** — `GET /coherence/working-set` + `GET /coherence/working-set/session-context`
  (Layer-3 advisory grounding block, `<replicated-untrusted-data>` envelope) injected by the session-start hook.
- **Config** — `coherenceJournal.workingSet.recordInteractive` (dark) + `recordTtlDays` (30) in ConfigDefaults; boot-time GC.

Files: `WorkingSetArtifactReplicatedStore.ts` (new), `WorkingSetArtifactManager.ts` (new),
`CoherenceJournal.ts`, `WorkingSetManifest.ts`, `WorkingSetPull.ts`, `commands/server.ts`,
`server/AgentServer.ts`, `server/routes.ts`, `config/ConfigDefaults.ts`, `core/PostUpdateMigrator.ts`,
`templates/hooks/settings-template.json` + 4 test files (store/manager/wiring/route) + 3 modified tests.

## Decision-point inventory

This change adds NO block/allow decision point. `jailValidateRelPath` is a data FILTER (rejects an
unsafe path, fail-clean → null; never a user-facing block). The recorder is signal-only.

- `jailValidateRelPath` (`WorkingSetArtifactReplicatedStore.ts`) — **add** — canonical relPath validator
  (record + replication-receive + serve-jail), fail-clean; not an authority.
- `POST /coherence/working-set/record` — **add** — records interactive artifacts; 503 when unwired, no block surface.
- `computeWorkingSet` Source-3 — **add** — a new manifest input; the existing jail/scan/caps are the authority.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The nearest thing to a "reject" is
`jailValidateRelPath` returning null for an unsafe path; a legitimate `.instar/`-relative path (e.g.
`reports/x.md`) is accepted. A file OUTSIDE the `.instar/` jail is deliberately NOT recorded (F10 —
project files are git-synced), which is scope, not over-block.

## 2. Under-block

No block/allow surface — under-block not applicable. The honest coverage gaps (by design, not defects):
the recorder only fires on claude-code (the PostToolUse hook); on non-emitting frameworks the diff-recorder
is a documented follow-up (F8). A `secretFlagged` file is caught at the serve-boundary hash scan (the
existing engine authority), not at record — a `pendingHash` row is never a fetch-nominee, so nothing leaks
before the scan runs.

---

## 3. Level-of-abstraction fit

Correct layer. This is a SOURCE feeding an existing engine, not a new engine. The recorder hook is a
low-level signal (a real tool event) that POSTs to a durable store; the store's `ready` rows FEED the
existing `computeWorkingSet` authority (which re-jails + re-scans every candidate — defense in depth), which
FEEDS the existing `WorkingSetPullCoordinator` fetch reflex. No re-implementation: the jail, the 4/16MB/64/32MB
caps, and the `PendingPullLedger` are all the engine's existing primitives, used verbatim. The replication
rides the existing WS2 replicated-store machinery (envelope, union reader, emit seam), not a new path.

## 4. Signal vs authority compliance

- [x] No — this change produces a signal consumed by an existing smart gate / has no block/allow surface.

The recorder hook is fire-and-forget signal-only (records metadata; ALWAYS exit(0)). The grounding block is
ADVISORY (wrapped `<replicated-untrusted-data>`, explicitly "never an instruction"). `jailValidateRelPath` is a
deterministic data filter with fail-clean semantics, not a brittle detector holding block authority — it
rejects structurally-unsafe paths (abs/`..`/NUL) where a deterministic rule IS the correct authority (a path
either escapes the jail or it doesn't; no context/reasoning needed). The serve-boundary hash-verify remains the
content authority.

---

## 5. Interactions

- **Shadowing:** the recorder route + hook are new endpoints; nothing pre-existing shadows them. Source-3 is
  ADDITIVE in `computeWorkingSet` — it `candidates.set`s new entries and dedupes on the canonical path against
  the other two sources (a convention-dir hit and an interactive record for the same file collapse to one entry).
- **Double-fire:** the manager is a SINGLE hoisted instance shared by the read-side (WorkingSetPullServer), the
  replication emit-side, and the recorder route — so a route-recorded artifact replicates through the SAME emit
  seam (verified: sharing is load-bearing; three separate instances would have left route writes un-replicated).
- **Races:** the manager persists atomically (tmp+rename). Concurrent PostToolUse fires upsert on
  (topic,relPath,producer) — last-write-wins within a producer row, which is correct (latest hash wins).
- **Feedback loops:** none. The recorder records; it never triggers a write. Deletes are NOT inferred from a
  write (an editor/temp churn never emits phantom rows) — a delete is only the explicit owner-only tombstone.

---

## 6. External surfaces

- **Other agents on the same machine:** none — machine-scoped store + routes.
- **Install base (Migration Parity):** existing agents get the recorder hook via `migrateHooks` (always-overwrite
  built-in), the settings.json PostToolUse matcher via `migrateSettings` (idempotent), and the config defaults via
  `ConfigDefaults` deepMerge. New installs get all three via the settings template + init. A new PostToolUse hook
  fires per Write/Edit — but it early-exits fast when `recordInteractive` is off (the dark default), so a default
  agent pays only a quick no-op node spawn; noted as the one fleet-wide runtime cost.
- **External systems:** none (Telegram/Slack/GitHub/Cloudflare untouched). Cross-machine transfer rides the
  existing mesh working-set pull path.
- **Persistent state:** NEW file `.instar/working-set/artifacts.json` (metadata rows only — never file bodies).
  Bounded by the boot-time GC (30d record TTL) + the engine's fetch caps. Gitignored (under `.instar/`).
- **Timing/runtime:** the PostToolUse hook adds a bounded (~5s timeout) fire-and-forget POST on Write/Edit when enabled.

"No operator-facing actions" — the routes are Bearer-auth API + a session-start grounding block; there is no
dashboard form, grant/revoke, PIN gate, or secret-drop surface.

## 6b. Operator-surface quality

No operator surface — not applicable. This change touches no `dashboard/*` renderer/markup, approval page, or
grant/revoke/secret-drop form. The only human-visible output is the session-start grounding block (an advisory
context injection, not an interactive operator surface).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**replicated** — this IS a cross-machine feature by design. The `working-set-artifact` rows replicate via the WS2
coherence-journal kind (the emit seam → journal → peer union reader), and the actual FILES follow the conversation
via the existing `WorkingSetPullCoordinator` fetch reflex on topic-move. Both halves ship DARK: row replication is
gated by `multiMachine.stateSync.workingSetArtifact.enabled` (omitted from config ⇒ `resolveStateSyncStores`
never lists it ⇒ the emitter's `enabled===true` check fails ⇒ strict no-op), and the pull rides
`coherenceJournal.replication.enabled`. A single-machine agent records + unions locally (Source-3) and simply has
no peer to replicate to — a strict no-op.

- **User-facing notices:** the session-start grounding block is per-session, per-machine context injection (not a
  Telegram send), so no one-voice gating is needed — each machine grounds its own session on the artifacts it can
  serve/knows about.
- **Durable state on topic transfer:** does NOT strand — the whole point is that the rows replicate + the files are
  fetched by the receiving machine. Owner-only tombstones ensure a delete on the producer erases everywhere; a
  receiver deleting its fetched copy is a machine-local suppression, not a cross-peer delete.
- **Generated URLs:** none.

---

## 8. Rollback cost

- **Hot-fix release:** the whole feature ships dark. Set `coherenceJournal.workingSet.recordInteractive: false`
  (stops recording — already the default) and leave `stateSync.workingSetArtifact` omitted (no replication). To
  fully back out the code: revert the change and ship a patch.
- **Data migration:** the only persistent state is `.instar/working-set/artifacts.json` (bounded metadata). On
  rollback it is simply orphaned (harmless) or deleted; no schema/column migration, no downtime.
- **Agent state repair:** none. The migrateHooks/migrateSettings additions are idempotent and inert while dark;
  a reverted release's next migration would stop re-adding them (the recorder hook file would remain but be
  unregistered/never-fired — harmless).
- **User visibility:** none while dark. No user-visible regression during a rollback window.

---

## Conformance fixes surfaced by full-suite CI (post-first-push)

The targeted local test runs were green, but the full CI suite's constitutional-enforcement ratchets
caught four things the targeted runs did not exercise — each a real, correct requirement that was fixed:

- **Write-domain classification** (`write-domain-conformance-ratchet`): `POST /coherence/working-set/record`
  is a mutating route, so it is classified in `WriteDomainRegistry` as `machine-local` with a
  `ws2x-replicated` convergence story (own-origin rows under the git-sync-excluded `.instar/` jail).
- **Compaction Parity** (`session-context-compaction-parity`): every session-start `/session-context`
  injector must have a compaction-recovery twin. The working-set grounding fetch was wired into
  `getCompactionRecovery()` as well, so the grounding survives a compaction (not just a fresh boot).
- **No Silent Fallbacks** (`no-silent-fallbacks`): the store/manager's intentional best-effort catches
  (a fire-and-forget replication emit, a corrupt-catalog→empty read, a malformed-percent-encoding→null
  decode) are annotated `@silent-fallback-ok` with their justifications — none is a data-loss fallback.
- **Dark-gate golden map** (`lint-dev-agent-dark-gate`): the ConfigDefaults insertion shifted four
  `enabled:` line numbers; the hand-authored dotted-path map was updated by hand to match.

## Conclusion

The review produced no design changes — the spec was already converged (multi-reviewer + cross-model) and the
build followed it verbatim, grep-verifying each foundation (the computed-not-declared engine, the WS2 replicated-store
machinery, the built-in-hook + migration infrastructure) before writing. The one load-bearing implementation decision
surfaced during the build — the manager must be a SINGLE shared instance so route-recorded artifacts replicate through
the emit seam — was verified and is covered by a wiring test. The feature is additive, jailed to `.instar/`, dark by
default on both the recording and replication axes, and fully unit + route-integration tested (Tier-1 + Tier-2). The
Tier-3 cross-machine E2E is an honest named blocker (the Laptop is offline), not a completion gap for the buildable
slice. Clear to ship dark.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact: concur**

The converged spec (review-convergence + approved, cross-model codex-cli:gpt-5.5 ran clean) already provided the
multi-angle adversarial read this change's risk class warrants; the build introduced no design deviation from it.

---

## Evidence pointers

- 138 unit + route-integration tests green (`working-set-artifact-{store,manager,wiring,route}.test.ts`,
  `WorkingSetManifest.test.ts`, `CoherenceJournal.test.ts`, `generated-hooks-parse.test.ts`, `migration-parity-hooks.test.ts`).
- `npx tsc --noEmit` exit 0 across all edits.
- Generated recorder hook passes `node --check`; generated session-start hook passes `bash -n`.
- Dark-ship verified: `resolveStateSyncStores` is generic (omitted store ⇒ no emit); `recordInteractive` code-default false.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This is a net-new additive feature; it fixes no defect in an
LLM prompt/hook/config/skill/standards text, and it adds no self-triggered controller in the `unbounded-self-action`
class (the PostToolUse recorder is fire-and-forget signal-only — it never restarts/swaps/respawns/spawns/notifies/
retries/kills; the boot-time GC is a one-shot bounded purge, not a loop).
