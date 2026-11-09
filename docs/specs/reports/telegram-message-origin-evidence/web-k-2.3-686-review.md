# Telegram Web K 2.3 (686) broker contract review — 2026-11-08 PST

Verdict: the driver's read, peer-resolution and single sealed RPC paths remain compatible in the public source maps, with one change to how errors are reported. Build 686 now turns a server result the client cannot parse into a synthetic `rpc_error 400 NETWORK_RESULT_UNREADABLE`. The driver used to read every 400 as a definite refusal. That would have let the outbox treat a write the server may have executed as safely failed. The same change set fixes the driver: that error is now an unknown outcome. Enrollment still requires the authenticated managed-profile canary to observe these exact bytes, the expected account, and self-peer resolution. No message was sent during this review.

## Trigger and public evidence

Since about 06:00 PST on 2026-11-08 the managed `justin-telegram` profile failed its version canary ("Two distinct browser builds failed"), and every typed browser send and snapshot returned 409. At 16:58 UTC the trusted `instar telegram-origin enroll-browser justin-telegram` canary refused `unreviewed-build` with fingerprint `4520f562fc99130960e9c89d2c15e16a700d4d85bf85808763951e6e4d4ce0f4`, `messagesSent: 0`. The existing enrollment was kept. Its refusal record is `.instar/lanes/telegram-browser-enroll-20261108-precheck.json` in Echo's agent workspace. That is a version failure. The canary reached the asset census, which runs after the page's account manager and the self-user read.

All assets below were fetched without credentials from `https://web.telegram.org/k/`. The page's `index.html` loads `index-C47pEAow.js` and preloads `app-Bzzv1JNw.js` and `apiManagerProxy-DnfIRNVs.js`. These are the only critical-asset names the canary's filter (`index-`, `app-`, `apiManagerProxy-`, `index.worker-`) matches. Their SHA-256 digests equal the authenticated canary's three observations:

| Asset | SHA-256 |
|---|---|
| `apiManagerProxy-DnfIRNVs.js` | `bec087196ed2e34b819ec9c5a5b93901e7c7661e696848f2753ccd0750b0f6f7` |
| `app-Bzzv1JNw.js` | `b0dce6918e3d0b32adb1915cd0487921788b2bf72ea67e6c57f510c14bc82acc` |
| `index-C47pEAow.js` | `e0eeb1d6ba579d85cae568f3831f072d59d7cfcd1b86ab05e5d60ba27a203dc3` |

`app-Bzzv1JNw.js` declares `version: 2.3`, `versionFull: 2.3 (686)`, build 686. Its API ID/hash and main-domain settings are unchanged from 684. The proxy references the main workers `index.worker-CIdOGE4M.js` (JS `a7cbd7ad1dfa2e3825e8ec647b03e7de4bfbdf5997d8d89262dae63b863d4af6`, map `6cc76cea7f2b5428e2230336d2c84665182a860a88c2f736061f7122234ed1d3`) and `index.worker-DUZnWO_a.js` (JS `1160fd4ffce5b9761ecc69d2863b981993e60ac3da49e4e09a3664549a872950`, map `a71a5e58493abb031e12f863a2ce73ec602fdc364633313a222d10334be67540`), plus the service worker `sw-BvBDvl93.js` (JS `e6ad778128392465858d85375b952475fb7c4955f5940b2033d454977c699d2d`). Page source-map digests: proxy `8a8e8f0458dbaa02f63ac6f2053710fa4f0fb16df6759dfd182b4d30cff0a06e`, app `8fba670cca6918970510c1ad446004133151560bb9bc8cf5a3134b9f7703ad14`, index `c57f54f96738088d0d198bef3686bbc392b98209a31fed09279dceac81bca2cf`. The reviewed 684 assets and maps are still served, and their digests re-verified equal to the 684 report.

The attention item says two distinct builds failed. Only 686 is served now, so an earlier intermediate build is no longer observable without operator-scoped status. It cannot be enrolled anyway, because enrollment admits only the build the live canary observes.

## Driver contract comparison with reviewed build 684

I compared `sourcesContent` by source path across the page, proxy, index and both main-worker maps of each build. The old build has 470 paths and the new one 528, with 458 shared; 97 shared paths changed. The MTProto schema moved from layer 229 to 233.

| Driver dependency | 686 finding |
|---|---|
| `window.createProxiedManagersForAccount` | `lib/getProxiedManagers.ts` is byte-identical: still mounted on `MOUNT_CLASS_TO`, and the bound-account proxy has no `isAlive`/`refuseWhenGone`. `config/debug.ts` adds only beta/preview-gated widget-sandbox flags (a literal `false` in production). The live canary also observed the global as a function. |
| Proxy dispatch | `lib/appManagers/appManagersManager.ts` is byte-identical. `superMessagePort.ts` also treats a `RangeError` as a clone error and adds a typed helper. `apiManagerProxy.ts` changes passcode-key transfer, notifications, reload gating and the global-history message-id helper. None of these touch manager request dispatch. |
| `apiManager.getAccountNumber()` / `invokeApi(...)` | `manager.ts` adds only two new manager fields (widgets, wallet). In `apiManager.ts`, 401 re-authorization becomes single-flight per request. A `303` of an unlisted kind and a refused base-DC switch now reject instead of looping. `FILE_MIGRATE` 303s move the request. `noRetry` is honored for 500 and `UNKNOWN`, and wallet keys are wiped on logout. The driver passes `rawError: true` and no `afterMessageId`. The new 303 rejection reaches the driver as code 303, which the broker already classifies as an unknown outcome. |
| `appPeersManager.getPeerId` / `getInputPeerById` | `appPeersManager.ts` and `utils/peers/getPeerId.ts` are byte-identical. |
| Wire schema for the broker's methods | `messages.sendMessage`, `messages.editMessage`, `users.getUsers` and the constructors `updateShortSentMessage`, `updates`, `updateMessageID`, `updateNewMessage`, `updateNewChannelMessage`, `updateEditMessage`, `updateEditChannelMessage`, `message`, `user`, `peerUser/Chat/Channel` and `inputPeerUser/Chat/Channel/Self` are identical between layers 229 and 233. |
| Server RPC result and retry identity | **Changed.** `mtproto/networker.ts` now wraps `deserializer.fetchObject` for `rpc_result`. A result the client cannot read becomes `{_: 'rpc_error', error_code: 400, error_message: 'NETWORK_RESULT_UNREADABLE'}`, and `processError` rejects the request with `{type: 'NETWORK_RESULT_UNREADABLE', code: 400}`. In 684 the same failure left the request unsettled until its stop time, which the broker classified as unknown. The server has answered, so it may have executed the write. |

## Driver change required by 686

`TelegramWebKDriver.invoke` now returns the error `type` with its code. It maps `NETWORK_RESULT_UNREADABLE` to a non-refusal transport error (`telegram-result-unreadable`), which the broker reports as `outcome-unknown` (`invoked && !refusal`). Every other server code keeps its existing classification. Unit tests cover both sides: the unreadable result is not a `TelegramRpcRefusal`, and an ordinary `PEER_ID_INVALID` 400 still is. The mapping does not depend on the build, so it is also correct for 684. That build never produces the error.

## Enrollment boundary

The new entry in `ReviewedWebKBuilds.ts` accepts only the three exact observed asset names and digests. The trusted CLI retires the profile's browser, checks the account and resolves the operator's self peer without a send, and keeps at most one prior reviewed build (684). A different future fingerprint requires a new review. No raw browser write or generic browser tool is used on this managed profile.
