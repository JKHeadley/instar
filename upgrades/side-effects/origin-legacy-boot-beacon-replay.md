# Side-effects review: a reply refused by the boot beacon is replayable

## Change
`src/messaging/telegram-origin/OriginLegacy.ts` (`snapshotLegacyOrigin`): a legacy queue row whose only refusal is HTTP 503 with the exact boot-beacon body (`{"status":"warming","phase":"booting"}`, two keys, nothing else) now counts as definite non-delivery, alongside 401 and 404. Before, any 5xx made the row `replaySafe: false`, so the origin import marked it `delivered-ambiguous` / `outcome-unknown` and it was never sent.

`BootHealthBeacon` answers every non-health request with that body before `AgentServer` listens. No reply handler, tone gate or Telegram call can run behind it, so the 503 proves the message never left.

## 1. Over-block
None. The change only widens which rows may be replayed.

## 2. Under-block
The row stores only the latest response body, so a row with several attempts is replayable only if every earlier attempt was 401/404 and the last one is the beacon 503. A row that met the beacon on an earlier attempt and something else later stays uncertain (safe direction).

## 3. Level-of-abstraction fit
The replay decision already lives in `snapshotLegacyOrigin`; this adds one evidence class there. Correct layer.

## 4. Signal vs authority
This is an authority (it decides whether a held message may be sent). It is deterministic and narrow: an exact two-key body match from our own loopback beacon. A replayed row still goes through `reviewLegacyRecovery` (the tone gate) and the normal origin dispatch, content dedup and budget, so no outbound check is skipped.

## 5. Interactions
Replay uses the row's original `preparedAt`, so the existing 6-hour deadline still applies. Content dedup prevents a duplicate if an identical message was sent meanwhile. A lookalike body (extra keys, other values) or the beacon body with another status code stays uncertain (tested).

## 6. External surfaces
Messages the agent sent while its server was restarting are now delivered after the restart instead of being silently dropped. The relay script already printed "Queued for recovery" for them.

## 7. Multi-machine posture
Each machine imports its own legacy queue; the beacon is per process on loopback. Machine-local by design.

## 8. Rollback cost
Revert the commit. Rows already replayed were delivered; nothing to repair.

## Evidence
On the Studio, three progress messages sent to topic 127504 between 19:16:40 and 19:18:11 UTC on 2026-11-02, during a server restart, have `http_code 503`, `error_body {"status":"warming","phase":"booting"}`, and are now `delivered-ambiguous` / `outcome-unknown` with no attempt. Over the past week, 161 sends ended expired with no attempt at all.

## Second-pass review
Concur with the review. BootHealthBeacon is the only producer of the body; the beacon releases the port before AgentServer listens, so a request it answers never reached a reply handler. The one near-miss is a standby relaying the lease holder's refusal verbatim (`relayedFromHolder: true`), which the exact two-key match rejects; a test now pins that body. Multi-attempt rows cannot qualify in practice (retries add history entries without a 401/404 code). A replay still passes content dedup and the legacy tone review.
