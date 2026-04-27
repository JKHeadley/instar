# Side-Effects Review — Deferral Detector — Orphan-TODO Patterns

**Version / slug:** `deferral-detector-orphan-todo`
**Date:** `2026-04-27`
**Author:** `echo`
**Second-pass reviewer:** `not required` (low-risk, non-blocking, no auth surface, no new state)

## Summary of the change

Extends the existing `deferral-detector.js` PreToolUse hook to also catch orphan-TODO phrasings ("queue for next session", "loop back later", "in a follow-up", etc.) — UNLESS the same outbound message also names real follow-through infrastructure (`/schedule`, `/commit-action`, a same-branch follow-up commit/PR, or a tied-to-existing-spec phrasing). When detected, an additional checklist section is appended to the existing inability-deferral checklist; the hook remains non-blocking (`decision: 'approve'`).

Files touched:
- `src/core/PostUpdateMigrator.ts` — extended `getDeferralDetectorHook()` template (+~70 net new lines).
- `src/data/builtin-manifest.json` — auto-regenerated (PostUpdateMigrator changes propagate to manifest hook hashes).
- `tests/unit/deferral-detector-orphan-todo.test.ts` — NEW, 14 tests, real-hook-spawn end-to-end.
- `docs/specs/deferral-detector-orphan-todo.md` — NEW, the converged spec (review-iter: 1, principal approved).
- `docs/specs/reports/deferral-detector-orphan-todo-convergence.md` — NEW, convergence report.

## Decision-point inventory

- **`deferral-detector.js` hook** — MODIFY. Extends the pattern set; does NOT change the hook's contract (still non-blocking). No new decision authority; the hook continues to inject `additionalContext` only.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The hook does not block inputs. It injects context for the agent to read. Worst case: a noisy nudge on a message that has good follow-through but used a phrasing the anti-trigger didn't recognize. The cost is one false-positive checklist injection — recoverable, since the agent's own judgment is the authority.

Specific edge cases reviewed:
- "deferred to a follow-up PR" → suppressed (anti-trigger matches "follow-up PR"). Verified by test.
- "I'll get to it next time" → fires (no anti-trigger). Correct — this is the canonical orphan-TODO phrasing.
- "Queue them for the next session" with no infrastructure named → fires. Correct (the originating incident).

## 2. Under-block

**What failure modes does this still miss?**

- Creative paraphrases not in the regex set (e.g., "let's revisit this another time", "park this for a rainy day"). Acceptable: the checklist's purpose is to prompt the agent's own judgment; comprehensive coverage is a never-ending arms race. The patterns capture the most common phrasings we've seen; future drift can extend.
- Multi-message orphan TODOs (one message proposes the deferral, a separate message names infrastructure) — the hook fires per-message, so these would fail-open. Acceptable: the same-message anti-trigger requirement enforces co-location of the commitment with its infrastructure.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The deferral-detector is the existing layer for "agent communication patterns that warrant a checklist nudge." Pushing this into a higher layer (e.g., the tone gate) would conflate brittle pattern detection with content authority — exactly the signal-vs-authority violation the principle warns against. Pushing it lower (e.g., into the script's prompt) would lose the structured PreToolUse stdin contract.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.
- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

Pure detector. The hook contract (`decision: 'approve'`) prevents block authority. The patterns are brittle regex matches — exactly the brittle-detector shape the principle calls out — but they feed the agent's own judgment via `additionalContext`, not a block path. Compliance: clean.

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Coexists with the existing inability-deferral checklist.** When both pattern categories fire, both checklist sections are emitted in a single `additionalContext` blob. Tested explicitly (`emits BOTH sections when message has both inability and orphan patterns`).
- **Does not touch the tone gate.** The tone gate is the single content authority for outbound messages. This hook fires on the Bash tool that *invokes* the relay, not on the message body itself — different layer entirely.
- **No race conditions.** The hook is per-invocation, stateless.

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** YES (intentional). All instar agents on next `instar update` get the new hook content. Behavior change: agents that propose orphan TODOs in outbound messages now get a checklist nudge.
- **Other users of the install base:** YES (intentional). Same as above.
- **External systems:** none.
- **Persistent state:** none.

## 7. Rollback cost

Revert the `getDeferralDetectorHook()` change in `src/core/PostUpdateMigrator.ts`. Manifest regenerates. Existing agents on next `instar update` revert to inability-only patterns. Zero persistent state, zero downtime, ~10 minutes ship time.

## Conclusion

Low-risk extension of an existing non-blocking hook. The structural contract (no block authority) is preserved. The cost of false positives is a noisy checklist; the cost of false negatives is one orphan TODO. Asymmetry favors broader matching with infrastructure-backed anti-triggers as the safety valve. The fix directly addresses the meta-issue surfaced by Justin during the telegram-delivery-robustness build (2026-04-27): Echo proposed "queue them for the next session" with no `/schedule` or `/commit-action` backing. The new patterns + checklist make that pattern visible-to-self at the moment of speech.

Clear to ship.

---

## Evidence pointers

- Test file `tests/unit/deferral-detector-orphan-todo.test.ts` — 14 tests, including:
  - 6 orphan-TODO pattern fires
  - 3 anti-trigger suppressions (`/schedule`, `/commit-action`, follow-up commit phrasing)
  - 1 inability-claim independence test
  - 1 dual-section test (both inability + orphan)
  - 1 non-message-command no-op
  - 1 hook-contract test (decision is 'approve')
- TypeScript: `pnpm tsc --noEmit` clean.
- Manifest: regenerated, `tests/unit/builtin-manifest.test.ts` (9 tests) green.
