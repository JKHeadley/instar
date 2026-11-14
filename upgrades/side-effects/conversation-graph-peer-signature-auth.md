# Side effects: peers authenticate by machine signature, and the graph says why it is waiting

## What changed

A real two-machine run found that Conversations could not commit across machines on a normally paired agent.

- **Peer route.** `/internal/conversation-graph-bootstrap/message` required a bearer equal to `config.authToken`. That token is per-machine on a normal fleet, so every peer call got 401 and changes stayed "recorded here" with no reason shown. Echo's machines happen to share one token and every test used one fixed value, so nothing caught it. The check is removed. Every message is signed by a signed member's machine key and verified in `receive()`.
- **Token no longer sent.** Peers no longer send an Authorization header, which also stops a machine handing its own API token to a peer.
- **`bootstrapBearer` option removed** from `ConversationGraphDefault`.
- **Reasons in the log.** Each is logged only when it changes, and only as a fixed-format code: why the graph is not open, a peer refusal, a failed delivery, a peer check, the local history check, the readiness step, and background sync. Startup also names which prerequisite is missing.

Test updates: three tests assumed a newly paired machine withholds reads. They now prove that it does not, and that losing a signed member does.

## Decision point

Yes: who may call this route. Authority moves to the existing signature check, which is not brittle. Nothing new gains blocking authority.

## Review

1. **Over-block:** none. This removes a refusal that was wrong.
2. **Under-block:** see the second-pass review.
3. **Level of abstraction:** signature checking stays in `receive()`, the one place every action goes through.
4. **Signal vs authority:** the log lines are signals only and change no behaviour.
5. **Interactions:** the sibling `/internal/conversation-graph` route keeps its sealed peer bearer.
6. **External surfaces:** the route accepts unauthenticated requests up to the signature check. Logs gain new lines.
7. **Multi-machine posture:** this is the fix that makes it multi-machine on ordinary fleets.
8. **Rollback cost:** revert. No data changes.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. This change adds no new trigger. The existing sync tick only logs a fixed-format reason when that reason changes, bounded by a single stored value.

## Prerequisites found, not changed

A graph across machines needs `multiMachine.coherenceJournal.enabled` with replication and `multiMachine.writeAdmission.enabled`. Write admission is on by default only for development agents. Without them the startup log now names what is missing. This belongs in the release note.

## Evidence

Studio and M5 throwaway agents over a real network, with different API tokens: pairing, one graph, both signed, both report ready. A change committing across them is **not yet proven**; see below. 13 tests pass, including a new one that no Authorization header is sent and a forged signature gets 403, and the real CLI boot.

## Not established

A change committing across two real machines. At this commit, on the throwaway pair, the change stays queued after both reported ready, and the M5 flaps with `graph-peer-unavailable`.

## Second-pass review

One fresh Claude reviewer, read-only, nothing run. The signature check holds: no path changes graph state without a valid signature, and replay is no worse than before. Findings:

- The route is mounted before the auth middleware, so it is publicly reachable, including through a tunnel. Peers can use a tunnel, so this stays. The signature is now the only gate.
- Unsigned requests cost disk and signature work. Malformed requests and a bad signature from a known sender are now refused before graph state is read. **Remaining:** a frontier request naming an unknown sender still costs one lineage read, needed so a removed member can get negative evidence.
- The log line took a request-supplied value. It now logs only allowlisted actions and at most 64 distinct lines.
- **Not fixed here:** `conversationGraphHistoryRoutes.ts:82` sends the local API token to a peer for Slack sources. On a per-machine token that should return 401, and it hands the token over. Tracked in CMT-1437.

These fixes have not had a further read.
