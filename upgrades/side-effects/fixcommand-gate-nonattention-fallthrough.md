# Side-Effects Review — Scope the fix-command gate to the Agent Attention topic

**Version / slug:** `fixcommand-gate-nonattention-fallthrough`
**Date:** `2026-06-09`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `independent reviewer subagent — concurred`

## Summary of the change

The emergency "fix command" gate in `wireTelegramRouting` (`src/commands/server.ts`) intercepted any inbound Telegram message whose text started with `restart`, `fix `, or `clean ` in **every** topic, dispatched it to `handleFixCommand`, and unconditionally `return`ed. But `handleFixCommand` only executes in the Agent Attention topic (`topicId === state.get('agent-attention-topic')`) and returns `false` everywhere else — so in a non-attention topic the gate sent the user an "I didn't recognize that command" help list **and swallowed the message** (it never reached the session). This change introduces a pure, exported helper `shouldInterceptFixCommand(text, topicId, attentionTopicId)` that returns true only when the message is in the Agent Attention topic and matches a fix verb. `wireTelegramRouting` gains a late-bound `getAttentionTopicId?: () => number | null | undefined` parameter; both call sites pass `() => state.get<number>('agent-attention-topic')`. The gate now fires only when `shouldInterceptFixCommand(...)` is true; otherwise the message falls through to normal session routing. Files: `src/commands/server.ts` (helper + signature + gate + 2 call sites), `tests/unit/fix-command-routing.test.ts` (new).

## Decision-point inventory

- `wireTelegramRouting` fix-command gate (`src/commands/server.ts`, inbound Telegram dispatch) — **modify** — the gate that decides whether a message is handled as a server-side fix command (and swallowed) vs routed to the session. Previously gated on a topic-agnostic verb test; now gated on `shouldInterceptFixCommand` which additionally requires the Agent Attention topic.
- `handleFixCommand`'s internal attention-topic guard (lines ~186) — **pass-through (kept)** — retained as defense-in-depth; it still returns `false` outside the attention topic, so even if the gate ever fired in the wrong topic nothing would execute.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

This change strictly *reduces* blocking. Before: any message starting with `restart`/`fix `/`clean ` in a non-attention topic was swallowed (over-blocked). After: those messages route to the session. Inside the Agent Attention topic the behavior is unchanged. There is no new input that is now rejected that previously was accepted — the change can only let *more* messages through. So: no new over-block introduced; an existing over-block (the core bug) is removed.

---

## 2. Under-block

**What failure modes does this still miss?**

Within the Agent Attention topic, the verb test is still a brittle prefix match (`startsWith('restart')`, etc.). A user in the Attention topic typing a non-command sentence that happens to start with "restart"/"fix "/"clean " (e.g. "restart the build") will still get the "I didn't recognize that command" help instead of being treated as chat. This is unchanged from before and is acceptable: the Attention topic is a control surface for tapping notifications, not a general chat thread, and `handleFixCommand` already only acts on the exact known commands. We are deliberately not widening or narrowing the in-attention-topic verb matching in this change (single-responsibility: fix the topic-scoping bug only). No tracked deferral — the in-topic verb matching is correct for its purpose, not an omission.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The routing decision belongs exactly where the gate sits — at the inbound message dispatch in `wireTelegramRouting`, before session routing. The change extracts the *decision* into a pure function (`shouldInterceptFixCommand`) at the same layer, which is the right altitude: it is a cheap, deterministic predicate, not a reasoning task, and it now consumes the same `agent-attention-topic` state that `handleFixCommand` already used as its own guard — so the gate and the handler now agree on the same authority (the attention topic) instead of the gate being topic-blind. No higher-level (LLM) gate is warranted: "is this the attention topic and a known verb" is objective.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no NEW block/allow surface; it *narrows* an existing brittle authority so it no longer over-reaches.

The fix-command gate is a brittle (prefix-match) detector that holds blocking authority (it swallows the message). Per the signal-vs-authority principle, a brittle detector must not over-extend its blocking authority. This change does the principle-compliant thing: it constrains that brittle authority to the one topic where the action is actually valid (the Agent Attention control topic), and removes its authority everywhere else (fall through to session). It does not add new brittle blocking authority; it shrinks existing brittle blocking authority to its legitimate scope. No reshaping needed.

---

## 5. Interactions

- **Shadowing:** The gate runs after the slash-command handler and the threadline hub-command intercept, and before the pipeline/session routing. Previously it *shadowed* session routing for any restart/fix/clean-prefixed message in every topic. After this change it only shadows session routing in the Agent Attention topic — which is correct, since fix commands there are not meant to spawn a session. No other check is newly shadowed.
- **Double-fire:** No. The gate `return`s on intercept (only in the attention topic now), so a message is either handled as a fix command OR routed to the session, never both. `handleFixCommand`'s own attention guard prevents double execution even if the gate condition were wrong.
- **Races:** The new param is a synchronous getter over `StateManager.get` (the same in-memory/JSON state the rest of routing reads). No new shared mutable state is introduced; `getAttentionTopicId` only reads.
- **Feedback loops:** None. The predicate reads state and returns a boolean; it feeds nothing back.

---

## 6. External surfaces

- **Other agents / users:** This is instar source shipped to the whole install base. User-visible effect is strictly positive: messages starting with restart/fix/clean now reach the session in normal topics. The "I didn't recognize that command" reply will no longer appear in non-attention topics (it remains in the Attention topic for genuinely unknown commands).
- **External systems:** No change to Telegram API usage, payloads, or the fix-command actions themselves (restart/clean/etc. behave identically when invoked in the Attention topic).
- **Persistent state:** None. No new state keys, ledgers, or migrations. Reads the existing `agent-attention-topic` key only.
- **Timing/runtime:** If `agent-attention-topic` isn't set yet (early boot), the getter returns null/undefined and the gate simply doesn't intercept — messages route to the session. Safe direction.

---

## 7. Rollback cost

Pure code change, no persistent state, no migration. Back-out = revert the commit and ship the next patch; behavior returns to the prior (buggy) state with no cleanup. No agent-state repair, no data migration. During the rollback window users would simply see the old swallow-and-bounce behavior again. Low rollback cost.

## Conclusion

The review confirms this is a scope-narrowing fix to a brittle blocking authority: it removes an over-block (the core bug — messages swallowed in non-attention topics) and adds no new blocking surface. The decision is extracted into a pure, fully unit-tested predicate, and the gate now agrees with the handler's own attention-topic guard. No design changes were required by the review. Because the change touches inbound message dispatch, a Phase-5 second-pass review is required before commit.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose)
**Independent read of the artifact: concur**

Concur with the review. The reviewer independently verified: (1) the boundary — `shouldInterceptFixCommand` returns false for null/undefined attention topic and for any non-attention topic, true only in the attention topic with a matching verb, and the verb clause is byte-identical to the old inline test (no in-topic regression); (2) BOTH `wireTelegramRouting` call sites (server.ts:4062-4066 send-only and 4203-4207 full) pass the `() => state.get<number>('agent-attention-topic')` resolver — no path left on old behavior; (3) no new swallow/double-fire — the gate `return`s only on intercept, normal routing sits immediately below, and `handleFixCommand`'s internal attention guard is harmless redundant defense; (4) signal-vs-authority — strictly narrows existing brittle blocking authority, adds no new block surface. Additional checks: `wireWhatsAppRouting` has no parallel fix-command gate (no missed surface); the stuck-message replay path re-injects through the same handler so it inherits the corrected boundary; existing test callers omit the new optional arg safely (null-safe getter). One non-blocking observation: new coverage is unit-only (the pure predicate, both sides) — proportionate since this adds no API route or DI component; wiring verified correct by inspection.

---

## Evidence pointers

- Live reproduction: 2026-06-09, topic 21624 — user typed `restart sessions`, received the "I didn't recognize that command" help list (which advertised "restart sessions"), and the text never appeared in the session's tmux pane.
- Tests: `tests/unit/fix-command-routing.test.ts` (17 tests, both sides of the boundary). `tsc --noEmit` clean; 364 unit tests across the 38 files importing `commands/server` green.
