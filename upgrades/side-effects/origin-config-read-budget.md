# Side-Effects Review — origin config read budget 10 s → 25 s, two state reads synchronous

**Version / slug:** `origin-config-read-budget`
**Date:** `2026-11-18`
**Author:** `Echo (echo-graph-event-loop-blocks, topic 144559)`
**Second-pass reviewer:** `independent general-purpose subagent — concur`

## Summary of the change

Tier 1 (tuning; a revert fully undoes it). 3 files, about 15 changed lines. `OriginConfigReader` read budget 10 000 → 25 000 ms. `TelegramOriginBoot` refresh reads `state/agent-attention-topic.json` and `state/topic-profiles.json` with `readFileSync` instead of `fs/promises.readFile`. Test asserting the default budget updated.

Cause: on the Studio (2026-11-18 00:46-01:12Z) 32 `origin-config-reader-timeout` lines and held Telegram replies, with no single >8 s event-loop freeze logged. The read's real work is ~60 ms; it is ~6 event-loop hops (stat, readFile, vault stat, worker message, worker terminate), and under back-to-back 2-5 s graph tasks each hop waits behind one, so reads ran past 10 s. Two consecutive timeouts age the snapshot past `SNAPSHOT_FRESH_MS` (30 s) and sends hold.

Effort: one review round, one commit attempt.

## Decision-point inventory

- Origin send admission (`healthy()` in `TelegramOriginBoot`: snapshot present, same revision, ≤ 30 s since `observedAt`) — pass-through — unchanged; it now receives fresh snapshots more often under load.
- `OriginConfigReader` timeout — modify — the bound on one pending read grows from 10 s to 25 s.

---

## 1. Over-block

This reduces over-block: reads that would have succeeded in 10-25 s are no longer discarded, so fewer sends are held for "snapshot stale".

## 2. Under-block

No new under-block. Freshness is still `now - observedAt ≤ 30 s`, with `observedAt` taken before the bytes are read, so a slower read can never yield an older snapshot than before. Real refusals (changed token, missing chat, unreadable or malformed file) still null the snapshot at once. The source poller still revokes on any change to `config.json`, the secrets vault or the master key, independent of reads. A read that hangs entirely now holds the single read slot for 25 s instead of 10 s; during that time sends rely on the last snapshot's 30 s bound, exactly as with a 10 s timeout followed by a retry.

## 3. Level-of-abstraction fit

The budget is the right knob for "how long one read may take". The underlying cause (long event-loop tasks in conversation-graph revalidation) is fixed in a separate PR (graph-revalidate-single-pass); this change keeps replies flowing on any busy host, which is a correct property on its own (the budget was already raised once, 2 s → 10 s, for a saturated host on 2026-11-05).

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow logic; it changes a timeout, not a decision rule.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The budget is a resource bound on one pending read.

## 5. Interactions

`OriginNoticePolicyObserver` and `OriginDetectorCanary` share `OriginConfigReader`; both call `read()` and tolerate timeouts. With a longer budget their calls share the same pending read for longer (the reader already dedupes to one pending read). The detector canary's bounded re-observation loop retries on failure; a longer read means fewer, longer attempts. Synchronous reads of two small local files (`agent-attention-topic.json` is a single number; `topic-profiles.json` is ~34 KB on the Studio) cost well under a millisecond and avoid four threadpool hops each; no test mocks these reads.

## 6. External surfaces

No route, config, or message change. Log lines unchanged. Users see fewer held replies.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine's origin layer reads its own config and secrets. Nothing replicated. No status surfaces changed.

## 8. Rollback cost

Revert and ship a patch. No state.

## Conclusion

Ship as Tier 1.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (read-only), 2026-11-18 01:20Z
**Independent read of the artifact: concur**

Concur with the review. `observedAt` is taken before any bytes are read (OriginConfigReader.ts:124) and admission requires `now - observedAt <= 30 s` plus a matching revision (TelegramOriginBoot.ts:169), so a 25 s read can only yield an older snapshot, never a fresher-looking one. Revocation paths are unchanged (non-timeout failure invalidates, mid-read change refuses, resolved-secret digest change invalidates, source poller revokes independently). The single-pending-read rule is intact. Synchronous reads keep the same error mapping (ENOENT ignored, other codes and parse errors become OriginSnapshotRefusal). Other consumers race the read against their own shorter deadlines (OriginNoticePolicyObserver 2 s, detector canary 6 s), so they are unaffected. Minor, pre-existing: the source poller does not watch the two state files; changes to them are picked up on the next refresh, as before.

## Evidence pointers

- Live log lines: `[telegram-origin] config snapshot unavailable: origin-config-reader-timeout` (32 between 00:46 and 01:12Z on 2026-11-18).
- Off-server timing under load 34: `security find-generic-password` 30-40 ms; worker online 12-14 ms; merge 48-55 ms.
- Tests: `tests/unit/telegram-origin/config-reader.test.ts`, `tests/unit/telegram-origin/notice-policy-observer.test.ts` — 15 passed.
