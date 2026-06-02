# Side-Effects Review — spinner-immune liveness signal

**Version / slug:** `spinner-immune-liveness`
**Date:** `2026-06-02`
**Author:** `echo`
**Second-pass reviewer:** `instar-codey (codex) — cross-model review completed; verdict incorporated`

## Summary of the change

`src/monitoring/sentinelWiring.ts`: `OutputActivityTracker.snapshot()` now hashes
`stripVolatileStatus(output, framework)` instead of the raw pane. `stripVolatileStatus`
strips the host's animated working-status region (Braille spinner glyphs, the
`Nm Ns` / `(Ns` elapsed timers, token/context counters, and the `esc to interrupt`
footer line) so only real scrollback changes refresh `lastChangeAt`. Fixes the
silence sentinel being permanently blinded by the spinner's ticking clock.

## Decision-point inventory

- `OutputActivityTracker: did this frame change?` (sentinelWiring.ts:~215) — **modify**
  — the hashed input is now spinner-normalized. The downstream "observed-change
  requirement" + `looksActivelyWorking` + silence-threshold logic are unchanged.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** The change cannot reject or
block anything. The only effect is that the silence sentinel correctly recognizes a
stalled-but-spinning turn as idle (rather than perpetually "active") and may issue
its existing non-destructive `Enter` nudge.

---

## 2. Under-block

**What does it still miss?** It strips a conservative, anchored set of volatile
tokens; an exotic future spinner format could still leak a changing token into the
hash (degrading gracefully back to the old "always active" behavior for that host —
no worse than today). It does not change the silence THRESHOLD; a true stall is
detected at the existing ~16-min mark.

---

## 3. Level-of-abstraction fit

Correct layer — a normalization at the change-detector's input boundary, reusing the
existing per-framework `getActivitySignal` patterns rather than inventing new ones.
It feeds the existing smart silence sentinel; it does not add a parallel detector or
hold any authority.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal (a fresher/stale activity timestamp)
  consumed by the existing `ActiveWorkSilenceSentinel`, which owns the (non-destructive)
  recovery decision.

The cross-model review (Codey) specifically affirmed the signal-vs-authority shape:
absence-of-activity must NOT authorize destructive recovery; here it only authorizes a
non-destructive `Enter` nudge, and the destructive Ctrl-C path (SocketDisconnectSentinel)
remains gated on a POSITIVE error-string marker. No change weakens that.

---

## 5. Interactions

- **Shadowing:** none — same single hash site; downstream logic unchanged.
- **Double-fire:** none — `SocketDisconnectSentinel` (error-string → Ctrl-C) and
  `ActiveWorkSilenceSentinel` (silence → Enter) remain independent; this only un-blinds
  the latter.
- **Races:** none — pure synchronous string transform inside the existing snapshot tick.
- **Feedback loops:** the Enter nudge could, on a genuinely-long generation, submit a
  stray blank line; the pane is mid-turn (spinner present) so it is queued/ignored, not
  destructive. Verified the nudge is `sendKey(session, 'Enter')` (sentinelWiring.ts:255),
  not Ctrl-C.

---

## 6. External surfaces

- Persistent state: none.
- External systems: none.
- Behavior visible to operators: a stalled-but-spinning session now appears in
  `logs/sentinel-events.jsonl` as detected/nudged where before it was invisible. The
  Telegram escalation default (off) is unchanged.
- Runtime: one extra string transform per session per silence tick — negligible.

---

## 7. Rollback cost

Pure code change — revert `stripVolatileStatus` + restore `cheapHash(output)`, ship a
patch. No persistent state, no migration, no user-visible regression (it would simply
return to the prior "spinner fools the detector" behavior).

---

## Conclusion

The cross-model review materially improved this change: it began as a multi-state
process-activity gate to protect long generations from a *destructive* Ctrl-C, but the
reviewer's grounded catch — the silence nudge is `Enter`-only, not Ctrl-C — collapsed it
to a single safe normalization, with the destructive path already correctly gated on a
positive error marker elsewhere. Clear to ship as a Tier-1 monitoring reliability fix.

## Second-pass review (if required)

**Reviewer:** instar-codey (codex)
**Independent read: concur (after the implementation correction).** The reviewer's
verdict drove the final design: do not let absence-of-activity authorize destructive
recovery (already satisfied — the silence path is non-destructive `Enter`; Ctrl-C stays
behind the SocketDisconnectSentinel error marker). No residual concern on the shipped
shape.

## Evidence pointers

- `tests/unit/spinner-immune-liveness.test.ts` — 7 tests (normalizer + tracker behavior).
- `src/monitoring/sentinelWiring.ts:255` — nudge is `sendKey(session, 'Enter')`.
- Origin incident: `logs/server.log` + `logs/sentinel-events.jsonl`, 2026-06-02 26-min stall.
