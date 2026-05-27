# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Notify-on-stop, Layer B.** When the Unjustified Stop Gate judges a stop unjustified-but-unblockable (`continue` in shadow mode — the gate wants to keep going but shadow can't block, so the session silently stalls) or ambiguous (`escalate`), and the stopping session is **unattended** (an autonomous run), the user now gets one coalesced plain-English heads-up ("a background run stopped mid-task — want me to pick it back up?"). Previously the gate saw these and could do nothing the user could observe.

Tightly bounded to stay near-silent: only those two genuinely-stuck decision classes, only unattended sessions, at most once per session per 30 minutes, coalesced onto the single system (lifeline) topic. Routine turn-ends, blocked-and-continued stops, and transient fail-opens stay silent. Default ON (Justin's explicit "tell me why it stopped"); disable with `monitoring.notifyOnStop.enabled=false`. Pairs with Layer A (autonomous-run terminal-exit notices).

**Feedback Factory Migration — dry-run/compare machinery.** Next increment of the migration (spec `docs/specs/feedback-factory-migration.md`, approved). Ships the safety harness that lets the ported Instar processor run safely against Portal's live database during the cutover — without ever being able to change it. Three new internal modules under `src/feedback-factory/`:

- **`store/ReadOnlyShadowStore.ts`** — a read-only wrapper around the feedback data layer. Reads pass through; every write throws. The structural guarantee that the dry-run can never mutate the curated bug history (Portal stays the sole writer through cutover).
- **`processor/parity.ts`** — the comparator for the three order-independent invariants the migration spec pins: per-cluster fingerprint, terminal status, and recurrence count. Recomputing fingerprints over the live clusters and diffing them is the highest-signal check — it catches any Python↔TypeScript divergence on real production titles.
- **`dryrun/dryRunCompare.ts`** — the runner: reads the clusters, compares the invariants, writes a JSONL audit trail, and returns a verdict. `divergent === true` is the signal that blocks cutover.

Still internal building blocks — not yet wired into any route or job, so no behavioral change. The live database adapter behind the read-only seam lands once Dawn hands off the read credentials.

## What to Tell Your User

- If one of my background runs stalls mid-task when it shouldn't have, you now get a single heads-up — even when the watchdog can't restart it itself.
- On the feedback system: this is the safety harness for moving it in-house. It lets me run my new version *alongside* Dawn's, reading the same live data, and prove they make identical decisions — while making it physically impossible for my version to touch the real records. The comparison is built to ignore harmless ordering differences and only flag *real* disagreements.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Unjustified mid-task stalls on unattended sessions surface one coalesced Telegram | Automatic (default on); `monitoring.notifyOnStop.enabled=false` to disable |
| Read-only shadow store (write-guard) | Internal `src/feedback-factory/store/ReadOnlyShadowStore.ts` — wraps any `FeedbackStore`; writes throw |
| Parity invariant comparator | Internal `src/feedback-factory/processor/parity.ts` — `compareInvariants()` |
| Dry-run/compare runner | Internal `src/feedback-factory/dryrun/dryRunCompare.ts` — `runDryRunCompare(source, opts)` → verdict + JSONL |

## Evidence

- **Notify-on-stop Layer B:** `src/monitoring/StopNotifier.ts` (decision matrix + attended-gate + dedup); wired via `src/server/routes.ts`, `src/commands/server.ts`, `src/server/AgentServer.ts`. Config: `monitoring.notifyOnStop` in `src/core/types.ts`. Tests: `tests/unit/StopNotifier.test.ts` (21) + `tests/unit/stop-notifier-wiring.test.ts` (6). Spec: `docs/specs/NOTIFY-ON-STOP-SPEC.md`. Side-effects: `upgrades/side-effects/notify-on-stop-layer-b.md`.
- **Feedback-factory dry-run:** 21 new unit tests across the three modules, all green; full feedback-factory unit dir 128/128 green; `tsc --noEmit` clean. Both-sides-of-boundary: every read delegates AND every write throws (with the offending method name); the comparator asserts no-divergence on matching data plus a real divergence for each invariant; the runner covers the clean path, a divergent corpus, the JSONL audit trail, return-only mode, and the never-mutates-the-source guarantee. Faithful to the reference: per-cluster fingerprint is derived exactly as the Python's `cmd_backfill_fingerprints` (`computeFingerprint(cluster.type, cluster.title)`). Side-effects: `upgrades/side-effects/feedback-factory-dryrun.md`.
