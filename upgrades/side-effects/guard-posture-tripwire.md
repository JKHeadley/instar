# Side-Effects Review — GuardPostureTripwire

**Version / slug:** `guard-posture-tripwire`
**Date:** `2026-06-06`
**Author:** `Echo (instar-dev agent, session-robustness topic per Justin's "work on more robust ways to handle these scenarios")`
**Second-pass reviewer:** `self-adversarial pass over alarm fatigue + boot-safety (the two ways a boot-time alarm can go wrong)`

## Summary of the change

A boot-time detector compares the resolved guard posture (every
`monitoring.*` enabled flag + `scheduler.enabled`) against the previous
boot's persisted snapshot. enabled→disabled → loud log + one aggregated
`logs/guard-posture.jsonl` row + ONE aggregated HIGH Attention item;
disabled→enabled → log + breadcrumb only; first boot → baseline only.
Files: `GuardPostureTripwire.ts` (new), `server.ts` boot wiring,
`PostUpdateMigrator.ts` CLAUDE.md section, three test files, spec.

## Decision-point inventory

- Posture extraction — **add (read-only)** — resolved config in, key/boolean map out; generic convention, no registry.
- Transition diff — **add (pure)** — intersection-only (shape changes are not flips).
- Attention emit — **add (signal)** — one aggregated HIGH item per boot-with-disables; dedupe by stable id; absent Telegram → breadcrumb only.
- Snapshot write order — **deliberate** — baseline advances BEFORE alarms so an emit failure cannot cause repeat alarms.

## 1. Over-block

Nothing is blocked — the tripwire has no authority. Worst noise case: an
operator deliberately disabling a guard gets exactly ONE Attention item at the
next boot (transition-based; the following boots are silent). A batch flip of
N guards is ONE item, not N (Bounded Notification Surface).

## 2. Under-block

(a) A flip that is reverted BETWEEN boots (off at 2pm, back on at 5pm, no
restart in between) never trips — acceptable: the guard never actually ran
disabled. (b) Mid-run flips alarm only at the next boot — that is when config
takes effect, so the alarm coincides with the guard actually dying; with
auto-update restarts every ~30 min the window is bounded. (c) Guards that
don't follow the `enabled` convention (none today) would be invisible —
the convention IS the contract, documented in the spec.

## 3. Level-of-abstraction fit

Lives in `monitoring/` beside the sentinels it watches over; wired in
server.ts boot exactly like the worktree detector (same emitAttention
adapter, same placement constraint). The CLAUDE.md knowledge rides the
existing migrateClaudeMd path with a content-sniff marker.

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [x] Pure signal. Never re-enables, never blocks a boot (every failure path
  degrades into `result.error` + a log line), never edits config. The
  Attention item is the operator's consent surface, not an action.

## 5. Interactions

- **Attention flood guard:** a single aggregated item with sourceContext
  `guard-posture-tripwire` — inside every budget; HIGH priority is justified
  (a dark guard is exactly the "user should know" class) and HIGH items are
  never coalesced away.
- **AttentionQueue dedupe:** stable id (`guard-posture-disabled:<date>:<list>`)
  makes a same-day re-emit a no-op via the existing id-collision path.
- **No Telegram:** breadcrumb still lands (the worktree-detector fallback
  pattern); boot line says "breadcrumb only".
- **Snapshot corruption:** degrades to first-boot semantics + self-repairs.

## 6. External surfaces / 7. Rollback

New files only: `state/guard-posture.json` (snapshot), `logs/guard-posture.jsonl`
(append-only history), one CLAUDE.md section (idempotent migration). No API,
no schema, no config key (default-on by design — a tripwire you can silently
disable would be the joke version of this feature; disabling it means deleting
the wiring, which is a reviewed code change). Rollback = revert; the files
stay as inert history.
