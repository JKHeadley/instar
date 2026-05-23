# Side-Effects Review — Atomic-Write Helper

**Source:** Cherry-pick from GSD-Instar spike (gsd-executor Rule 2 finding)
**Author:** Echo · autonomous run · 2026-05-23

## 1. Over-block
N/A — additive library function, blocks nothing.

## 2. Under-block
N/A — not a gate.

## 3. Level-of-abstraction fit
Lives in SafeFsExecutor alongside the other safe-fs primitives. Natural home. Static methods matching the existing `safeRmSync` etc. style.

## 4. Signal-vs-authority compliance
N/A — not a gate/filter. Pure fs primitive.

## 5. Cross-feature interactions
- Additive — no existing callsite changes. Existing `fs.writeFileSync` callers are untouched; they can migrate to the atomic helper incrementally.
- Shares the destructive-ops audit trail (appendAuditEntry) — adds `atomicWriteFileSync` / `atomicWriteJsonSync` verbs to the JSONL. No schema change, just new verb values.
- Temp file naming uses pid + timestamp in the same directory; concurrent writes to the same target from different processes each use a distinct temp, then race on rename (last-rename-wins, which is the correct atomic semantics — no corruption, just last-writer-wins).

## 6. Rollback cost
Trivial. Two new static methods + one test file. Revert the commit; any caller that adopted it would need reverting too, but at ship time there are zero adopters (the helper is introduced here; migration of existing callsites is a separate follow-up).

## 7. Migration parity
N/A — `SafeFsExecutor` is a compiled-in library module, not an agent-installed file (`.claude/settings.json` hook, config default, CLAUDE.md section, hook script, or skill). Ships with the package on `npm i instar@next`. No PostUpdateMigrator entry needed.

## Conclusion
Ship. Purely additive crash-safety primitive. Zero blast radius at introduction. Adopting it across existing `.instar/state/*.json` writers (TopicIntent store, etc.) is a separate follow-up that each gets its own review.
