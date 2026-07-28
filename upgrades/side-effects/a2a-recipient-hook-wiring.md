# Side-Effects Review — a2a recipient hook + TelegramAdapter wiring (PR 3b)

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Fix 2b "Implementation surface"
items 3 + the recipient routing flow + Codey's round-2 anti-loop discipline. PR 3 part b.
**Change:** Wire the agent-to-agent Telegram comms receiver into the TelegramAdapter
dispatch pipeline as a **pre-dispatch hook** (not a wrapper around an external handler).
**Files:** `src/messaging/TelegramAdapter.ts` (additive: new field + setter + insertion
point in the text-dispatch path), `src/messaging/installAgentMessageHook.ts` (new
production binding that composes decideRoute + ledger + processed-id store + role-handler
map into the hook closure), `tests/unit/messaging/installAgentMessageHook.test.ts` (new —
end-to-end hook closure tests + adapter wiring-integrity).

## Design correction (honesty up-front)

The spec's PR-3b text described "wrap at server.ts:~3038." Reading the code revealed
that's the TelegramAdapter *construction* line — there's no `telegram.onMessage(handler)`
registration there or anywhere in the main dispatch (the only caller of
`telegram.onMessage(...)` codebase-wide is `TelegramConfirmationTransport.ts:109`, a small
provider). Telegram message handling is internal to TelegramAdapter — dispatch happens
inside `poll()`'s per-update processing. The cleaner integration was a dedicated
`agentMessageHook` field that the adapter calls **before** the existing
`onTopicMessage`/`this.handler` dispatch in the text path (other message types can't
carry the `[a2a:…]` marker, so they bypass entirely). One insertion point, minimally
invasive.

## What changed

1. **TelegramAdapter** (`src/messaging/TelegramAdapter.ts`):
   - New exported types: `AgentMessageHookInput`, `AgentMessageHook`.
   - New private field `agentMessageHook?: AgentMessageHook` + public setter
     `setAgentMessageHook(hook | undefined)`.
   - In the text-dispatch path (after the Prompt Gate, before `onTopicMessage` —
     i.e. AFTER auth + sentinel + prompt-gate, BEFORE normal user routing), the adapter
     calls the hook if set. On `{handled:true}` → return (skip normal dispatch). On
     `{handled:false}` → continue. On hook error → log + fall through (a broken hook
     must NOT freeze the message pipeline).
2. **installAgentMessageHook** (new — production hook composer):
   - Builds an `AgentMessageHook` closure from injected `{config, ledger, processedIds,
     roleHandlers}`.
   - Calls `decideRoute(ctx, config, {isProcessed, knownRole})`.
   - On `fall-through` → returns `{handled:false}` + writes NO row (user messages don't
     flood the audit).
   - On `drop` → writes a `ReceiveAuditRow` with the drop reason + returns `{handled:true}`.
   - On `route` → marks the id processed **before** invoking the handler (so a handler
     crash mid-process still dedups the retry — at-least-once delivery / exactly-once
     attempted processing), writes a `decision:'routed'` row, then awaits the role
     handler. A handler error is logged but does not unmark the id (retrying would just
     re-fail; Stage-B can see the routed row + the absent downstream effect).

## The seven questions

1. **Over-block.** The hook only fires on TEXT messages with the field set + falls through
   on `no-marker`. Other message types bypass entirely. The dispatch order (after
   sentinel + prompt-gate) preserves priority for emergency-stop and active prompt-gate
   collection.
2. **Under-block.** The hook NEVER falls through on a marker-shaped message — it always
   routes or drops (security event). The user-spoof defense (round-2 adversarial F1) is
   inherited from `decideRoute`. Idempotency on receive: `processedIds.markProcessed` runs
   before the handler so a retry can't double-invoke.
3. **Level-of-abstraction fit.** Hook field on the adapter; composer module owns the
   policy; pure routing logic stays in `decideRoute` (PR 1). Three layers, single
   responsibility each, fully injectable for tests.
4. **Signal vs authority.** `decideRoute` is the routing authority (unchanged from PR 1);
   the hook is its actuator + audit writer + idempotency boundary.
5. **Interactions — THE risk, and how it's bounded.** This touches Echo's primary message
   dispatch in TelegramAdapter (the channel to the user). The change is dark-by-default:
   the hook field starts undefined → the new code path is `if (this.agentMessageHook && ...)`
   which is a no-op until something calls `setAgentMessageHook`. No production wiring
   does that yet — the mentor consumer (PR 3c) will. Hook errors fall through to normal
   flow (log + continue), so even a broken hook can't freeze user messages. The existing
   Telegram suites (71 + 25 + 8 + 3 + 7 = 114 tests) pass unchanged.
6. **External surfaces.** None new in this PR. The wiring module exports
   `buildAgentMessageHook` for PR 3c (or any future consumer) to call.
7. **Rollback cost.** Trivial — revert removes the additive field, setter, hook composer.
   Dispatch loop returns to identical-to-pre-PR behavior (no field set → no code path
   touched).

## Testing

7 new unit tests in `installAgentMessageHook.test.ts`, all green:
- **fall-through**: non-marker user message → `{handled:false}` + NO audit row (don't
  flood the ledger with every user message).
- **route**: valid marker + registered role-handler → handler called with the parsed
  message + topic id; `decision:'routed'` audit row written; id marked processed.
- **idempotency**: re-delivered marker (same id) → dropped with reason
  `agent-marker-duplicate`; handler NOT called a second time.
- **spoof defense**: human-typed marker (`senderIsBot:false`, no `sender_chat`) → dropped
  with `agent-marker-spoofed-by-user`; handler NOT called.
- **unknown-role**: marker with no registered handler → dropped with
  `agent-marker-unknown-role`; never falls through to user flow.
- **handler error**: a role-handler that throws → logged, hook returns `{handled:true}`,
  id stays marked (no infinite retry on a broken handler).
- **TelegramAdapter wiring-integrity**: `setAgentMessageHook` accepts a hook + sets the
  field; setting `undefined` clears it.

Plus the 36 existing a2a tests (PRs 1, 2a, 2b, 3a) — 43 a2a-related tests in total, all
green. `tsc --noEmit` clean.

## Migration parity

None — additive: no caller invokes `setAgentMessageHook` yet (PR 3c will). No config
consumed, no routes, no agent-installed file changes.
