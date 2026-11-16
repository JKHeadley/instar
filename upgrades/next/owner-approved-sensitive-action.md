# Owner-approved sensitive actions: a Face-ID tap stands behind an irreversible delete (ships dark)

## What Changed

The security program found a class of Threadline MCP handlers (starting with the irreversible `threadline_delete`) that treated *any* same-machine caller as the owner — so a sensitive, unrecoverable action could be taken with no human decision. A same-machine session is not proof of the owner's intent.

This change adds the **owner-approved-sensitive-action** primitive (`src/server/OwnerApprovedActionStore.ts`, `src/server/PendingApprovalRegistry.ts`, four `/mobile/action-approval` routes in `src/server/mobileOwnerPresenceRoutes.ts`, and the `threadline_delete` gate in `src/threadline/ThreadlineMCPServer.ts`, wired through `src/commands/server.ts` so the phone routes and the MCP handler share one store). When enabled, a gated action no longer trusts "same machine" — it requires a **device-signed owner approval**: a Face-ID-gated key on the owner's phone signs a single-use challenge that commits to the exact action (`{purpose, actionKey}`), verified by the existing owner-presence mechanism. The `isLocal` signal is demoted from authority to a hint. It reuses the owner-presence authenticator already in the product — it is not a new credential.

Ships **dark**: `security.ownerApprovedActions.enabled` defaults false, and with it off every path behaves exactly as today (byte-identical). It is turned on only after a live phone-tap proof.

## What to Tell Your User

Nothing changes yet — this ships switched off. When it is turned on (after we have proven it end-to-end), deleting a Threadline conversation, and other sensitive actions as they are added, will show one plain card on your phone — "Delete the conversation 'X'?" — that you approve with a single Face-ID tap on any phone you've enrolled. It restores what was always meant to be true: these decisions are yours to make, not something a program on your machine can do on its own. There is no single-device lockout — any enrolled phone can approve.

## Summary of New Capabilities

- `OwnerApprovedActionStore` (single-use, TTL, revision-bound approvals) + `PendingApprovalRegistry` (server-written card text) + four owner-presence-gated `/mobile/action-approval` routes (challenge / approve / pending / decline).
- `threadline_delete` requires a device-signed owner approval when `security.ownerApprovedActions.enabled` is true; dark default is byte-identical.
- The owner-presence signing message gains two purposes (`thread-delete`, `trust-grant`), each binding the exact action so one tap can never authorize a different one.

## Evidence

16 unit tests green (approval store incl. a wrong-revision DoS guard, the pending registry, and the exact signed-byte contract the phone apps sign); an e2e "feature is alive" test (routes mounted + dark-safe: 503 not 404 when off, the owner-presence gate refuses when on without an enrolled phone); 0 type errors; all 54 lint steps green through the real gate. Design converged across 4 rounds (5 internal reviewers + GPT cross-model ×4); spec `docs/specs/owner-approved-sensitive-action.md` (converged + approved). The live phone-tap proof and the stdio-MCP-path gate are pre-flip gates, tracked before the switch is ever flipped.
