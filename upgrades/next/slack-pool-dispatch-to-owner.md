## What Changed

Extended the **WS1.1 dispatch-to-owner** machinery (Multi-Machine Session Pool) from Telegram to **Slack**, so a Slack conversation follows the user across machines. Previously the Slack adapter's inbound channel→session dispatch was LOCAL-ONLY: a Slack message bound a channel to whatever local session was already running and reused it, IGNORING pool ownership. A live multi-machine test surfaced the bug — a Slack channel's topic was transferred to a peer machine (`POST /pool/transfer` 200, ownership converged `reason:pinned`), but the NEXT Slack message in that channel was still injected into the already-running LOCAL session instead of being routed to the owner machine. Telegram's inbound path already followed a transfer; Slack's never did.

The fix routes Slack inbound through the SAME §L4 `SessionRouter` authority Telegram uses. The Slack `onMessage` handler now consults `_sessionRouter.route()` on the Slack routing key BEFORE local dispatch and short-circuits when `isRemotelyHandled` says the owner is a remote peer (it also honors the custody-ACK short-circuit so a durably-queued message isn't double-handled). The existing Slack dispatch body was extracted into a shared `slackInboundDispatch(message)` function so the live inbound path AND the owner-side mesh bridge replay through one code path (Structure > Willpower — they can't drift). A new pure module `src/core/SlackForwardBridge.ts` (`isSlackSessionKey` / `parseSlackRoutingKey` / `reconstructSlackMessage`) lets the owner-side `onAccepted` bridge distinguish a Slack routing key (non-numeric string `C…`/`C…:thread_ts`) from a Telegram topic key (pure number) and reconstruct the forwarded inbound Message. The whole feature is gated on the existing `_sessionPoolStage() !== 'dark'` — no new config key, route, or authority.

audience: agent-only
maturity: stable

## What to Tell Your User

Nothing to announce proactively — the multi-machine session pool ships dark by default, so for any single-machine agent (and any agent that hasn't enabled the pool) nothing changes; the Slack inbound path is byte-identical to before. If asked: when you run the agent on more than one machine with the session pool enabled and you move a Slack conversation to another machine, the next Slack message in that channel now correctly goes to the machine that owns the conversation, instead of being answered by the stale session on the old machine. This is the same "follow the user across machines" behavior Telegram already had, now working for Slack.

## Summary of New Capabilities

No standalone new capability and no new config key — this completes the existing dispatch-to-owner capability for a second platform (Slack), behind the already-shipped `multiMachine.sessionPool` dark gate.

## Evidence

Observed before/after for the live multi-machine repro that surfaced the bug:

- **Before:** A Slack channel's topic was transferred/pinned to a peer machine (Mac Mini): `POST /pool/transfer` returned 200 and ownership converged (`reason:pinned`, `pendingReplacement:false`). The NEXT Slack message in that channel was STILL injected into the already-running LOCAL (Laptop) session — never routed to the owner machine. Laptop `logs/server.log` showed the message dispatched locally with no `[session-pool] slack route` line, because the Slack `onMessage` handler never consulted the SessionRouter at all. Telegram's inbound path under the identical scenario correctly forwarded to the owner.
- **After:** The Slack `onMessage` handler logs `[session-pool] slack route key=<C…> → action=forwarded owner=<peer> … acked=true` and short-circuits local dispatch (`… handled by owner … — not dispatching locally`); the owner machine's `onAccepted` bridge logs `[session-pool] owner-side Slack dispatch for forwarded key <C…>` and resumes/spawns the conversation there. The forwarded message is deduped on the owner's ledger (a redelivery ACKs `duplicate` and is not re-dispatched).
- **Reproduced in test, not just unit-passing:** `tests/integration/session-router-dispatch.test.ts` drives a Slack-shaped routing key (`C0123ABCD:1716200000.001500`) through the real MeshRpc transport and asserts `action: 'forwarded', owner: 'OWNER'` with the owner's ledger recording it exactly once. `tests/e2e/session-pool-delivermessage-e2e.test.ts` posts a signed forwarded Slack-keyed `deliverMessage` to a real `/mesh/rpc` route and asserts the owner-side bridge dispatches it to Slack with the right channel + thread + sender, while a numeric Telegram key routes to the Telegram path and a redelivery is deduped (`slackDispatched` length stays 1).
