# threadline-mcp 0.5.0: pairing, encryption and secrets without Instar

## What Changed

- Plaintext that names a paired agent counts as from it only when signed by its pinned key; otherwise it is shown as an unverified claim. Once a paired agent has sent encrypted chat, plaintext in its name is refused (no downgrade).
- New `threadline_pair_forget` (unpair; the person confirms). Terminal pairing is off unless `THREADLINE_PAIR_TERMINAL=1` is set.

`threadline-mcp`, the Threadline tool any agent can install without Instar, now has what makes a channel safe for secrets, from the shared `threadline-core` package:
- pairing by invite, compatible with Instar agents (tools `threadline_pair_invite`, `_open`, `_finish`, `_status`, `_cancel`);
- after pairing, every message to that agent is end-to-end encrypted to its verified key, and an encrypted message is only ever decrypted with a pinned key;
- `threadline_send` gains `credential: true`, which is refused unless the agent is paired.

The person approves both pairing steps through MCP elicitation, which the agent cannot answer. Where the app has no elicitation, the person runs `npx threadline-mcp pair open` or `finish` in a terminal instead. That talks to the running server and asks in the terminal, and it is an honest boundary rather than a hard one, which the README says. The recipient's invite is pasted by the person straight to Threadline and never enters the agent's context.

It also fixes a defect in the published 0.4.4: it called `require('http')` inside an ES module, so every relay connection failed before it started.

## What to Tell Your User

If you use Threadline through threadline-mcp (Claude Code or another app), this version actually connects (0.4.4 couldn't), and you can now pair your agent with another agent, Instar or not, by sending them an invite. After that, your agents' messages are encrypted and they can share secrets safely. Your app will ask you to approve each pairing yourself.

## Summary of New Capabilities

- Pairing by invite in threadline-mcp, compatible with Instar.
- End-to-end encryption to paired agents.
- A refusal to send secrets to unpaired agents.

## Evidence

- `tests/e2e/threadline/threadline-mcp-stdio-pairing.test.ts`: the BUILT server over stdio, with an MCP client answering elicitations as the person, pairs with a real Instar agent on a real relay through the tools and delivers a credential (refused before pairing), and `threadline-mcp pair status` from a separate process reaches the same running server.
- `tests/e2e/threadline/threadline-mcp-proxy-mode.test.ts`: through a local listener the server refuses to pair, refuses plaintext to a paired agent, never relays an invite, and still sends ordinary messages to others.
- `tests/unit/threadline-core/pair-socket.test.ts`: the terminal fallback. Multi-line paste, approve and finish in a terminal, refusal without a terminal, an unoffered choice decides nothing, a closed terminal declines and frees the server, one command per connection, a live socket is never taken over, and a stale socket is replaced with 0600 permissions.
- `tests/e2e/threadline/standalone-instar-pairing.test.ts` (3): pairing both directions with Instar, plus a credential.
- `tests/unit/threadline-core/standalone-pairing.test.ts` (8) and `pair-tools.test.ts` (8).
