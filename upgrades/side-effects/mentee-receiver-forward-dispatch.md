# Side-Effects Review — mentee receiver wiring fires on lifeline-forward path

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Recipient side.
Fast-follow to PR #462 (mentee receiver wiring) — closes the dual-path
ingress gap surfaced by dogfood.

**Change:** Three production files + three test files.
- `src/messaging/TelegramAdapter.ts` (+ ~55 LoC: `dispatchAgentMessageHook`
  public method; polling text-dispatch now calls it instead of inlining the
  hook logic — pure extraction, no behavior change on the polling path)
- `src/server/routes.ts` (+ ~20 LoC: destructure `senderIsBot` /
  `senderChatId` / `senderBotId` from forward body; invoke
  `dispatchAgentMessageHook` before `onTopicMessage`; short-circuit on
  `handled:true`)
- `src/lifeline/TelegramLifeline.ts` (+ ~15 LoC: derive + include
  `senderIsBot`/`senderChatId`/`senderBotId` in the forward body)
- `tests/unit/TelegramAdapter-dispatchAgentMessageHook.test.ts` (new, 8)
- `tests/integration/telegram-forward-a2a-dispatch.test.ts` (new, 3)

## What changed

1. **`dispatchAgentMessageHook` public method** on `TelegramAdapter`:
   wraps the existing hook invocation with the FAIL-OPEN try/catch (a
   broken hook never freezes the dispatch loop) and the senderBotId
   derivation logic (sender_chat wins; rawFromId iff senderIsBot;
   undefined for real users). Polling path now calls the dispatcher
   instead of inlining the same code — pure extraction.
2. **`/internal/telegram-forward` handler** destructures the new spoof-
   defense fields from the request body. Before invoking `onTopicMessage`,
   calls `dispatchAgentMessageHook`. On `handled:true`, returns
   `{ ok: true, forwarded: true, agentMessage: true }` (NEW response shape
   addition — additive, doesn't change the existing `{ ok, forwarded }`
   contract for non-a2a forwards). On hook throw, logs + falls through
   (same fail-open semantics as the polling path).
3. **`TelegramLifeline.forwardToServer`** derives `senderIsBot` from
   `rawMsg.from.is_bot === true`, `senderChatId` from
   `rawMsg.sender_chat?.id`, `senderBotId` from `senderChatId ?? (isBot ?
   rawMsg.from.id : undefined)`. Includes them in the buildBody output
   only when they have values (omitted fields → server treats as falsy →
   marker-bearing forwards drop closed for spoof defense).

## The seven questions

1. **Over-block.** N/A — additive. The forward route now invokes the hook
   before `onTopicMessage`; if no hook is installed (or no adapter has
   `dispatchAgentMessageHook`), the route falls through to the existing
   behavior. Backward-compatible test (`preserves existing behavior when
   the adapter has NO dispatchAgentMessageHook`) covers this.
2. **Under-block.** Spoof defense is end-to-end on the forwarded path:
   missing `senderIsBot` from older lifelines → server treats as falsy →
   any marker drops as `agent-marker-spoofed-by-user`. This is the
   fail-CLOSED side, matching spec invariant.
3. **Level-of-abstraction fit.** Extraction-then-reuse: the hook
   invocation logic moves from inlined to a method on the adapter, called
   from both polling and forward paths. No new abstraction; just exposes
   what was already there.
4. **Signal vs authority.** The dispatcher returns a clean boolean to the
   caller; the caller decides whether to short-circuit. Authority lives in
   the caller (route or polling loop), not in the dispatcher. Same as the
   prior inline version.
5. **Interactions.** Reuses `agentMessageHook` set by `setAgentMessageHook`
   — no new state. The forward route reads three new optional fields from
   the body; older clients (lifeline pre-this-PR) omit them and get the
   fail-CLOSED spoof defense automatically.
6. **External surfaces.** The `/internal/telegram-forward` response gains
   one additive flag (`agentMessage: true`) when the hook claims the
   message; the existing `{ ok, forwarded }` contract is preserved
   otherwise. No new routes. No new config.
7. **Rollback cost.** Trivial — revert restores the inline hook call in
   the polling path, drops the dispatcher and the forward-route call,
   drops the lifeline body additions. The new `agentMessage:true` flag is
   an additive response field, so any consumer relying on it would need a
   one-line fix back to checking `forwarded:true` alone.

## Testing

11 new tests, all green (`tsc --noEmit` clean):

- **Tier 1 unit (8):** `TelegramAdapter-dispatchAgentMessageHook` covers
  no-op safe (no hook), handled:true short-circuit, handled:false
  fall-through, FAIL-OPEN on hook throw, three senderBotId derivation
  modes (sender_chat / rawFromId+isBot / undefined for users), explicit
  override.
- **Tier 2 integration (3):** `telegram-forward-a2a-dispatch` boots
  `createRoutes` with a mock adapter through the real Express pipeline;
  asserts short-circuit when hook claims, fall-through when not,
  backward-compat when adapter lacks the method.
- **Tier 3 E2E:** the existing `mentee-receiver-lifecycle.test.ts` from
  PR #462 (which installs the hook end-to-end on server boot) plus the
  live dogfood loop that motivated this PR are the lifecycle proof.

## Migration parity

No config changes; no new config keys. The lifeline-side change is
deployed via the same npm release as the server-side change, so the
mixed-version state is only momentary (server upgrades alongside its
lifeline via the existing AutoUpdater + LifelineDriftPromoter pair).
Mixed-version safety is preserved either direction (server new / lifeline
old: spoof-fail-closed; server old / lifeline new: unknown fields ignored).
