# Side-Effects Review — pairing invite approver wording and refusal receipts

**Version / slug:** `pairing-approver-refusal-receipts`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `one independent code review: concurred on the code, raised two documentation concerns (send-failure partial effect; update parity). Both were corrected and the same independent reviewer concurred in a follow-up (actual Opus 5.5, successful result, 5 turns). The reviewer ran no tests.`
**Tracking:** feedback `fb-9566b1d3-f4d`, topic 9210 (larger enrollment / pending-invite resume work, NOT implemented here)

## Summary of the change

A user forwarded a pairing invite to a receiving agent. It refused with "this agent hasn't been told who its owner is", then the lifeline posted "✓ Delivered". "Owner" meant the human who approves connections for the receiving agent, not the owner the inviting agent claims; and the tick made a refused invite look delivered.

1. `src/threadline/PairingInviteTelegram.ts`: `NO_OWNER_REFUSAL` / `NOT_OWNER_REFUSAL` reworded to the receiving agent's approver role ("approve new connections for me"). No name or id, and the no-approver line no longer claims the setting is absent (it may be ambiguous or invalid). `onForwardedInvite` now returns a discriminated `ForwardedInviteResult` that mirrors its existing three branches: `refused` (operator check refused), `invalid` (engine rejected the invite), each with `refused: true`; `awaiting-approval` (Approve/Decline posted) with `refused: false`. The type makes an awaiting-approval result with `refused: true` (or the reverse) impossible.
2. `src/server/routes.ts` (`/internal/telegram-forward`, invite branch): the response stays `200 { ok: true, pairingInvite: true }` and adds `refused: true` unless the handler reported `awaiting-approval`. No handler (pairing off) and a thrown error both stay refused. The invite is still consumed before the sentinel, log, session and topic memory.
3. `src/messaging/TelegramAdapter.ts`: `PollingPairingHandler.onForwardedInvite` return type `Promise<void>` → `Promise<void | { refused: boolean }>` so `PairingInviteTelegram` can still be passed straight to `setPairingHandler`. A wrapper in routes was considered and rejected: it would change handler identity and add code for no behavior gain. The polling adapter ignores the value; this is a return type only, no authority.

The lifeline consumer is unchanged and already in this base: `readForwardRefused` reads `refused: true` from an accepted forward, `forwardToServer` stores it in `ack.refused`, and the text, photo, document and replay paths skip "✓ Delivered" when it is set.

Size: Tier 1, small. Source: about 28 lines added, 9 removed across 3 files. Effort: small.

## Decision-point inventory

- Who may approve (`resolveApprovalOwner`, `operatorTap` order, callbacks, approval, crypto, expiry, topic routing, own-agent preauth): **unchanged**.
- Whether the lifeline posts "✓ Delivered" for a forwarded invite: now follows the existing pairing decision through the existing `refused` field.

## 1. Over-block

A valid invite waiting for Approve/Decline is never marked refused, so its tick still appears. No message is newly blocked: the invite was already consumed in every path.

Partial effect on a send failure: if `receiveInvite` succeeds and then sending the Approve/Decline prompt throws, the engine's pending accept (plus the invite's topic mapping and minted button tokens) can remain until the invite expires. The route still answers `200` consumed with `refused: true`, which only withholds the misleading positive transport receipt ("✓ Delivered"). It is **not** a denial and nothing is rolled back; no new decline, cleanup or permission action is taken, and the invite must not be resent or replayed automatically (it is not: it is consumed). The integration case asserts this partial effect (`fx.flow` is `['receive']`). The user sees neither prompt nor tick. Dashboard handling of this partially accepted invite has not been verified.

## 2. Under-block

An older lifeline that ignores `refused` still shows the tick (unchanged behavior). The polling path (no lifeline) never posted a tick, so it is unaffected. The larger gap (no way to enroll an approver and resume the invite) remains open and tracked.

## 3. Level-of-abstraction fit

The decision is reported by the component that made it (`onForwardedInvite`), carried by the route that already owns the forward response, and read by the lifeline's existing decoder. No new check, endpoint, flag or config.

## 4. Signal vs authority compliance

No new authority. The existing pairing decision stays the only authority; this change only reports its outcome so the UI stops contradicting it. No detector gained blocking power (`docs/signal-vs-authority.md`).

## 4b. Judgment-point check

None added. The result mirrors deterministic branches that already existed.

## 5. Interactions

- Lifeline `readForwardRefused` / `ack.refused` / three guarded "✓ Delivered" sites and replay: reused as is (structural test `tests/unit/lifeline/refused-forward-no-delivered.test.ts` passes).
- Send failure after `receiveInvite`: engine-side pending state is left as is until expiry (see §1); `refused: true` is receipt-only.
- Invite secrecy: response body carries no invite text or error string; the existing `catch` still keeps it consumed. No new catch, no new silent-fallback exemption, no logging of the invite or the exception.
- Polling adapter: ignores the new return value.

## 6. External surfaces

User-visible: two reworded Telegram lines; "✓ Delivered" no longer follows a turned-away invite. Internal HTTP: optional `refused: true` on the invite branch of `/internal/telegram-forward`, a field the lifeline already understands. No new route, config key or template.

## 7. Multi-machine posture

Machine-local; nothing is replicated or stored. Server and lifeline run on the same machine but do **not** necessarily restart together: `AutoUpdater` signals a lifeline restart only when an update crosses a major.minor boundary (`crossesBreaking`); a patch update restarts the server, not necessarily a running lifeline. The receipt fix needs the current compiled server plus a running listener that has `readForwardRefused` (introduced in 753857c0e, #3064, first tag v1.3.1731, confirmed against local tags). An older running listener keeps the previous tick until its normal controlled restart. The wording change needs only the server. Live rollout must verify the actual running server and lifeline versions. This patch adds no updater, migration or restart code and performs no live restart.

## 8. Rollback cost

Revert the commit. No persisted data, permission, pairing decision or config to repair.

## Tests (actual status)

- Unit, run: `tests/unit/threadline/PairingInviteTelegram.test.ts` red on the old runtime (8 failed, 35 passed, exit 1), green with the change. Focused run of 4 unit files (PairingInviteTelegram, -notices, lifeline refused-forward-no-delivered, pairing-invite-never-persisted): 67 passed, exit 0. After the union/type tightening: `no-silent-fallbacks`, `PairingInviteTelegram` and `refused-forward-no-delivered` unit files, 53 passed, exit 0.
- TypeScript: `tsc --noEmit` exit 0 (both the npx compiler and `typescript-native`).
- Integration, written, **NOT RUN** here: `tests/integration/pairing-invite-telegram-routes.test.ts` gains a real-HTTP block (listening server, real fetch `Response`, the real `readForwardRefused`): valid approver not refused; unknown approver, wrong approver, unusable invite, pairing off, and a throwing send all refused; always 200, invite secret absent from the response, sessions and log; no error text in the response.
- E2E production path, written, **NOT RUN** here: `tests/e2e/threadline/pairing-handshake-production-path.test.ts` adds a case on the real `bootstrapThreadline` engine: unusable invite → `invalid`, valid → `awaiting-approval` (not refused, not connected), stranger → `refused` with the new wording. This tier drives `PairingInviteTelegram` directly (as the existing file does), not the HTTP route.
- Full suite: NOT RUN (owned by the primary session's official verification).
- Live validation on a real lifeline + server pair: NOT done. Needed before claiming rollout.

## Agent awareness and update parity

No CLAUDE.md template change: no new capability, endpoint or command; the agent's pairing instructions stay correct. No migration: product code changes no installed config default, hook, template or skill. Existing agents receive the server change through the normal compiled package update; the receipt part also depends on the running listener being v1.3.1731 or later (see §7). Approver enrollment and pending-invite resume remain TRACKED (fb-9566b1d3-f4d, topic 9210), not implemented.

## Proportion and validation record

- Source: small, Tier 1, no spec review cycle.
- Builder: two invocations. The first stopped at its 26-turn cap without completing; a same-context continuation finished in 13 turns, during which 3 build stop-hook prompts were left for the primary session (no completion claimed).
- Review: one independent code review (code concurred; the two documentation concerns are addressed here). 0 commit attempts.
- Test counts are per run and overlap; they are not additive: old runtime 8 failed / 35 passed; 4 focused unit files 67 passed; 3 overlapping unit files including the no-silent-fallbacks guard 53 passed; native compiler exit 0. The sendThrows `fx.flow` assertion was added after those runs and has not been run yet.
- HTTP integration and E2E cases: written, NOT RUN. Full suite: NOT RUN. Live validation: NOT RUN.

Independent review closure: `.instar/state/build/pairing-ux-review-followup-result.json`, session 86e1ef9d-cd1f-4d18-9e02-1d7824d2499f, success/is_error false, CONCUR. Runtime and unit/E2E hashes remained unchanged; the integration partial-effect assertion and documentation were reviewed. After review the primary removed the unverified dashboard recovery promise from this artifact and the release fragment, and recorded this closure. No runtime edits or extra design round.

Build/startup verification (21:27Z): normal `npm run build` exit0; official `node dist/cli.js test-as-self --no-roundtrip` exit0, six steps PASS. Disposable port4041 had no remaining listener/process/launchd/tmux after teardown. No tracked build-generated edits; frozen nine-file hashes matched before/after. Actual native Opus result success/is_error:false, 9 turns. No bot or lifeline was started: this verifies package deploy/startup/crash checks, not invite delivery or receipt behavior. Targeted HTTP/E2E and full final-head verification remain pending.

Targeted HTTP verification (21:38Z): `npx vitest run --config vitest.integration.config.ts tests/integration/pairing-invite-telegram-routes.test.ts` exit0, 24 tests passed. Full log and terminal end/exit metadata retained; total952.50seconds included the ordinary suite-slot wait, actual tests337ms. This executes the partial-effect assertion added after the unit runs. It uses real HTTP routes and the listener receipt decoder with a stub engine seam. The separate production-bootstrap E2E file is queued normally; full final-head verification and live listener/agent delivery remain pending.
