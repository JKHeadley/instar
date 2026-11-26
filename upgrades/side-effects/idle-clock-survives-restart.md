# Side-Effects Review — Idle clock survives a server restart

**Version / slug:** `idle-clock-survives-restart`
**Date:** `2026-10-22`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `independent reviewer subagent (session-lifecycle change → required)`

## Summary of the change

`SessionManager.idlePromptSince` — the per-session "first observed idle at a prompt" instant that the idle-zombie kill compares against the 240-minute topic-bound threshold — was an in-memory `Map`, reset to empty on every server restart. An agent whose server restarts more often than the threshold (auto-updates land roughly every 30 minutes) could therefore never accumulate enough observed idleness to close an idle topic-bound session; sessions piled up to `maxSessions` and every new conversation was refused ("Max sessions (20) reached"). Observed live on the sagemind agent, 2026-10-22: 20/20 sessions, 17 idle at a prompt for 17–64 h, three server restarts that day, a refused spawn, operator-visible as "Luna is not responding".

The fix persists the idle-start instant on the session record (`Session.idleSince`, ISO-8601) and, on the first idle observation after a restart, seeds the in-memory clock from it — only when a pure resolver (`src/core/idleSincePersistence.ts#resolveIdleSinceSeed`) says the value is usable: present, parseable, not in the future, and not refuted by the framework transcript's mtime (a transcript modified after the recorded instant proves the session worked since, so the value is discarded). The instant is cleared, in memory and on disk, wherever the monitor already reset the clock (session observed active, new input arriving, paste retry, API-error nudge, compaction-recovery veto).

Files: `src/core/idleSincePersistence.ts` (new, pure), `src/core/SessionManager.ts` (seed/clear helpers + `transcriptMtimeMs`, six call sites rewired), `src/core/types.ts` (one optional field), `tests/unit/session-idle-clock-survives-restart.test.ts` (new).

## Decision-point inventory

- `SessionManager` monitor tick → idle-zombie kill request (`handleIdleZombie` → `#terminateSessionInternal('idle-zombie')`) — **pass-through, input modified**. The decision (kill / veto / back off) and its authority (ReapAuthority + KEEP-guard + veto-backoff ledger) are untouched; only the `idleMs` input can now be larger after a restart.
- `resolveIdleSinceSeed` — **add**. A pure, deterministic "may the clock resume from this recorded instant?" decision. It holds no kill authority; it chooses between two clock starting points, and every uncertain case picks today's starting point (`now`).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The only input this change can "reject" is a recorded idle instant, and rejecting one means *start the clock now* — today's behaviour. Concretely: a legitimately-idle session whose transcript mtime is newer than the recorded instant (for example, Claude Code's own idle compaction rewrote the JSONL after the session went idle) is treated as NOT idle for that span and starts fresh. That delays its close by up to one threshold; it never prevents it, and it can never cause a wrong close. No issue identified beyond this deliberate conservatism.

---

## 2. Under-block

**What failure modes does this still miss?**

- A session whose transcript cannot be read (no `claudeSessionId` yet, non-Claude framework path unresolvable) gets no transcript corroboration: the recorded instant is trusted on its own. The instant is still cleared on every active observation and on every inbound message, so the exposure is a session that did work *without* the monitor ever seeing it active between two restarts. The existing kill gate's own live checks (idle prompt patterns AND no active child processes at kill time, plus the KEEP-guard's recent-user-message / open-commitment vetoes) still stand between a seeded clock and a kill.
- The seeded clock does nothing for an agent whose kill is permanently vetoed for another reason (protected session, standby `not-lease-holder`); those sessions still accumulate. Out of scope: that is a separate keep-reason, surfaced by the existing escalation item.
- The `maxSessions` saturation itself is still possible with 20 genuinely-active sessions; this change only restores the idle path.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The defect is that one authority's *input* was volatile. The fix makes that input durable at the exact place it is produced (the monitor tick's first idle observation) using the existing durable session record (`StateManager.saveSession`) — no new store, no new sweep. The resolver is a detector-level pure function; it feeds the existing authority rather than running parallel to it. The alternative — a boot-time sweep that guesses idleness from transcript mtimes — would be a second, parallel judge of idleness; rejected.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The persisted instant is a signal (observed-idle duration) consumed by the existing idle-zombie authority, which keeps every veto it has today (recent user message, topic-bound grace, open commitment, protected, in-flight, not-lease-holder) and its veto-backoff + escalation brakes. The resolver adds no blocking authority: its only power is to make the clock resume rather than restart, and on every doubt it chooses restart.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The resolver's rules are enumerable invariants about a timestamp (absent / unparseable / future / contradicted by a later transcript write), not a judgment between competing live signals. The competing-signals decision — "is this session truly idle enough to kill?" — remains with the existing gate, unchanged.

---

## 5. Interactions

- **Shadowing:** none. The seed runs inside the existing `if (!idlePromptSince.has(id))` branch; everything after it (paste retry, API-error nudge, compaction-recovery veto, the kill request) runs exactly as before. `clearIdleClock` replaces `idlePromptSince.delete` one-for-one at six sites and additionally clears the durable field.
- **Double-fire:** none. The number of kill requests per session per tick is unchanged (at most one), and the veto-backoff ledger (`idleKillBackoff`) still suppresses re-requests within its cooldown.
- **Races:** the monitor loop's `session` is a shallow snapshot taken at tick start and can be seconds stale by the time a later session is reached (the loop awaits tmux captures per session). The first draft of this change saved that snapshot back whole; the second-pass review showed that is a new write class — a kill-to-respawn landing mid-tick reuses the SAME tmux name under a NEW record id, and writing the stale snapshot back as `status: 'running'` would make `saveSession`'s supersede pass close the NEW live record and leave the pane tracked by the resurrected stale one (with a stale `claudeSessionId`, so the next resume picks the wrong transcript). Resolved: both helpers go through `persistIdleSince`, a synchronous read-modify-write on the FRESH on-disk record (`StateManager.getSession` reads the file) that refuses unless the record still exists, is `running`, and has the same `tmuxSession` as the snapshot, then changes only `idleSince` and saves that. With no `await` between read and write, a concurrent in-process field write (`claudeSessionId` capture, `confinedDeliveredAt`) is not dropped either. Covered by the "writes onto the FRESH on-disk record" test (killed record → no write; re-used id with another tmux name → no write; sibling field set after the snapshot survives; the clear path obeys the same rule). Remaining exposure: a cross-process writer (none exists today; all session writes are in-process) could still race the read-modify-write — the cost would be one restart's worth of resumed clock, never a wrong kill.
- **Feedback loops:** none added. A seeded clock changes WHEN a kill request is first made, not HOW OFTEN; after a kill the session leaves the set.
- **SessionReaper (the separate pressure-driven reaper):** unaffected; it computes its own idle evidence and is off on the observed agent anyway. The idle-zombie path skips a session the reaper has leased (`isReaping`), as before.

---

## 6. External surfaces

- **Other agents / install base:** every agent gains one optional field on its session records. Older binaries ignore it; new binaries treat its absence as "fresh clock". No API shape changes (`GET /sessions` serialises the record as-is, so `idleSince` becomes visible there — informational only).
- **External systems:** none.
- **Persistent state:** `idleSince` on `state/sessions/*.json`. Written on first idle observation, deleted on first active observation. Legacy records: absent → fresh clock.
- **Timing / runtime conditions:** depends on the transcript's mtime for corroboration; an unreadable transcript degrades to "trust the recorded instant" (bounded by the existing live kill checks), never to "keep forever".
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing actions added or touched.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** A session is a tmux process on one machine; its idle clock describes that process on that machine and is meaningless elsewhere. The session record (`state/sessions/*.json`) is already machine-local for the same reason, and the pool-wide question ("what is running where?") is already answered by the existing proxied-on-read `GET /sessions?scope=pool`, which will now carry `idleSince` per machine as informational data. On topic transfer the OLD machine's session is closed by the existing post-transfer closeout and its record (with `idleSince`) ends with it — nothing strands. No user-facing notices, no URLs.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit and ship the next patch. The field is additive and optional; a reverted binary ignores records that carry it.
- **Data migration:** none. Stale `idleSince` values left on records by the reverted binary are inert (the old code never reads them) and vanish when those records are pruned.
- **Agent state repair:** none.
- **User visibility:** a rollback restores the restart-prone saturation; no regression beyond the original bug.

---

## Conclusion

The review confirmed the shape: a durable input to an unchanged authority, with every uncertain case resolving to the pre-existing behaviour. Two design changes came out of review. First, transcript-mtime corroboration was added so a recorded instant can never credit idleness over a span in which the session demonstrably worked (the only way a longer seeded clock could bring a kill forward wrongly). Second — from the second-pass review — the durable write was re-based from the monitor loop's stale snapshot onto the fresh on-disk record (`persistIdleSince`), closing a resurrect-and-supersede race that the first draft would have introduced on a mid-tick kill-to-respawn. Clear to ship once the second-pass reviewer confirms the re-based write.

---

## Second-pass review (required — session lifecycle / kill path)

**Reviewer:** independent reviewer subagent (claude)
**Independent read of the artifact: concur**

The first-draft concern (saving the monitor loop's stale snapshot back whole, which on a mid-tick kill-to-respawn under the same tmux name would resurrect the old record and let `saveSession`'s supersede pass close the new live one) is resolved: `seedIdleClock` (`src/core/SessionManager.ts:5478-5480`) and `clearIdleClock` (`:5488-5491`) now write only through `persistIdleSince` (`:5508-5521`), which reads the on-disk record (`:5510`), refuses unless it exists, is `running`, and carries the snapshot's `tmuxSession` (`:5511`), no-ops when the field already holds the value (`:5512`), changes only `idleSince` and saves that record (`:5513-5515`), with no `await` between the read and the write, so an in-process sibling write cannot be dropped. `supersedeStaleLiveRecords` is still entered mechanically by any `running` save (`StateManager.ts:305-307`), but it can no longer find a ghost from these helpers: a record that is `running` on disk right now has, by that same invariant, no newer live record sharing its tmux name (the newer record's own save would already have closed it), so the harmful resurrect-and-supersede outcome is unreachable. Verified by the new test (`tests/unit/session-idle-clock-survives-restart.test.ts`, "writes onto the FRESH on-disk record…": killed record → no write; re-used id under another tmux name → no write; a `claudeSessionId` set after the snapshot survives; the clear path obeys the same rule) — 14/14 pass on a targeted run. Everything else from the first pass stands: no new blocking authority (`handleIdleZombie` `:1679-1745` and `computeIdleZombieReapVerdict` untouched), the kill still requires idle-prompt + no child processes on the current tick (`:3014-3025`) plus the ReapGuard vetoes (`src/core/ReapGuard.ts:189-203`), the firing path is byte-identical, and records are machine-local with the standby kill vetoed `not-lease-holder`.

---

## Evidence pointers

- Live: sagemind laptop `GET /health` → `sessions: {current: 20, max: 20}`; `POST /sessions/spawn` → `500 "Max sessions (20) reached"`; pane scan of all 20 → every one idle at a prompt, 17 started 2026-10-19/21 with `maxDurationMinutes: 240`; server restarted 1.3.1391 → 1.3.1394 → 1.3.1399 the same day.
- Code: `src/core/SessionManager.ts` `private idlePromptSince = new Map<string, number>()` (in-memory only, pre-fix).
- Tests: `tests/unit/session-idle-clock-survives-restart.test.ts` — 13 tests; the `REGRESSION` case constructs a second `SessionManager` over the same state directory and asserts the observed idleness spans the restart. With the seed disabled (resolver forced to `no-persisted-value`) that case fails on `expected 0 to be >= 14400000` — the pre-fix behaviour.

---

## Class-Closure Declaration (display-only mirror)

This change modifies a self-triggered controller (the SessionManager monitor tick's idle-zombie kill request), so the `unbounded-self-action` declaration applies.

- **`defectClass`**: `unbounded-self-action`
- **`closure`**: `guard`
- **`guardEvidence`**: `{enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: The change alters only the clock INPUT to an existing registered controller and adds no new trigger. Control-loop edge: a kill request is made at most once per session per tick, and a killed session leaves the live set — the edge is one-way, the action's effect cannot re-enter its own trigger. Steady-state bound: under sustained worst-case pressure (every session idle, every request vetoed) the request count converges to at most one per session per veto-backoff cooldown window, total bounded by maxSessions, exactly as before this change; a seeded clock can bring a session's FIRST request forward once but cannot add requests. Settling brake: the existing idleKillBackoff veto-backoff ledger (dwell/hysteresis on a repeated veto) plus the once-per-episode escalation breaker remain the brake; the ratchet in tests/unit/self-action-convergence.test.ts proves the registered idle-kill controller settles under the pressure fixture, and this change leaves that controller's firing path byte-identical.}`
- **`gap`**: not applicable.
