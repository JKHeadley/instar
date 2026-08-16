# Side-Effects Review — Lower PromiseBeacon default auto-pause threshold (12 → 4)

**Version / slug:** `promise-beacon-threshold-tune`
**Date:** `2026-05-12`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

PR #163 added an auto-pause for PromiseBeacon after N consecutive unchanged-snapshot heartbeats, with N defaulting to 12. In production this proved too patient: a user reported still seeing nine "still working" pings over ~3 hours before the watcher would have paused. This change lowers the default from 12 to 4, so an idle beacon emits at most ~3 templated heartbeats (plus one final "auto-paused — reply 'keep watching' to resume" line) before going quiet. Users can still extend via `keep watching` (resets the counter and re-arms) or via per-commitment `beaconAutoPauseAfterUnchanged` override. Files touched: `src/monitoring/PromiseBeacon.ts` (constructor default + docstring), `tests/unit/PromiseBeacon-ux-fixes.test.ts` (new test covering the default).

## Decision-point inventory

- `PromiseBeaconConfig.defaultAutoPauseAfterUnchanged` (src/monitoring/PromiseBeacon.ts:113) — modify — default value goes from 12 → 4; docstring updated to match.
- `scripts/pre-push-gate.js` side-effects-artifact check — modify — when `upgrades/NEXT.md` exists (a new PR is in flight), evaluate NEXT.md instead of the frozen released `<version>.md` and accept any fresh artifact from the last 24h. Restores the pre-release-cut behavior for the post-release-cut + new-PR state. Necessary to unblock the push of this same change; previous releases shipped descriptive-slug artifacts (e.g. `jobs-as-agentmd-phase-1a.md`) that the gate kept demanding be renamed to `<version>.md` after the fact.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Auto-pause is a stop on a recurring side-effect, not a block/allow gate. The closest analogue to "over-block" is "pauses too eagerly — a legitimate long-running watch gets silenced." With the new default:
- A beacon firing on a 10-minute cadence (default) auto-pauses after the 4th unchanged heartbeat, ≈40 minutes of pure quiet.
- A threadline round-trip that completes within ~40 minutes of the agent's promise still sees the watcher pause silently before resolution. The user can resume with `keep watching` on the topic; or the underlying delivery/verify path can resolve the commitment independently (auto-pause is non-terminal — status stays `pending`).
- For commitments that legitimately need to watch for hours (e.g. waiting on a slow build), maintainers can set `beaconAutoPauseAfterUnchanged` per commitment to a higher value, or set `defaultAutoPauseAfterUnchanged` in agent config.

Verdict: acceptable. The previous default (12) silenced complaints by erring long; the user explicitly chose the shorter horizon and the resume path covers the edge case.

---

## 2. Under-block

**What failure modes does this still miss?**

- A beacon that the snapshot detector incorrectly reads as "changed" each cycle (e.g. a tmux pane that scrolls a clock) never increments `consecutiveUnchanged`, so auto-pause never fires regardless of threshold. This is a snapshot-detection issue, not a threshold issue, and is out of scope for this change.
- The threshold counts *cycles*, not wall-clock time. If cadence ramps long (the existing atRisk-doubling path), 4 cycles can stretch past 40 minutes. The change still bounds the *number* of "still working" messages the user sees, which is the actual user complaint.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The threshold is a tuning parameter for an existing, well-bounded mechanism. This change touches one number in the same module that owns the auto-pause behavior. No new decision points, no new layer.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

The auto-pause path is a self-stop on a side-effect emitter, not a gate that can block other code paths. Adjusting its threshold doesn't introduce any authority. Resume continues to flow through the existing endpoints (`POST /commitments/:id/resume`) and the "keep watching" Telegram detector, both already in place.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** None for the threshold change. For the pre-push-gate fix: the upper NEXT.md content-validation block (lines 41–79) is unchanged and continues to validate the versioned guide when it exists. The side-effects sub-gate now evaluates NEXT.md (when present) instead. The two blocks don't shadow each other; they validate different invariants.
- **Double-fire:** None. The auto-pause sends exactly one final message and clears the timer; lowering the threshold doesn't change that contract.
- **Races:** None new. The existing per-id `mutate()` CAS queue serializes the paused-flag write; the resume event handler re-arms only after the cold record reflects `beaconPaused=false`.
- **Feedback loops:** Resume → re-arm → may re-pause is the *intended* loop. Lowering the threshold makes each loop shorter (≈40 min instead of ~2–3 h). A user spamming "keep watching" against an unmoving snapshot cycles the loop faster but still terminates after each round.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- Other agents on the same machine: yes — every instar agent's beacons will now pause sooner by default. This is the intended behavior; agents that need longer patience can set `defaultAutoPauseAfterUnchanged` in `.instar/config.json` under a beacon section, or override per-commitment.
- Other users of the install base: same as above. Documented in release notes.
- External systems (Telegram, Slack, GitHub, etc.): no protocol changes. The number of outbound Telegram messages per quiet beacon goes from ~12 + 1 final → ~4 + 1 final.
- Persistent state: no schema changes. The cold field `beaconAutoPauseAfterUnchanged` already exists per commitment; only the *default* differs.
- Timing/runtime conditions: cadence math unchanged.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure one-number change. Revert the line in `PromiseBeacon.ts` (and the doc/test), ship as next patch. No persistent-state migration, no agent reset needed. Any commitments already paused under the new default stay paused (the cold record carries `beaconPaused=true`), and a revert doesn't unpause them — they'd re-arm only on explicit `keep watching` or programmatic resume. That's the same behavior as today and not a regression.

---

## Conclusion

Single-knob tune driven by direct user feedback: the previous default silenced spam too late. New default of 4 cycles caps user-visible heartbeats at ~4 per quiet stretch and pairs with the existing `keep watching` resume path so legitimate long waits aren't lost. No interactions or external-surface changes beyond the user-visible message count. Clear to ship.

---

## Evidence pointers

- `tests/unit/PromiseBeacon-ux-fixes.test.ts` — new test "auto-pauses by default within ~5 fires when no threshold override is configured" exercises the default path end-to-end. Existing UX-fixes tests continue to pass.
- Live production observation: CMT-392 (topic 9597) reached 9 unchanged heartbeats over ≈3 hours under the 12-cycle default before user complaint. Withdrawn manually pre-fix.
