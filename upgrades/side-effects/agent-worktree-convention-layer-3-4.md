# Side-Effects Review — Agent Worktree Convention (Layers 3 + 4)

**Version / slug:** `agent-worktree-convention-layer-3-4`
**Date:** `2026-05-19`
**Author:** `echo`
**Second-pass reviewer:** `not required` (see §"Phase 5 trigger check" below)

## Summary of the change

Completes the agent worktree convention spec by adding the two layers
that propagate the convention to **existing** agents and observe
violations on every agent boot.

- **Layer 3 — `PostUpdateMigrator.migrateWorktreeConvention`.** Runs on
  every agent update tick. Validates the agent home against Layer 1's
  shape contract (registry membership + anchored regex), refuses if
  `<agent_home>/.bin` is a symlink, then installs/refreshes the
  `instar-worktree-create.sh` wrapper (always-overwrite per Migration
  Parity Standard), idempotently adds `.worktrees/` to
  `<agent_home>/.gitignore`, and ensures `<agent_home>/.worktrees/`
  exists with mode `0700`. Plus a **Migration Parity Standard backfill**
  in `migrateClaudeMd`: the "Worktree Convention" section is appended
  to existing agents' CLAUDE.md (the scope-coherence checkpoint caught
  this gap earlier — without it, only fresh `instar init` agents would
  ever see the convention text). Mirrored to AGENTS.md / GEMINI.md via
  the v1.0.15 shadow-capability mirror (added one entry to the markers
  list).
- **Layer 4 — `AgentWorktreeDetector`.** Runs once per agent server
  boot, from `startServer()`. Resolves the canonical instar repo
  deterministically (config `worktree.repoPath` or default fallback
  chain — explicitly NOT `INSTAR_REPO` env, because env vars can
  differ between lifeline boot and interactive sessions and the
  detector wants consistent results across both). Runs `git worktree
  list --porcelain` with a 2-second timeout, skips the main checkout
  and bare entries, and emits an AttentionItem-shaped record for every
  remaining worktree whose path is not under any registered agent's
  `.worktrees/`. **Signal-only**: never blocks, never moves, never
  deletes. Dedupe via the documented `worktree-misplaced:sha256(path)`
  key. When no Telegram adapter is configured, appends to a JSONL
  fallback at `<stateDir>/audit/worktree-detector.jsonl` (O_NOFOLLOW +
  fstat owner/mode gate, 24h rolling-window dedupe).

**Files touched:**

- `src/core/PostUpdateMigrator.ts` (+~130 lines: `migrateWorktreeConvention` method, registration in `migrate()`, marker addition in `migrateFrameworkShadowCapabilities`, "Worktree Convention" section in `migrateClaudeMd`, import of `resolveAgentHome` from Layer 1's manager).
- `src/core/AgentWorktreeDetector.ts` (new, ~330 lines).
- `src/commands/server.ts` (+~35 lines: detector invocation after `registerAgent`).
- `src/templates/scripts/instar-worktree-create.sh` (new — canonical wrapper template the migrator installs into `<agent_home>/.bin/`).
- `scripts/lint-no-direct-destructive.js` (+8 lines — adds the wrapper template to `SHELL_ALLOWLIST` with documented rationale).
- `tests/unit/migrateWorktreeConvention.test.ts` (new, 5 cases).
- `tests/unit/AgentWorktreeDetector.test.ts` (new, 10 cases).
- `upgrades/NEXT.md` (appended section + capabilities-table rows + updated deferred list).

## Decision-point inventory

- **Migrator refusal on `.bin/` symlink** — *add*. Structural safety guard
  on an irreversible action (would write a wrapper script via a symlink
  that resolves outside the agent home, e.g., to `/usr/local/bin`).
  Hard-invariant: `lstat`-based, no judgment call. Carve-out applies.
- **Migrator silent-skip on non-conforming agent home** — *add*. Refuses
  to install the wrapper for project-bound agents whose home isn't
  `~/.instar/agents/<name>/`. The convention only applies to
  agent-home-living agents; project-bound agents have the project dir
  as their primary working directory and the wrapper is meaningless
  for them. Hard-invariant via the same regex+registry contract as
  Layer 1.
- **Detector — AttentionItem emission** — *add*. Pure signal. Emits to
  AttentionQueue (which already exists as the authority for what to do
  with attention items). Never blocks; the agent boots regardless.
  Compliant with signal-vs-authority per the spec's explicit
  "signal only" framing.
- **Detector — path-based filter rule** — *add*. The detector's only
  authoritative rule is `realpath(worktree_path) startsWith
  realpath(<safe_root>)` for some registered agent. Pure structural
  validator, no judgment.

No new authorities introduced. No detectors hold blocking power.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **Migrator** silently skips agents whose home doesn't match the
  `<instarHome>/agents/<name>/` shape. *Intentional* — project-bound
  agents would receive a wrapper that points at their project dir but
  the convention's spec is specific to agent-home-living agents.
- **Migrator** refuses if `<agent_home>/.bin` is a symlink. Operators
  who deliberately symlink `.bin/` to a shared dir would be refused.
  This is documented in the spec adversarial-finding section; the
  alternative (silently writing into the symlink target) was rejected
  as a security regression.
- **Detector** flags every worktree of the canonical instar repo
  outside the safe-root set. **First-run on echo's machine will emit
  ~30 attention items** (one per pre-existing worktree). Each is
  deduped for 24h. Operator must drain or relocate. This is the spec's
  documented "one-time burst" and is in the Deferred list of NEXT.md.

## 2. Under-block

**What failure modes does this still miss?**

- **Migrator** does not detect or repair drift in `.worktrees/` mode
  beyond re-asserting 0700 on every run. If something changes the
  permissions on individual worktree directories underneath, that's
  not policed. *Acceptable* — those are operator-managed
  per-worktree.
- **Detector** treats stale `git worktree list` entries (paths whose
  worktree dir was rm'd outside `git worktree prune`) as not-misplaced
  (they're skipped via the existsSync check). This is intentional —
  the spec wants signal on real misplacements, not on stale
  metadata. A separate detector for stale-metadata could be a
  follow-up.
- **Detector** does not yet feed AttentionQueue when Telegram is
  configured — it falls back to JSONL in v1 because TelegramAdapter
  initializes later in `startServer` than the detector. NEXT.md
  Deferred list documents this; the JSONL trail is the durable
  observation surface for v1.
- **Compromised local user** (same uid, full execution privilege)
  remains explicitly out-of-scope per the spec's threat-model
  boundary.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

- **Migrator step** lives where every other `PostUpdateMigrator`
  step lives, registered in `migrate()`. The bash-wrapper template is
  in `src/templates/scripts/` alongside other agent-installed scripts
  (`git-sync-gate.sh`, etc.) — same pattern as
  `migrateConversationalCatalogPlaybookManifest`.
- **CLAUDE.md backfill** is a content-sniffing patch inside the
  existing `migrateClaudeMd`, matching the pattern every other Capability
  section already uses (`Self-Discovery`, `Cloudflare Tunnel`,
  `Dashboard`, etc.). One marker added to
  `migrateFrameworkShadowCapabilities` is the minimal touch needed for
  Codex/Gemini shadow propagation.
- **Detector** is a standalone module under `src/core/` (alongside
  Layer 1's `InstarWorktreeManager`). It's invoked once from
  `startServer()` — a deliberate placement after `registerAgent` so
  the registry is populated before `enumerateSafeRoots()` walks it.
- Reused primitives: `resolveAgentHome` and `resolveInstarRepo` (from
  Layer 1's manager) — keeps the validation rules in one place so the
  CLI and the migrator/detector can't disagree about "what an agent
  home is" or "what a valid instar repo is."

A lower-level primitive (Layer 1's manager) is consumed; the higher
layer (AttentionQueue) is fed via signal-only emission. No new
authority introduced.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — the migrator's blocks are structural safety guards
  (`.bin/` symlink refusal, agent-home regex+registry check) — both
  carve-outs in `docs/signal-vs-authority.md` ("hard-invariant
  validation" and "safety guards on irreversible actions").
- [x] No — the detector is **explicitly signal-only** per spec. It
  emits AttentionItems / appends JSONL; the AttentionQueue is the
  authority that decides what to do with them. The detector's filter
  rule is path-based hard-invariant (no judgment).

The detector's invariant — "the rule lives here and only here, never
the audit ledger" — is restated in the file-level comment so future
maintainers can't drift toward ledger-membership.

## 5. Interactions

- **Shadowing:** the migrator runs in the `migrate()` chain after
  `migrateConversationalCatalogPlaybookManifest` and before the async
  `migrateParityRenderings` (in `migrateAsync()`). It doesn't share
  state with adjacent steps. The `migrateClaudeMd` backfill rides on
  top of the existing patched-content flow, sharing `patched` with
  earlier sections so the file is written once.
- **Double-fire:** the wrapper template the migrator installs is now
  the canonical source. The hand-rolled wrappers in echo + bob's
  `.bin/` will be refreshed by the migrator on their next update tick.
  Until then they coexist (both work — they're functionally
  equivalent).
- **Races:** the detector runs once per agent boot, before the server
  starts listening. No concurrent invocations from the same agent.
  Two agents booting concurrently could each enumerate the same
  worktree list — each emits its own AttentionItem with the same
  `worktree-misplaced:sha256(path)` id, which the AttentionQueue
  collapses to a single topic per the existing dedupe contract (line
  2949 of `TelegramAdapter.ts`). The JSONL fallback dedup is per-file
  (each agent has its own state dir).
- **Feedback loops:** the detector reads `git worktree list`. The
  Layer 1 CLI writes to that list. There's no infinite-loop concern
  because the detector emits to AttentionQueue (or JSONL), not back
  into `git worktree`.
- **Migration Parity:** the Layer 2 changes (seed CLAUDE.md +
  GITIGNORE_ENTRIES) are now also delivered to existing agents on
  update — closing the parity gap. Without the Layer 3
  `migrateClaudeMd` backfill, existing agents would never see the
  convention text; with it, they pick it up on the next update tick.

## 6. External surfaces

- **Other agents on the same machine:** every agent picks up the
  wrapper, the `.gitignore` entry, the `.worktrees/` directory, and
  the CLAUDE.md section on its own next update tick. Single-agent
  scope per spec — no cross-agent writes.
- **Other users of the install base:** purely additive. Existing
  workflows are unchanged. The wrapper just makes the safe path the
  default; raw `git worktree add` still works (and gets flagged by
  the detector).
- **External systems:** none. No network. The detector calls `git`
  locally, with a 2-second timeout.
- **Persistent state:**
  - `<agent_home>/.bin/instar-worktree-create.sh` (new file per agent
    on update tick — always-overwrite).
  - `<agent_home>/.gitignore` (idempotent line addition).
  - `<agent_home>/.worktrees/` (directory creation, mode 0700).
  - `<agent_home>/CLAUDE.md` (single section appended, idempotent
    via content-sniff).
  - `<agent_home>/AGENTS.md` / `GEMINI.md` (single section mirrored
    when those shadows exist).
  - `<stateDir>/audit/worktree-detector.jsonl` (append-only signal
    log; bounded by 24h rolling-window dedupe before append).
  - All git-ignored or per-machine. Rollback is `rm` of these files.
- **Timing:** the detector's 2-second timeout means a hung
  `git worktree list` doesn't block agent boot beyond that window.

## 7. Rollback cost

- **Code:** revert this commit. The Layer 1 CLI subcommand (PR #277)
  continues to function for fresh `instar worktree create` calls.
  Existing agents that already received the wrapper on a prior update
  tick keep it (it works — it delegates to Layer 1).
- **Persistent state:**
  - The wrapper, `.gitignore` entry, and `.worktrees/` directory in
    each agent home are harmless leftovers. No removal required.
  - JSONL fallback files are signal-only and consumed by nothing on
    rollback. `rm` is a safe one-liner per agent.
  - CLAUDE.md "Worktree Convention" section is documentation only —
    leaving it in is benign.
  - AGENTS.md / GEMINI.md mirrored sections — same.
- **Agent state repair:** none required.
- **User visibility during rollback:** none.

Total rollback time: under 5 minutes (one revert + optional cleanup
sweep).

## Conclusion

Completes the agent worktree convention spec. Migrator backfills
existing agents with the on-disk surface (wrapper, gitignore, dir
permissions, CLAUDE.md section, AGENTS/GEMINI mirror) so the
convention applies fleet-wide on the next update tick — closing the
Migration Parity gap the scope-coherence checkpoint flagged during
Layer 1+2+5 implementation. Detector emits signal per misplaced
worktree without ever blocking. All structural validators are in the
signal-vs-authority carve-outs. 15 new tests pass (5 migrator + 10
detector). Pre-push gate green.

Phase 5 trigger check: the change does **not** touch outbound/inbound
messaging dispatch, session lifecycle, compaction, coherence gates,
idempotency at transport, trust levels, or anything named
sentinel/guard/gate/watchdog (the "Detector" naming is intentional —
it's a signal producer, not a gate). No second-pass reviewer required.

Clear to ship.

## Evidence pointers

- **Migrator unit tests:** `tests/unit/migrateWorktreeConvention.test.ts`
  (happy path with wrapper + .worktrees/0700 + .gitignore;
  idempotency; always-overwrites tampered wrapper; refuses
  `.bin/`-as-symlink; silently skips project-bound agents).
- **Detector unit tests:** `tests/unit/AgentWorktreeDetector.test.ts`
  (silent when no misplaced; skips main checkout entry; emits one
  AttentionItem per misplaced via injected emitter; skips when under
  safe root; JSONL fallback writes; 24h JSONL dedupe; refuses
  pre-planted symlink at the fallback path; resolveDetectorInstarRepo
  honors config and returns null on no-repo).
- **Spec:** `docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md` (approved
  2026-05-17 22:35 UTC).
- **Sibling artifact:**
  `upgrades/side-effects/agent-worktree-convention-layer-1-2-5.md`
  (Layers 1+2+5, merged in PR #277 as commit `bdf8508f`).
