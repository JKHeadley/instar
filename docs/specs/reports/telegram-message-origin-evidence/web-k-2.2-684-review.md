# Telegram Web K 2.2 (684) broker contract review — 2026-10-31 PDT

Verdict: the driver's read, peer-resolution and single sealed RPC paths remain compatible in the public source maps. Enrollment still requires the authenticated managed-profile canary to observe these exact bytes, the expected account, and self-peer resolution. No message was sent during this review.

## Trigger and public evidence

The managed `justin-telegram` profile returned `409 telegram-browser-snapshot-unavailable`. The trusted `instar telegram-origin enroll-browser justin-telegram` canary then refused `unreviewed-build` with fingerprint `904f9293dbf8e6b694e64b6f4ee879a84024473afa04fa32bc5aea0042877a01`, after identifying the expected account. Its refusal record is `.instar/lanes/telegram-browser-enroll-20261031-1847.json` in Echo's agent workspace; `messagesSent: 0`. The existing enrollment was retained.

All assets below were fetched without credentials from `https://web.telegram.org/k/`. Their SHA-256 digests match the authenticated canary's three critical-asset observations:

| Asset | SHA-256 |
|---|---|
| `apiManagerProxy-BsT2jiCe.js` | `6f8d5d5bc0b7ce65da1112f443d8ab4a52af11054b880648c5d0a29aee6a9b63` |
| `app-Y8QFA5bv.js` | `4e877485f8e9629d0b723468fac7291d47b02fb01fa35493f1b8cda1aafd0e72` |
| `index-kWWFxlHg.js` | `1c43fc11afbbaa87272ce5df6b9d1157352cf1142187dfa099782e23f2b1b59d` |

`app-Y8QFA5bv.js` declares `versionFull: 2.2 (684)` and build 684. Its API ID/hash and main-domain settings are unchanged from reviewed build 679. Public source-map digests: proxy `a86b1bebcaec88eb7505f565a8ae5388e6ed3289a4beb042b19ae052294bd40d`, app `e3fcd7708225efffa509f0a8c9d184317f5c5d95b043f118291fcb51fea15e19`, index `78f22a03b58fa270e32229679baeaede610ae7d2d157b72a2d0a8eaf6cbd7396`, main workers `index.worker-CBtdsaB4.js.map` `15c8cc6ebc087263a6037d0484501ad61a576a901db26c72dc9993528dd7a69b` and `index.worker-DhxEPYOj.js.map` `e5f921f1ee555b731942ad7b8b623247426919387a69970fd6b2140e5126ecfa`. The worker JS digests are `6484a59d762792896e820e9d033f399219edba49618a3fc4c066987c04bce4d1` and `55ec72b6c3358825bb1f16a5f7ddb501e9e7b2ed78e1b462cc4b14b0a225c35a` respectively.

## Driver contract comparison with reviewed build 679

I compared `sourcesContent` for the page, proxy, index, and both main-worker maps. Bundle placement changed substantially (679 proxy: 150 source files; 684 proxy: 47), so comparison was by source path across all five maps, not by bundle. There are 462 shared source paths; 51 changed.

| Driver dependency | 684 finding |
|---|---|
| `window.createProxiedManagersForAccount` | Still mounted by `getProxiedManagers.ts`; `config/debug.ts` is byte-identical. Its bound-account call still passes a fixed account number to `apiManagerProxy.invoke('manager', {name, method, args, accountNumber})`. New account-session cancellation applies to tab-following proxies; the driver's bound proxy has no `isAlive` or `refuseWhenGone` callback. |
| Proxy dispatch | `appManagersManager.ts` changes duplicate-account login cleanup, not manager request dispatch. The `manager` request and account number still route to the selected account. |
| `apiManager.getAccountNumber()` and `apiManager.invokeApi(...)` | `manager.ts` is byte-identical. The `invokeApi` body in `apiManager.ts` is unchanged; changes elsewhere in that file concern sign-in state and temporary auth-key persistence. |
| `appPeersManager.getPeerId(peer)` and `getInputPeerById(id)` | Their bodies remain unchanged. The `getPeerId.ts` helper is byte-identical. A different `getChatMigratedTo` helper replaces an inline migrated-chat check outside these two methods. |
| Server RPC result and retry identity | `mtproto/networker.ts` is byte-identical; its `rpc_result` settlement and same-request retry behavior remain. The driver keeps one sealed `random_id` and does not resubmit an unknown outward result. |

The page's `apiManagerProxy.ts` has account-switching and UI-state changes, but the broker's pinned global, account-manager call and raw `invokeApi` path remain present. The trusted enrollment canary is the final runtime check; a source-map comparison alone does not authorize a send.

## Enrollment boundary

The new entry in `ReviewedWebKBuilds.ts` accepts only the three exact observed asset names and digests. The trusted CLI retires the profile's browser, checks the account and resolves the operator's self peer without a send, and keeps at most one prior reviewed build. A different future fingerprint requires a new review. No raw browser write or generic browser tool is used on this managed profile.

At 18:53 PDT, the authenticated managed-profile canary passed: build 684's three exact digests, account number 1, `accountMatchesExpectedOperator: true`, and `selfPeerResolved: true`. The trusted CLI enrolled `[web-k-2.2-684, web-k-2.2-679]`, `messagesSent: 0`; the receipt is `.instar/lanes/telegram-browser-enroll-684-20261031.json` in Echo's agent workspace. The server's typed snapshot is a separate check and still must be observed after its existing per-build recovery cooldown expires.

At 18:59 PDT, the installed server's typed `GET /telegram/browser/justin-telegram/snapshot` returned HTTP 200, the expected account, and 1,176 characters of page text when called with the current origin session credential from tmux. The desk pane's inherited credential was stale and caused the preceding immediate 409 probes; they did not reach the browser broker. This read is the requested working managed snapshot. The observer's fresh #2190 send and receipt are separate pending evidence.
