# Side-Effects Review — native /goal delegation (Phase 2)

**Version / slug:** `goal-native-delegation`
**Date:** 2026-05-24
**Author:** echo
**Second-pass reviewer:** internal conformance pass

## Summary of the change

Where the framework has a native /goal loop (Claude Code >= 2.1.139), autonomous mode delegates
completion to it: instar **injects `/goal <condition>`** into the session via
`SessionManager.sendInput` (tmux send-keys — its existing session-input mechanism), marks the
job `goal_mode: native`, and the stop-hook **defers** the continue/stop decision to native
/goal (approves each turn). instar still enforces emergency-stop + duration by injecting
`/goal clear` first. Phase 2 of `docs/specs/goal-completion-evaluator.md`. `src/`: two routes
(`/autonomous/native-goal/set|clear`) + capability-index entry + migration marker bump. Non-src:
hook native branch, setup auto-detection.

## Decision-point inventory
- Stop-hook `goal_mode: native` branch — **modify**: defer completion to native /goal (approve);
  still enforce emergency-stop + duration (clear native first). This REMOVES instar's completion
  authority for native topics by design (native /goal is the authority there).
- `POST /autonomous/native-goal/set` / `clear` — **add**: inject the slash command + flip
  goal_mode. Thin; the side-effect is the session injection.
- `setup-autonomous.sh` native detection — **modify** (`.claude/`): activate native mode when
  Claude Code >= 2.1.139 + a condition is set.

## 1. Over-block
- In native mode instar approves (never blocks) for completion, so instar cannot over-block.
  Native /goal's own hook decides. No new over-block path.

## 2. Under-block (false "done" / premature exit)
- instar approving in native mode does NOT cause a false done: in Claude Code's hook composition
  a `block` from native /goal wins over instar's `approve`, so native /goal keeps the session
  working until ITS evaluator confirms the condition. If native /goal somehow isn't active, the
  session would exit — mitigated because goal_mode:native is only set after a successful inject
  (the set endpoint flips the flag only when sendInput returns true).

## 3. Level-of-abstraction fit
- Correct + the point of the change: drive the framework's native feature via instar's own
  session-input mechanism, rather than reimplementing or treating "no /goal API" as a blocker.

## 4. Blocking authority
- [x] In native mode instar **yields** completion authority to native /goal (reduces instar's
  authority — safe direction) while retaining its terminal STOP concerns (emergency/duration) by
  clearing the native goal. No new brittle authority added.

## 5. Interactions (the key one: two Stop hooks)
- instar's hook + native /goal's hook both fire each turn. Resolved by composition: instar
  approves (completion) so native /goal's block keeps control; instar only force-stops on
  emergency/duration, and does so by clearing native /goal first (so they don't fight).
- **Emergency-stop** already kills the session via the sentinel path (native /goal dies with it);
  the hook also clears native /goal on the flag. **Duration** clears native /goal then exits.
- Falls back cleanly to the instar evaluator (Phase 1) when native /goal is absent.

## 6. External surfaces
- **Session injection:** instar types `/goal <condition>` / `/goal clear` into the agent's own
  tmux session (send-keys). This is instar's established mechanism (initial-message injection).
  No new external/credential surface.
- **HTTP:** two authed routes under the already-claimed `/autonomous` prefix.

## 7. Rollback cost
- Low. Reverting restores instar's own evaluator everywhere (Phase 1 still in main). A
  `goal_mode: native` left in a state file is ignored by an older hook (falls to the evaluator/
  promise path). Migration marker is content-sniffed (rollback re-deploys cleanly).

## 8. Test evidence
- Hook: native defers (approve/exit, retained) + emergency/duration clear+exit. Integration:
  set injects `/goal <cond>` (verified sendInput) + flips goal_mode; clear injects `/goal clear`;
  404 unknown topic. tsc clean; 174 affected tests green.

## Deviation from the original spec
Spec Phase 2 sketched a `ThreadGoalSlot` provider primitive. Shipped instead via direct slash-
command injection through `SessionManager.sendInput` — simpler and the correct use of an existing
instar capability (per maintainer direction: "we already input text into sessions; use that to
call /goal"). Same intent, better mechanism; `ThreadGoalSlot` left unimplemented (not needed).
