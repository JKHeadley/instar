# Side-effects review: Conversations transfer, coverage and privacy fixes

Tier 2. About 350 paths on the feature branch, nearly all carried from the reviewed checkpoint; today's own changes touch about 20 files. Effort: three independent review rounds on today's changes, one commit attempt so far. Conversations stays off by default; nothing here enables it.

## Summary

- Privacy: held private views register descendants before exposure; a held proof that observes invalidity closes and releases its views; a held-only row cannot leave through the generic exporters.
- Coverage: the source inventory worker names this machine by its real id when the flat layer says `local`; checkpoints publish on change plus an hourly heartbeat, not every minute.
- Speed: fsync is skipped for files this process already flushed and that are unchanged; proven signature checks are reused; the readiness pass joins an in-flight pass and skips records already reconciled or settled.
- Streams: row metadata frames are released after use; the status poll tolerates an unreachable peer for up to 120 seconds.

## 1. Over-block

The generic exporters now refuse while a live held-only row exists, which fails tail-close on that member and refuses later stages at Transfer:145. No runtime has paged wiring yet, so this is not reachable today; it must be resolved when that wiring lands. Otherwise no issue identified.

## 2. Under-block

A catalog removed before a cold start leaves no trace for the export check. A dead producer now goes unflagged for up to 3 hours instead of 3 minutes. Coarse-timestamp filesystems could in theory hide a same-size rewrite within one tick from the flush memo; lease files are replaced with new inodes, and directory creates always flush.

## 3. Level-of-abstraction fit

The flush memo and signature memo are small shared helpers at the lowest layer, so every caller keeps its checks unchanged. Trust checks, readbacks and byte comparisons still run; only repeated flushes and repeated pure crypto are skipped.

## 4. Signal vs authority compliance

No new blocking authority from brittle logic. The export refusal follows validated signed catalogs and fails closed. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

The flush memo bypasses repeat fsyncs that an existing test asserted; that test now asserts a fresh file still propagates a fault and that a repeat does not flush. The readiness skip keeps the member-loss repair gate by calling it before the skip.

## 6. External surfaces

No change to anything other agents or users see while Conversations is off. With it on, the false "Some original history is unavailable" clears after the first checkpoint when native conversations are on. It stays partial when native conversations are off, so graph read must ship coupled to them.

## 6b. Operator-surface quality

Checked on a real CLI server in headless Chromium at 320, 390 and 1280 wide.

1. Leads with the primary action: yes. "Create effort" and search are on the first screen of "Your efforts", with Overview and All as tabs.
2. Zero raw internals as primary content: yes. The screen shows effort titles and short labels. An untitled effort reads "Untitled".
3. Destructive actions de-emphasized: yes by design and earlier browser walkthroughs; name removal sits under More, behind its own step. Not rechecked on the real server in this change.
4. Plain language and phone width: yes. No sideways scroll at 320 or 390. One known gap: "Some original history is unavailable." offers no action while it shows, which is for about a minute on a fresh install. Light theme is not rechecked on the real server.

Raw Telegram send baseline: one entry added for `TelegramAdapter#handleCommand`. It answers the owner's own `/conversations` in their private chat, only after the authorized-sender check, and sends a fixed pointer. It is a direct reply, not a notification.

## 7. Multi-machine posture

Replicated: checkpoints and records travel by the existing graph replication. The memos are per-process and machine-local by design; a restart starts empty and flushes again.

## 8. Rollback cost

Feature is off by default, so a revert of this branch suffices. No migration. Checkpoints already written stay readable.

## Class-Closure Declaration

- `unbounded-self-action`: closure guard, citing `tests/unit/self-action-convergence.test.ts`. The checkpoint publish and the status poll are registered as `graph-source-sweep-checkpoint-retry` and `graph-source-status-poll-retry` and use the real decision functions. The readiness and bootstrap ticks only reconcile on a fixed timer, are single-flight and emit no restart, kill or notice; they are not modeled in the registry.

## Evidence

- Privacy suite failed 4/4 before the fixes and passed 4/4 after.
- 65 x 1 MiB signed peer transfer passed in place on the M5 in 398 s against its 600 s limit, once. Studio runs under load 20 to 30 passed once at 802 s with a raised limit and otherwise hit the limit.
- Regression: 63 tests across unit and integration files, then 63 across the slower peer and member-loss files. Those ran before the signature memo; afterwards 62 focused tests passed, plus the M5 run. Temporary unit copies were used for most integration files.
- Real CLI server rendered at 320, 390 and 1280 wide; warning cleared after the first checkpoint and no new files appeared over a following minute.

## Not established

Full suite on this head. Merge with latest main. Real member join. Native chat and media schema proof. Light theme and naming flows on the rendered dashboard.

## Second-pass review

Fresh Claude reviewers, read-only, same model family. Concur on all items after follow-ups; findings fixed were descriptor in the memo key, member-loss gate before the skip, flush on directory create, memo size, membership in the inventory hash, descriptor stamp in the flush helper. Reviewer did not review the signature memo.
