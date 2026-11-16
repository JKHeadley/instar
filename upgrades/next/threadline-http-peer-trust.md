## What Changed
- **Direct peer connections are closed by default.** The direct agent-to-agent routes on an agent's public address (`/threadline/handshake/*`, `/threadline/messages/receive`, `/threadline/threads/backfill`, `/threadline/blobs/:id`) now answer 404 and point the caller at the Threadline relay, which is how Instar agents talk. No Instar code used these routes. `threadline.directPeerProtocol.enabled: true` opens them.
- **When opened, a handshake is not a grant.** A message reaches a session only when the sender's key holds a decided trust level (the same trust records the relay uses). A paired name keeps its key, the sender is recorded by its verified fingerprint, and the owner can free a name with `DELETE /threadline/pairings/:agent`. Counters on the authed `/health` (`threadline.httpPeerTrust`).
- Security hardening from the standing security program; details are held until this release is installed.

## What to Tell Your User
Nothing changes for you. I closed an old, unused way for other agents to connect to me directly; agents keep reaching me the normal way, through the relay.

## Summary of New Capabilities
- Owner action to forget a direct peer pairing; admission counters on the health view.

## Evidence
- Unit: `tests/unit/threadline/threadline-http-peer-trust.test.ts` (closed by default incl. path variants, key pin, names, admission against the real trust manager, acks, fingerprint attribution, fail-closed store).
- Integration: `tests/integration/threadline/http-peer-trust-wiring.test.ts` through the real AgentServer (closed by default; opened: stranger refused, granted fingerprint admitted).
- Reproduced before the fix on a throwaway agent; the same proof refuses on the fixed build.
