# Side-effects review — the standing compaction canary and the sentinel status route

**Version / slug:** `cb-canary`
**Date:** 2026-11-10
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (Fable 5.2; see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.1 "Standing canary" ("Per `(machine, engine, version)`, counts of compaction detections, PostCompact records and recovery blocks in the transcript. The detection channel is independent of the hooks under test, with one rule: the engine-written compact-boundary entry in the transcript … alone is a detection; … the engine's native pre-compaction event alone is never a detection. A hook family that never fires therefore reads `diverged`, never `uninitialized` … States, defined on detections within the current verification epoch …: `n/a: switch-off`; `uninitialized` …; `diverged` …; `healthy` (≥ N detected in the epoch, default 3, all with both artifacts, at least one of them a fresh positive control …)"), §7.8 (the canary runs in the sentinel), §16 Phase 0 ("sentinel skeleton (canary with the transcript detection channel …)"). Converged 6 rounds, approved 2026-11-09 17:22 PST. Phase 0 task 10, part c; stacked on 10b.
**Tier:** 2 (a new read route and an agent-awareness row shipped to every agent; observation only).

## Summary of the change

1. **`src/monitoring/compactionCanary.ts`** (new) — `CompactionCanary`: a durable ledger (`state/context-budget/canary.json`). `scan(sessions, switchOn)` reads each topic session's transcript INCREMENTALLY (byte offset per file; whole lines only, a torn last line waits for the next tick; truncation re-reads; at most 32 MB per file per tick) and records:
   - a **detection** for each engine-written compact-boundary entry (Claude Code: `type: "system"`, `subtype: "compact_boundary"`; trigger, version, timestamp), deduplicated by its uuid;
   - its **recovery block**: the engine's own `attachment` `hook_success` with hookName `SessionStart:compact` and exit 0, after that boundary, whose `command` is Instar's `session-start.sh` AND whose output (`stdout`, which Claude Code keeps in full; `content` is only a preview) carries the post-compaction marker `=== IDENTITY RECOVERY (post-compaction) ===` — a hook that fell back to the startup orientation, or another hook succeeding under the same name, is NOT recovery;
   - its **PostCompact record** (PostCompactStore), matched ONE-TO-ONE: the earliest unclaimed record of that session from 15 s before the boundary (the hooks run about a second before the engine stamps it) to 10 minutes after, and more than 5 s before the session's next boundary in transcript order;
   - **synthetic positives**: a `manual` boundary within 5 minutes after a press recorded by `recordSyntheticPress`; each press counts for ONE boundary (the press itself is task 11).
   Every transcript seen is remembered, so a session that compacts and exits between ticks still gets its final lines read (idle 24 h ⇒ forgotten). An unreadable transcript is skipped for that tick without stopping the other scans; an unreadable LEDGER is replaced and the reset is reported (`ledgerResetAt`).
   `report(switchOn)` groups detections in the current **verification epoch** by (machine, engine, version): `n/a` (switch off), `uninitialized` (no settled detection), `diverged` (a settled detection — past the 10-minute artifact grace — missing either artifact), `healthy` (≥ 3 complete, ≥ 1 synthetic, and none still pending — "all with both artifacts"), and **`accruing`** (every settled detection complete, but fewer than 3 or no synthetic yet). A detection still inside its grace is `pending` and counts toward nothing. The epoch restarts when the switch turns on and on `restartEpoch()` (a completed remediation); history stays in the ledger (last 500).
2. **`ContextBudgetSentinel`** — an optional `canary` dep: the tick scans (a failing scan fails the step, so the heartbeat goes stale); `status()` carries the canary report.
3. **`contextBudgetSentinelBoot.ts`** — `productionCanarySessions`: topic-bound Claude Code sessions with a known session id, their transcript resolved by the production resolver under the session's config home.
4. **Route** `GET /context-budget/sentinel` (read-only): the sentinel's status; `503` with `enableWith: contextBudget.sentinel.enabled` when it is off. Plumbed `server.ts` → `AgentServer` → routes ctx. **CapabilityIndex** entry `contextBudget` (prefix `/context-budget`).
5. **Agent awareness** — a Registry-First row ("Does compaction recovery work on this machine? / is a context fold stuck?") in `generateClaudeMd`, and the same row inserted for existing agents by `migrateClaudeMd` (idempotent, after "What are we working on?", sniffed on the route); tracked in the feature-delivery parity test.

**Phase 0 posture:** the sentinel ships dark, so the canary runs only where it is turned on (the test agent's verification run, task 11). The route answers 503 everywhere else.

## Decision-point inventory

- No decision point. The canary observes and reports; its state gates nothing yet (the §11 backstop window that it will gate is Phase 3).

## 1. Over-block

None (no gating).

## 2. Under-block

- **Synthetic press** — the canary counts a press but does not perform one; the press on a throwaway session is the task 11 verification suite's job, so `healthy` is unreachable until then. <!-- tracked: CMT-1536 (Phase 0 task 11: synthetic positive control on a throwaway session) -->
- **Heal ladder by cause** (re-run migration, re-stage and re-inject the seed, record only) — not in this slice. <!-- tracked: CMT-1536 (Phase 1: canary heal ladder by cause) -->
- **Engines**: Claude Code only (its transcript shapes are the ones verified here, from this session's own 2.1.321 transcript). Codex joins when its adapter's transcript channel is verified. <!-- tracked: CMT-1536 (Phase 1: Codex canary channel) -->
- **`accruing`** is a fifth state the spec does not name: the spec's four leave "all complete but not yet N" unnamed, and calling it `uninitialized` would be false. It never lowers anything (only `healthy` would).
- The size-drop detection channel is not used (it needs corroboration and fold/clear exclusion); the boundary entry alone is the spec's sufficient rule.

## 3. Level-of-abstraction fit

A ledger module the sentinel ticks, reading engine artifacts (transcripts) and the existing PostCompact store; no parallel recovery path.

## 4. Signal vs authority compliance

Signal only.

## 5. Interactions

- Reads transcripts read-only, bounded per tick; never writes to them.
- PostCompactStore read only.

## 6. External surfaces

A new read route (auth-gated like every route) and one CLAUDE.md row for every agent (new and existing).

## 7. Multi-machine posture

Machine-local by design: the canary measures THIS machine's engine and hooks (§9.1 states are per machine); the report names the machine. A pool-wide read is a dashboard concern (Phase 1 card).

## 8. Rollback cost

Revert. The ledger file is inert without the code; the CLAUDE.md row is harmless if the route 503s.

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: observation only; no self-triggered action.

## Evidence

- `tests/unit/compaction-canary.test.ts` (19): `n/a` / `uninitialized`; a boundary alone is a detection, complete with both artifacts; a hook that never fires reads `diverged` past the grace, never `uninitialized`; a missing PostCompact record or a failed hook diverges, and records never cross boundaries even on tied timestamps; a torn last line completes on the next tick without double counting; `healthy` needs 3 complete plus a synthetic positive (`accruing` until then); an unpressed manual compaction is not synthetic; epoch restart (switch on, remediation) keeps history; versions are separate groups and a truncated transcript re-reads without duplicates; the ledger survives instances; this session's own real boundary line; compactions before the switch turned on are history. Review round 1: a hook with no recovery marker diverges; another hook under the same name is not recovery; a pending compaction holds healthy back; one press counts once; a session that exits between ticks is still counted; an unreadable transcript is skipped without stopping other scans; an unreadable ledger reset is reported. Fixtures carry the real 2.1.321 attachment shape (`command`, full `stdout`, preview `content`).
- `tests/unit/ContextBudgetSentinel.test.ts` (+1): the canary runs each tick and appears in status; a failing scan leaves the heartbeat stale.
- `tests/unit/migrate-context-budget-sentinel-row.test.ts` (2): existing agents get the row once after "What are we working on?" with their port; `generateClaudeMd` carries it.
- `tests/integration/context-budget-sentinel-route.test.ts` (3): 503 naming the switch; 200 with heartbeat, folds and the canary counting a real-shaped compaction through the real routes; the capability index classifies the prefix.
- `tests/e2e/context-budget-canary-alive.test.ts` (2): the sentinel built with `productionCanarySessions` and the production transcript resolver (config home), a compaction with both artifacts reads complete through the route; WIRED source check (canary given to the sentinel, sentinel passed to AgentServer).
- 283 template/scaffold/migration unit files green (incl. feature-delivery parity, capabilities discoverability); `tsc --noEmit` clean.

## Second-pass review

**Reviewer (independent subagent on Fable 5.2, 2026-11-10 04:41 PST): "Concern raised."** BLOCKING: the recovery block was "a SessionStart:compact hook exited 0" — it never checked what the hook printed or which hook ran; three compactions whose hook printed only the startup orientation read complete (one press from `healthy`), and an unrelated hook succeeding while Instar's failed also counted. Real 2.1.321 evidence: `content` is a preview, `stdout` carries the marker. MINOR: `healthy` ignored a pending unrecovered compaction; a session that compacts and exits before the next tick was never counted; a compaction just before the first scan falls outside the epoch; a corrupt ledger silently turned `diverged` into `uninitialized`; one press marked every manual compaction within 5 minutes synthetic; the PostCompact skew margin was thin; an unreadable transcript threw out of the whole scan (and so staled the heartbeat); offsets never pruned; Slack topics excluded; the CLAUDE.md row did not name all states; no route test through auth. Checked fine: the detection rule against the real boundary, whole-line reading, cost (118 ms first scan of the real 18.5 MB transcript, 2 ms idle), the route's 503 and payload (no paths or summaries), the migration, `accruing` as an honest name.

**Resolution:** BLOCKING fixed — a recovery block requires Instar's `session-start.sh` command and the recovery marker in its output (tests for both failure shapes; fixtures now carry the real attachment shape). Minors: pending holds `healthy` back; known transcripts get a final scan after their session leaves the running list (idle 24 h ⇒ pruned, which also bounds offsets); presses are consumed on first match; PostCompact matching uses a 15 s early tolerance and a 5 s next-boundary margin (the hooks run ~1 s before the stamp); an unreadable transcript is skipped for that tick; an unreadable ledger reset is reported as `ledgerResetAt`; the CLAUDE.md row names all five states (template and migration identical). Accepted, stated: a compaction stamped between switch-on and the first scan (≤ one tick) falls outside the new epoch, as the spec's epoch rule says; Slack-bound topic sessions are out of this slice's scope (the canary's scope is Telegram topic sessions today; the channel-neutral row writer is Phase 1) <!-- tracked: CMT-1536 (Phase 1: canary scope for Slack- and app-bound topic sessions) -->; the route sits behind the server's global auth middleware like every route, verified by the reviewer.

**Re-check (same reviewer, 2026-11-10 04:49 PST): "Concur with the review."** Every probe reads honestly: a hook with no marker and a foreign hook both `diverged`; genuine recovery with the record 0.9 s or 6 s early is complete; a pending unrecovered compaction takes `healthy` to `accruing` (then `diverged` past the grace); a session that exits between ticks is counted; idle entries prune and a returning session re-reads without duplicates; one press counts once; an EACCES transcript does not stop the scan; a corrupt ledger reports `ledgerResetAt`; the real 2.1.321 transcript reads `recoveryBlock: true` via `stdout`. Minors and resolution: (1) the marker was a substring match, so a startup fallback quoting it in recent topic messages read complete — fixed: a whole line must equal the marker (test); (2) the press tolerance ran backwards — fixed: a boundary cannot precede its own press (test); (3) an early-tolerance record can be attributed to the wrong boundary in `recent` while the group state stays honest — accepted; (4) a permanently unreadable transcript was skipped silently — fixed: `unreadableTranscripts` in the report (test).
