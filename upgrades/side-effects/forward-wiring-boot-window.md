# Side effects: wait for forward-to-holder wiring at boot

## Change
`TelegramAdapter` gains `holderForwardReady`, a promise the server arms right after
constructing the adapter on a machine whose registry lists a second unrevoked machine.
`sendToTopic` and `resolveTopicName` wait for it (at most 30 s) while
`holderForwardPolicy` is still unset. The server resolves it once the policy and
`outboundRelay` are wired.

Evidence: the Mama PC (v1.3.1569/1571) held automatic notices at 07:09Z and 09:14:45Z
on 2026-11-01. Its 09:14 boot was at 09:14:33Z, so the sends came ~12 s after boot,
before the wiring at the end of the session-pool block ran. Without a policy the
adapter answered `local`, `authorize` refused (not the lease holder) and the direct
hold is never replayed on a standby.

1. **Over-block** — none. Sends are delayed, never refused. Single-machine agents
   never arm the wait.
2. **Under-block** — a send that reaches the API through another path than
   `sendToTopic` (e.g. raw `apiCall` callers) is not covered. If wiring never
   arrives the send proceeds after 30 s on the old path.
3. **Level-of-abstraction fit** — the adapter already owns the route decision; the
   wait sits where the missing policy was read.
4. **Signal vs authority** — no new decision authority; it only defers the existing one.
5. **Interactions** — boot-time notices on paired machines are up to ~30 s later.
   Gate/tone checks are unchanged (they run in the same path after the wait).
6. **External surfaces** — none beyond delivery timing.
7. **Multi-machine posture** — this is the multi-machine fix; machine-local by design.
8. **Rollback cost** — revert the commit; no state.
