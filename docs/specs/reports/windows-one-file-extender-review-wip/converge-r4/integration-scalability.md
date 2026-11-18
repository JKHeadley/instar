# Round 4: integration/deployment + scalability review of windows-one-file-extender (draft 4)

Reviewer lenses: integration (migration parity, backup/restore, rollback truthfulness, multi-machine posture, mesh forwarding, the instar.sh drop dependency) and scalability (hot paths, stream relay, audit growth, load admission). Read-only. Code claims checked against this worktree's `src/` and `site/`.

## Round-3 integration/scalability findings: resolved in draft 4?

| Round-3 finding | Status |
|---|---|
| DESIGN: the same-network pinned-cert origin exists only in a draft spec (no TLS server or mDNS in src) | **Resolved.** v1 addresses are a tunnel or an existing Tailscale; same-network and hosted relay are tracked as later items. The new quick-tunnel option brings its own conflict with the mint path (finding D4). |
| DESIGN: revocation must be ordered before dispatch across machines (lease, fail-closed) | **Resolved by redesign.** One home machine holds both the socket and the decision, so Lower/Remove land before success is returned; phone-signed orders cover a cut-off home. Residual gaps: the restart gate (D5) and the orders slot (D1, D2). |
| DESIGN: split stores (records, holders, audit) | **Resolved.** The holders store goes away with the holder model; `computerExtenders` and `computerAudit` are separate. Putting audit in a replicated kind raises a new conflict with substrate retention (D8). |
| PRECISION: frames signed by the socket holder with a per-generation sequence | Resolved (home key, per-connection sequence). |
| PRECISION: phone gets the machine key set from the mint response | Moot. One home key is sealed in the drop. |
| PRECISION: bundled Ed25519 library in .NET | Resolved. |
| PRECISION: RECONCILER_ALLOWLIST | Named, but worded backwards (P1). |
| PRECISION: callers retry once after a holder change | Superseded. Forwarding retries now carry a duplicate-execution risk (D6). |

## DESIGN findings

### D1. The drop's first-writer-wins rule lets anyone who knows `d` block the beacon and the owner's orders indefinitely, not "by a window" (Address beacon; Owner orders)

`site/src/pages/api/pair-drop/[id].ts` answers 409 to any PUT on an occupied slot, and GET returns only the **first** slot holding a value (`for (const slot of also ? [id, also] : [id])`). The beacon and orders slots are named from a hash of `d` and the 120 s window, so every future slot name is predictable to anyone who has `d`. `d` is shown in the PC's QR (screen, photos, the remote-control session in the scam case), known to the phone, and replicated to every agent machine in `computerExtenders`. One 22-character PUT every 2 minutes squats the current slot:
- the home machine's (or new home's) record then gets 409, and
- a squatted *current* slot also shadows a valid *previous*-window record, because the GET returns the squatter's blob first.

So the spec's claim "they can occupy a slot to delay reconnection by a window" is wrong: the block lasts as long as the squatter keeps writing. More importantly, the owner's phone-signed Lower/Remove on the orders slot can be blocked the same way, which voids "cannot keep it working against the owner's order for more than about two minutes". This holds for any outside party who has `d`, and also for the home machine itself if the threat model includes a misbehaving home.

**Fix:** name slots from secrets, not from `d`:
- beacon slot = first 16 bytes of HMAC(beaconSecret, window), base64url (22 chars, matching `ID_RE`). The home machine makes `beaconSecret` and seals it to the PC in the pairing drop.
- orders slot = HMAC(ordersSecret, window). The phone makes `ordersSecret` and puts it in the same sealed blob, so it is known only to the phone and the PC. The phone gives the republishing machine a precomputed list of slot ids (for example, the next 24 h of windows, 720 x 22 chars) along with the signed order.

Have the PC read each slot in its own GET (or extend the route to return every non-empty slot), so a filled slot never hides another. Restate the guarantee as best effort: the drop is non-durable Runtime Cache and can evict.

### D2. Disconnected PCs read the drop at socket-backoff cadence, which hits the 60-per-minute per-address limit with a handful of PCs (Address beacon; Reconnect)

The firewall rule is 60 requests a minute per client address, over all of `/api/pair-drop/*` (mac-qr-pairing §5). The spec reads the orders slot "on every attempt while disconnected", and reads the beacon "with backoff" alongside the socket's full-jitter backoff, which starts at 1 s. In its first minute a disconnected PC makes about 7 attempts, each needing a beacon GET and an orders GET (one `also` per GET, so two requests), which is about 14 requests. The typical trigger is the beacon's own use case: the home machine restarts, its quick-tunnel address changes, and every PC drops at once. In that case 4 to 5 PCs behind one home or office NAT exhaust the address's budget within the first minute. The firewall then refuses that address, including Mac QR pairing from the same network.

When connected, one orders GET a minute per PC caps one public address at about 60 connected PCs. That is much less behind carrier-grade NAT, where unrelated Instar users share the address. The spec does not say what the PC does on a 429. If it treats a 429 like a 404, the owner's out-of-band order is silently lost.

**Fix:**
- Decouple drop reads from socket attempts: at most one drop poll per 60 s per PC (beacon and orders together), jittered, never faster, because records change only every 120 s.
- After a 429 or 503, wait at least 5 minutes before the next drop read.
- Treat 429/503 as "drop unreachable", never as "no order", and show it in the tray's state.
- State the per-address budget: about 2 requests a minute per PC, so about 30 PCs per public address.
- Add a live-proof row: 10 fake PCs behind one address through a home restart, with no 429.

### D3. Sealing beacon and orders records "to the PC's key `d`" assumes a CNG key that can both sign and do key agreement (Address beacon; Owner orders; Pairing hand-off)

`d` is the PC's P-256 signing key: it signs redeem, mode and requests, and is non-exportable, in Windows CNG and possibly the TPM Platform Crypto Provider. CNG separates ECDSA and ECDH algorithm keys. Whether the Platform Crypto Provider will create one P-256 key usable for both signing and ECDH (TPM2 ECDH_ZGen) is not established, and the software fallback needs the generic ECC algorithm with explicit usages. The Mac flow avoided this with a separate one-time seal key `k`.

**Fix (pick one and state it):**
- the PC makes a second non-exportable CNG key `e` (ECDH P-256) at pairing and sends it with `d` at redeem; records are sealed to `e`, or
- records are not sealed at all: they are signed, and the origin is not a secret that needs protecting from the drop, or
- seal with a symmetric key carried in the pairing drop (which D1's secrets already require).

Add a Windows test that runs the chosen operation on both the PCP and the software provider.

### D4. The existing mint and redeem paths refuse a quick-tunnel origin and apply Telegram approval gates that the extender flow does not use (Addresses; Pairing hand-off)

The spec offers "the free quick tunnel every agent can run" as a home address. The current code does not allow that:
- `POST /mobile/pairing-codes` takes its origin from `pairingOrigin()` (`src/server/mobilePairingRoutes.ts:1106`), which returns only a running *named* Cloudflare tunnel or a proven Tailscale own name. Anything else gets 409 `stable-address-required` (`:1466`).
- Redeem is gated by `redeemHostEligible` to the same two kinds of host.
- Mint also refuses with `approval-unavailable` when there is no Telegram/introducer approval path, or when the path is Telegram and this machine is not the lease holder (`:1470-1478`). Neither condition matters for an extender, whose only approval is the phone's presence signature on `/mobile/extenders/:id/approve`.

As written, the phone's "Connect a Windows PC" fails on most agents whose only address is a quick tunnel, and on non-lease-holder machines that have Telegram approval. Allowing a quick tunnel into the existing pairing path would also loosen phone pairing, whose code and links rely on a stable origin.

**Fix:** specify a separate extender mint/redeem path (or a `deviceClass: 'extender'` branch) with its own origin chooser that admits the quick tunnel, its own host eligibility for `/mobile/extenders/*` and `/computers/link`, and no approval-path or lease precondition. Leave phone and computer pairing's `pairingOrigin()` unchanged. Add a unit test that phone pairing still refuses a quick-tunnel host.

### D5. The restarted-home gate syncs only with the lease holder, so a revocation written on a third machine can be missed (Connection, liveness and revocation)

"The requesting machine writes a `pending-revocation` request row, and the home machine, after any restart, accepts no PC handshake until it has completed one `computerExtenders` sync with the lease holder (or is the lease holder)." Replicated kinds travel over `peer-http` with `eventual` freshness (`state-coherence-registry.json`, the mobile-device-key-ledger entry). That leaves gaps:
- If machine B wrote the row and B is not the lease holder L, L may not have pulled it yet when home machine A syncs with L. A then re-admits the revoked PC.
- If A is itself the lease holder, it syncs with nobody.

Phone-signed app orders on the drop partly cover this (subject to D1/D2). Console Removes carry only a machine signature and are not covered. The spec also names no existing "completed one sync with peer X" primitive.

**Fix:**
- A Remove or Lower requested on a non-home machine returns `applied` only when the home machine applied it. Otherwise it returns `pending` ("applies when <home> is back"), and success also requires the lease holder to acknowledge it holds the row, via a mesh RPC that returns the row's HLC.
- The home's boot gate pulls `computerExtenders` from every peer that answers within a bound, not only from L.
- Name the mechanism used to know a pull completed (a per-peer journal high-water mark from the applier) or specify it as new.

### D6. Forwarded calls ride a 5-second request/response MeshRpc with caller-side retries: long execs do not fit, and a retry can run a command twice (Agent side)

`MeshRpc` is a signed request/response envelope with a fixed command union and per-command RBAC (`src/core/MeshRpc.ts`). `MeshRpcClient.send` has a per-attempt timeout that defaults to 5,000 ms and leaves retries to the caller (`src/core/MeshRpcClient.ts:41-79`). A forwarded `exec` runs for 2 minutes by default (the caller may ask for more), so it cannot be a held RPC. A caller that retries after a timeout would submit the PowerShell command a second time. That cannot be undone, and the spec's own decision table marks PC commands irreversible.

**Fix:**
- New MeshRpc command types (`computer-call-submit`, `computer-call-status`, `computer-call-cancel`) added to the `MeshCommand` union and RBAC.
- Submit carries a caller-generated `callId`. The home machine dedupes by `callId` for the call's lifetime plus a margin and answers at once with accepted, `pc-busy` or `pc-offline`. Results come back by ticket or status poll.
- Stop, Lower and session end cancel by `callId`.
- Cache the per-session token verification ("checks the token's session against the issuing machine's record over mesh RPC") for a short time, so input and screenshot calls do not pay a second round trip each.
- Test: the same `callId` submitted twice runs once.

### D7. `DesktopMeshStreamRelay` is a live-display byte pipe, not a resumable file relay (Results and files)

`src/server/DesktopMeshStreamRelay.ts` (112 lines):
- forwards WebSocket frames between a browser and a peer's `/desktop-stream`;
- caps browser-to-target messages at **4,096 bytes**, so an agent-to-PC upload direction cannot use it;
- **closes** the pair when buffered bytes exceed 1.6 MB, by design, so the H.264 stream restarts on a keyframe;
- has no offsets, no resume and no disk spooling.

The spec's "ticketed stream relay (the DesktopMeshStreamRelay pattern) ... 256 KB chunks with resume by offset, straight to disk" is therefore almost entirely new code. The reused part is the signed upstream connect with a ticket subprotocol. The close-on-backpressure rule is also wrong for files: a slow caller disk would abort large transfers over and over. Callers are also sessions using HTTP, not browsers, so the receiving end is the calling machine's server writing to disk.

**Fix:**
- State that the file relay is new: a ticket-bound WebSocket (or chunked HTTP range) channel between the home and calling machines, in both directions.
- Use pause-on-backpressure (stop reading from the PC socket for that call id) instead of close.
- Fsync per chunk and resume from the last durable offset.
- Return the ticket's file path to the session when the transfer completes.
- Add an integration test that transfers a 1 GB file in each direction with a forced mid-transfer disconnect.

### D8. `computerAudit` as a replicated kind conflicts with the substrate's retention and budgets, and with "never deleted" (Audit; Stores)

Replicated kinds get bounded retention: the default is `maxFileBytes` 8 MB with `rotateKeep` 4 (`src/core/ReplicationBudget.ts:45-47`), and rotation beyond that drops the oldest files. They also get per-kind token-bucket rate caps inside an aggregate journal budget that throttles every kind fair-share, and a serve-read ceiling (`JournalSyncApplier.ts:95`). The registry comment says "replicated memory stores are small".

Audit is the highest-volume record this feature makes: one row per exec, file, open-url or input call, each carrying redacted command text, all day for an agent automating a PC. That means about 40 MB online and then silent rotation, which contradicts "archived by age, never deleted". It also competes with conversation and lease-adjacent kinds for replication bandwidth, and copies every row to every machine although the home machine is the only writer and is where every call runs.

**Fix:**
- Make audit **machine-local on the home machine** (single writer; append file per PC, archived by the Disk Steward), with `GET /computers/:id/audit` **proxied** to the home machine.
- After a move, the read also asks earlier home machines listed in the move rows (or the new home copies the tail once).
- If a cross-machine summary is wanted, replicate a small per-PC daily count row, not the call rows.
- Declare the registry retention for `computerExtenders` as class C with compliance hold (like `mobileDeviceKeyLedger`), because the default rotation would also prune it, against "never pruned".

## PRECISION findings

- **P1 (Stores).** "a reconciler registration (added to `RECONCILER_ALLOWLIST`)" is self-contradictory. The allowlist lists stores the reconciler does **not** cover, each with a reason (`src/core/ReplicatedStoreReconcilerWiring.ts:50-54`). Say: allowlisted with the reason "written only by the server extender routes on the home machine; no CLI path". Do the same for `computerAudit` if it stays replicated (D8 says it should not).
- **P2 (Who may call).** The cited `SessionManager.issueSessionToken` is `MemoryPrivacy.issueSessionToken` (`src/users/MemoryPrivacy.ts:441`), called from `SessionManager.ts:8491` only when the session is memory-scoped and memory privacy is wired. Points to settle:
  - The new owner-session token kind must not depend on memory privacy being on, which it is not on most agents.
  - Say where it is stored. Durable, like the `mps_` records, so sessions survive server restarts.
  - Say how it reaches each framework's session.
  - Owner sessions already running at update time have no token until they respawn; say so in the awareness entry.
- **P3 (Config).** `computers.enabled: false` in ConfigDefaults must be classified for the dark-gate lint (`scripts/lint-dev-agent-dark-gate.js` assertion C; `src/core/devGatedFeatures.ts` `DARK_GATE_EXCLUSIONS`). For example `action-bearing`, with its reason; otherwise the feature is dev-gated with `enabled` omitted. Also register a `/features` entry, so the switch's `effective` status is truthful.
- **P4 (Rollback).** The switch-off behaviour (cancel running calls, `feature-off` frames, sockets closed) needs the flag read live (`src/config/LiveConfig.ts`), or the spec must say it applies at restart (`off-after-restart`). A downgraded home machine answers 404 on `/computers/link`. Map 404, and any unknown refusal, to `unknown-device` behaviour so the PC neither removes itself nor spins.
- **P5 (Multi-machine posture).** These surfaces are missing a declaration:
  - the per-session token store: machine-local on the issuing machine, `physical-credential-locality` (held by that machine's session processes), verified by proxy;
  - the beacon and orders slots: external, not agent state, as the Mac spec words its drop;
  - the requesting machine's republish queue for pending orders: machine-local, but must be durable across restart;
  - where `/mobile/extenders/:id/approve` and redemption run: the home machine, with the phone's request proxied if the phone reaches another machine;
  - the audit read: proxied, per D8.
- **P6 (Owner orders).** Each window has one slot, and the first writer wins. A Lower and then a Remove in the same window would lose the second until the next window. Publish one "effective order" record (Remove supersedes Lower, with a sequence number), and have the republisher always publish the latest. Say the republish list persists across the requester's restart and stops at the home's confirming row or after a stated bound.
- **P7 (Beacon).** State the slot-id encoding: 16 bytes, base64url, 22 chars, to match `ID_RE`. Beacon and orders need two GETs per poll, since `also` takes one extra slot. A move record and an old home's address record compete for the same beacon slot; give move records their own slot, or have the old home stop publishing as soon as it sees the move row.
- **P8 (Beacon lifecycle).** The home machine publishes for every disconnected PC "while not connected", with no end. A PC wiped or reinstalled without telling the home machine (the leave notice is best effort) keeps 720 writes a day going forever, against the home machine's own per-address budget. Fix: after the PC's breaker point (7 days), publish only in windows aligned to the hour, matching the PC's hourly attempts, and have the PC read the aligned window. After a stated period (for example 90 days) without a handshake, stop and show "not seen since <date>" on the Devices page with Remove.
- **P9 (Cost).** "One read a minute per connected PC on the existing drop" is per-request-billed Vercel function plus Runtime Cache usage. At fleet scale, for example 10,000 connected PCs, that is about 430 M invocations and reads a month. Put the expected monthly cost in the graduation criterion, or slow the connected-PC orders poll (for example 5 minutes while the socket is healthy, 60 s once the socket has been silent past a heartbeat). Re-check the "about two minutes" claim against whatever cadence is chosen.
- **P10 (Load).** Admission is per PC (buffered bytes and PC load), with no per-session fairness. One session streaming files can hold the window while other sessions get `pc-busy` for minutes. Add a per-session share of the window, or round-robin of chunk frames by call id.

design: 8, precision: 10
