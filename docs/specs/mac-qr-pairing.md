---
title: "Pair the Instar Mac app by scanning a QR code with the phone"
slug: "mac-qr-pairing"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "mac-qr-pairing.eli16.md"
status: "approved"
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin; no constitution file is touched). The feature itself was asked for and approved by Justin: topic 143051 messages 143497 and 143512."
review-convergence: "2026-11-16T00:00:43.066Z"
review-iterations: 5
review-completed-at: "2026-11-16T00:00:43.066Z"
review-report: "docs/specs/reports/mac-qr-pairing-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 12
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Pair the Instar Mac app by scanning a QR code with the phone

## Problem statement

The Instar Mac app pairs with an agent only by pasting a pairing link (`InstarMac/MacPairing.swift`). On 2026-11-15 the operator tried it and asked for a QR option ("seems to be working, although I would expect a qr code option here", Telegram topic 143051, message 143497, 2026-11-15 14:09 PT, read from the topic's history), the way Telegram Desktop pairs: the computer shows a code, the phone that is already signed in scans it. He was offered: the Mac shows a QR, the paired Instar phone app scans it, the owner confirms with Face ID, the Mac is paired, through a small short-lived drop point on instar.sh that holds the agent's address sealed so only that Mac can open it. He answered "yes" (topic 143051, message 143512, 14:38 PT), the next operator message after that offer (agent message 143500).

His standing direction is decentralized by default: "INSTAR should aim for decentralized architecture, wherever and whenever possible, with the idea that every agent and the agent fleet gains robustness as more agents and more machines are added" (topic 134088, 2026-10-31, as recorded in the agent's memory note `decentralized-by-default`; the message itself is older than the topic history the agent can read, so its id is not resolved). This drop point is the exception he approved in that offer ("It would hold nothing for more than a minute or two, and the agent still approves the pairing exactly as it does today", message 143500, answered by 143512), so three properties are invariants of §5: it is **dumb** (it holds only bytes it cannot read and decides nothing), **short-lived** (nothing past 120 s), and **optional** (pairing never depends on it; pasting a link still works without it).

## Simplest route, and why not the local network

The simplest robust route reuses everything pairing already has (the one-time code and its redeem, the device key, the owner phone's Face ID approve) and adds one thing: a way to carry a fresh pairing link from the phone to a Mac it can see but cannot reach. The phone handing the link straight to the Mac over the local network would need no instar.sh, but it needs Bonjour plus the Local Network permission prompt on both devices, a listening socket in the sandboxed Mac app, and fails on guest and office Wi-Fi with client isolation and on VPNs. The operator approved the drop point instead.

## What is reused and what is new

Reused unchanged: `PairingCodeStore` (`src/core/MobilePairing.ts`), the redeem and mint routes (`src/server/mobilePairingRoutes.ts`), the owner-phone approve path (`src/server/mobilePairingApproval.ts`, `PairingApproveFlow.perform` in the app, including presence-key enrolment on first use), `DeviceKey`, `PairingLink`, `AgentClient.redeem`, the Mac's wait and poll. New: a QR link format, an owner device being allowed to mint (bound to one key), the sealed hand-over, and the drop point.

## Proposed design

### 1. The flow the person sees

1. Mac: "Pair an agent" opens on a QR code (default). "Paste a link instead" keeps today's paste box one click away and is remembered for the next open once chosen.
2. Phone: in the Instar app, + → "Scan pairing code" scans it. The phone shows "Pair the computer that calls itself <Mac name> with which agent?" listing only its agents that answer the owner's waiting-list read (§3.1). With one, it is preselected. The screen says: "This gives that computer full access to <agent>. Continue only if this code is on a Mac in front of you that you are setting up now."
3. Phone: tap "Pair <Mac name>". It says "Waiting for <Mac name>…".
4. Mac: "Pair this Mac with the agent at <host>? It calls itself <agent>." with Pair and Cancel (and "This replaces this Mac's current pairing with it." when this Mac already has that host). One click. The host is the only fact here; the names were chosen by the sender.
5. Phone: "Approve the computer that calls itself <Mac name>?" and Face ID. The key fingerprint is shown small underneath as supporting detail (the Mac shows the same one while it waits); the phone has already matched it to the scanned code, so the person is not asked to compare strings.
6. Mac: a kept result, "Paired with <agent> at <host>", with Done and Remove (it does not close itself). Phone: "<Mac name> is paired with <agent>."

No typing. One Face ID, at the step that adds the device. One click on the Mac, at the step that chooses the agent.

### 2. The QR content (v1)

`https://instar.sh/pair-mac#v=1&r=<slot>&k=<seal key>&d=<device key>&n=<Mac name>`

- `r`: 16 random bytes, base64url (22 chars), fresh per code. The drop-point slot.
- `k`: a one-time P-256 key-agreement public key (CryptoKit, software, memory only, x9.63, base64url), fresh per code.
- `d`: the Mac's device public key for this pairing attempt (the Secure Enclave `DeviceKey(agentID: localID)`; the form redeem sends as `devicePublicKey`). It is made when the sheet opens; if it cannot be made the sheet opens on the paste step with "This Mac couldn't make a pairing key. Paste a link instead." A new `localID` and `d` are made whenever an attempt ends without pairing (cancel, refusal, stop, a blob that arrived), and the old key is deleted and any pending row revoked.
- `n`: the Mac's name, ≤ 40 chars, display-only and untrusted.
- Everything is in the fragment. The phone parses strictly (exact keys, first value wins, regex per field) and refuses anything else.
- **In-app scanner only.** The phone opens this format only from its own scanner. `/pair-mac` is NOT added to the universal-link association, so a tapped link in a message cannot start the flow; `site/src/pages/pair-mac.astro` (same no-network CSP as `/pair.astro`) says "Open Instar on your phone, tap +, choose Scan pairing code, and scan the code on your Mac."
- Refresh: a new `r`/`k` every 120 s; the previous pair stays readable one more interval, so a scan just before a refresh still lands. A slot's key is discarded when the slot retires (240 s after it was made). After 10 minutes of showing codes with nothing received, the sheet shows "Show a new code". Once a blob has opened, the confirm step and the existing approval wait govern instead. Polling runs only while the QR is on screen.

### 3. The phone's side

1. **Eligible agents:** every agent this phone holds a device key for is listed, each checked with `GET /mobile/pairing-requests` when the screen opens. One answering 200 can be chosen (that answer means an owner phone, the approve switch on, a secure address). One that cannot is shown greyed with its reason: 403 `owner-phone-required` → "Only the owner's phone can add a computer."; 503 → "Approving devices from the app is turned off on <agent>."; 403 `secure-transport-required` → "<agent> can't approve devices over this connection."; unreachable or 429 → "<agent> can't be reached right now." No presence key is needed up front; the first approve enrols it, as today.
2. **Mint:** `POST /mobile/pairing-codes` over the device-signed channel with `{ forDevice: { publicKey: d, name: n } }` (§4).
3. **Seal:** HPKE base mode `P256_SHA256_AES_GCM_256` (CryptoKit `HPKE.Sender`; iOS 17 / macOS 14 are the apps' minimums), recipient `k`, `info` = `"instar-pair-mac-v1\n" + r`. Plaintext JSON `{ link, agent, phone }` where `link` is the agent's answer verbatim; `agent` and `phone` are display-only and untrusted on the Mac (≤ 40 chars each). Blob = `encapsulatedKey || ciphertext`, base64url (≈ 600 chars).
4. **Drop:** the phone keeps, for 240 s, each slot it sent to with that slot's sealed blob. A retry re-sends the same blob without minting, and a scan of a slot it already filled goes back to "Waiting for <Mac name>…" without minting or sending. If more than 100 s have passed since the scan when Pair is tapped, the phone says "Scan the code again" instead of minting (the slot may be about to retire). Then `PUT https://instar.sh/api/pair-drop/<r>`, `Content-Type: application/octet-stream` (Astro's origin check refuses a `text/plain` body without an `Origin`), body = the blob. 201 → waiting. 409 after an earlier send to this slot whose answer never arrived → "This code was already answered, possibly by your first try. Look at <Mac name>: if it asks about <agent>, continue there." Any other 409 → "Someone else answered this code first. On <Mac name>, cancel and start again. If your Mac says it paired with an agent you don't know, remove it." Anything else → "Couldn't reach <Mac name> through instar.sh. On the Mac choose Paste a link instead, and ask <agent> for a pairing link." (No share button: the minted code is bound to this attempt's key and cannot help a different sheet.)
5. **Approve:** poll `GET /mobile/pairing-requests` every 3 s (its device bucket is 30 a minute, shared with the app's own waiting-list read; after a failed read the next waits 6 s, then 12 s, and a good read resets it) until the minted code's `expiresAt` (5 minutes), for the row whose `fingerprint` equals `deviceFingerprint(d)` (same formula as the server: first 16 hex of sha256 of the key bytes, upper case, groups of four). Show "Approve the computer that calls itself <Mac name>?" (the fingerprint small underneath, as support), then run `PairingApproveFlow.perform` with the Face ID reason "Approve the computer with key …". Any refusal shows the server's `detail`. A row that does not match is never approved here. Timeout → "<Mac name> didn't check in. On it, start again, or scan the code again." The phone reads through its normal agent client, which reaches the machine it minted on (the link's origin is that machine's stable address); a moved route shows as the timeout.

### 4. The agent's side (instar server)

`POST /mobile/pairing-codes` becomes reachable from an owner device:

- Device route rule: `{ method: 'POST', re: /^\/mobile\/pairing-codes$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 6, bucket: 'pairing-mint' }`.
- With a device principal: the person is the owner (body `userId`/`role` ignored); `forDevice.publicKey` must parse (`parseDevicePublicKey`) or 400 `bad-device-key`; the label is `"<Mac name ≤ 24> (added from <phone's recorded name ≤ 20>)"` (≤ 60 chars, `cleanText`'s cap); the code's lifetime is 5 minutes (not the 30 a paste link gets: it is used within seconds); at most 5 device mints an hour, inside the existing shared 10 an hour and 10 live, so phone mints can never use up the agent's own link-making. Everything else is the existing mint path (stable origin, approval path, lease, sole server).
- **Key binding:** `CodeEntry.boundKey`. Redeem compares it with the submitted key after take-and-delete; a mismatch answers 400 `wrong-device` with feature evidence, and the code stays spent.
- **Naming the device:** the pending record gets `deviceKind: 'computer'` when the redeem body says `deviceKind: "computer"` (the Mac app sends it on every redeem, pasted or QR) or the code was key-bound (a floor for older Mac builds). It is display-only, untrusted like `deviceName`, and grants nothing; absent means phone, as today. The owner's Telegram message, the waiting list (`client: "computer"`) and the phone's approve words then say "a computer" instead of "a phone", and the Telegram message gives the label as a claim ("it calls itself <label>").
- The pending device waits exactly as any redeem does; every existing approve path still applies (owner phone Face ID, the Telegram code or button, the dashboard). Nothing new can activate a device.
- No new config key. Older agents answer the device call 403 `device-not-allowed`; the phone treats `device-not-allowed` and 404 as "update the agent" and `owner-phone-required` as "only the owner's phone".
- Awareness: `src/data/awareness/mac-qr-pairing.md`.

Mint refusals, in the phone's words (the agent's `detail` is shown when it is written for a person; these replace the ones that are not):

| Agent answer | Phone says |
|---|---|
| 409 `stable-address-required`, `address-unverified`, sole-server errors | "<agent> can't make a pairing code right now. On the Mac, paste a link instead." |
| 409 `approval-unavailable` | "<agent> can't confirm a new device from the machine your phone is connected to. On the Mac, paste a link instead, and ask <agent> for one." |
| 429 `too-many-mints`, `too-many-live-codes`, bucket | "Too many pairing codes were made recently. Try again later, or paste a link on the Mac." |
| 403 `owner-phone-required` | "Only the owner's phone can add a computer." |
| 403 `device-not-allowed`, 404 | "Update <agent> to pair a computer from your phone. Or, on the Mac, paste a link." |
| 503 | "Pairing is switched off on <agent>." |
| (Mac side) the link's host ends in `.ts.net` | The Mac's confirm step adds "This address works only while Tailscale is on on this Mac." |

### 5. The drop point on instar.sh

One Astro server route, `site/src/pages/api/pair-drop/[id].ts` (`prerender = false`), on Vercel's Runtime Cache (`getCache({ namespace: 'pair-mac-v1', keyHashFunction: (k) => k })` from `@vercel/functions`, pinned to 3.10.4; part of the existing Vercel Pro plan: no new vendor, database or account). The identity key function matters: the library's default key hash is 32 bits, so two random slots could share an entry.

Delivery is **best effort**. Runtime Cache is non-durable and per region, has no conditional write, and may evict before the TTL. Safety never depends on it: the Mac opens only a blob sealed to its own key, waits for a click, and the code registers only `d`. What depends on it is delivery and the 409 warning; a lost or evicted blob ends in the phone's bounded wait and "scan the code again". The site's functions run in one region (the project default; no multi-region setting), which this route relies on: adding a region would split the mailbox.

- `PUT /api/pair-drop/:id`: `id` `^[A-Za-z0-9_-]{22}$`; body base64url ≤ 2048 chars. If a value is observed in the slot → 409. Else set it with ttl 120 s → 201. 201 means "accepted", not "delivered": two racing writers can both get 201, and eviction can lose a blob.
- `GET /api/pair-drop/:id[?also=<id>]`: returns the first slot that holds a value (200, the blob) or 404. Reads do not delete, so a lost response can be read again and a writer after a read still sees the slot occupied while it lasts.
- Which cache backs it: the pinned library picks, in order, the request context's cache, then the cache named by `RUNTIME_CACHE_ENDPOINT`/`RUNTIME_CACHE_HEADERS` (unless `RUNTIME_CACHE_DISABLE_BUILD_CACHE`), then a per-instance memory cache (`cache/index.js` in 3.10.4). The route applies the same test before every call and names the path it used in `X-Pair-Drop-Store` (`context`, `env` or `none`); when it would land on the memory cache, where a phone and a Mac on different instances never meet, it answers 503 with `none`. The deployment proof is that header reading `context` on the deployed site: that branch is taken only when the platform itself hands the function its shared Runtime Cache. Separate successful requests alone are not proof (one warm process can answer them all), so each module load also makes a random instance tag, returned as `X-Pair-Drop-Instance`; a check run where the GET that returned the blob carries a different tag from the PUT records `shared-proven`, otherwise `delivered-same-instance`. To provoke a second instance, the check sends its GETs as 8 parallel requests. If three runs still show one instance, the stage passes on `X-Pair-Drop-Store: context` with `shared-proven: not observed` recorded, and the 6-hour check keeps looking. A library upgrade re-reads that selection code before the pin moves.
- `Cache-Control: no-store`, `text/plain` answers, no CORS. The route logs no body and no id. The platform's request log keeps the path (with `r`) and the client address; exposure is denial of that one pairing, never the link.
- Cost and abuse: an honest 10-minute sheet is at most about 400 cache reads (Pro bills roughly $0.40–0.64 per million reads and $4–6.40 per million writes). The route has no limiter of its own; the agent creates a Vercel firewall rate-limit rule on `/api/pair-drop/*` (60 requests a minute per address) through the Vercel API at deploy and records its id in the side-effects artifact; the live proof sends 70 requests in a minute from one address and sees the later ones refused. If the route is overwhelmed or removed, QR answers "isn't reachable" and paste works.
- **Health:** a scheduled check on Echo (`pair-drop-check`, every 6 hours): PUT a random slot, GET it twice (both 200, both `X-Pair-Drop-Store: context`), PUT again (409). It is a signal, not a notifier: a failure is retried once and then recorded as a failed job run by the scheduler (the job's reports are quiet by default, per the per-job notification choice), which is where the operator or the agent's own job review sees it. There is no self-repair it could do (the route is static code on the host), so it never notifies on its own.

### 6. The Mac's side

- The QR step creates `localID`, the device key and the first slot, draws the QR (CoreImage, correction M), and polls the drop point for its current and previous slot in one request, every 3 s while the code is on screen (2 s → 10 s → 30 s backoff after 3 and 10 failures; a success resets it).
- A blob that opens with a live slot's key: stop polling and refreshing, ignore any later answer, and show the confirm step (§1.4). Pair → the existing `add()` with that link and this attempt's key; Cancel → nothing was redeemed; new key and code. A blob that does not open: "A code arrived that this Mac couldn't open. Showing a new one." and a new key and code.
- Drop point unreachable 3 times in a row: "Pairing by QR isn't reachable right now. Paste a link instead." with paste one click away.
- Waiting for approval: "Approve this Mac on <phone>." and "Check that it shows <fingerprint>." Outcome: active → the kept result state; refused, declined or expired → today's words, then a new key and code.
- Leaving the sheet any way other than paired: revoke the pending row (`POST /mobile/devices/:id/revoke`, as Cancel does today), delete the key.

## Decision points touched

- **Which agents the phone offers** — invariant; basis: enumerable-domain; evidence: the agent's own answer to `GET /mobile/pairing-requests` (200 or not) for this phone; the agent decides owner, switch and transport, the phone only reads it.
- **Whether an owner device may mint, and its limits (5 minutes, 5 an hour inside the shared 10)** — judgment-candidate; floor: minting grants nothing (the device still waits for an existing approve path), only owner devices can mint, and the agent's own link-making keeps at least 5 of its 10 hourly mints; arbiter: the operator, through the code, from observed `too-many-mints` refusals. The 5-minute lifetime is the time a scan-and-send takes many times over; a stale code only costs a re-scan.
- **Redeem with a key other than the bound key** — invariant; basis: irreversible-consequence; evidence: letting a code minted for one key register another lets whoever carries the link add their own device to the agent; refusing costs only a re-scan.
- **Which waiting row the phone approves** — invariant; basis: enumerable-domain; evidence: exact equality of the row's fingerprint with `deviceFingerprint(d)` from the scanned code. This proves the row is the scanned key, not that the device is the person's; that judgment is the person's, made at the Face ID step with the words in §1.2 and §3.5.
- **Whether this Mac pairs with the agent that arrived** — judgment-candidate; floor: nothing is redeemed until the person clicks Pair on the Mac after seeing the agent's name and address; arbiter: the person at the Mac.
- **Drop slot: 409 when a value is observed, reads never delete** — judgment-candidate; floor: the Mac's key check and confirm click, and the key-bound code, hold whatever the store does; arbiter: none at runtime. The 409 and re-readability are best-effort conveniences on a non-durable cache.
- **Slot lifetime 120 s, previous slot kept one more interval** — judgment-candidate; floor: no slot outlives 120 s from its PUT and no key outlives 240 s; arbiter: none at runtime, revisited from use if scans miss.
- **Blob cap 2048 chars** — invariant; basis: enumerable-domain; evidence: the payload is a v1 link (at most about 420 chars: a 253-char host, a 22-char code, a 40-char name) and two names the phone clips to 40 before sealing, plus a 65-byte encapsulated key and 16-byte tag: under 1000 base64url chars at the maximum.
- **Mac polling (3 s on screen, backoff 2 s → 10 s → 30 s on failures, 10 minutes with nothing received)** — judgment-candidate; floor: the loop ends, paste is always one click away; a blob that cannot be opened makes a new code at the poll interval, so repeated bad blobs cost one poll each and never speed the loop up; arbiter: none at runtime.
- **Phone mint/send/approve retries** — judgment-candidate; floor: nothing is retried automatically; the person taps again, and a retry re-sends the same sealed link without minting; arbiter: the person.
- **Phone waits for the pending row until the code's expiry, polling every 3 s with 6 s / 12 s backoff on failed reads** — judgment-candidate; floor: on timeout it only stops waiting; the device stays approvable from the normal approvals screen until its own expiry.
- **Phone waits until the minted code's expiry; refuses to mint 100 s after the scan** — judgment-candidate; floor: either way it only stops and says scan again, nothing is spent past one mint.
- **Health check result** — judgment-candidate; floor: a failure becomes one degradation record after one retry, never a direct notice; arbiter: the scheduler's job-failure record and its review.

## Multi-machine posture

- Pairing codes and `boundKey`: machine-local, unchanged. machine-local-justification: physical-credential-locality — a code is bound to the stable origin of the machine that minted it and redeem must arrive on that host (`docs/specs/mobile-pairing-tailscale-origin.md` §3.1).
- The pending record's `client: 'computer'`: part of the existing device registry; same posture as `browser`.
- A phone can mint only on the machine its device record lives on, and on the Telegram approval path only while that machine holds the lease; otherwise the mint is refused with the table's words and paste works.
- The phone's waiting-list read reaches the machine that minted, because the link's origin is that machine's stable address; a route that moves mid-pairing shows as the phone's timeout, and the device stays approvable through the normal approvals screen.
- The drop point: not agent state; one external route shared by all agents, holding ciphertext ≤ 120 s, in one function region.
- The health check runs on one machine (Echo's lease holder) like any scheduled job.
- The Mac's QR keys: Mac memory only.

## Security and trust

- **What this is:** ordinary app pairing under the existing agent-managed trust model. The bearer token can still mint codes. A paired owner device's Face ID approve is the approval it is today: evidence of the owner's act on a device the agent's own registry lists, not custody independent of the agent (trust journey G9). This feature adds no approval path and inherits that limit. Trust journey G9's "bearer-mintable" becomes "bearer- or owner-device-mintable"; the trust-journey spec owner is told (tracked as CMT-1826). <!-- tracked: CMT-1826 -->
- **The drop point** sees a random slot id, a sealed blob, an address and timing. It cannot decrypt, cannot tell which agent is involved, and holds nothing past 120 s. If it is compromised, the worst it can do is deny QR pairing (paste works); a forged blob needs `k`, which only someone who saw the QR has.
- **Someone who sees the Mac's QR** within its life can answer first with their own agent. The real phone may then get 409, and its words say so (a race or eviction can instead end in its timeout and "scan again"); the Mac shows that agent's name and address and waits for a click; a Mac paired by mistake is removed from the kept result screen. They cannot reach the victim's agent this way.
- **Someone who gets the owner to scan their QR** (shown on their own screen) gets their key approved only if the owner taps Pair, reads "This gives that computer full access to <agent>. Continue only if this code is on a Mac in front of you that you are setting up now.", and approves with Face ID. Restricting the format to the in-app scanner removes the tapped-link version. This residual is the same one any QR sign-in (Telegram Desktop, WhatsApp Web) carries, and it is inside what the operator approved (the owner confirms with Face ID).
- **Replay:** slots and seal keys are single-use per code; the pairing code is single-use, 5 minutes, and bound to `d`; HPKE `info` binds the blob to its slot.
- **A Mac paired this way is an owner device**, like any device paired by the owner: it can mint codes for computers and can approve other devices once it has a presence key.
- **Team posture:** owner devices only. A member's computer pairs by an invite link, because only the owner approves devices.

## Testing

- Server unit/integration: the device rule is owner-only; a device mint forces the owner and requires `forDevice.publicKey`; device codes live 5 minutes and stop at 5 an hour while the bearer mint still works; `wrong-device` refuses and spends the code; a bound redeem marks `client: 'computer'` and the Telegram text names a computer; the full chain mint → redeem → owner-phone approve → active through the real middleware; the bearer mint is unchanged.
- Server e2e: the device mint answers 200 on the production init path.
- Drop point: unit tests for validation, 409 on an observed occupied slot, reads that do not delete, `?also`, expiry, the cache-path test mirroring the pinned library (503 and `none` on the memory fallback, 503 when the cache call throws), verbatim keys (a pair of slots the default hash merges), no body or id in logs; a live check against the deployed route that requires `X-Pair-Drop-Store: context`.
- Apps: link parse/refuse, the fingerprint against a vector computed by the server's function, seal/open bound to key and slot, blob size; the Mac's slot rotation and single consumption.
- Observability: feature evidence records each device mint, each `wrong-device` refusal and each approval (existing). Success is computers approved ÷ codes minted by a phone, per agent, read from feature evidence at each stage review; the health check records drop-point liveness and `shared-proven` runs.
- Live proof before the operator is asked: a throwaway agent with an https stable origin; the signed Mac app shows the QR; the iPhone app in the simulator opens the same code through its scanner path (an injected scan of the QR's URL), mints, seals and drops; the Mac confirms and redeems; the owner-phone approve (presence-signed, as `.instar/lanes/po-proof` does) activates it; a conversation works on the Mac. Then: drop point unreachable → the Mac's fallback words and paste work; a second writer gets 409; an expired slot is gone; a wrong-key redeem is refused. No physical iPhone is attached to any machine the agent can drive (checked 2026-11-15: `devicectl` lists none), so the physical camera scan and real Face ID are recorded as **pending proof**: the build is reported as simulator-proven with that step named, never as fully proven, and the first physical scan is done with the operator when he next has the phone at the Mac.

## Maturation plan

- **test-agent-live:** a throwaway agent on this Studio with an https stable origin (the named tunnel `mac-proof-1114.dawn-tunnel.dev`), the signed Mac app, the drop point on the branch's preview deployment: every Live proof case above passes, with `X-Pair-Drop-Store: context` and a `shared-proven` run or `not observed` after three parallel-GET runs. Target 2026-11-16, owner echo.
- **dev-agent-live:** Echo, used by the operator's own Mac and phone, from the release that carries the server half: the operator pairs his Mac by QR once (also the pending physical proof). Target 2026-11-18, owner echo. `devicectl` is re-checked at each stage; if a physical iPhone is attached, the physical proof runs before the operator is asked.
- **fleet:** the next release after dev-agent-live; owner echo, review due 2026-11-25. The server half is owner-only and grants nothing by itself, so a fleet agent changes nothing until its owner installs an app build that uses it.
- **graduation criterion:** on Echo, at least one computer approved after a phone mint, with no `wrong-device` refusal for an honest scan and the health check green on `context` (with a `shared-proven` run, or `not observed` after three parallel-GET runs).
- **dark-window:** none: no switch; the feature is live wherever the server half and an app build that uses it both are.
- **ladder:** not applicable: no switch and no staged rollout of its own, it rides the release train and a revert undoes it.

## Rollback

- Server: revert the commit. Device codes expire within 5 minutes; devices already paired stay paired (they were approved the normal way).
- Drop point: delete the route; the apps fall back to paste with plain words.
- Apps: the paste path is untouched.

## Frontloaded Decisions

1. **Approval authority:** the existing approve paths, with the phone's Face ID approve over the matching row as the normal one. The mint is not an approval and the drop point is not one.
2. **Where the phone gets the code:** the existing `POST /mobile/pairing-codes`, opened to owner devices, not a new route.
3. **Bind the code to the Mac's key:** yes, server-side, plus the phone's fingerprint match.
4. **Crypto:** CryptoKit HPKE base mode P-256/SHA-256/AES-256-GCM. No third-party code.
5. **Storage:** Vercel Runtime Cache under the existing Pro plan. Not Upstash: the team's one free Upstash database is a client project's, and a new one is paid.
6. **The Mac confirms the agent with one click** before redeeming; the phone confirms the computer with Face ID. Both are the person's judgment; key equality is only the floor under them.
7. **In-app scanner only** for the QR format; no universal link for `/pair-mac`.
8. **Default on, through the ladder above;** no config switch (it adds no authority, and a per-machine switch would have to be kept equal on every machine).
9. **Android:** same design, after this build; tracked as CMT-1825 (follow-through due 2026-11-29). <!-- tracked: CMT-1825 -->
10. **Live proof uses the simulator for the phone** because no physical iPhone is reachable; the physical step is reported as pending, not passed, and the stage-2 ask to the operator carries one line saying the first camera scan and Face ID will be his because no iPhone is attached to a machine the agent can drive.
11. **The QR-phishing residual** (an owner who scans someone else's code and approves it with Face ID adds that computer) is accepted as inherent in the flow the operator approved ("the owner confirms with Face ID", message 143500 → 143512), with the warning words, the in-app-only scanner and the Mac's confirm step as its mitigations. It is named to the operator in the milestone report.
12. **Rules touched** (2.0 rule book, which ends at 116): 1, 4, 5, 6, 8, 9, 10, 13, 26, 28, 30, 31, 32, 34, 35, 39, 40, 42, 43, 44, 49, 52, 53, 55, 60, 62, 63, 65, 66, 69, 71, 72, 73, 74, 76, 77, 78, 79, 80, 82, 83, 84, 86, 87, 88, 89, 94, 95, 98, 102, 103, 104, 106, 107, 108, 109, 111, 113, 116. The architecture check `scripts/check-architecture.mjs` exists only in the 2.0 repository and depends on 2.0's composition machinery, so it does not apply to this 1.x change; the 1.x structural checks are the instar-dev commit and push gates and `instar dev:preflight`, whose result is attached to the pull request.

## Tracked commitments

> **CMT-1825** — "Android app: add Pair a computer (scan the Mac QR, mint, seal, drop, approve) with the same design as docs/specs/mac-qr-pairing.md, after the iPhone + Mac build ships"

> **CMT-1826** — "Tell the trust-journey spec owner (worktree .worktrees/trust-journey-spec, docs/specs/trust-journey.md G9) that pairing codes become bearer- or owner-device-mintable (owner device mints a code bound to one computer key; no new approval path) once mac-qr-pairing merges, and check G9 is updated"

## Open questions

*(none)*
