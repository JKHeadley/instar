# Side-Effects Review — PromptGate auto-dismiss memory

**Version / slug:** `promptgate-auto-dismiss-memory`
**Date:** `2026-06-05`
**Author:** `instar-codey`
**Second-pass reviewer:** `self-review required by PromptGate/session-input surface; concur`

## Summary of the change

PromptGate deterministic auto-dismiss prompts were repeatedly firing when the terminal kept the same dismissed prompt text visible after the dismiss key was sent. The server called `onInputSent()` after auto-dismiss to clear normal cooldown/dedup for the next real prompt, but that also allowed the identical stale prompt to re-emit. This change adds a separate in-memory successful-auto-dismiss cache in `src/monitoring/PromptGate.ts`, records into it from the auto-dismiss consumer in `src/commands/server.ts` only when `sendKey` returns true, and clears it when the captured pane content changes or the session is cleaned up.

## Decision-point inventory

- PromptGate auto-dismiss emission — **modify** — suppresses a previously successful auto-dismiss fingerprint while the pane content is unchanged.
- Server auto-dismiss consumer — **modify** — records successful auto-dismisses in the detector before resetting normal input state.
- Normal prompt detection/dedup — **pass-through** — unchanged for prompts without `autoDismissKey`.
- LLM `NO_PROMPT` cache — **pass-through** — unchanged; this fix is separate from the prior token-burn cache.

---

## 1. Over-block

Legitimate repeated auto-dismiss prompts with byte-identical prompt text in byte-identical pane content will be suppressed until the pane content changes. That is intentional: if the pane has not changed after a successful key send, the visible prompt is stale terminal text, not a new modal. Failed key sends do not enter the cache, so delivery failures can still retry.

---

## 2. Under-block

If the terminal redraws the same prompt with any content change, the cache clears and PromptGate may auto-dismiss again. This is the intended re-arm boundary because a changed pane can represent a real new modal or a re-rendered still-blocking state. The change does not attempt cursor-position analysis; it uses the existing captured-text boundary.

---

## 3. Level-of-abstraction fit

The memory lives inside PromptGate because PromptGate owns prompt fingerprints and dedup semantics. The server remains the right place to decide whether the key send succeeded, so it records successful auto-dismisses after `sendKey` returns true. This avoids placing delivery-success knowledge inside the detector and avoids teaching the server how to fingerprint prompt text.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but this is deterministic dedup/memoization of a prior successful deterministic auto-dismiss, not a brittle semantic classifier.
- [ ] Yes, with brittle logic — STOP. Reshape the design.

PromptGate already held authority to emit deterministic auto-dismiss prompts. This change narrows repeat emission for the exact prompt fingerprint after a successful key send. It does not add a new modal detector, approve any new action, or change LLM classification authority.

---

## 5. Interactions

- **Shadowing:** the successful-auto-dismiss cache runs before normal emitted-prompt dedup. It only applies when the match has `autoDismissKey`.
- **Double-fire:** reduces double-fire by preventing the same stale prompt from re-emitting after `onInputSent()` clears normal dedup.
- **Races:** if pane content changes before the next tick, the cache clears and the prompt can re-arm. If `sendKey` fails, no cache entry is recorded.
- **Feedback loops:** no persistent feedback loop. State is per-process and per-session.

---

## 6. External surfaces

Visible behavior changes for agents using PromptGate: repeated auto-dismiss log lines for the same unchanged stale prompt should stop. No API, config, persistent state, migration, Telegram route, dashboard route, or model behavior changes. The server log still records the original auto-dismiss with `sent=true/false`.

---

## 7. Rollback cost

Rollback is a pure code revert and patch release. No state migration or cleanup is needed because dismiss memory is in-memory only. During rollback, the prior repeated auto-dismiss behavior can return for stale terminal captures.

---

## Conclusion

The fix is narrow and tied to the observed failure: successful deterministic auto-dismisses now get a memory layer that survives the normal input reset and is invalidated by real pane-content changes. Focused tests cover successful suppression, failed-send retry, and re-arm on content change.

---

## Second-pass review

**Reviewer:** instar-codey self-review
**Independent read of the artifact:** concur

I re-read the change as a PromptGate/session-input reviewer. The main risk was suppressing a real prompt after a failed key send; recording only when `sendKey` returns true addresses that. The other risk was never re-arming; clearing on captured content change and cleanup bounds the memory.

---

## Evidence pointers

- Focused unit gate: `npx vitest run tests/unit/PromptGate.test.ts` — 62 tests passed.
- Regression cases added: successful auto-dismiss suppresses unchanged stale pane text; failed send does not suppress; changed pane content re-arms.
