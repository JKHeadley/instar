# Side-Effects Review — Layer 4 detector → AttentionQueue wireup

**Version / slug:** `worktree-detector-attention-wireup`
**Date:** `2026-05-21`
**Author:** `echo`
**Second-pass reviewer:** `not required` (see §"Phase 5 trigger check")

## Summary of the change

The Layer 4 lifeline detector (from the agent worktree convention,
shipped in v1.1.0 via PR #278) was running on every agent server boot
and emitting to its JSONL fallback only — the Telegram AttentionQueue
wireup was deferred because, in `startServer()`, the detector was
invoked at line ~2208 while `TelegramAdapter` doesn't initialize until
line ~2810/2897. The deferred state is documented in the v1.1.0 NEXT.md
and in `upgrades/side-effects/agent-worktree-convention-layer-3-4.md`.

This PR closes the gap by moving the detector invocation to **after**
both `TelegramAdapter` setup blocks. When Telegram is configured, the
detector now passes `telegram.createAttentionItem` as its
`emitAttention` callback; when it isn't, the JSONL fallback fires
exactly as before. The detector remains signal-only — no blocking,
no moves, no deletes.

**Files touched:**
- `src/commands/server.ts` (+62 / -29 lines: removed the old early invocation, replaced with a one-paragraph stub comment; added the new conditional invocation after the full-mode Telegram block).
- `tests/unit/AgentWorktreeDetector-attention-wireup.test.ts` (new, 3 cases — shape-compat, async-await safety, JSONL-fallback preservation).
- `upgrades/NEXT.md` (new — fresh v1.2.4 release).
- `package.json` (1.2.3 → 1.2.4).

## Decision-point inventory

- **Detector emission target selection** — *modify*. Was unconditional
  JSONL; is now Telegram-when-configured-else-JSONL. The selection
  rule is a pure presence check (`telegram ? emitToTelegram : undefined`),
  no judgment. Both paths exist in the spec.
- **AttentionItem.id dedupe** — *pass-through*. The detector already
  produces `worktree-misplaced:sha256(path)` ids; TelegramAdapter's
  existing `attentionItems` Map collapses repeats. No new dedupe logic.
- **JSONL fallback rolling-window** — *unchanged*. Same 24h, same
  O_NOFOLLOW + fstat owner/mode gate on the fallback file.

No new authorities introduced. No new detectors. Just a wiring change
that connects an existing signal producer (detector) to an existing
authority surface (AttentionQueue).

---

## 1. Over-block

No block/allow surface — over-block not applicable. The detector emits
attention items; AttentionQueue is the authority that decides what to
do with them. Neither side rejects the user/operator from anything.

## 2. Under-block

No block/allow surface — under-block not applicable.

A related coverage gap worth naming (and tracked in NEXT.md Deferred):
the 24h JSONL dedupe is per-file. The Telegram path leans on
`AttentionItem.id` collision in TelegramAdapter's in-memory
`attentionItems` Map, which is reset on every agent restart. Two
agent restarts within 24h on a Telegram-configured agent could
theoretically re-emit for the same misplaced worktree path. In
practice, agent restarts are infrequent; if noise becomes a problem,
the fix is to consult the JSONL dedupe state from the Telegram path
too. Acceptable for v1.

## 3. Level-of-abstraction fit

Right layer. The detector lives where every other lifecycle observer
lives (`src/core/`), invoked from the agent boot path
(`src/commands/server.ts`), feeding the existing AttentionQueue
surface in TelegramAdapter. The move from "before TelegramAdapter
init" to "after TelegramAdapter init" is the only change; everything
else reuses primitives that have been in production since v1.1.0.

A smarter gate (the AttentionQueue) already exists; this PR feeds it
the signal it was always intended to consume.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] **No — this change produces a signal consumed by an existing smart gate.** The detector remains signal-only. AttentionQueue (TelegramAdapter's `attentionItems` registry) is the authority that owns dedupe, topic creation, and operator routing. The detector's only authoritative decision is the path-based "is this worktree under a registered safe root" filter, which is hard-invariant validation (carve-out in `docs/signal-vs-authority.md`).

The detector's invariant that the audit ledger is **never** consumed
as an allowlist remains in force — the path-based rule is the
detector's only authority surface, and that rule is restated in
`src/core/AgentWorktreeDetector.ts`'s file-level comment.

## 5. Interactions

- **Shadowing:** the detector now runs AFTER `telegram.start()` and
  after the Telegram routing/callback wireup (`wireTelegramRouting`
  + `wireTelegramCallbacks`). It still runs BEFORE the AgentServer
  HTTP listener (line 7037), so no inbound traffic is missed during
  the detection sweep.
- **Double-fire:** dedupe is owned by AttentionQueue (`item.id`
  collision) for the Telegram path and by the JSONL rolling-window
  scan for the fallback path. Two concurrent agent boots against the
  same instar repo would each emit; the AttentionQueue collapse
  protects the Telegram side, and the JSONL state-dir is per-agent
  so cross-agent file contention is impossible.
- **Races:** the detector awaits each `emitAttention` call (verified
  by the async-await test in
  `tests/unit/AgentWorktreeDetector-attention-wireup.test.ts`). The
  TelegramAdapter's `createAttentionItem` does a network roundtrip
  (`createForumTopic`); awaiting it keeps the detector's
  `result.emitted` counter accurate.
- **Feedback loops:** the detector reads `git worktree list` and
  emits attention items. AttentionQueue creates Telegram topics. No
  loop back into `git worktree`.
- **Startup ordering:** moving the detector down ~700 lines in
  `startServer()` lengthens the time between `registerAgent` and
  the first detection by the duration of TelegramAdapter init. On
  echo's machine that's typically <500ms (the Telegram
  `start()` call awaits a long-poll handshake). No user-visible
  latency change.

## 6. External surfaces

- **Other agents on the same machine:** none. Each agent's
  detection emits to its own TelegramAdapter / JSONL.
- **Other users of the install base:** purely additive — for any
  agent that wasn't already configured for Telegram, behavior is
  byte-identical to v1.2.3 (JSONL only). For Telegram-configured
  agents, attention topics will appear on next agent restart per
  misplaced worktree.
- **External systems:** Telegram (additional topic creates via
  `createForumTopic`). Rate-limited by Telegram's API; one topic
  per detection emission per misplaced path per process. Real-world
  impact on echo's machine: ~30 attention topics on first boot
  after this release, then near-zero per subsequent boot (all
  deduped via item.id).
- **Persistent state:** the existing
  `<stateDir>/audit/worktree-detector.jsonl` fallback file is
  unchanged. Telegram attention topic registrations land in the
  existing TelegramAdapter state (`<stateDir>/state/attention-items.json`,
  managed by the adapter itself).
- **Timing:** detector still uses the existing 2-second timeout
  on `git worktree list --porcelain`. Unchanged.

## 7. Rollback cost

- **Code:** revert this commit. The detector returns to its pre-PR
  position (early in `startServer()` with `emitAttention` always
  undefined), and the JSONL fallback resumes as the only emission
  channel. No data migration. Attention topics already created on
  Telegram remain — they're operator-managed and don't depend on
  this PR's wiring.
- **Persistent state:** no schema change. The
  `<stateDir>/state/attention-items.json` registry is the same one
  TelegramAdapter has owned since v0.10.x.
- **Agent state repair:** none required.
- **User visibility during rollback:** new attention topics stop
  appearing; existing ones stay until the operator `/done`s or
  `/wontdo`s them. The JSONL trail continues unchanged.

Total rollback time: under 2 minutes (one revert).

## Conclusion

Pure wireup change. The detector and AttentionQueue have both been
in production since v1.1.0; this PR connects them. Signal-only
contract is preserved. Three new tests pin the shape-compat,
async-await safety, and JSONL-fallback-preservation invariants.
Pre-push gate green.

Phase 5 trigger check: the change does **not** touch outbound or
inbound messaging *dispatch* (the detector emits a category that
AttentionQueue already handles), session lifecycle, compaction,
coherence gates, idempotency at transport, trust levels, or anything
named sentinel/guard/gate/watchdog. The detector is signal-only and
AttentionQueue is the long-existing authority. No second-pass
reviewer required.

Clear to ship.

## Evidence pointers

- **Wireup tests:** `tests/unit/AgentWorktreeDetector-attention-wireup.test.ts`
  (3 cases: shape-compat between detector output and adapter input,
  async-callback await safety, JSONL fallback preservation).
- **Spec:** `docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md` (approved
  2026-05-17 22:35 UTC).
- **Sibling artifacts:**
  - `upgrades/side-effects/agent-worktree-convention-layer-1-2-5.md`
    (Layer 1+2+5, merged in PR #277 as `bdf8508f`).
  - `upgrades/side-effects/agent-worktree-convention-layer-3-4.md`
    (Layer 3+4, merged in PR #278 as `c7e8e08b`; documented this
    wireup as deferred follow-up).
