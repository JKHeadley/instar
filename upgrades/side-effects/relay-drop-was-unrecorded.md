# Side-Effects Review — a relay that dropped left "connected" as the last word

**Version / slug:** `relay-drop-was-unrecorded`
**Date:** `2026-07-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `see Phase 5`

## Summary of the change

`RelayClient` emits two connection-loss events: `disconnected` (socket close, client
retries with backoff) and `displaced` (another connection claimed this identity —
**terminal**, because `case 'displaced': shouldReconnect = false` disarms retry for
the life of the process). `ThreadlineBootstrap` subscribed to `message`,
`unknown-sender` and `auto-discovered` — and to **neither** loss event. Verified by
grep: both return empty in that file. Only `listener-daemon.ts` handles them.

So the server logged `Threadline: relay connected (fingerprint: …)` and could log
nothing afterwards, whatever happened.

**Observed (2026-07-26, topic 29723).** The agent could not send to peer
`instar-codey`; two send paths refused with `Relay not connected and local delivery
unavailable`. The peer's own server reported `ready:true, relay.connected:true`,
listening since 2026-07-25 — the peer was fine. This agent reported
`ready:false, relay.connected:false`, while its last written word on the subject was
`relay connected` at 18:21:27Z, with no disconnect line anywhere.

**The property that makes this worth fixing rather than noting: the defect conceals
its own cause.** `displaced` would fully explain why exponential backoff never
recovered the connection. Whether a `displaced` frame arrived is **unknowable**,
because nothing recorded it. The absence of evidence is produced by the defect.
`ThreadlineBootstrap` itself documents a known "displacement race" between the
server's client and the standalone listener daemon — a candidate, **not asserted**.

This change RECORDS transitions. It does not reconnect and does not alter client
behaviour. That ordering is deliberate and is a correction to my own first plan
("reconnect, then observe"): a reconnect fix built first would have been
unverifiable, because there would be no way to see whether it held.

## Decision-point inventory

| point | classification | note |
|---|---|---|
| `disconnected` → record, non-terminal | `invariant` | Deterministic event subscription. |
| `displaced` → record, terminal + error-level | `invariant` | Same. `terminal` is stored explicitly rather than inferred, because "will retry" vs "will never retry" is the distinction a reader needs and they are otherwise identical. |
| reason string clamped to 300 chars | `invariant` | The reason originates off-machine; it is treated as untrusted text, never structured data. |
| audit-write failure swallowed | `invariant` | An observer must not throw out of a handler on the path it observes. |

No judgment points. No model call. Nothing gates or blocks.

## 1. Over-block

Nothing is blocked. The observer only appends and logs; it cannot refuse a
connection, a send, or a message. The strongest available failure is noise in the
log if the relay flaps — which is information, not a block, and is the signal a
future reconnect fix will be judged against.

## 2. Under-block

**It does not fix the outage.** The relay is still down as of writing, and this
change does not reconnect it. Restarting the server restores the connection; that is
unchanged and untouched.

**It does not identify tonight's cause.** That evidence was destroyed before it
existed. The honest claim is narrower than it looks: the *next* occurrence becomes
diagnosable, this one does not become explicable.

**It observes only the server's client.** The MCP server and the listener daemon each
construct their own client. The daemon already handles both events; the MCP path is
untouched and remains unobserved. Recorded, not silently deferred.

**A record that is never read is only half of observability.** This writes a durable
JSONL and exposes the latest event through the bootstrap result. Surfacing it on
`/threadline/status` is the obvious next step and is deliberately not bundled — this
PR's refusal evidence is about recording, and mixing a route change in would blur it.

## 3. Level-of-abstraction fit

A pure-ish module (`fs` only), below the bootstrap, testable with a fake
`EventEmitter` and no socket. The bootstrap owns wiring; the module owns recording.

**A smarter component already exists and was consulted, not duplicated.**
`listener-daemon.ts` handles both events and writes `listener-displaced-alert.json` —
a single-slot file. This deliberately appends instead: a one-slot file cannot show a
flapping connection, which is exactly the shape a reconnect bug takes.

## 4. Signal vs authority compliance

Pure signal. It records and logs; it holds no authority over anything. It cannot
block a send, refuse a connection, or influence reconnection. `docs/signal-vs-authority.md`
is satisfied trivially — there is no decision to misplace.

The one risk an observer can carry is taking down what it watches. That is closed by
swallowing audit-write failures, asserted by a test.

## 4b. Judgment-point check (Judgment Within Floors standard)

None introduced. Every branch is a deterministic event subscription.

## 5. Interactions

- **`listener-daemon.ts`** — already handles both events independently; unchanged.
  Its single-slot alert file is left alone; this is a second, additive record.
- **`ThreadlineClient` / `RelayClient`** — unchanged. No new emissions, no altered
  reconnect behaviour, no change to `shouldReconnect`.
- **The daemon-handles-relay branch** — when the daemon owns the relay, the server
  never connects and the observer is never attached. Correct: nothing to observe.
- **`/threadline/status`** — unchanged in this PR (see §2).

## 6. External surfaces

One new durable file, `logs/threadline-relay-events.jsonl`, and one optional field on
the bootstrap result. No route, no config key, no CLI flag, no message to any user.

**Content:** timestamps, event names, this agent's own fingerprint, and a clamped
reason string from the relay. No message bodies, no peer content.

## 6b. Operator-surface quality

Two new log lines. The displacement line is error-level and states the consequence in
plain terms — that retry is disarmed and the agent cannot send or receive until
restart — rather than naming the event and leaving the reader to infer what it means.
The disconnect line is calm and says a retry is coming. That difference is the entire
point; a reader must be able to tell "wait" from "this is over".

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. Each machine observes its own relay client and writes its own
record; a relay connection is per-process and cannot be reasoned about remotely. No
replication, no lease interaction, no shared state, no generated URL.

## 8. Rollback cost

Low. Delete the module, remove one import, one declaration, one call, one optional
result field. No migration, no persisted state anyone reads yet, no config default,
nothing installed into an agent home. The test would fail on revert, announcing it.

## Phase 5 — Second-pass review

The change touches the session/dispatch family only in the sense that it observes it;
it holds no authority, gates nothing, and cannot alter connection behaviour, so the
high-risk trigger list (block/allow decisions, session lifecycle, trust) is not
engaged. Author-applied lenses, disclosed:

**Adversarial — "how would I make this useless?"** By recording to a single slot (a
flap would overwrite itself) or by letting a write failure kill the handler. Both are
closed and asserted by tests.

**"Did I fix the symptom or the cause?"** Neither — deliberately. This fixes the
*blindness*, which is a precondition for diagnosing the cause. Stated plainly in §2
rather than implied.

**"Would it have caught the incident?"** It would have recorded the transition and,
if a displacement occurred, said so at error level with the consequence spelled out.
It would not have prevented it.

**Weakest point:** §2's last item. A durable record that no status surface reads is
observability only for someone who knows the file exists. I judged the route change
worth separating to keep this PR's refusal evidence unambiguous, but a reader could
reasonably call that half a job — which is why it is written down here rather than
left for them to notice.
