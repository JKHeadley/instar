<!-- bump: patch -->
## What Changed

Signed pool reads (a session list, a transcript, pool history) ask another machine over the signed mesh first, and send the agent token only when that machine says it can't serve the read. Mesh answers are not signed, so a party on the network path could forge that answer to get the token sent (SEC-114, active form).

Each machine now remembers the highest version it has ever seen for each of its peers. The record is persisted, machine-local and never lowered. Once a peer has been seen at 1.3.1740 or later, the fallback to it is refused whatever the answer says. A refusal is counted (`fallbacksRefused` on `GET /pool/signed-reads`) and reported as a degradation, at most once per machine and kind of read per 15 minutes.

This is an interim mitigation that raises the cost of the attack. The full fix is signed mesh answers.

## What to Tell Your User

Nothing to do. One way someone on your network could have tricked your agent's computers into sending each other the agent's master key is now closed off. If one of your computers ever has a real problem answering, you'll see a notice saying so, instead of the key being sent.

## Summary of New Capabilities

- The signed-read bearer fallback is refused for any peer ever seen at a version that serves the read.
- `GET /pool/signed-reads` counts refused fallbacks.

## Evidence

New unit cases in `tests/unit/sec114-signed-read-forced-fallback.test.ts`:
- the version boundary;
- a forged `no-handler` refused, while an older peer still falls back;
- a remembered "needs the token" ignored for a known-new peer;
- timeouts never fall back;
- the version floor only rises and survives a restart;
- every route caller passes the floor.

A new integration case drives the refusal through the real transcript route. An independent second pass concurred.
