---
title: "Documents from any computer: a team invite opens a computer, no app needed"
slug: "member-browser-any-computer"
eli16-overview: member-browser-any-computer.eli16.md
author: echo
created: 2026-11-20
status: converged
approved: true
approved-by: "echo (agent), on its own converged spec under Approval Only Where Required: docs/specs/** is not on the protected list (.github/CODEOWNERS); build pre-approved by Justin 2026-11-20 11:19 PST (topic 141385, message 145944); the browser-key-for-passkey trade-off is reserved to the operator as an Approve/Decline before any fleet turn-on (Frontloaded Decision 9)"
parent-principle: "The Person Decides; the Agent Does the Rest (STANDARDS-REGISTRY). Rule 123: An Instar Agent Always Serves a Team. Instar Documents Frontloaded Decision 14 (docs/specs/instar-document-viewer.md §13): documents stay dark on the fleet until a member can comment from a computer without the iPhone app."
origin: "Justin, 2026-11-10 17:54 PST (members can only comment from a computer through the iOS app) and 21:34 PST, topic 141469 (\"Split into their own project\"); restarted after the Mac Studio outage on Justin's 2026-11-20 11:19 PST request (topic 141385, message 145944), topic 146128"
lessons-engaged: "Know Your Principal (a computer is bound to a person only through the owner's own code, §3.2); Signal vs Authority (every access decision deterministic, no model in the loop, §6); P21 An Instar agent is always a multi-machine entity (bindings replicate; one address per computer with a way back from every other, §3.6, §5); P19 No unbounded loops (the only periodic work is the existing per-minute sweep, bounded by the registry, §3.7); No silent degradation (every refusal names its reason, §3.3); P20 Verify the state, not its symbol (§7); work in other repositories has an owner (no app change is required; the site page is in this repo and gated by a link flag, §4)"
review-convergence: "2026-11-20T21:22:39.403Z"
review-iterations: 6
review-completed-at: "2026-11-20T21:22:39.403Z"
review-report: "docs/specs/reports/member-browser-any-computer-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 0
contested-then-cleared: 6
---

# Documents from any computer: a team invite opens a computer, no app needed

## 1. Problem statement

Instar Documents (docs/specs/instar-document-viewer.md, merged in #3053) lets people read and comment on the agent's documents. A team member reaches a document only through their own devices (Frontloaded Decision 9): the Instar app on their phone, or a computer **linked by that phone** (§3.6a). A member without the iPhone app therefore cannot comment at all, and a member with the app needs it on hand to start using any computer. Decision 14 of the documents spec records that the operator raised this on 2026-11-10 at 17:54 PST, and that documents stay off for the fleet until it is solved. His own words in topic 141469 were lost in the Studio rebuild. Decision 14's text is the surviving record, and this spec cites it, not a paraphrase.

An earlier design (any browser, WebAuthn passkeys, chained enrollment where one linked computer could link the next) went through six review rounds without settling: six security findings stayed open. Its record was lost in the Mac Studio rebuild on 2026-11-20, so this spec starts again from the documents design (§3.6a, §13a). It is the same project Decision 14 names ("the passkeys project", topic 146128). It reaches the project's goal without passkeys, for the reasons in §13a, and amends Decision 14's wording to match (§13, decision 8).

The question the earlier design never closed is **what vouches for the first computer** when the member has no phone in the system. Chaining computers off each other only pushes that question back one step. This spec answers it with what already vouches for every team member's first phone: **the owner's team invite, confirmed by a code that only the owner's phone shows**.

## 2. What exists (instar main d9117905d, read from code)

- **Team invites** (`src/server/teamRoutes.ts:439`, team-roles-and-access §3.4). `POST /mobile/team/invites` is **owner-phone only** (`ownerDevice`, `teamRoutes.ts:214-224`; there is no admin invite path in code). It writes `person-add` for a new person, or with `existingPersonKey` mints a link for someone already on the team and writes no log event. Both return a one-time link from `mintTeamLink` (`mobilePairingRoutes.ts:592`): `https://instar.sh/pair#v=1&o=<origin>&c=<code>`, everything in the fragment, 30 minutes by default (`codeTtlMs`, 1 to 60), bound to the host it was minted for, carrying `{ userId: personKey, role: 'team' }` in the in-memory `PairingCodeStore`.
- **Redeem** (`MOBILE_REDEEM_PATH`, `mobilePairingRoutes.ts:1250`). Public, only over this agent's secure address. It refuses unless an approval path exists and, on the Telegram path, this machine holds the serving lease. For a team code it also requires `appCaps: ['standing']` (else `426`) and that the person still stands in the log. It takes and deletes the code synchronously (failed redeems count toward `MAX_FAILED_REDEEMS`, 30), records reuse of a spent link from a second key (`noteLinkReused`, active only with pairing-approve on, phrased for phones), and creates a pending device. **A team device's code is held in `dashboardCodes`** (`holdDashboardCode`). The owner's phone reads it with `GET /mobile/team/invites/:personKey` (owner phone; answers `{ deviceId, deviceName, code, expiresAt }` per waiting device). **That same store is also listed to any PIN-unlocked dashboard session** by `GET /mobile/pairing-approvals` (`:1542`, `dashboardApprovals()` has no role filter). `notifyOwnerPhones` **does nothing for team devices** (`approvable` is false for `role: 'team'`, `:925`, `:1082`), so no one is told a code is waiting. Confirm (`POST /mobile/device/confirm`, `:1714`) records a dashboard-held device as `approvedVia: 'dashboard-pin'`.
- **Browser devices** (`src/server/mobileBrowserDevices.ts`). A browser can be a signed device: a WebCrypto P-256 key, non-extractable, in IndexedDB **of the origin that made it**, `client: 'browser'` in its ledger activation row. The device-signature middleware (`mobilePairingRoutes.ts:2931`) admits a browser record with a `scope` only with a live `linkExpiresAt`, and then only on its scoped routes.
- **Phone-linked computers** (instar-document-viewer §3.6a, `src/server/documentLinkRoutes.ts`). The member's phone signs `POST /mobile/browsers/link`. The computer becomes a browser device with `userId`, `role: 'team'`, `scope: 'documents'` (guests `documents-read`), `approvedVia: 'person-phone'`, `linkExpiresAt` ≤ 30 days, and a machine-written `browser-bind` row carrying the phone's signed request (`verifyBrowserLink`). The allowance (3 live per person, 4 per hour, 30 days) is three hard-coded exports (`documentLinkRoutes.ts:34-36`) with no setting. A per-minute sweep forgets expired links, links whose phone left, and removed people. `bindTeamPhones` skips team browsers, so a scoped computer never gets an unscoped `phone-bind`.
- **Document access** (`AgentServer.documentDeviceKeyNow` ~10820, `documentDeviceKeyAt` ~10780, `documentBrowserLinkValid` ~10743; `src/documents/originCheck.ts` `deviceStoodAt` :89, `checkRowOrigin`). A computer bound in `browserLinks` is a `person` principal with its scope. `documents` may do the page's reads and writes plus one Send template; `documents-read` reads only; a guest reads only; a `dashboard-pin` browser never writes. Past rows are re-checked against the team-log position they were accepted under, and that re-check verifies the linking phone's signature (`verifyBrowserLink` inside `deviceStoodAt`'s callback).
- **Origins.** Each machine has its own tunnel host (for Echo, `echo-studio.dawn-tunnel.dev` and one per other machine). Links the agent posts are on the lease holder's host. The documents spec says any machine verifies any device's binding (§3.6 "Links and machines"), which is true of the server check, but a browser's key exists only in IndexedDB of the origin it was made on. So today a phone-linked computer opened on another machine's host has no key there.
- **Team log replication.** An unknown machine event is dropped by an older build (`knownEvents`, `TeamAccessLog.ts:125`), and the rest of its row still applies.
- **instar.sh pair page** (`site/src/pages/pair.astro`). It shows the link as a QR code for a phone, plus a Copy button, and makes no network requests. The site deploys separately from agents (Vercel), so whatever it shows reaches links from every agent version.

## 3. Proposed design

### 3.1 The member's path, start to finish

1. **The owner invites**, as today: a new person, or the existing "another device" invite for someone already on the team. The owner sends the link however they like (text, email). Nothing new on the owner's side.
2. **The member opens the link on a computer.** When this agent can take computers (§3.3, both switches on), `mintTeamLink` adds `&j=1` to the fragment. Only then does the pair page show **Use this computer instead**, with "No Instar app? You can read and comment on documents in this browser." and the destination address in plain text ("This opens echo-studio.dawn-tunnel.dev"). Owner links and links from agents without this feature never show the button. The button is a plain navigation to `https://<origin from the link>/docs/_join#v=1&c=<code>`. The code stays in the fragment, and `no-referrer` stays.
3. **The join page** (served by the agent under the document page's CSP) clears the fragment from its history entry (`history.replaceState`) and asks the browser to keep its storage (`navigator.storage.persist()`, best effort). It then creates a non-extractable P-256 key and posts `POST /docs/_join/redeem { code, browserPublicKey }`, with the code in the body.
4. **The server** runs the shared redeem core (§3.3.1) and creates a **pending joined computer** for that person. Its code is held the way a team phone's is (`holdDashboardCode`), so the owner's People screen already lists it, and the lease-loss tick already keeps it. The owner's phones get one push with an attention item behind it: "Mara is waiting for a code to use a computer" (§3.3.4).
5. **The page** shows: "Ask Justin for your code. It's on his phone, in People, under your name." It also shows the computer's **check letters**, the first 8 characters of the key fingerprint in two groups, using the digits 0–9 and letters A–F (`7F3A-91C0`), plus a code box and "Waiting for Justin". The owner's People screen already lists waiting devices with their codes. The waiting entry's name is built by the server: "Computer 7F3A-91C0, Chrome on macOS, from 203.0.113.4, asked at 13:04". The owner can ask "do your check letters say 7F3A-91C0?" before reading the code out. Check letters identify the device; they are not a secret.
6. **The member types the code.** The page signs `POST /docs/_join/confirm { deviceId, code }` with its own key (§3.3.2). On success it is a **joined computer** (§3.4). If the member arrived from a document link, the page opens it. From the invite alone it says "You're set up. Open any document link Justin or Echo sends you, on this computer." No document list route is added.
7. **The computer's address.** The computer is set up for this one address, the machine it joined on (§3.6). The page says once, in plain words: "This computer is set up for echo-studio.dawn-tunnel.dev. If a document link opens on a different address, use the button on that page to come back here."
8. **Staying in.** While the member keeps using the computer it stays in: at least about 22 days and up to 30 days after the last use, and at most 90 days after joining (§3.5). The page's menu shows the exact end date the server holds. The browser itself may forget the key sooner (Safari, §8). In the last 7 days a line appears, computed by the page from `expiresAt` with no message sent: "This computer can open documents until 12 Feb. After that, ask Justin for a new link." A week before the 90-day end, the computer's home machine raises one attention item for the owner. Computers ending in the same week are listed in one item, never one item each. For example: "Mara's computer 7F3A-91C0 stops working on 12 Feb. If Mara still uses it, send her a new invite."

### 3.2 Why this is safe enough, and exactly as strong as a member's phone

- **The anchor is the owner's code, as for team phones.** A computer becomes the member's only after the owner gives out a code that is shown **only on the owner's phone**. The code is read by `GET /mobile/team/invites/:personKey` (owner phone). The one PIN route that lists held codes, `GET /mobile/pairing-approvals`, stops listing team devices, and the PIN decline refuses them (§3.3.7). Both rules hold for team phones too.
- **A copied link.** A stranger who copies the link gets a pending computer and no code. The member's own attempt then fails with "This link was already used. Ask Justin for a new one." The owner sees a waiting computer whose check letters and address don't match the member's, and gives no code.
- **A relayed page (stated limit).** Someone who can intercept the link on its way to the member can instead give the member a lookalike page that forwards the real flow. The stranger's key is the one that redeems, so the member reads out the stranger's check letters, which match what the owner sees. This is the same exposure as §3.6a item 6 and as team phones. The mitigations: the destination address shown on the pair page and in the browser's address bar; the waiting entry's address, which may hint that a stranger's server asked; and the owner line in People, "Only give the code to Mara if her page is on your agent's own address. Tell it to her by voice or another channel, not as a reply to the link.". The check letters prove which device is waiting, not which address the member is looking at.
- **Guessing is bounded.** Redeem failures count toward `MAX_FAILED_REDEEMS`, as for phones. An unknown or garbage code gets "expired or already used", never a hint about what kind of link it was. Confirm allows the existing 3 attempts (`svc.confirm.check`), then drops the pending computer.
- **Same reach as a phone-linked computer, never more**: `documents` / `documents-read`, plus the one Send template through the conversation send route under exactly the §3.6a exception (§3.3.2), and nothing else.
- **Same strength as a team phone.** A team phone's binding is a machine-signed `phone-bind` (team-roles Step 2b), as strong as the machine. A joined computer's is a machine-signed `computer-bind`, no weaker. §3.6a item 5 carries over unchanged: the join page is served by the agent, so a process running as the agent's user could put its own key there. That key could do only what the member's computer can do, labelled as the member's computer.

### 3.3 Server changes

Everything here except item 7 is behind `documents.enabled` **and** `mobilePairing.browser`. With either off, every route here answers `503` with the existing plain reasons (`documents-off`, `browser-devices-off`), and `mintTeamLink` adds no `j=1`.

1. **`POST /docs/_join/redeem`** (public). The redeem checks are factored out of `MOBILE_REDEEM_PATH` into one function both routes call: secure-address arrival, eligible host, bound-host match, pairing pause, take-and-delete, failure counting, and `noteLinkTaken`/`noteLinkReused` (with computer wording in the reuse notice). The approval-path check (including its `!approval` refusal) and its Telegram lease rule stay in the phone route only. A team code's confirmation never travels through Telegram or the dashboard (`mobilePairingRoutes.ts:1337`); it reaches the owner through the app. So the join route applies neither rule. The phone route keeps its behaviour, and every existing redeem test stays green. What differs for a computer:
   - The code is taken first, as the phone redeem does. A taken code that is not `role: 'team'` answers `403` "That link has expired or was already used." The link is spent, as a link opened on the wrong device already is. The pair page only offers the button on team links, so this case is reached only by hand.
   - No `appCaps` requirement. The person must still stand in the log at the take.
   - The allowance (§3.5) is checked **before** the take, through `peekPerson`. A peek that names no team person falls through to the take, so it counts as a failure there.
   - `DeviceRegistry.createPendingComputer(...)` (one synchronous read-modify-write) creates the record with:
     - `userId`, `role: 'team'`, `client: 'browser'`, `deviceKind: 'computer'`, `joinedVia: 'team-invite'`;
     - `scope` from the person's tier (`documents-read` for a guest);
     - `browserPublicKey` and `host`;
     - the server-built `deviceName` (§3.1 step 5);
     - the pending lifetime pending team phones use (`pendingDeadline`), with boot expiry. Because the code is held through `holdDashboardCode`, the lease-loss tick (`leaseTick`, `:430`) keeps the pending computer, as it keeps a pending team phone (`dashboardPendingIds()`, and `confirm.clearAll(keep)` spares its code). A computer joining on a machine that doesn't hold the lease is therefore not expired.

     A pending computer does not count toward the allowance.
   - The answer is `{ deviceId, status: 'pending', ownerName, checkLetters, expiresAt }`. `ownerName` is the owner's profile name (fallback `threadline.ownerName`), the only person who can invite.
2. **`POST /docs/_join/confirm`** is public, with its body signed by the pending key. The signature uses a new domain, `instar-join-v1`, over `{ deviceId, code, host, timeMs }`, checked against the record's `browserPublicKey`, with a 5-minute time window (generous to computers with a skewed clock; replay is already prevented by the single-use code). It runs on the machine that holds the pending record, which is the host the link was minted for. It is a separate route, so the device middleware and `/mobile/device/confirm` (with its `svc.browser.activate` and `dashboard-pin` branches) are never involved. In order, each step undone if a later one fails (the pattern of `POST /mobile/browsers/link`):
   1. Re-check that the person still stands, that the tier allows the scope, and the allowance.
   2. `svc.confirm.check` against the held code. Three wrong codes drop the computer, and the owner's attention item changes to "Mara's computer was turned away after three wrong codes. If Mara still wants in, send a new invite."
   3. Write the ledger activation (`client: 'browser'`, new `approvedVia: 'team-invite'`).
   4. Activate the registry record (`status: 'active'`, `linkExpiresAt`).
   5. Write the `computer-bind` row (§3.4).

   **Commit point and retries.** The pending record stores the complete intended bind (scope, `idleDays`, `endsBy` and `host`, fixed at redeem from the limits then in force), so recovery never re-reads changed limits. The ledger activation (step 3) is the durable commit point, keyed by the pending `deviceId`. The computer may write documents only once its `computer-bind` exists, so a crash between steps never leaves a half-admitted computer that works. At boot, and in the existing per-minute pass, a reconcile step finishes any `team-invite` activation that has no `computer-bind`. It uses the same pattern as browser activation effects (`mobileBrowserDevices.ts` recovery), writing steps 4 and 5 idempotently. A confirm retried with the same key and `deviceId` after success answers `{ status: 'active' }`, not "wrong code". Tests restart the server after each write boundary.

   **The old confirm route refuses these.** `POST /mobile/device/confirm` refuses any pending record with `joinedVia: 'team-invite'` before reading the code or counting an attempt (`409 use-join-page`). The held code is in the same store as team phones' codes, so this check is what keeps the two routes apart. A test confirms that the same pending computer still completes through `/docs/_join/confirm` afterwards. (On the join route, the signed `host` must equal the record's `host`.)

   **Send.** A joined computer gets exactly the phone-linked computer's exception in the device-signature middleware, with the scope intersected with the person's tier now. A member lowered to guest can't Send, and that is tested. It may call the conversation send route (`POST /mobile/chat/:topicId` or `/mobile/chat/app/:key`) only with the Send template for a document it can see, into that document's primary conversation (`scopedSendTarget`). The middleware's live-link test for scoped browsers changes from `linkExpiresAt` alone to `computerStanding` (§3.4), so the same branch serves both kinds. Every other `/mobile/*` route refuses a joined computer. **Stated limit:** like a team phone, the computer reaches only its home machine. Send goes through that machine's conversation route, which answers `409 not-serving` while another machine holds the serving lease. The page then says "Your comments are saved. Echo is answering from another machine right now, so Send will work when echo-studio is answering again. You can also tell Justin, and Echo can read the comments any time." Comments themselves are rows that replicate, so nothing is lost. The §10 proof moves the lease between commenting and sending.
3. **`ApprovedVia`** gains `'team-invite'`, added to `originApprovedVia`, the CLAUDE.md line listing its values, and the awareness entry. The documents `mayWrite` rule keeps refusing only `dashboard-pin` browsers.
4. **The owner is told.** A pending joined computer raises one attention item for the owner, pushed to the owner's phones through the existing hub push (`MobilePush`, contentless; the app fetches the title with `GET /mobile/attention/:id`). The title is "Mara is waiting for a code to use a computer". The body is "Open People in the app. Mara's computer shows the check letters 7F3A-91C0. Only give the code to Mara if her page is on your agent's own address." It is raised through the existing local attention path (`raiseReachNotice`, which pushes `kind: 'item'`) with the condition key `team-computer-waiting:<deviceId>`. No new `PushSubject` is added, and the owner-browser `browser-approval` notice is never used. There is one item per pending computer. It closes on confirm, on expiry, or at boot. The boot step that expires pending devices also closes every `team-computer-waiting` item whose pending computer is gone. The item is in the attention queue, so a PIN session can see the check letters but never the code.
5. **`POST /docs/_link/forget-self`** (signed by the computer's key under `instar-docpage-v1`): "Forget this computer" works on any computer, phone-linked or joined. It writes the ledger revocation and `browser-unbind` for that key, then clears this computer's own browser state: the key, any pending join state, and every unsent comment draft the document page keeps in `localStorage`. On a shared browser, the next person starts clean. A test forgets a computer with an unsent draft, then checks it is gone.
6. **The owner removes a computer by asking the agent.** `POST /team/people/:personKey/computers/:deviceId/forget` (bearer only) writes the same revocation and unbind. Taking access away is already the bearer's to do (team-roles §3.3 `lower`). `GET /team/people` rows gain `computers: [{ deviceId, name, via: 'person-phone' | 'team-invite', host, linkedAt, expiresAt }]`, built in one pass over `browserLinks` and `computerLinks` and readable only by the owner and the bearer, like the rest of that read.
7. **Team codes leave PIN surfaces.** `GET /mobile/pairing-approvals` stops listing `role: 'team'` devices, both team phones and joined computers. The filter sits on that route, not inside `dashboardApprovals()`, because `GET /mobile/team/invites/:personKey` uses `dashboardApprovals()` too. `POST /mobile/pairing-approvals/:id/decline` refuses team devices. This is a foundation fix: §13a says the agent can read the PIN, so a PIN session must never see, or decline, a member's anchoring code. It is **not** behind the two switches. It ships to every agent, because it closes an exposure team phones have today. The owner's People screen is unaffected.
8. **The pair page** (`site/src/pages/pair.astro`) gets the button, its line and the destination address, shown only with `j=1`. The parser keeps ignoring unknown keys. `j` is the only new key.
9. **The join page** (`GET /docs/_join`) has these states:
   - making a key;
   - waiting for the code, with the owner's name and the check letters. The page keeps the pending `deviceId` beside its key, so closing and reopening the tab returns to this state while the code is still waiting;
   - wrong code, with the attempts left;
   - link used or expired: "Ask Justin for a new link";
   - limit reached (§3.5);
   - documents off;
   - success: the document, or the "You're set up" page.

   The document page gains the "set up for another address" state (§3.6).
10. **Limits** live in the replicated `computer-limits` row (§3.5).

### 3.4 The binding rows

Joined computers get their **own event types**, so an older reader drops them cleanly as unknown events (`knownEvents`) instead of misreading a known type with new fields. `browser-bind` is unchanged:

```ts
| { type: 'browser-bind'; ...today's phone-linked fields... }                          // §3.6a, unchanged
| { type: 'computer-bind'; keyHash: string; deviceId: string; boundTo: string;
    host: string; browserPublicKey: string; linkedAt: string; expiresAt: string;
    idleDays: number; endsBy: string;           // the limits in force at admission
    scope: 'documents' | 'documents-read' }
| { type: 'computer-renew'; keyHash: string; expiresAt: string }                        // §3.5
| { type: 'computer-adopt'; keyHash: string; host: string }                             // §3.5, a machine taking over a computer's address
| { type: 'computer-limits'; personKey?: string; maxPerPerson?: number; maxNewPerHour?: number; idleDays?: number; maxDays?: number }   // §3.5
```

All are machine events, signed under the accepting machine's pinned identity key. Validation in `TeamAccessEvents` uses fixed format bounds, never a machine's current settings, so every machine reaches the same verdict on the same row:
- `boundTo` must not be `owner` or `owner-browser`.
- `deviceKeyHashOf(browserPublicKey) === keyHash`, and the scope is one of the two.
- `1 ≤ idleDays ≤ 365`, `endsBy - linkedAt ≤ 365 days`, and `expiresAt ≤ endsBy`.
- The fold keeps first-bind-wins across all three maps: a key already in `bindings`, `browserLinks` or `computerLinks` is never re-bound. A test delivers two conflicting binds for one key (different people) in both orders, and every machine ends with the first by fold order.
- `computer-adopt`: its `keyHash` names a `computer-bind`, and its `host` equals that row's `host`.
- `computer-adopt` and `computer-renew` rows whose signer is past an `origin-gone` cut are ignored, as `computer-limits` rows are. An old, revoked machine identity therefore can't take over as home.
- `browser-unbind` for a joined computer carries the `deviceId` of its `computer-bind` (the fold already requires that match).
- Ordering by signed time uses a new comparator: machine-signed `at`, then the existing `rowOrder`. The existing `rowOrder` is seq-first and is not reused alone.
- A `computer-renew` applies only to a live `computer-bind` key. It only moves `expiresAt` forward, never past that row's own `endsBy`.

**How every machine checks a computer.** One function, `computerStanding(keyHash, state, now)`, replaces the per-kind checks in `documentBrowserLinkValid`, `linkStillValid`, `documentDeviceKeyAt`'s callback and `deviceStoodAt`. Each caller passes the state it already uses: the current state, or the state as of a row.
- **phone-linked**: today's `verifyBrowserLink`, unchanged.
- **joined** (`computer-bind`): not unbound, key not revoked, the person standing, and not past `expiresAt` (after the newest valid `computer-renew`). A bind row stays valid when the machine id that signed it is later revoked, as after a rebuild. The row was valid when accepted, and its computer then lives on through `computer-adopt`.

The fold keeps `computerLinks` beside `browserLinks` (keyed by `keyHash`). `browser-unbind` ends either kind, because older readers already know it and treat an unknown key as a no-op. Allowance counts, `GET /mobile/browsers` and the forget routes read both maps.

In both cases the scope applied to a request is the row's scope **intersected with the person's tier now**. A member lowered to guest keeps reading and stops writing. The sweep never forgets a computer for a lowering, only for a removal. `deviceStoodAt` uses the same function as of the row, so the comments of a computer later forgotten, expired or removed still verify on every machine.

The local `DeviceRecord` side branches on `joinedVia`. A joined computer has no linking phone, so its local check is `computerStanding` on its key. A unit test checks that a joined computer survives a sweep.

### 3.5 Limits and staying in

Four limits, kept in the team log as one machine event, `computer-limits { maxPerPerson, maxNewPerHour, idleDays, maxDays }`, so every machine reads the same values. Rows are ordered by their machine-signed time, with `rowOrder` breaking ties; per-machine `seq` counters don't give time order. The newest row wins, and with no row the defaults apply. Both kinds of computer read them, and the §3.6a constants become their defaults, so nothing changes for phone-linked computers:

| Setting | Default | Allowed | What it does |
|---|---|---|---|
| `maxPerPerson` | 3 | 1 or more | Live computers per person, phone-linked and joined together, checked at admission |
| `maxNewPerHour` | 4 | 1 or more | New computers per person per hour, checked at admission |
| `idleDays` | 30 | 1–365 | A joined computer ends this many days after its last use |
| `maxDays` | 90 | `idleDays`–365 | A joined computer ends this many days after joining, used or not |

The 365-day bound on the two lifetimes is the one hard limit, enforced by the route and by row validation. It bounds how long a lost or stolen computer that keeps being used can stay in, and it is the format bound rows are validated against. Machines must agree on one fixed bound. 365 days is a hygiene choice, and its cost is one new invite a year for a computer used all year. The other two settings have no ceiling: they are resource bounds, not safety boundaries, because every computer is admitted with the owner's own code.

The limits are agent-wide by default. When the owner says "let Mara use 5 computers", the agent calls `POST /team/computer-limits { personKey, maxPerPerson: 5 }` (bearer only; values range-checked as in the table), which writes the row. Without `personKey` the row is agent-wide. The bearer may write it because a higher limit gives no one access: every computer is still admitted only with the owner's own code. The row may also carry `personKey`, to set limits for one person ("let Mara use 5 computers" sets only Mara's). A person's own row wins over the agent-wide one, and the newest row of each kind wins by signed time. "Put Mara back on the team's limits" writes a person row with no values, which clears hers. Rows past an `origin-gone` cut are ignored, as other machine rows there are.

**Limits apply at admission only.** A bind row records the `idleDays` and `endsBy` in force when it was admitted. Lowering a setting never ends a computer already in; the next admission uses the new value. Counting uses replicated rows. Two machines admitting at the same moment can both pass and leave one computer over the limit. That is accepted: nothing forgets it automatically, and the owner sees the count (§3.3.6).

**At the limit**, the join page says only: "This person is already using as many computers as Justin allows. Ask Justin to remove one (he can tell Echo 'remove Mara's old computer'), or choose Forget this computer on one of them." It lists nothing. Whoever holds an invite link has not proven they are Mara, so the page must not show her computers or end one.

**Staying in.** A joined computer's **home** is the machine serving its row's `host`: the only machine its key's signed requests reach (§3.6). The home is the single writer for that computer (renews, the 90-day reminder, its local record). A machine adopts every live `computer-bind` whose `host` is one of its own hosts (any host `redeemHostEligible` accepts here: its named tunnel and its own Tailscale names) and that it holds no record for. It does this at boot and whenever such a row arrives: it rebuilds the local record from the replicated row and the ledger activation, and appends a machine-signed `computer-adopt { keyHash, host }`. So a machine rebuilt at the same address keeps serving its computers with no new invite, even with a new machine identity, as the Mac Studio got on 2026-11-20. **The home, as every machine sees it**, is the signer of the newest valid row of that computer's `computer-bind` and `computer-adopt` rows, ordered by machine-signed time. A second machine adopting a host that a live machine has adopted is visible in the log and raises one attention item: "Two of Echo's machines both answer for echo-studio. Computers set up there may stop renewing until one is retired." That stays within the stated limit that a machine can forge a binding (§8). So does a future-dated adopt from a live pool machine, which holds the home role until a later row appears. It raises the same attention item when another machine still serves that host. When it accepts a signed request from the computer, and at least a quarter of its idle window has passed since its last renew (its end is less than `¾ × idleDays` away), it writes `computer-renew { keyHash, expiresAt: min(now + idleDays, endsBy) }`. So a computer in use ends between `¾ × idleDays` and `idleDays` after its last use. With the default 30 days that is about one row per computer per week, and none while it is unused. Every allowed `idleDays` value renews. A renew is written only when it moves `expiresAt` forward, so at the `endsBy` cap nothing more is written. A renew counts on every machine only if its machine-signed time is before the end it extends, and only if its signer was the home at that signed time (the bind row's signer, or the newest adopter before it). Every machine checks this from replicated rows. The signed time is the home's own clock, which sits within the home-trust limit: a home could backdate a renew, as it could forge a binding. A late-arriving renew therefore changes no verdict: each comment is judged as of its own acceptance time and access vector (`deviceStoodAt`). **Expiry writes nothing.** No machine writes a revocation or unbind because a computer's end passed. Every machine judges expiry from the folded rows, and `computerStanding` as of a row judges that row's time, so old comments keep verifying with no unbind. The home's sweep only marks its local record expired. If a renew that moves the end forward arrives later, or a missing activation or bind arrives, the record is live again and adoption is reconsidered. A test covers both arrival orders across a rebuild. Only explicit removal writes a permanent revocation: Forget, the owner's removal, or the person's removal. A phone-linked computer keeps today's rule, renewed by its phone. Historical re-checks cache `teamStateAt` per `access` vector within one pass, so old comments do not re-read the log once per row. The owner is asked again at most once per `maxDays` per computer, with the reminder in §3.1 step 8.

### 3.6 One computer, one address

A browser key lives only in IndexedDB of the origin that made it, and each machine has its own tunnel host. A joined computer is therefore set up for **one address**: the machine it joined on. That machine serves every document to it, because document rows replicate to every machine. The same is true today of phone-linked computers.

When a document link opens on another of the agent's addresses where this browser has no key, the document page does not dead-end. It says "This computer isn't set up for this address. If you set it up on another of Echo's addresses, open the document there:" and shows one button per address of the agent's machines, each opening the same document path there. It also offers "No computer set up? Ask Justin for a new link." The address list is display only, read from the machines the agent knows. A wrong or stale entry just opens a page that also has no key; it never authorizes anything. The page is identical for every `/docs/<id>` path, whether or not that document exists, so it reveals nothing about documents. The addresses it lists are not secrets: they appear in every document link the agent posts. The documents spec's `no-referrer` rule is about third-party sites, and it still holds.

**If the home machine is down or retired**, the computer can't open documents until it comes back. The member asks for a new link and joins on a machine that is up, and the old computer ends on its own (§3.5) or is forgotten. That is the stated cost of one key per address, chosen over setting one computer up on every address (§13a). The links the agent posts use the lease holder's address. New computers join at the address of the machine the owner's phone used to mint the invite, which is often but not always the lease holder. When they differ, the way-back button covers the gap. When the home machine is unreachable, the page on another address says so plainly ("echo-studio isn't answering right now"), using the machine list it already shows.

### 3.7 Revocation

A computer stops working in these cases:
- Its end passes (§3.5). That is decided at read time by `computerStanding` on every machine, and its home machine's sweep drops the local record.
- The person is removed: the sweep and `revokePersonPhones`.
- The member taps Forget on it (§3.3.5), or on their phone if they have one.
- The owner asks the agent (§3.3.6).

The last three write both the ledger revocation and `browser-unbind`. `deviceStoodAt` needs the unbind to keep a forgotten computer's earlier comments verifying. An expired computer needs none (§3.5), and both are tested. A lowering intersects the scope and removes nothing. The sweep is the existing per-minute pass over the registry.

## 4. The iPhone app and other repositories

No app change is required. The owner's People screen already lists waiting devices with their codes and already offers an invite for an existing person. The attention item reaches the app through the existing hub push and attention read. The server-built device name carries the check letters, browser, address and time.

Optional app improvements, none of them dependencies:
- a labelled "Invite to use a computer";
- a person's computers listed with Forget;
- the check letters shown apart from the name.

They are filed as one app feedback item when this ships (build step 8, checked by its feedback receipt).

The instar.sh page is in this repository (`site/`). It deploys from `main` through the repository's Vercel project (`vercel.json` at the root builds `site/`). Because the button needs `j=1`, its deploy order relative to agents changes nothing for anyone. After merge, the run checks that the deployed page shows the button for a `j=1` link and not for a link without it.

## 5. Multi-machine posture

- **Unified (replicated):** `browser-bind`, `computer-bind`, `computer-renew`, `computer-adopt`, `computer-limits`, `browser-unbind`, ledger activations and revocations all travel in the team log and the key ledger to every machine. Any machine judges any computer key with `computerStanding`, and the comments a computer wrote verify everywhere.
- machine-local-justification: physical-credential-locality — a browser's signing key exists only in IndexedDB of the one tunnel origin that made it, so each joined computer is served by the machine serving that origin. That machine's local `DeviceRecord` and its role as the single renew writer follow from it. A machine that takes over the address adopts the record from the replicated binding (§3.5). The bindings, renewals and comments that matter to other machines are replicated. The page on any other address offers the way back (§3.6).
- machine-local-justification: physical-credential-locality — the pending computer record, its held code (in memory) and the confirm window are single-use credentials checked by the machine that minted the link, as phone pairing codes are. A restart loses the held code; the page then answers "This code is no longer waiting. Ask Justin for a new link.", and the owner's attention item closes. The owner's People read reaches the machine that holds the code because the phone minted the link there. If the phone has moved to another machine in between, People there doesn't show the code. The attention item names the machine ("on echo-studio"), and the code is still read there once the phone talks to that machine again. Otherwise the member asks for a new link.
- **Unified (replicated):** the `computer-limits` row, so the allowance and lifetimes don't change when the agent moves machines.
- **Admission needs no serving lease.** Redeem and confirm both run on the machine the link names. That is the machine the owner's phone used to mint it, so the owner's People read of the code reaches the same machine. The join route does not apply the phone route's Telegram lease rule (§3.3.1), and the lease-loss tick keeps the pending computer as it keeps a pending team phone. An integration test runs redeem and confirm on machine A with the lease on machine B.
- **Older machines would hold everyone.** An older build drops unknown event types from its fold (`knownEvents`). But it also marks a row with an unread event as a gap (`gapsIn`, `TeamAccessLog.ts:216`). On a pool with more than one machine, that gap makes `teamRefusal()` hold every team phone on that machine (`access-being-checked`). So **no machine writes any `computer-*` row until every pool machine advertises that it reads them**. The advert is a new heartbeat flag, `seamlessnessFlags.teamLogComputerRows: true`, sent whatever the feature switches say, as `documentsDecisionRows` is (`src/core/types.ts`, read by peers through `PeerPresencePuller` and `MachinePoolRegistry`). A missing flag counts as false. The flag is **sticky**: a machine whose last received heartbeat carried it keeps counting while it is asleep or unreachable. Only a newer heartbeat without the flag (a rollback) withdraws it. A machine past an `origin-gone` cut (retired) doesn't count at all. So a sleeping, already-updated laptop never blocks anything. Until every machine counts, these all wait, before anything is taken or written:
  - `/docs/_join/redeem` answers `409 peers-updating`: "Echo is finishing an update on echo-laptop. Try this link again later."
  - `POST /team/computer-limits` answers the same.
  - Confirm step 5 and the reconcile step hold and retry on the next per-minute pass.
  - Renew and adopt wait.

  If the gate stays closed for more than a day, the owner gets one attention item: "Computers can't join Echo until echo-laptop updates or is retired." It names the machine and the two ways out. A mixed-version test checks that an older machine's team phones are never refused because of these rows, and that a sleeping machine whose last heartbeat carried the flag doesn't close the gate. **Stated limit: rolling a machine back** to a build without the reader, after computer rows exist, makes that one machine hold its team phones until it is upgraded again or retired. Rollback is a deliberate operator act, its own heartbeat withdraws the flag, and the attention item above names it. If a computer's home machine is rolled back to an older build, the old sweep fails that computer's local check (no linking phone) and revokes it for good; the member joins again with a new invite after the upgrade. That is the safe direction, and §15 says so.

## 6. Decision points touched

| Decision | Classification | Basis and evidence |
|---|---|---|
| A computer may be registered only from a team code; any other code this route takes is spent with "expired or already used" | invariant | basis: enumerable-domain; evidence: a pairing code carries exactly one of the roles `owner`, `msp`, `team` (`PairingCodeStore` person field); only a team person has a scoped, revocable standing in the log to bind a computer to |
| The computer becomes the member's only after the code shown on the owner's phone is typed into it | invariant | basis: irreversible-consequence; evidence: a binding puts the member's name on every comment and Send until it is found and forgotten; the owner-held code is the existing anchor for every team phone (team-roles §3.4) |
| The join code is never listed to, or declinable by, a dashboard or PIN session | invariant | basis: irreversible-consequence; evidence: §13a of the documents spec says the agent can read the PIN, so a PIN-visible code lets the agent's machine bind a computer as anyone the owner invites |
| Scope applied = the row's scope intersected with the person's tier now | invariant | basis: enumerable-domain; evidence: two scopes and the tier map are closed sets already enforced for phone-linked computers (§3.6a, `access.ts`) |
| `computerStanding`: which computer keys count, now and as of a row | invariant | basis: enumerable-domain; evidence: unbound, revoked, person standing and expiry are the complete facts the team log and key ledger record about a computer key |
| Row validity uses fixed format bounds (365 days), never a machine's settings | invariant | basis: external-constraint; evidence: machines must agree on one fixed bound (365 is the chosen value; its cost is one new invite a year), and two machines with different settings would otherwise disagree about a replicated binding, and a comment's verdict would change with a config edit (round 2 finding against §3.4) |
| Device name shown to the owner is server-built (check letters, browser kind, address, absolute time) | invariant | basis: irreversible-consequence; evidence: text the requester wrote would sit on the owner's screen at the moment they choose whom to give the code (§3.6a item 6) |
| The other-address buttons on a page with no key are display only | invariant | basis: enumerable-domain; evidence: a navigation carries no credential; the only way in is a key on that origin or a new invite |
| The home: the signer of the newest valid `computer-bind` or `computer-adopt`, by machine-signed time; adoption only for the machine's own eligible hosts with no local record | invariant | basis: enumerable-domain; evidence: the replicated rows and each machine's own `redeemHostEligible` hosts are the complete facts available; a host claim beyond them is the stated machine-forgery limit (§8) |
| A renew counts only when signed by the home at that time, before the end it extends | invariant | basis: enumerable-domain; evidence: signer identity and signed time are both on the replicated row, so every machine computes the same verdict |
| Limits order: newest by signed time; a person's row beats the agent-wide row; an empty person row clears | invariant | basis: enumerable-domain; evidence: the rows carry `personKey` and a machine-signed `at`; seq order is per machine and not time (round 4 finding) |
| Two machines adopting one host raises one attention item | invariant | basis: enumerable-domain; evidence: two live adopters for one host is directly visible in the log; the item never decides anything |
| No `computer-*` row is written until every live machine advertises `teamLog: computer-v1`; unreachable counts as not advertising | invariant | basis: irreversible-consequence; evidence: an older machine marks an unread event as a gap and holds every team phone (`gapsIn`, `teamRefusal`) |
| Expiry writes no revocation; only explicit removal does | invariant | basis: irreversible-consequence; evidence: a revocation is permanent on every machine, and expiry seen from a machine missing a renew would otherwise end a computer in use for good (round 5 finding) |
| Allowance (`maxPerPerson` 3, `maxNewPerHour` 4), checked at admission | judgment-candidate | floor: the configured value, counted from replicated rows, refused before the code is taken; arbiter: the owner, through the agent writing the replicated `computer-limits` row (`POST /team/computer-limits`); defaults from §3.6a (a person's home, work and laptop); overshoot by simultaneous admissions accepted, never auto-forgotten |
| Staying in (`idleDays` 30, `maxDays` 90; hard bound 365) | judgment-candidate | floor: the values recorded in the bind row at admission; renewal only by accepted use, written by the computer's home machine; arbiter: the owner, through the same row, or by removing a computer at any time |
| Protocol constants: 3 wrong codes, 5-minute confirm window, renew after a quarter of the idle window, 7-day page line and owner reminder | invariant | basis: external-constraint; evidence: the 3-attempt drop is the existing pairing constant (`svc.confirm.check`), and a wrong-code member gets a new invite; the 5-minute window only tolerates clock skew, because the single-use code already prevents replay; renewing once a quarter of the idle window has passed bounds log growth to about one row per computer per week at the default (round 2 scalability finding); the 7-day lines are advisory text only |

## 7. Verify the state, not its symbol

- **Admission.**
  - Symbol: a `201` from `/docs/_join/confirm`.
  - State it should prove: the member can comment from this computer.
  - Corroboration: a comment row in the document's stream, signed by that computer's key and accepted by a second machine's re-check (`checkRowOrigin` returns `ok` there), shown on the owner's phone as "from Mara's computer".
  - Unmeasurable: if the second machine can't be reached, the result is reported as "not yet checked on <machine>", never as passed.
- **Renewal.**
  - Symbol: a `computer-renew` row.
  - State it should prove: the computer is still in use.
  - Corroboration: an accepted signed request from that key. A renew is written only from that event, on the home machine.
- **Owner notice.**
  - Symbol: an attention item.
  - State it should prove: the owner can act.
  - Corroboration: the push delivery record (`MobilePush` outcome).
  - Unmeasurable: with no push token, the item still sits in Needs you and People, and the join page still tells the member to ask.

## 8. Security

No access decision in this spec uses a model. Every refusal is deterministic and has a plain-word reason.

| Threat | Answer |
|---|---|
| Copied invite link | Redeems to a pending computer with no code; the code shows only on the owner's phone; the member's own redeem fails and tells them to ask; the owner sees check letters and an address that don't match. |
| Relayed lookalike page | Stated limit (§3.2), as for team phones and §3.6a item 6. Reduced by: the destination address on the pair page; the stranger's address on the waiting entry; the owner line "only if her page is on your agent's own address". |
| Guessing a code | Redeem failures count toward `MAX_FAILED_REDEEMS`; confirm drops after 3 wrong codes. |
| A PIN or dashboard session reading or declining the anchor code | Join codes are never listed there; team phone codes are removed from the listing and from decline (§3.3.7). |
| A joined computer reaching anything but documents | Scope enforcement as §3.6a; the middleware allows only the Send template exception; tested route by route. |
| A guest writing; a lowered member writing | Scope intersected with the tier now. |
| A removed person's computers | Sweep plus every use re-checks standing. |
| A machine forging a binding | Machine-signed like `phone-bind`; as strong as the machine (team-roles Step 2b). Stated limit, unchanged. |
| The agent-served page substituting its own key | §3.6a item 5, unchanged. |
| Attention or push spam | Only a holder of a live single-use team link, which the owner minted, can create a pending computer; one item each. |
| A shared or public computer | Forget on the computer; idle end; removal by asking the agent; the join page clears the code from its own history entry (the pair page's entry keeps a spent code, which is harmless). |
| Browser storage cleared (Safari clears idle site storage after about 7 days) | `storage.persist()` is asked for; if the key is gone, the page says the computer isn't set up and offers a new link. Stated in the ELI16. |

## 9. Agent awareness and migration parity

- A new awareness entry, `src/data/awareness/member-computers.md`, says:
  - a member without the app can open documents on a computer from their invite link;
  - the owner gives them the code shown in People, after checking the check letters and address;
  - "remove <name>'s computer" uses the bearer forget route;
  - "let <name> use more computers" calls `POST /team/computer-limits` with that person's key;
  - `originApprovedVia` now includes `team-invite`.
- The CLAUDE.md core line that lists `originApprovedVia` values (`APP_CONVERSATIONS_POOL_LINE`) gains `team-invite`, with a `migrateClaudeMd` content-sniffing step.
- CapabilityIndex: the documents entry lists the join routes and `forget-self`; the team entry lists the bearer forget route and `computers`.
- No config change: the limits live in the team log, with read-time defaults when no row exists, so no `migrateConfig` step is needed. The awareness entry follows `src/data/awareness/README.md` (no em dash or `**` in the title; the first body line is prose).

## 10. Live-User-Channel Proof (before "done")

On a throwaway agent with two machines (two server instances with their own origins on one host):
- **Happy path:**
  1. Owner invite through the device-signed route.
  2. Link opened in headless Chromium; Use this computer.
  3. Code read from `GET /mobile/team/invites/:personKey`; confirm.
  4. The member comments and sends.
  5. The second machine accepts the comment row.
  6. The page on the second origin shows the other-address button.
- **Refusals:**
  - an owner link taken on the join route;
  - a guest write;
  - a fourth computer;
  - three wrong codes;
  - a person removed between redeem and confirm;
  - a confirm signed by the wrong key.
- **Lifecycle:** Forget; a renew after use; expiry, with the old comment still verifying on both machines; a link minted while the owner's phone talks to the machine without the lease, so the computer's later links from the lease holder start on the other-address page.
- **Lease placement:** redeem and confirm on machine A while machine B holds the lease; the lease moved between commenting and sending (Send waits with the plain message, comments replicate).
- **Rebuild:** machine A rebuilt with a new machine identity and its address kept; A adopts the computer from the replicated binding, serves it with no new invite, and its renew is accepted by machine B.
- **Regression:**
  - phone-linked computers keep working;
  - team phone pairing still works, with its code now absent from `GET /mobile/pairing-approvals`;
  - an owner phone and an owner browser still pair.

## 11. Build order

1. Factor the redeem core out of `MOBILE_REDEEM_PATH` (no behaviour change; existing tests stay green).
2. Rows, validation and fold (`computer-bind`, `computer-renew`, `computer-adopt`, `computer-limits`) and the `teamLog: computer-v1` capability advert with the all-peers write gate. These ship and are read before anything writes them. Then `computerStanding` in all four check sites and the middleware's scoped-browser test; `POST /team/computer-limits`; the confirm reconcile step.
3. `POST /docs/_join/redeem`, `/docs/_join/confirm`, the attention item and push; team codes out of the PIN listing and decline (with a regression test that `GET /mobile/team/invites/:personKey` still returns them).
4. The join page; the document page's other-address state; `forget-self`; the bearer forget route and the `computers` field.
5. `mintTeamLink` `j=1`, and the pair page button with the destination address.
6. Awareness, migration and the capability index; the documents spec's Decision 14 and §8 amendments.
7. The live proof (§10).
8. File the optional app improvements (§4) as one feedback item; check the deployed instar.sh page.

## 12. Tests

- **Unit:**
  - Validation of the new types: owner `boundTo` refused, mismatched key hash, `endsBy` over 365 days, `expiresAt` after `endsBy`; an older reader dropping all four types and still applying the rest of the row.
  - `computerStanding` for both kinds, now and as of a row, including a forgotten or expired computer's old comment still verifying.
  - Scope intersection on lowering: read kept, write refused, before and after the sweep.
  - Renew rules: forward only, never past `endsBy`, written only by the home machine, and firing for `idleDays` of 1 as well as 30.
  - Allowance counting across both kinds.
  - The server-built name.
  - `createPendingComputer` refusing a duplicate key.
  - `bindTeamPhones` still skipping team browsers (protected rule).
  - Lowering a limit not ending an admitted computer; the newest `computer-limits` row winning by signed time across two machines with very different `seq` counts, a person's row winning over the agent-wide one, and an empty person row clearing it.
  - Adoption: a machine for whose own hosts a live binding's `host` is eligible rebuilds the record and writes `computer-adopt`; any other machine does not; a third machine replaying the history accepts renews from the adopter with a new machine id and refuses them from a non-home machine.
  - A renew counting only when signed by the binding's home before the end it extends.
- **Integration (HTTP):**
  - Redeem over the secure address gives a pending computer, with its code in `GET /mobile/team/invites/:personKey` and absent from `GET /mobile/pairing-approvals`. Also checked for a team phone, and PIN decline is refused for both.
  - Codes: an owner code is spent and refused; a garbage code counts as a failure; a wrong host is refused.
  - Admission refusals: the limit reached before the take; the person removed before confirm; a confirm signed by the wrong key; three wrong codes.
  - Activation writes ledger `team-invite`, never `dashboard-pin`.
  - A comment by the computer is accepted.
  - Send: the template is accepted through the chat route only for that document; other `/mobile/*` routes are refused.
  - The attention item is raised and closed.
  - Forget-self and bearer forget.
  - The `computers` field.
  - `POST /team/computer-limits` writes the row, out-of-range values are refused, and a second machine applies the new limit.
- **E2E:** a real server boot with both switches on:
  - the whole §3.1 path in headless Chromium with a real WebCrypto key;
  - a second server instance that accepts the comment row and shows the other-address state;
  - an expired computer's old comment still verifying;
  - adoption after a rebuild with a new machine identity at the same host, checked on a second instance;
  - a renew that arrives after the end it extended changing no verdict.
- **Wiring:**
  - the routes are mounted and don't answer 503 with both switches on;
  - confirm writes the ledger row and the bind row;
  - the sweep and the middleware use `computerStanding`, and neither is a no-op.

## 13. Frontloaded Decisions

1. **The anchor is the owner's team invite and the code on the owner's phone**, the same as for a member's first phone. No new trust root.
2. **No chaining.** A computer never adds another computer, on any address. Each computer comes from the owner's invite, or the member's phone (§3.6a).
3. **Same scope as a phone-linked computer**: documents (guests read only), one Send template.
4. **Staying in by use**: 30 days from last use, at most 90 days from joining, then a new invite. These and the allowance are replicated limits, agent-wide or per person, applied at admission.
5. **One address per computer**, with a way back from any other address (§3.6).
6. **No app change required.** App improvements are filed, not dependencies.
7. **WebCrypto keys, not WebAuthn passkeys** (§13a).
8. **Ships dark** with documents: on where documents and the browser switch are on (development agents), off for the fleet until documents go to the fleet.
9. **This is the project Decision 14 names.** This change amends the documents spec's Decision 14 from "until the passkeys project ships" to "until members can comment from any computer without the app (docs/specs/member-browser-any-computer.md)". §13a here explains why passkeys were not the means. The goal is unchanged; only the means changed. `docs/specs/**` is not on the protected list (`.github/CODEOWNERS`), and the recorded instruction reserved the goal, not the method, so the amendment is the agent's call. The documents spec also named passkeys as the way to make page signatures stronger (its §8). This spec doesn't decide that trade-off. Giving up passkey-strength signing (a person's touch for each signature) is a security decision, so it is the operator's. The amended Decision 14 reads: documents go to the fleet only after members can comment from any computer without the app (this spec, shipped) **and** the operator has accepted WebCrypto signing for browsers. The acceptance is one Approve/Decline on a document that states the trade-off, asked when the fleet turn-on is proposed (documents Decision 10). Nothing in this change turns documents on for the fleet. Development agents use it dark meanwhile. Build step 6 amends both Decision 14 and the documents spec's §8 line that calls passkeys the planned strengthening.
10. **Team phone codes leave the PIN surfaces** as part of this change, ungated, for every agent (§3.3.7).

## 13a. Alternatives considered

- **WebAuthn passkeys for every write** (the earlier design's core). A passkey makes each signature need the person's touch, which would stop a compromised agent from writing silently. But the person can't see what they sign: the system prompt shows only the site name, and the challenge is an opaque hash. The page asking for the touch is served by the agent, so the agent could still swap the comment under a real touch. It would also ask for Touch ID or a security key on every comment, and some computers have no platform authenticator. That is little gain over this design's stated limit, for a lot of friction. Hardware-backed person presence belongs with the platform project (App Attest, CMT-008).
- **Chained enrollment** (a linked computer links the next one). It doesn't answer what vouches for the first computer. Every link in the chain is a computer key, weaker than a phone's Secure Enclave key. The earlier design's open findings sat in the chain: cascading revocation, expiry inheritance, and laundering a short link into a long one.
- **One computer on every address ("siblings")**, round 2 of this review. The computer would hold one key per machine address, each added by a cross-origin handshake signed by an existing key. Rejected, because the review found the handshake brought back the chained-enrollment problems in a smaller form:
  - recovery after one address's storage is cleared;
  - root loss;
  - proving two keys sit in one browser;
  - trusting each peer's self-reported address;
  - a member stranded mid-handshake on a machine that is down or older.

  One address per computer, with a way back (§3.6), costs a new invite only when a home machine is lost.
- **The owner taps Approve instead of reading out a code.** Team phones are deliberately code-only (team-roles §3.4). A tap on "a computer wants in" can go to the wrong waiting device. A code reaches only the device whose person was told it.
- **A link sent to the member's Slack or Telegram account.** The agent runs those bots, so the link would be as strong as the agent, not the owner. Many members have neither account.
- **A dashboard PIN for members.** The agent can read the PIN, and a PIN is a shared secret, not a person.
- **One stable address for all machines.** That would make every computer work on every machine. It needs a Cloudflare load-balanced hostname per agent, which is a separate infrastructure project. Per-machine links already posted would still exist.

## 14. Open questions

*(none)*

## 15. Rollback

Turning off `documents.enabled` or `mobilePairing.browser` does three things:
- every route here answers 503;
- computers stop working (existing checks);
- new links carry no `j=1`.

Rows stay in the log, harmless.

Reverting the code:
- Older builds drop the new row shapes, so joined computers are not accepted there; their rows read pending.
- The home machine of a joined computer revokes it on its first sweep, for good. The member joins again with a new invite after a re-upgrade.
- Team phone codes reappear in the PIN listing.
- Phone-linked computers are unaffected.

## Maturation plan

- **test-agent-live:** §10 on a throwaway two-machine agent.
- **dev-agent-live:** Echo, with Justin inviting a test member who uses only a computer, for a week.
- **fleet:** with documents (Decision 10 of the documents spec). This spec meets the first of the amended Decision 14's two conditions. The operator's Approve/Decline on the WebCrypto trade-off is the second.
- **graduation criterion:** a week on Echo with a member commenting from a computer only, with links opened from both of Justin's main machines; zero refused legitimate writes; zero computer reaching a non-document route in the audit.
- **ladder:** documents
- **dark-window:** if documents are not on for the fleet within 30 days of this landing, record why on the Maturation board with a new date.

## Left behind

Precision items not iterated on, and design items accepted or fixed at the round cap (details in `docs/specs/reports/member-browser-any-computer-convergence.md`):

- **Fixed at the round-6 cap, not re-reviewed:**
  - the advert carrier (`seamlessnessFlags.teamLogComputerRows`);
  - the sticky advert, with retired machines excluded and an attention item after a day;
  - the complete intended bind kept in the pending record;
  - Forget clearing drafts, key and pending state.

  The build's own tests cover each one (§12).
- **Accepted stated limits:**
  - rolling a machine back after computers exist holds that machine's team phones until it is re-upgraded or retired;
  - Send waits while the home machine isn't serving (as for team phones);
  - the relayed lookalike page (as for team phones and §3.6a item 6);
  - one address per computer.
- **Declined with reasons:**
  - forwarding Send to the lease holder: team phones have no such forward, and it would be a new inbound path;
  - the owner approving with a tap instead of a code (§13a);
  - the agent preparing a re-invite automatically: the owner reminder covers it, and an invite needs the owner's phone;
  - deriving exact values for the allowance and lifetimes: they are judgment-candidates the owner arbitrates (§6);
  - code-guess budgets: these are the existing pairing constants.
- **Precision:**
  - name the inverted device-authorization pattern (RFC 8628) and short-authentication-string comparison in §13a for outside readers;
  - a plain message when the computer's clock is outside the 5-minute window ("your computer's clock looks wrong");
  - coarse location instead of a raw IP on the waiting entry;
  - one line in `mobile-pairing-link.md` §2.3 saying `j` is an optional key every parser ignores;
  - split §3.5's long "Staying in" paragraph.
- **Queued to feedback:** team phones recorded as approved by `dashboard-pin` (fb-8dc58d7e-9d2); no owner notice for a waiting team phone (fb-ac5cd939-bd7).
