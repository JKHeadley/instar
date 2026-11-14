## What Changed
- **The dashboard's reply box no longer clears text it cannot confirm.** The console used to clear a typed message the moment the browser handed it to its socket, and never read the answer. For a session on another machine the relaying server answered for the far machine, dropped the message when its link was not up, and returned nothing, so a reply could vanish silently (F5 in `docs/specs/native-conversation-any-machine-access.md`). Now every message carries a random `clientInputId`, and the box clears only when the machine running the session acknowledges that exact id, however late. An acknowledgement with no id or another id clears nothing.
- **The serving machine says what it can do, first.** On every subscribe the server sends `input_caps` (`inputAck: 2`, and whether it accepts input from another machine). The relay forwards it, keeps the last one per session and replays it to a tab that opens the session later. An older serving machine sends no such frame; the relay then says `inputAck: 1` for it. Until the answer arrives the box reads "Connecting to that machine…". If that machine has remote input switched off, the box is read-only with the reason before anything is typed.
- **Never typed twice.** The serving machine records each `(session, clientInputId)` before it writes to the terminal and answers a repeat with the original acknowledgement, without writing again, whichever connection the repeat came in on. A retry is flagged; a flagged retry whose id the machine does not know (it restarted, or the id was one of more than 256 newer ones) is refused `input-retry-unknown` and not typed. "Send again" is offered only where the machine recognises a repeat.
- **The answer goes to the sender.** The relay remembers which browser tab sent each id and passes that answer to that tab alone, and answers `peer-stream-lost` with the id when it could not send.
- **An unconfirmed message is shown honestly, and the session is asked.** After 8 s with no answer the message moves above the box as "Not confirmed yet", with Send again (where safe), Copy and Discard. Once per message the dashboard types one fixed `[dashboard] …` line into the session naming the id and the time, so the session tells the user in the conversation whether it received it. The person is never asked to check anything. Against an older serving machine the message is unresolved at once, with no send control.
- **Keys only report.** A key press carries an id and shows a failure, and is never kept or retried.
- **Counters.** `GET /sessions/dashboard-input-status` (bearer) → `inputIdsEvicted`, `inputRetryUnknown`, `inputIdsRepeated`, per session and in total, plus `allowRemoteInput`. No text, no ids.
- `dashboard.poolStream.allowRemoteInput` stays off by default; nothing about who may type into a session changes.

## What to Tell Your User
If you type a reply to one of my sessions from the dashboard and the dashboard cannot confirm it arrived, your text now stays on screen marked "not confirmed" instead of disappearing, and I am asked directly whether I got it, so I will tell you in the conversation. Pressing "Send again" can never make me receive the same message twice.

## Summary of New Capabilities
- Dashboard input carries `clientInputId`; acknowledgements and refusals echo it; repeats are answered without a second write.
- `input_caps` frame on every subscribe (relayed, replayed to late tabs, synthesised as `inputAck: 1` for older machines).
- `GET /sessions/dashboard-input-status` counters for the 2026-11-25 maturation check.

## Evidence
- `tests/unit/console-input-model.test.ts`: every composer state, including an id-less acknowledgement leaving the draft, a late id-carrying acknowledgement clearing it, the session line sent once and waiting for `input_caps` when the link is down.
- `tests/unit/WebSocketManager.test.ts`: id echoed on the ack and each refusal; a repeat written once, also mid-write and on a different connection; unknown flagged retry refused and counted; eviction counted; relayed frame keeps the id; ack only to its sender; `input_caps` first, synthesised for an older peer, replayed late.
- `tests/unit/PeerStreamProxy.test.ts`: relay result boolean, caps cache cleared on link drop.
- `tests/integration/dashboard-input-durability.test.ts`: two real servers; off → refused with id; on → one write for two sends; dropped link; browser socket dropped then Send again (arrived → cleared, never arrived → refused, nothing typed); older-server stub cases, including two waiting tabs.
- `tests/e2e/dashboard-input-durability-alive.test.ts`: the production AgentServer's socket and counters route (200); the shipped console over real sockets keeps the text when the socket drops before the ack.
