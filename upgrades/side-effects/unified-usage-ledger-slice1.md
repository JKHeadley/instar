# Side-Effects Review — Unified usage ledger, Slice 1 (store, record, Claude transcript capture)

**Version / slug:** `unified-usage-ledger-slice1`
**Date:** `2026-11-09`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

First build slice of `docs/specs/unified-usage-ledger.md` (approved 2026-11-09). Adds `src/monitoring/UsageLedger.ts`: a new SQLite store at `server-data/usage-ledger.db` holding one row per Claude Code model request from this agent's own sessions, session bindings (spawn records plus topic, job, run and account attribution), per-file checkpoints, and hour, day and session-day rollups updated in the same transaction as each insert. Membership follows the spec (spawn record, then the transcript's own cwd under this agent's home, never under a nested registered agent home). Wiring: a dev-gate entry `usage.ledger.enabled` (`src/core/devGatedFeatures.ts`, config type in `src/core/types.ts`); `SessionManager.setClaudeSessionId` now also tells an optional sink about each new Claude session id; `AgentServer` constructs the ledger when the gate is on, registers the server's Claude config dir, `~/.claude` and each session's config home as roots, scans every 60 s and prunes hourly. Tier 2 (new durable store). Size: 3 source files changed, 1 new module (~600 lines), 1 new test file (17 tests). Effort: six spec review rounds (the Tier-2 cap), one commit attempt so far.

## Decision-point inventory

- Agent-scope membership (`UsageLedger.membership`) — add — decides which transcripts count toward this agent's usage figures. Reporting only: it changes no behavior, blocks nothing and routes nothing.

No block, allow, route or notify decision is added or changed.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The nearest analogue is under-counting: a session this agent ran in a folder outside its home that has no spawn record (for example a session started by hand) is not counted. It shows up as skipped directories in coverage, not as a silent loss.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Counting gaps that remain in this slice, each scheduled in later slices of the same spec: Codex rollouts, intelligence-call rows and cross-source dedupe (Slice 2), prices (Slice 3), the pool pull and read API (Slice 4), the console (Slice 5), and the snapshot and import path.

---

## 3. Level-of-abstraction fit

It is a pure observability store at the monitoring layer, next to TokenLedger and reusing its proven primitives (native-heal open, SQLite registry, WAL, incremental auto-vacuum). It deliberately does not extend TokenLedger, because the spec keeps TokenLedger, its routes and BurnDetector unchanged (FD4). The session-id hook reuses the one place the server already learns each Claude session id, so no new hook script is needed.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The ledger only records and aggregates. Nothing reads it to decide anything.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point that drives behavior. Membership is declared in the spec's Decision points as a `judgment-candidate` with a deterministic floor (spawn record, then cwd, otherwise not a member), and its weaker signal is exposed as `scope_basis` per row.

---

## 5. Interactions

- **Shadowing:** none. The ledger runs beside TokenLedger and reads the same transcript files read-only; neither changes what the other sees.
- **Double-fire:** the session-id sink runs after the existing `originLifecycle.bindNative` call and is wrapped in try/catch, so a sink failure cannot affect session state or the origin binding.
- **Races:** all ledger writes are synchronous better-sqlite3 transactions on the server's thread; a 60 s timer and the session-id sink are the only writers. A transcript still being written is read up to its last complete line; the partial line waits for the next tick (tested).
- **Feedback loops:** none. The ledger feeds nothing.

---

## 6. External surfaces

- Other agents on the same machine: none. The ledger reads other agents' transcript folders only far enough to rule them out by name, and never counts them.
- Install base: dark on the fleet (dev-gated); live only on development agents.
- External systems: none.
- Persistent state: a new file `.instar/server-data/usage-ledger.db` (plus WAL/SHM), in the folder git-sync already excludes. Growth is bounded by pruning (90 days raw, 4 million raw rows, 400 days hourly and session-day).
- Timing: a 60 s scan costs one stat per candidate file and reads only new bytes past each checkpoint.
- Operator surface: no operator-facing actions in this slice.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

This slice is machine-local: each machine records the transcripts on its own disk under its own machine id. The spec declares the rollups and bindings unified through the lease holder's change-sequence pull (Slice 4) and raw rows proxied-on-read; this slice already stamps `machine_id`, `change_seq` and `generation_id` so that pull can be added without a migration. It emits no user-facing notices, its durable state is keyed by session and machine id so a moved topic does not strand it, and it generates no URLs. No new `/status`, `/health`, `/capabilities` or `/channels` answers in this slice.

---

## 8. Rollback cost

Turn `usage.ledger.enabled` off, or revert the commit: the timer and sink stop and `server-data/usage-ledger.db` is left inert. No migration, no change to existing state, no user-visible regression.

---

## Conclusion

Clear to ship as the first slice. The store, record and Claude capture behave as the spec requires under the 17 unit tests, including the scope, attribution-by-time, replay, depth, round-robin budget, retention and persistence cases. The existing session-manager and dev-gate wiring suites still pass.

---

## Evidence pointers

- `tests/unit/UsageLedger.test.ts` — 17 tests: token mapping; count-once and rollups; NOT NULL sentinel; scope (other agent, nested home, sibling prefix); spawn record outside the home with attribution; hook id with mismatched cwd; attribution by request time; subagent tagging; checkpoint and partial line; replay after pruned raw rows; replaced file; copied history; depth and symlinks; round-robin budget; transaction consistency; pruning and the row ceiling; persistence and generation id.
- `tests/unit/devGatedFeatures-wiring.test.ts` (298), `claude-session-id-bridge`, `session-manager-behavioral`, `native-hook-events-consumers` — all pass.
