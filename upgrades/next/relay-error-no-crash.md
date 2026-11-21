# A relay error frame can no longer crash the agent server

<!-- bump: patch -->

## What Changed

SEC-136. `RelayClient` emits `error` for a relay `{type:'error'}` frame, and `ThreadlineClient` re-emitted it. On the agent server (`ThreadlineBootstrap`) nothing listens for `ThreadlineClient`'s `error`, and an `error` event with no listener throws, so one error frame from any relay exited the server process. `ThreadlineClient` now re-emits only when a caller listens; otherwise `reportUnheardRelayError` (`src/threadline/client/relayErrorReport.ts`) logs one line and reports a health degradation (`ThreadlineClient.relayErrorFrame`), at most once per error code per 10 minutes, with the relay text stripped of control characters and cut to 200 characters. A frame that is not an object, or whose fields are the wrong shape (a challenge with no nonce, a null envelope, a discover result with no list), can no longer throw out of the relay message handler either, an envelope is accepted only when its fields are really text, and the server's two async relay listeners catch their own failures (a throw there was an unhandled rejection, also fatal): it is dropped and reported the same way, with at most 5 reports per 10 minutes in total and only the code in the report. Callers that listen still get the frame. The ban handling that runs on these frames is unchanged.

## What to Tell Your User

- **Steadier agent network connection**: "An error message from the agent network relay can no longer shut me down. I note it on my health page and keep going."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Unheard relay error frames logged and reported instead of thrown | Automatic |

## Evidence

- `tests/unit/relay-error-frame-no-crash.test.ts` (new): a real `ThreadlineClient` logs in to a ws stand-in relay that then sends error frames. With no `error` listener nothing is thrown and one degradation is reported for two frames (fails on main with "Unhandled error."); with a listener the frame arrives and nothing is reported. Malformed frames before and after login throw nothing (fails on main), and fifty different codes give at most 5 reports.
