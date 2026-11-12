# Telegram Web K 2.3 (687) broker contract review — 2026-11-11 PST

Verdict: build 687 is compatible with the driver as it is. Every driver dependency is byte-identical to reviewed build 686 in the public source maps: the proxied-managers global, proxy dispatch, the account number, `invokeApi` and its error paths, peer resolution, the networker's `rpc_result`/`rpc_error` handling, and the MTProto schema (layer 233). The changes are limited to dialog-list pagination, chat reaction settings, rich-message layout and one service-worker cache pattern. No driver change is needed. Enrollment still requires the authenticated managed-profile canary to observe these exact bytes, the expected account, and self-peer resolution. No message was sent during this review, and no browser profile was used.

## Trigger and public evidence

At 21:36 UTC on 2026-11-11 a live read-only canary refused `unreviewed-build` with fingerprint `6809d24cb4b13c010206dea32ff726d177b500ed9180351276092efe8d3b839e`, `messagesSent: 0`. It observed three critical assets, listed below.

All assets below were fetched without credentials (user agent `Mozilla/5.0`) from `https://web.telegram.org/k/`. The page's `index.html` loads `index-Dthh6gB6.js` and references `app-B3AbKbVS.js` and `apiManagerProxy-xL1OSBOW.js`. Those are the only critical-asset names the canary's filter (`index-`, `app-`, `apiManagerProxy-`, `index.worker-`) matches in the page. Their SHA-256 digests equal the canary's three observations:

| Asset | SHA-256 |
|---|---|
| `apiManagerProxy-xL1OSBOW.js` | `58a81d3e1a235bd1e171fa972b24342f64b1ba5076831c5b7e4bee4b87f7d75f` |
| `app-B3AbKbVS.js` | `ad4146645016e21cc1621fffba19d211320616d197880eedeb7ba727d8e4e160` |
| `index-Dthh6gB6.js` | `b0a0d838ea117b4b1b15a15e39862f86cc60db03ec6db19d8a4140b4db9423eb` |

`app-B3AbKbVS.js` declares `version: 2.3`, `versionFull: 2.3 (687)` and `build: 687`. Apart from the build number, it is identical to 686's `app-Bzzv1JNw.js`, so the API ID/hash, push key, domains and base DC are unchanged.

The proxy references the main workers `index.worker-CAQPBjMz.js` (JS `6faec28bd1413eb832df51b295e933829ce8b2e23e7cf8ea20ac1e72e5f35715`, map `d23169f91fddb1472f8519be19e9bfca5124e9a1cd2407ae2f30c414fbffac93`) and `index.worker-CkExtqhF.js` (JS `dc108a2006dd6158fcf7a5bd9ecf195759fd3bfbbac00d72178a0a92ef9fe573`, map `f5f0728c4d8b896db6fae762e4d13c931108bb2273ffb55c7f7311a5474079e4`). It also references the service worker `sw-DJvSA5mt.js` (JS `a9974e08426e3859d9fb7ad95cfb70d8bcde492012e3c43993bd99bbda6c5896`, map `c1d8032e3877e20deec86ba8ea878074a4c8ca32a236576e1344b8e2c81577d8`). Page source-map digests: proxy `9066f4e0469ef70642d11c543c580ce14be2326293ab29666b1bb5cdb4055243`, app `aaddb05701e5e9474a25e74dca5c832a17db6dc5dedcbf145f65a30ad280933d`, index `203e9e8f4f0ce0db7ace448d7a757e6f6a6546fcf238c3d87b7fb100da57fc89`.

The reviewed 686 assets, workers, service worker and maps are all still served (HTTP 200). Every digest re-verified equal to the 686 report. The 686 report did not list a digest for its service-worker map, which hashes to `0e7dc4a1f58dc42e43ff745f66dad9995237b9ca2ffd877d2640616e7dd727e6` today.

## Driver contract comparison with reviewed build 686

I compared `sourcesContent` by source path across the page, proxy, index, both main-worker maps and the service-worker map of each build, the same set the 686 review counted. The old build has 528 paths and the new one 530, with 528 shared. 10 shared paths changed: `appChatsManager.ts`, `appMessagesManager.ts`, `appReactionsManager.ts`, `utils/reactions/availableReactionToReaction.ts`, `utils/reactions/filterReactionsAtUniqCap.ts`, `utils/state/loadState.ts`, `richMessage.ts`, `serviceWorker/index.service.ts`, `storages/dialogs.ts` and `storages/peers.ts`. Two paths are new: `utils/dialogs/getDialogsPaginationOffsets.ts` and `utils/reactions/createEmojiReaction.ts`. No path was removed. The MTProto schema stays at layer 233, and `mtproto/schema.ts` is byte-identical.

| Driver dependency | 687 finding |
|---|---|
| `window.createProxiedManagersForAccount` | `lib/getProxiedManagers.ts` and `config/debug.ts` are byte-identical. |
| Proxy dispatch | `lib/appManagers/appManagersManager.ts`, `superMessagePort.ts` and `apiManagerProxy.ts` are byte-identical. |
| `apiManager.getAccountNumber()` / `invokeApi(...)` | `appManagers/manager.ts`, `appManagers/apiManager.ts` and `apiManagerMethods.ts` are byte-identical. Account number, `rawError`/`noErrorBox`/`stopTime` handling, 303/401/500 paths and the error objects the driver reads (`code`, `type`) are unchanged. |
| `appPeersManager.getPeerId` / `getInputPeerById` | `appPeersManager.ts` and `utils/peers/getPeerId.ts` are byte-identical. `appChatsManager.ts` changed only in `setChatAvailableReactions`, which now applies the cache after the server accepts and takes optional `reactions_limit`/`paid_enabled`. `getInputPeer`/`getChannelInputPeer` are untouched. `storages/peers.ts` only adds the `paginationOffsets` key to a type union. |
| Wire schema for the broker's methods | `mtproto/schema.ts` is byte-identical (layer 233). That covers `messages.sendMessage`, `messages.editMessage`, `users.getUsers` and the constructors `updateShortSentMessage`, `updates`, `updateMessageID`, `updateNewMessage`, `updateNewChannelMessage`, `updateEditMessage`, `updateEditChannelMessage`, `message`, `user`, `peerUser/Chat/Channel` and `inputPeerUser/Chat/Channel/Self`. |
| Server RPC result and retry identity | `mtproto/networker.ts` is byte-identical. The 686 behavior of reporting an unreadable result as `rpc_error 400 NETWORK_RESULT_UNREADABLE` remains. The driver already maps it to an unknown outcome. |
| Other changes | `appMessagesManager.ts` changes only `getDialogs` pagination: it now keeps the next-page offset from the last dialog of the previous page. `storages/dialogs.ts` stores those offsets. `loadState.ts` adds a one-time `build < 687` migration that resets the stored dialog list, the same reset the existing `build < 677` step already did. The rest is reactions UI, rich-message bubble layout, and a service worker that also caches `.mesh` files. None of these is called by the driver, which invokes `apiManager.invokeApi` directly and never goes through `appMessagesManager` send paths. |

The dialog-list reset on first load of 687 does not touch the users/chats storages the peer resolution reads. I did not trace what `getInputPeerById` returns for a peer missing from the cache. Whatever it returns, the driver checks it with `browserPeerMatches` before any invocation and refuses a mismatch (`browser-peer-mismatch`), so that case fails closed and nothing is sent.

## Driver change required by 687

None. `TelegramWebKDriver.ts`, `TelegramBrowserBroker.ts` and the refusal set the broker classifies (400, 401, 403, 404, 406, 420 as refusal, all else unknown after invocation) depend only on code that is unchanged in 687.

## Enrollment boundary

A new entry in `ReviewedWebKBuilds.ts` should be `web-k-2.3-687`, accepting only the three exact observed asset names and digests above. The trusted CLI retires the profile's browser, checks the account and resolves the operator's self peer without a send, and keeps at most one prior reviewed build (686). A different future fingerprint requires a new review. No raw browser write or generic browser tool is used on this managed profile.

Not verifiable from public files: whether the canary's fingerprint `6809d24c…` hashes exactly this asset set. The digests match one for one. The fingerprint composition was not recomputed in this review; it was recomputed afterwards from the three asset names (the unit test pins it, and the independent second pass on 2026-11-11 recomputed it again) and equals the canary's value. Whether the authenticated page serves these same bytes is still the enrollment canary's check.
