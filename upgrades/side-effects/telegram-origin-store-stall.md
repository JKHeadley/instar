# Side-Effects Review — Telegram origin store stall

**Version / slug:** `telegram-origin-store-stall`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** `independent general-purpose subagent; see the end of this file`

## Summary of the change

Tier 2: it touches retry pacing and, narrowly, send authority. It fixes four measured faults behind replies held for over 20 minutes on a saturated Studio. `listSessionDeliveryExceptions` is rewritten so a page takes under 0.6 s instead of 39 s. Bot API requests get their own dispatcher with a 5 s per-address connect window, up from 250 ms. A config read that only ran out of time no longer revokes the last snapshot inside its 30 s bound, and the read budget goes from 2 s to 10 s. Recovery runs every 30 s when the origin outbox owns it, with reservation pacing of 30 s, 1 m, 2 m, 5 m, then 15 m. The exception scan stays at 5 minutes.

Files: `OriginStoreBackend.ts`, `OriginConfigReader.ts`, `TelegramOriginBoot.ts`, `TelegramOriginRuntime.ts`, `TelegramOriginService.ts`, `OriginMesh.ts`, `telegram-egress.ts`, `delivery-failure-sentinel.ts`, `selfActionRegistry.ts` (the forward bound moves from 27 to 31), plus tests. Size: 9 source files, about 135 lines. Effort: see the Proportion line at the end of this file.

## Decision-point inventory

- `healthy()` / `authorize` in `TelegramOriginBoot.ts` — modify — a read timeout no longer drops a snapshot still inside its 30 s bound.
- `OriginConfigReader.read` revocation — modify — a timeout no longer bumps the revision; every other failure still does.
- `reserveRecoveryAttempt` — modify — the interval only. The eligibility SQL is untouched.
- Sentinel tick cadence — modify — 30 s when `recoverOrigin` is present.
- Claim fence, `markDispatched`, outcome recording, `allowQueuedRecovery`, `provedUnsentCode` — pass-through.

---

## 1. Over-block

The change only loosens or speeds things up. Nothing newly refused. A still-refused case: a real config failure refuses all sends at once, as before.

## 2. Under-block

- A config change that the source poller has not yet seen, during a run of read timeouts, can be acted on for up to 30 s from the last good read. Before this change that exposure was about 5 s in the common case, though the 30 s bound already existed. A change to `config.json`, the secret vault, or the master key revokes at once through the poller, so the window is limited to a change the poller also misses.
- A send can still be held for other reasons this change does not address, such as the 2 s store budget during a long retention step.
- The cause of the 2 s config reads inside the server is not measured.

## 3. Level-of-abstraction fit

Right layers. The bound belongs in the store query that caused the stall. The connect window belongs at the one Telegram door. The timeout meaning belongs with the reader that knows the difference and the consumer that holds the snapshot. Pacing stays in the durable reservation, so main and lifeline contenders share it. No second retry loop was added.

## 4. Signal vs authority compliance

Compliant (`docs/signal-vs-authority.md`). The change adds no brittle check with blocking authority. It reduces the blocking reach of a transient timing signal: a timeout was acting as a config refusal, and now it is treated as what it is, an absence of evidence, while the durable freshness bound keeps the authority.

## 5. Interactions

- Recovery ten times as often: `recoverHeld` is single-flight through `recovering`, each candidate still passes reservation and claim, and a send whose first pass is still running here is skipped. The tick's store calls measured 109-142 ms in total at load, far under the 2 s budget.
- `reviewQueuedReply` and legacy tone review run per reservation, so spend per failing operation rises from 24 to at most 28 starts in 6 hours.
- `allowQueuedRecovery` retires a reply once newer conversation overtakes it. Faster retry means fewer such retirements. That is the intended direction, and it does change which replies arrive.
- The exception scan keeps its 5-minute pace, but it now always finishes. Before, it often died at 30 s and restarted. Rows that were never reached can now raise their notice. See External surfaces.
- The stall watchdog is unchanged and should simply stop firing for this query.

## 6. External surfaces

- Readers may see a batch of "an earlier reply was late" or "may have been lost" notices once the scan stops dying. On the copy, 132 rows qualify by state, and 74 reply-delivery notices already exist; whether a specific row was already noticed could not be matched from the copy, so the true backlog is between 0 and 132. It is limited to a page of 100 rows per 5 minutes, and each notice has a stable logical send id, so none repeats.
- If the Bot API's first address silently drops packets, a send now takes up to 5 s, not 250 ms, to fall back to the next. undici's 10 s connect limit still applies. Other connections keep the default.
- Depends on host timing. Those are what the tests pin down with explicit pauses.

## 7. Multi-machine posture

Machine-local by design. The store, the reader and the sentinel are per machine, and forwarded operations keep their existing ladder. A clock disagreement between machines is why the out-of-order window has a 5-minute tolerance. Beyond 5 minutes of skew, a forwarded reply could be missed as out of order, which only loses an explanatory notice and never affects delivery.

## 8. Rollback cost

A plain revert. The added index is additive and harmless to older code. Schedule rows hold plain timestamps. No migration, no config.

---

## Proven and unproven

Measured on a copy of the live store, or in a separate process: the 39 s query and its replacement, result parity, the ETIMEDOUT mechanism and the fix for it. Through Node's `fetch` with a tokenless GET and a 400 ms pause after the connect starts: 10 of 10 failed `ETIMEDOUT` at the default window, 0 of 10 failed at 5 s, and 0 of 6 failed with a 1500 ms pause at 5 s.

Unproven until live:
- That each production ETIMEDOUT came from an event-loop pause.
- What uses the 2 s inside the server during config reads.
- The number of notices the first complete scans raise.
- The real held-reply latency on the Studio under load.

## Second-pass review

An independent reviewer read the code and ran one probe. It found no double-send path and no send without authority, and raised six concerns. All are resolved:

1. The connect window was process-wide. Fixed: a Bot API dispatcher.
2. A tick could retire a reply whose first send was still running. Fixed: recovery skips those.
3. The registered forward bound hardcoded the old schedule. Fixed: 31, with the model updated.
4. A snapshot could be used for up to about 40 s of data age. Fixed: `observedAt` counts from before the read.
5. Transport budget is spent sooner under sustained failure. Accepted, stated in the spec.
6. Notice observer budget, health wording, and boot read time. Accepted, stated in the spec.

Cross-model review (codex-cli gpt-6-astra) ran twice. Round 1 raised three items, all resolved: a measured replacement timing with a concurrent store probe, a stated limit on examined rows, and more precise attribution wording. Round 2, on the fixed code, returned minor issues, all resolved: the forward model's move from quick steps to reservations, and two wording precisions.

The independent reviewer re-read the fixes. It concurred on the dispatcher (verified on Node 24.14 through fetch, including multipart and the unsent proof), the forward bound and the age stamp, and found no stranding. It raised one more gap: a forwarded send on the holder reached the network without the first-send guard. Fixed by `runFirstSend`, used by both `sendBot` and the mesh path; this last edit has not had a further read.

Proportion: Tier 2, two review rounds, 9 source files.
