# Side-effects review — rope key-expiry mesh scoping

**Change:** the Tailscale key-expiry tier of `RopeHealthMonitor` now considers only tailnet
nodes that back a mesh rope (plus self), instead of every node on the tailnet.
`parseTailscaleStatus` gained an optional mesh-address set and a per-entry
`backsMeshRope` flag; `soonestKeyExpiry` gained `opts.meshScopedOnly`; `server.ts` supplies
the addresses from the registry's `tailscale` endpoints.

**Origin (live, 2026-08-29, topic 62395):** a tailnet node offline since 2026-08-13 with a
lapsed key was the tailnet-wide soonest expiry, so `GET /mesh/rope-health` reported
`warn: true, inDays: -16.6` continuously. Every real mesh machine's key was valid into
Dec 2026 / Feb 2027. The permanent warning was not merely noise — it was read as a live
finding and relayed to the operator as a real risk requiring their login.

## 1. Over-block — what legitimate input does this now reject?

A genuine expiry on a tailnet node that backs a mesh rope but whose address is NOT in the
registry's endpoint list — e.g. a peer reachable over tailscale that has only ever
advertised `lan`/`cloudflare`. That node's expiry would no longer warn.

Bounded by two fallbacks that both fail LOUD: an unreadable address source and an empty
address set BOTH degrade to the tailnet-wide scan. So the narrowed scope applies only when
a non-empty mesh address list is genuinely available. Self is unconditionally included.

## 2. Under-block — what does this still miss?

It does not detect a rope dropping for any reason other than key expiry (unchanged), and
it cannot warn about a mesh machine whose tailscale address this machine has never
recorded. It also does not change the two-week horizon, so a key that lapses inside one
check interval is still reported late — pre-existing, untouched.

## 3. Level-of-abstraction fit

Correct. The parser owns the scrubbed shape and is the only place that may see addresses,
so the matching belongs there; the monitor owns the policy (`meshScopedOnly`); the wiring
site owns knowledge of the registry. Putting the filter in the monitor would have required
addresses to escape the parser, breaking that file's stated content-scrub boundary.

## 4. Signal vs authority compliance

Compliant. This is a digest/status signal with no blocking authority — it gates nothing,
changes no routing, and cannot suppress a rope. It makes an existing signal more accurate.

## 5. Interactions

- The `key-expiry-warning` metric fires strictly less often (that is the fix).
- `composeDigest()` drops the permanent expiry sentence when scoped — the other digest
  sentences (per-peer conditions) are untouched.
- `TailscaleKeyExpiryEntry` gained a field; one existing unit assertion deep-equalled the
  old shape and was updated. No serialized/persisted format includes this type.
- No interaction with the U4.3 recovery prober or the resolver — the expiry tier has its
  own cadence and data source.

## 6. External surfaces

`GET /mesh/rope-health → keyExpiry.soonest` may now name a later expiry (a mesh node)
where it previously named an earlier one (an unrelated node). No shape change. The
content-scrub boundary is preserved: addresses flow INTO the parser and only a boolean
flows out — no identity, address, or account data is added to any output.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** Each machine runs its own `tailscale status` and reads its own
registry, so each scopes to the peers it knows. This is correct rather than a limitation: a
tailnet node backing a rope is a per-observer fact, and the digest is composed per machine.
No replication path added. A single-machine agent supplies an empty address list and
therefore keeps exactly today's tailnet-wide behaviour.

## 8. Rollback cost

Trivial. Remove the `meshTailscaleAddresses` dep from the `server.ts` construction and the
monitor reverts to the tailnet-wide scan by an explicitly-tested path. No persisted data,
no migration, no state repair.

## Tests

- Unit `tests/unit/tailscaleStatusParser.test.ts` (+6): flagging, mesh-scoped soonest,
  un-scoped soonest (pre-fix behaviour retained), no-set and empty-set back-compat, self
  always counts, node with no address array is not mesh-backing.
- Unit `tests/unit/RopeHealthMonitor.test.ts` (+2): the dead-node regression through the
  monitor (scoped vs un-scoped on identical input), and the throwing/empty source falling
  back to tailnet-wide rather than to a silent empty scope. Verified RED against pre-fix
  behaviour and green after.
- E2E: not applicable — no new route or feature-liveness surface; this narrows an existing
  status field already covered by the monitor's own suite.
