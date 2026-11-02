# Side-effects review: an unreadable config is "unknown", not "missing"

Tier 1. 5 runtime/test files plus artifacts, about 120 lines. One review round.

## Change
1. `TelegramOriginBoot.ts`: the 5-second config refresh used to end in `catch { snapshot = null }`. The snapshot then fed `toWireParams` with `issuesChatId: undefined`, so a failed read surfaced as `IssuesChatNotConfiguredError` ("this process has no messaging config issuesChatId"). Now, with no snapshot, an issues-topic send throws `OriginConfigUnavailableError(reason)` instead, and the sender-display check throws the same error when the snapshot is stale. The refresh records a bounded, secret-free reason code and logs it once per change (and on recovery). `refresh()` itself is unchanged in what it accepts.
2. `types.ts`: new `OriginConfigUnavailableError` (retryable, `reason`). Its message is still exactly `origin-display-authority-unavailable`, so existing string matchers keep working.
3. `routes.ts` (`POST /telegram/reply` catch): this error now answers `503 {error:'origin-config-unavailable', reason, retryable:true, message}` instead of a generic 500.
4. `OriginLegacy.ts`: `snapshotLegacyOrigin` treats two exact bodies on the latest attempt as definite non-delivery, the same way PR 2596 does for the boot beacon: that 503 body, and the 500 body `{"error":"issues-chat-not-configured: topic N belongs to the issues group…"}`. It also accepts the bare 500 `{"error":"origin-display-authority-unavailable"}` that earlier releases returned when config could not be read; that text is thrown only by display resolution inside `prepareBot`. All of these are thrown while a send is being prepared, before admission and before any network call.

## 1. Over-block
None added. A send that was refused before is still refused while config is unreadable; only the reason and status change. Main-group protection is unchanged: with no snapshot an issues topic is never translated to the main chat, and `authorize()` still requires a healthy snapshot.

## 2. Under-block
The underlying stall on a busy machine is not fixed here (see Interactions). Sends during a stall still wait; they are now retried instead of lost. A row with several attempts qualifies only if every earlier attempt was 401/404 (the table keeps only the latest body), which is the safe direction.

## 3. Level-of-abstraction fit
The misreport was produced where the snapshot is built, so it is fixed there; the HTTP mapping lives in the existing reply-route catch; the replay proof lives in the existing replay check. No new layer.

## 4. Signal vs authority
The replay check is an authority (it lets a held message be sent). It is deterministic and narrow: exact bodies from our own reply route, exact key sets, a 1 KiB cap, and a body relayed from another machine (`relayedFromHolder`) is rejected (tested). Replayed rows still pass the legacy tone review, content dedup and the original 6-hour deadline.

## 5. Interactions
- PR 2596 edits the same lines of `snapshotLegacyOrigin` (boot-beacon 503). The two compose: both are "latest attempt carries an exact pre-dispatch body". Whichever lands second rebases into one helper.
- The relay script already queues any 5xx ("Queued for recovery"), so the new 503 needs no script change.
- The stalls behind this (server event loop blocked for 10–30 s, then the lifeline restarting it after 60 s unresponsive) are a separate problem and are reported separately.

## 6. External surfaces
`POST /telegram/reply` returns 503 with a new error code for this case instead of 500. Callers that treat 5xx as retryable (the relay script) behave as before. Messages refused this way are now delivered later instead of silently dropped.

## 7. Multi-machine posture
Machine-local by design: each process reads its own config and imports its own queue. This matters most on standbys, which send through the lease holder but prepare locally.

## 8. Rollback cost
Revert the commit. Rows already replayed were delivered once; nothing to repair.

## Second-pass review
Concur with the review. Both refusals are raised in `prepareBot` (wireParams, then display) before admission. Every failure after dispatch is a `TelegramOriginHoldError`, and the adapter does not fall back to a second send. There is no partial multi-chunk send, because chunks are children of one sealed operation built after translation. A holder's relayed refusal carries `relayedFromHolder`, which fails the exact key check. The relay script stores the body untruncated (the 1024 cap applies only to the event payload), and both bodies are well under 1 KiB; an oversized body fails safe. `OriginConfigUnavailableError` is matched by `instanceof` only in the reply route; every other caller matches the unchanged message. Main-group protection is intact. Logged reasons are fixed codes only. The integration test's wait was lengthened so a loaded machine does not make it flaky.
