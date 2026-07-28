---
status: approved
approved: true
approval-provenance: "Justin session pre-approval 2026-06-15, topic 12476 (autonomous instar-dev session): 'there is absolutely no reason we should be cutting off autonomy sessions … make our autonomous sessions MUCH more robust and resilient. We need to update our standards and infrastructure.'"
parent-principle: "No Silent Degradation to Brittle Fallback"
lessons-engaged:
  - "Structure beats Willpower (auto-heal, don't rely on remembering to clear a lock)"
  - "No Silent Degradation to Brittle Fallback (a disabled revival guard must announce itself)"
  - "Signal vs. Authority (surfacing is signal; it never blocks)"
  - "Distrust Temporary Success / fail-closed on unknown (unknown FS → treat as shared → never auto-heal)"
  - "Bounded Notification Surface (one aggregated attention item, not per-tick)"
  - "Migration Parity + Agent Awareness (fleet default + CLAUDE.md template)"
review-convergence: "2026-06-15T18:12:52.265Z"
review-iterations: 2
review-completed-at: "2026-06-15T18:12:52.265Z"
review-report: "docs/specs/reports/autonomous-run-outlives-session-convergence.md"
cross-model-review: "unavailable"
cross-model-review-reason: "cross-model-script-needs-built-dist-in-worktree; codex-not-on-path-in-context"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 1
contested-then-cleared: 0
---

# An autonomous run must outlive its session

## The principle (new constitutional standard)

A registered autonomous run is durable work the operator delegated. Its host
*session* is a disposable vessel — it will be reaped (age-limit), restarted
(updates), the machine will be renamed, the server will bounce. **None of those
vessel-level events may silently end the run.** The run's goal is persisted
per-topic (`.instar/autonomous/<topicId>.local.md`); the revival machinery
(`ResumeQueue` + `ResumeQueueDrainer`, #1156/#1157) exists to bring a reaped run
back. The standard this spec adds to `docs/STANDARDS-REGISTRY.md`:

> **An autonomous run must outlive its session.** A registered autonomous run
> survives any vessel-level event (reap, restart, rename, bounce) — it is revived
> and resumed, or its failure to revive is LOUDLY surfaced. A revival guard that
> is disabled, inert, or skipped is itself an incident and must announce itself.
> It may never fail silent.

Enforcement is structural (Structure > Willpower): backed by the GAP-D auto-heal +
guard-posture surfacing below and the GuardPostureProbe inventory, not by an agent
remembering to check.

## The gap that motivated this (real incident, 2026-06-15)

The revival machinery shipped (#1157) and reads `enabled:true, dryRun:false` — yet
on Justin's machine it was **silently DISABLED** and had been for an unknown
duration. Root cause, verified live: `ResumeQueue` acquires a host-scoped lock at
`state/resume-queue.lock` to enforce its (correct) invariant that the state dir
must be host-local — a shared volume across two hosts is unsupported. The lock
records `{pid, hostname}`. On a hostname mismatch the queue assumes a shared-volume
conflict and **disables itself**, surfacing only a `disabled:` string on the
`/sessions/resume-queue` read (no attention item, no guard-posture alert, no log
escalation). The machine had been **renamed** (`Justins-MacBook-Pro-7.local` →
`Mac.attlocal.net`); the lock from the old name (pid 28995, long dead) looked
exactly like a foreign-host conflict. So a routine single-host rename permanently,
silently disabled the run-revival guard. (One-time manual lock-clear already
performed on this machine as interim; the durable fix is below.)

## Frontloaded Decisions

All decisions below are made in-spec so the build is single-run-completable. They
resolve the convergence-round findings (FS detection, guard-posture wiring,
pid-recycle, atomicity, the fleet-rollout cheap-tag contest, foreign-host
heartbeat).

- **FD1 — Host-local FS detection is a NEW helper, default-deny.** There is NO
  existing reusable network-mount detector (only `WorktreeManager`'s
  `df -T apfs,hfs` allowlist, not reusable). Build `isStateDirHostLocal(path):
  boolean` as a closed **network-FS denylist** check against `df -PT <path>`
  (field-1 fstype): any of `nfs nfs4 smbfs cifs afpfs webdav davfs2 ftp 9p
  fuse.sshfs fuse.*` → NOT local. `df` failure / timeout (3000ms, reuse
  WorktreeManager's budget) / unparseable / a type not positively recognized →
  **unknown → treated as NOT local**. Local ⟺ a positively-recognized local type
  (`apfs hfs ext4 xfs btrfs zfs`) not on the denylist. Checked ONCE at
  acquire-time. This is an external-state detector (Lesson L5) → it ships with a
  deterministic parse, a unit truth-table over the mount types, and a canary that
  fails loud if `df -PT` output shape drifts.
- **FD2 — FS-local is the DISPOSITIVE, first-checked condition; pid-death only
  corroborates.** The existing code deliberately never pid-probes a foreign-host
  lock ("pid checks are meaningless cross-host"). Auto-heal fires ⟺ **(FS
  positively local) AND (pid dead on this host) AND (heartbeat stale, ≥5min —
  reuse the existing window)**. FS-local is necessary and evaluated first; a
  foreign-host lock on a non-local/unknown FS is NEVER pid-probed and STAYS
  disabled (preserves the original HARD INVARIANT for the genuine shared-volume
  case). This makes the single safety dependency explicit and ordered.
- **FD3 — pid recycling is OUT OF SCOPE, accepted because it degrades safe.** A
  recycled pid (`process.kill(pid,0)` hits an unrelated live process) yields a
  false "live conflict" → the queue STAYS disabled and (per D2) LOUDLY escalates.
  Worst case is a false escalation the operator can clear, never corruption. We do
  NOT read process start-time (no existing primitive; not worth the build for a
  safe-direction degrade). Stated outright, not left as "when determinable".
- **FD4 — Atomic takeover MUST be first-writer-wins via O_EXCL.** The current
  `acquireLock()` is a non-atomic `existsSync`→`writeFileSync` TOCTOU. The build
  replaces the takeover with the `ProjectRoundLock.ts` precedent: after
  classifying the lock stale, `unlink` it, then `openSync(tmp,'wx')` + atomic
  rename; if the `wx` open OR the rename loses to a concurrent boot, treat it as
  "another process won" → re-read and re-evaluate, NEVER blind-overwrite. The
  plain write-temp+rename (last-writer-wins) option is **forbidden** — it would let
  two boots both believe they hold the lock.
- **FD5 — Fleet rollout default is FALSE; dev-agent runs it (dryRun→live) first.**
  `monitoring.resumeQueue.autoHealStaleHostLock` ships **default false on the
  fleet** (this touches a durable-state-corruption invariant — never "cheap" even
  behind a flag, per the closed taxonomy). It resolves TRUE only on the dev agent
  via the dev-agent gate, dryRun-first (logs "would auto-heal …" without rewriting)
  to soak the FS classifier on real data, then live. A later, separate decision
  flips the fleet default to true after the soak proves the classifier — that flip
  is its own reviewed change, not this spec's blast radius.

## Design

### D1 — Distinguish a host RENAME from a genuine shared-volume conflict

At lock-acquisition, when the on-disk lock's `hostname` ≠ current host, classify
per FD1–FD4:

- **Stale (auto-heal):** `isStateDirHostLocal()` positively local **AND** pid dead
  on this host **AND** heartbeat ≥5min stale → atomically (FD4) replace the lock
  with a fresh one for the current host, log loudly, write an audit entry, proceed
  ENABLED.
- **Live conflict (stay disabled):** any other case — FS non-local/unknown, OR pid
  alive, OR fresh heartbeat. Stay disabled and escalate (D2). FS-local is checked
  first and is dispositive (FD2).

### D2 — A disabled revival queue must be LOUD, never silent (ALWAYS-ON)

This surfacing is **NOT gated by dryRun** — only D1's lock-rewrite is. (Otherwise a
rename on the dev agent during the dryRun soak would still silently disable the
queue — the exact incident.) The four concrete wiring edits (enumerated so the
build is single-run; M2 finding):

1. **`ResumeQueue.guardStatus(): { enabled: boolean; dryRun: boolean; reason?:
   string }`** — returns `enabled:false` + the `disabledReason` whenever the queue
   is disabled.
2. **`GUARD_MANIFEST` entry** `monitoring.resumeQueue.enabled`:
   `component:'ResumeQueue'` (the lint's join key — REQUIRED), `defaultEnabled:true`,
   `expectRuntime:true`, `process:'server'`,
   `dryRunConfigPath:'monitoring.resumeQueue.dryRun'`, `liveConfig:false` (config
   read once at construct).
   - **Lint classification (both guard-shaped class names — `lint-guard-manifest.js`
     requires each in exactly ONE list):** `ResumeQueue` → the GUARD_MANIFEST entry
     above. `ResumeQueueDrainer` (the tick-loop sibling) → a `NOT_A_GUARD`
     entry `{ component:'ResumeQueueDrainer', reason:'rides its parent ResumeQueue
     guard (poller, not an independent guard)' }`, following the
     `QuotaTrackerPoller → QuotaTracker` parent-rides precedent. Without both, the
     lint fails the build.
3. **`guardRegistry.register('monitoring.resumeQueue.enabled', () =>
   resumeQueue.guardStatus())`** at the post-`start()` callsite in `server.ts`.
4. **Register UNCONDITIONALLY** — even when `start()` returned false (disabled),
   so the posture reads `off-runtime-divergent` (config on, runtime self-reports
   off → the ALERTING class), not `missing`.

**What is genuinely NEW here vs. already-wired:** the aggregated attention item
already fires on the foreign-host disable branch today (`raiseResumeAggregated`,
wired at construction in `server.ts`) — the builder must NOT double-implement it.
The net-new surface is the **guard-posture path** (the manifest entry +
`guardStatus()` + registration above) so `/guards` and the GuardPostureProbe
classify a disabled revival queue as `off-runtime-divergent` instead of it being
visible only as a `disabled:` string on the `/sessions/resume-queue` read.

### D3 — Scope / non-goals

- GAP-B (guaranteeing "go autonomous" registers a run; recognizing active
  autonomous WorkEvidence absent a state file) is the SIBLING spec under this same
  standard — in-scope for THIS run, distinct mechanism, specced+shipped as its own
  sibling commit within the same run (sequenced and actively built, not postponed).
- No change to the host-local invariant itself — a genuine shared volume stays
  unsupported. We only stop misclassifying a rename as that.

## Config / flags

- `monitoring.resumeQueue.autoHealStaleHostLock` — **fleet default false** (FD5);
  dev-agent resolves true via the dev-agent gate, dryRun-first. Rollback lever:
  setting it false anywhere restores today's disable-on-mismatch behavior.
- D2 surfacing is unconditional (not flag-gated) — a disabled guard is always loud.

## Tests (all three tiers — Testing Integrity Standard)

- **Unit:** `isStateDirHostLocal` truth-table (apfs/ext4 → local; nfs/smbfs/cifs/
  fuse.sshfs → not; `df` fail/timeout/unknown-type → not-local); the classifier
  (local+dead-pid+stale-heartbeat → auto-heal; live-pid → conflict; non-local FS
  with dead pid → conflict, never pid-probed; fresh-heartbeat foreign lock →
  conflict); O_EXCL first-writer-wins under simulated double-boot (loser re-reads,
  never clobbers); `df -PT` shape-drift canary.
- **Integration:** `/sessions/resume-queue` reports `enabled` after a simulated
  rename (stale lock, dead pid, local FS); reports `disabled` + a guard-posture
  anomaly on a simulated live conflict.
- **E2E:** boot with a stale foreign-host lock on disk → ResumeQueue alive (200,
  ticking) post-boot; auto-heal audited.
- **Wiring:** GuardPostureProbe receives the disabled-state signal (dep not null,
  delegates) — a disabled queue cannot be invisible. `lint-guard-manifest.js`
  passes with the new entry.

## Migration parity

- `migrateConfig()` adds ONLY `monitoring.resumeQueue.autoHealStaleHostLock`
  (default false) when absent — it NEVER touches the existing `enabled`/`dryRun`
  keys, which #1157 deliberately keeps un-frozen in ConfigDefaults to preserve the
  fleet flip.
- **Agent Awareness (P5):** `generateClaudeMd()` gains a line under the
  resume-queue/guard-posture section ("a machine rename heals its own revival lock
  on the dev agent; a genuinely-disabled revival guard raises one attention item"),
  with a `migrateClaudeMd()` content-sniff so deployed agents get it.

## ELI16 / what changes for the operator

Before: rename your Mac → the system that brings your autonomous work back after a
restart quietly switches off, and nothing tells you. After: on the dev agent a
rename heals itself (carefully — only when it's provably the same physical machine
on a local disk), and if the revival system is ever genuinely off, you get one
clear alert instead of silence. The careful version ships to everyone else once the
self-heal has been proven safe on the dev agent.

## Open questions
*(none)*
