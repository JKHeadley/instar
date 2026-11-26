# Telegram Web K 2.2 (679) adapter compatibility review — 2026-10-16 UTC

**Verdict: compatible. No adapter change is needed.** Every contract `TelegramWebKDriver` relies on is byte-identical between the enrolled build 676 and the new build 679, apart from one additive proxy guard that makes the driver's use safer, not different. Build 679 may be enrolled as `web-k-2.2-679`, keeping `web-k-2.2-676` as the second allowed build.

No Telegram message was sent, no login was altered, and no account storage or cookies were read. Everything below comes from Telegram's public assets and source maps, plus one anonymous ephemeral canary.

## What changed upstream

On 2026-10-16 `https://web.telegram.org/k/` began serving a new build. The broker's critical-asset census (`index-`, `app-`, `apiManagerProxy-` and `index.worker-` scripts loaded by the page) changed, so `TelegramWebKDriver.canary()` correctly refused the unknown fingerprint.

| | build 676 (enrolled) | build 679 (new) |
|---|---|---|
| `app-*.js` | `app-BSCNxN1b.js` `29cc1441…84ed6` | `app-DVSixCDs.js` `fb82ff310b30bfd265e4ada88a8c5e2e6eb7e8bc971543cb4200bf3f4169bf6b` |
| `apiManagerProxy-*.js` | `apiManagerProxy-DVXobuyu.js` `dd0c085f…6f23c` | `apiManagerProxy-DYhbs4ln.js` `70513b1b70daee74142dce7f1452c95f695465812b7bb40340aa18fa4ca1932a` |
| `index-*.js` | `index-CBuWbkpt.js` `f96a8174…12e93` | `index-xJZhS8vI.js` `2faf42121fb7488fe20708d958a439e1cdddfffe95dd2de3e886bc465be455a9` |
| main worker | `index.worker-BkprtmJC.js`, `index.worker-DGfthI1r.js` | `index.worker-D-oUJ7CX.js`, `index.worker-CHAcBazd.js` |

`app-DVSixCDs.js` reports `versionFull: "2.2 (679)"`, `build: 679`. The API id/hash pair and the domain list are unchanged from 676.

The SHA-256 values for 679 are the exact public bytes fetched from `https://web.telegram.org/k/<asset>` with no credentials. The authenticated canary (below) must observe exactly these three names and digests before enrollment is allowed. Worker bundles are recorded for review provenance only; the page's resource census does not list them, matching the 676 enrollment.

Source map digests (SHA-256): `apiManagerProxy-DYhbs4ln.js.map` `43573b789ff947d0702adced0065c041b646a995d6668dfc3cce094fd466300e`; `index-xJZhS8vI.js.map` `324fc810ff4578d329999c53fdd762253caf83f84321b20694d316efe37786a0`; `app-DVSixCDs.js.map` `1e06b917627c7e3c61f70bba63d85d24adcf400dc7136f9a5e50dfd61b04cc31`; `index.worker-D-oUJ7CX.js.map` `53dadeeb0d81652b4713a34827131bed5971647a645521f8e2bbeee9570e27cd`; `index.worker-CHAcBazd.js.map` `26bef2555a11e5bbaf545a61005a1e530b29d1d406446d65dab7618b09deb0c4`.

## Contract-by-contract check (676 vs 679 source maps)

Sources were extracted from the `sourcesContent` of both builds' maps (page bundle, `index-` entry and both main-worker bundles) and compared file by file.

| Driver dependency | Where the driver uses it | 679 result |
|---|---|---|
| `window.createProxiedManagersForAccount` mounted on the page global | readiness check, every probe, peer resolution, invoke | Still exported and mounted (`getProxiedManagers.ts:159,163`); `config/debug.ts` (`MOUNT_CLASS_TO = DEBUG \|\| true ? ctx : {}`) is **identical**. |
| Manager proxy dispatch `{name, method, args, accountNumber}` → account manager | every manager call | `appManagersManager.ts` **identical**. `getProxiedManagers.ts` adds only `isProxyIntrospectionProperty`: symbol, `then` and `toJSON` reads now return `undefined` instead of a remote-call stub. The driver never reads those properties; it only calls named methods. This change prevents a proxy from being mistaken for a promise, which is strictly safer. |
| `apiManager.getAccountNumber()` | probe | `manager.ts` `getAccountNumber` **identical**; the anonymous canary round-trip still returns `1`. |
| `apiManager.invokeApi(method, params, {rawError, noErrorBox, stopTime})` | `users.getUsers` self-check, `messages.sendMessage`, `messages.editMessage` | `invokeApi` body **identical**, including the `rawError` branches and the `stopTime` handling. |
| `appPeersManager.getPeerId(peer)` and `getInputPeerById(id)` | `resolvePeer` | Both method bodies **identical**; the `utils/peers/getPeerId.ts` helper is byte-identical (same SHA-256 in both maps). The file only adds new `min`-peer helpers (`registerMessagePeers`, `isMinPeer`, `getMessageWithPeer`) that the driver does not call. |
| Raw server result returned from `invokeApi` (receipt correlation in `correlateBrowserReceipt`) | send/edit receipts | Result delivery is unchanged: `rpc_result` still resolves the per-message deferred with the server object. |

### Observations that do not require an adapter change

- **Perfect forward secrecy.** `apiManager.ts` and `mtproto/networker.ts` now use temporary per-DC auth keys (`TempAuthKeys`). On `AUTH_KEY_PERM_EMPTY` the networker re-sends the *same* queued MTProto message over a fresh temporary key; an empty HTTP response also re-sends unanswered messages. Both re-send the identical request, so the `random_id` the broker sealed is preserved and Telegram's own `random_id` de-duplication still applies. This is the same class as the internal-retry caveat already recorded in `browser-feasibility.md`; the broker's rule (one request and one `random_id`, outcome-unknown after the deadline, no resubmission with a new id) remains correct.
- **`appMessagesManager.ts`** changed substantially (rich messages, edit refactor). The driver never calls `appMessagesManager`; it invokes `messages.sendMessage` / `messages.editMessage` directly through `apiManager.invokeApi`, as the feasibility report recommends.
- **`apiManagerProxy.ts`** changes concern service-worker passcode state and tab-local worker URLs. They do not touch the manager-invoke path.

## Anonymous canary on 679

`node .instar/telegram-origin-review/upstream-spike/anonymous-k-canary.cjs` (anonymous ephemeral context, no managed profile, no send method), run 2026-10-16:

```json
{"url":"https://web.telegram.org/k/","accountManagerRoundTrip":1,
 "publicGlobals":{"createManagers":"function","apiManagerProxy":"object","rootScope":"object"},
 "scripts":["https://web.telegram.org/k/index-xJZhS8vI.js","https://web.telegram.org/k/app-DVSixCDs.js","https://web.telegram.org/k/apiManagerProxy-DYhbs4ln.js"]}
```

## Enrollment gate

The reviewed entry is recorded in `src/messaging/telegram-origin/ReviewedWebKBuilds.ts`. The trusted entrypoint (`instar telegram-origin enroll-browser <profile>`) enrolls a build only after the authenticated read-only canary on the managed profile observes exactly these asset names and digests, the expected account, and a successful read-only peer resolution of the operator's own user. The authenticated result is recorded in `authenticated-web-k-canary-679.json`.

## Reproduce

Fetch each asset and its `.map` from `https://web.telegram.org/k/`, compare the SHA-256 values above, extract `sourcesContent` for the files named in the table, and diff them against the build-676 maps (`apiManagerProxy-DVXobuyu.js.map`, `index-CBuWbkpt.js.map`, `index.worker-BkprtmJC.js.map`, `index.worker-DGfthI1r.js.map`, still served). Live asset names can change; a later different build is a new measurement, not a failed one.
