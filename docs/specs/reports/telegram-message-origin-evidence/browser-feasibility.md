# Telegram Web receipt feasibility — 2026-09-06 UTC

**Result: a concrete Web K adapter is feasible.** Production Web K exposes a manager RPC that can invoke `messages.sendMessage` with a broker-provided durable `random_id` and return Telegram's server `Updates`. This avoids inventing a DOM-based receipt. No Telegram message was sent, no login was altered, and the managed Justin profile was not launched or copied.

## Local profile and production canary

Authenticated local `/playwright-profiles` resolves `justin-telegram` to the dedicated local profile; its login assertion remains unverified. No running browser process used that profile during this investigation. Read-only History queries showed its most recent Web A visit at 2026-08-29 05:29:09 UTC and Web K visit at 2026-08-28 02:39:04 UTC. These establish visited clients, not current login validity. Chrome's recorded profile version is 151.0.7922.174; that is not Telegram's version.

Public JavaScript resource URLs in its cache identify Web K **2.2 (673)**:

- `app-BFKylAvQ.js` reports build 673.
- `apiManagerProxy-D4CB6hUf.js`, SHA-256 `94b3390c3f1042c13671f8e86c805e90220d49e524d3a73919fbedb19bbc11ad`.
- `index.worker-C6dbvVmt.js`, SHA-256 `c2bdf19f80b351a94bf31a83baa6dc820c158796fa6e093803c78466f88eb899`.

Those exact public assets and source maps were retrieved from Telegram's server; no account storage/cookies were read. [Build manifest](https://web.telegram.org/k/app-BFKylAvQ.js), [manager bundle map](https://web.telegram.org/k/apiManagerProxy-D4CB6hUf.js.map), [worker bundle map](https://web.telegram.org/k/index.worker-C6dbvVmt.js.map).

A separate anonymous ephemeral browser loaded current production Web K **2.2 (676)**. It exposed `createProxiedManagersForAccount`, `apiManagerProxy`, and `rootScope`; a read-only call to `createProxiedManagersForAccount(1).apiManager.getAccountNumber()` returned `1`. No authenticated account or send method was used. Evidence: `upstream-spike/anonymous-k-canary.json`. Current observed entry assets are `index-CBuWbkpt.js`, `app-BSCNxN1b.js`, and `apiManagerProxy-DVXobuyu.js`. [Current build manifest](https://web.telegram.org/k/app-BSCNxN1b.js).

## Concrete source path

The exact build-673 source maps, extracted under `upstream-spike/k-build-673/`, show:

1. `debug.ts` mounts classes on the global context even outside debug mode; `getProxiedManagers.ts:155` exposes `createProxiedManagersForAccount`.
2. Its manager proxy sends `{name, method, args, accountNumber}` through `apiManagerProxy.invoke('manager', ...)`.
3. `appManagersManager.ts:97–114` selects that account's manager and returns `manager[method](...args)`.
4. `apiManager.invokeApi()` returns the deferred server result, not a local message bubble.
5. `appMessagesManager.sendText()` itself invokes `messages.sendMessage` with `peer`, `message`, `random_id`, entities and reply context. It handles `updateShortSentMessage` and normal `updateMessageID` updates, then produces `message_sent` only after final-message reconciliation.

Current upstream snapshot is `morethanwords/tweb@4a82cc7667477751cfc1b0dcec75db539c797a03`; the relevant paths remain present. [Manager proxy](https://github.com/morethanwords/tweb/blob/4a82cc7667477751cfc1b0dcec75db539c797a03/src/lib/getProxiedManagers.ts), [typed text sender](https://github.com/morethanwords/tweb/blob/4a82cc7667477751cfc1b0dcec75db539c797a03/src/lib/appManagers/appMessagesManager.ts), [API invocation](https://github.com/morethanwords/tweb/blob/4a82cc7667477751cfc1b0dcec75db539c797a03/src/lib/appManagers/apiManager.ts).

## Recommended adapter

Inside the isolated broker, pin the enrolled Telegram account number and verify its actual authenticated principal. Resolve the destination `InputPeer` through that same account's `appPeersManager.getInputPeerById`. Use a narrowly typed broker text-send operation whose immutable request includes exact text/entities, full peer/topic reply context, and a durable 64-bit `random_id`. Internally, invoke that account's `apiManager.invokeApi('messages.sendMessage', request, options)` through the exposed manager proxy. The agent must never receive the generic invocation capability.

Do **not** treat `sendText()`'s promise as a receipt: its public return type is `Promise<void>`, it creates optimistic messages and it parses Markdown. Calling the lower RPC with already prepared text/entities avoids those presentation mutations and gives the actual server result.

Accept either a direct `updateShortSentMessage.id` correlated to that exact RPC, or the `updateMessageID` whose `random_id` equals the durable submitted value, joined to the corresponding final message update. Retain account/peer/topic and final content state; distinguish scheduled results. Unknown/missing correlation stays outcome-unknown. Local temporary IDs, event timing and matching prose are insufficient.

Version gate activation by tested build/bundle hashes plus the non-sending manager round-trip and authenticated-principal/destination canaries. Unknown builds require adapter compatibility review. Source inspection and the anonymous canary establish a real callable seam; a permitted development send/receipt test is still necessary before claiming end-to-end delivery works with the managed login.

One material implementation constraint: upstream `invokeApi` contains internal retries. `rawError` disables some branches, but an `UNKNOWN` branch can still retry. The broker must retain one request/random ID, represent a timed-out invocation as still possibly in flight, and never resubmit a new random ID merely because its external deadline elapsed. Validate bounded invocation/cancellation behavior during the adapter proof; promise timeout alone does not cancel Web K's worker activity.

## Web A and enrollment boundary

Web A also has a real receipt path: `sendApiMessage()` invokes GramJS `messages.SendMessage`; `handleLocalMessageUpdate()` converts `UpdateShortSentMessage`/`UpdateMessageID` into final state. Its high-level send promise resolves without returning that identity, making the worker update correlation an extra integration seam. The inspected upstream is `Ajaxy/telegram-tt@9cb10b20797dc09e33fcffee0ba390bb429c66d3`. [Web A send/update source](https://github.com/Ajaxy/telegram-tt/blob/9cb10b20797dc09e33fcffee0ba390bb429c66d3/src/api/gramjs/methods/messages.ts).

Prefer the now-evidenced Web K manager path. The existing profile has visited K, but its current K login was not verified. During authorized broker enrollment, open that existing profile under the broker and perform read-only principal verification first. If K needs authorization while A remains authenticated, assess Web A worker integration before requesting a new login. This investigation does not establish that TDLib enrollment or user intervention is necessary. Inbound bot updates can provide an additional receipt for managed destinations, but do not cover arbitrary external user chats and cannot replace the general RPC receipt seam.

No feature code, managed-profile changes, or sends were made. Scratch evidence contains upstream public code, resource fingerprints and anonymous canary results only.

## Reproduce the non-sending canary

From the agent home, run `node .instar/telegram-origin-review/upstream-spike/anonymous-k-canary.cjs`. It uses the already installed Playwright package and Chrome, creates an anonymous ephemeral context, performs only `getAccountNumber`, records globals/resource URLs, and closes the browser. The script intentionally contains no send call or managed-profile path. Re-fetch the public asset/map links above to independently reproduce the build-673 source evidence; compare the published SHA-256 values before relying on extracted source. Live resource names can change, and a changed version is a new measurement rather than a failed historical observation.
