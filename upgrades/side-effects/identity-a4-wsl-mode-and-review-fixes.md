# Side-Effects Review — WSL networking mode read, not guessed; review fixes on the home address (A4/A5)

**Version / slug:** `identity-a4-wsl-mode-and-review-fixes`
**Date:** `2026-11-20`
**Author:** `Echo (builder #45)`
**Second-pass reviewer:** `independent Opus reviewer, recorded below`

## Summary of the change

Tier 2 (identity, a network listener's bind rule, a credential file read). Four fixes on branch `echo/a4-lan-first-phone`
(draft PR #3518), from the spot checks in the outside-review verdict (1, 4, 5, 7):

1. **WSL networking mode is read, not guessed (MAJOR).** `wslNatAddress` inferred NAT mode only from the address and router
   sitting in 172.16.0.0/12. A mirrored WSL on a 172.16-31.x home network has that shape, so the listener would have bound
   the LAN address with the per-address limit skipped. Now `readWslNetworkingMode` reads the mode (WSL 1 is never NAT;
   `wslinfo --networking-mode` is authoritative; else the Windows user's `.wslconfig` `[wsl2]`/`[experimental]`
   `networkingMode` through `/mnt/c`, else WSL 2's default NAT; a `.wslconfig` changed after WSL started is unknown), and
   `wslBindPlan` fails closed: NAT binds WSL's NAT address (shape still checked); mirrored is closed unless the Windows app
   says it enforces the network rule (`windowsAppHandlesNetworkRule: true`), and then binds loopback with the per-address
   limit ON; unknown, WSL 1, virtioproxy, none and bridged are closed. The refusal comes before anything is recorded and,
   on the A5 path, before the credential is spent. `GET /mobile/same-network` reports `wslMode`.
2. **The two at-computer fields are one fact (#7).** `admittedAtComputer(d)` (either `admission` or `approvedVia` is
   `'at-computer'`) replaces the seven single-field checks; `DeviceRegistry.applyConfirm` refuses an activation that would
   make the fields disagree; a ratchet test fails on a new direct comparison in `src/`.
3. **Ceremony credential file: one handle (#4).** Opened once with `O_NOFOLLOW | O_NONBLOCK`; type, link count, mode and
   owner are checked with `fstat` on that handle, and the same handle is read. A link, a second name (hard link), a FIFO or
   a directory is refused.
4. **Owner actions are serialized (#5).** `openForOwner`, `allowCurrentNetwork` and `close` run one at a time in the order
   asked (a failed one does not block the next), so a port move cannot be undone by an open that started earlier and a
   close asked during an open is not lost.

## Decision-point inventory

- `SameNetworkListener.reconcile` / `openForOwner` WSL bind — modify — the bind decision now keys on a read mode (`wslBindPlan`), refusing more, never less.
- `SameNetworkListener.perAddressOk` — modify — the skip is decided with the bind plan (WSL NAT, or a test loopback override), never "inside WSL" as a whole and never in mirrored mode.
- `POST /mobile/phone-setup` — modify — a new refusal `409 wsl-networking-mode` (before the credential is spent) and the optional `windowsAppHandlesNetworkRule` field.
- At-computer approval checks (mobilePairingRoutes x6, mobileConsoleTicket x1) — modify — one helper, same or stricter answer.
- `DeviceRegistry.applyConfirm` — modify — refuses a mismatched activation (only reachable by a path that does not exist today).
- `spendCeremonyCredential` read — modify — same refusals plus hard link / FIFO / directory.

---

## 1. Over-block

- An agent in WSL without `wslinfo` and without Windows interop (cmd.exe unreachable) reads `unknown` and its home address stays closed. Before, a NAT-shaped address opened it. Intended fail-closed: the app can still pass its word only for mirrored, not unknown; `wslMode.detail` names the cause.
- An owner who edited `.wslconfig` without restarting WSL gets `unknown` (only on the fallback path; `wslinfo` is read first).
- A mirrored WSL with the app's word counts every caller as one address (they all reach loopback through the pass-through): 6 open, 40 a minute. Enough for one phone's setup; a busy home phone could be throttled. Stated in the spec's limits.
- A credential file with two names (hard link) is refused. Nothing writes one; `mintCeremonyCredential` uses tmp + rename (one name).

## 2. Under-block

- `wslinfo` is trusted as the running mode. It is WSL's own tool on the system path; anything that can replace it already runs as the agent's user (A4 limit 1).
- On the `.wslconfig` fallback, a policy-set mode (enterprise MDM) that overrides the file would be missed. Only on WSL versions old enough to lack `wslinfo`, which predate mirrored mode's general release.
- In NAT mode other WSL distros and Hyper-V VMs on the same virtual switch can still reach WSL's NAT address (stated in the spec, limit 3). Unchanged.
- The ratchet catches comparisons written as `field === 'at-computer'` (either order); a computed comparison (`d[f] === v`) would not be caught. None exist.

## 3. Level-of-abstraction fit

The mode reading lives with the other network observation (`SameNetworkNetwork.ts`), the bind decision is a pure function
there, and the listener applies it. The at-computer helper lives with the record type (`MobileDeviceKeys.ts`), and the store
enforces agreement where both fields are written. Serialization is inside the listener, the one owner of its state.

## 4. Signal vs authority compliance

- [x] No judgment-based block/allow. Every check is exact: a named mode from WSL's own tool or config, a file's type, owner, mode and link count, two record fields. Required reference: `docs/signal-vs-authority.md`. These are access-control floors (refuse when unproven), the kind the principle allows to block.

## 4b. Judgment-point check

No new heuristic. The address-range check is demoted from evidence to a shape check, under a read mode.

## 5. Interactions

- `reconcile` re-reads the plan each tick; a definite mode reading is cached for the process (WSL's mode cannot change without the WSL VM, and so this process, restarting). An unknown reading is retried each tick.
- The serial owner queue and the reconcile's own serialization compose: an owner action joins or starts a reconcile; the 15-second tick never waits on the owner queue, and owner actions never wait on each other's reconciles except through the queue.
- `close()` and the unused-close in `reconcile` both forget the app's word, so a later open must say it again.
- `stateOf` round-trip: `readState` now keeps `windowsAppNetworkRule` (a restart test caught it being dropped).
- The A5 credential path checks the WSL plan before spending; the PIN path refuses in `openForOwner` before anything is recorded.

## 6. External surfaces

- `POST /mobile/phone-setup`: optional `windowsAppHandlesNetworkRule` (exactly `true`), new error `409 wsl-networking-mode` with `mode`.
- `GET /mobile/same-network`: new `wslMode` (`{mode, source, detail}` inside WSL, null elsewhere); `held` may be `wsl-networking-mode`.
- The Windows app (piece 3c): in mirrored mode it must say it enforces the network rule and forward to `127.0.0.1:<port>`; it reads `bind` as before. Contract stated in the spec §3.1.
- Inside WSL the agent now runs `wslinfo` (and, only without it, `cmd.exe` and `wslpath`) when the home address opens or is reconciled, with a 5-second timeout.
- **Operator surface (Mobile-Complete):** no new operator action.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design, as before: the WSL mode is this machine's, the listener is this machine's, the app's word is stored
in this machine's `state/same-network.json` (never synced). The at-computer invariant is a property of each device record and
holds wherever the registry is read.

## 8. Rollback cost

Pure code revert. A stored `windowsAppNetworkRule` is ignored by the earlier code. No data migration.

## Conclusion

The WSL bind no longer depends on an address-range guess: the mode is read from WSL itself and every other case is closed,
and mirrored mode never loses the per-address limit. The other three fixes close review leads with tests that fail without them.

## Second-pass review

Concur with the review. Independent second pass (Opus, read-only), 2026-11-20. All four fixes do what was asked. Read: SameNetworkNetwork.ts, sameNetworkListener.ts, phoneSetupRoutes.ts, MobileDeviceKeys.ts, ceremonyCredential.ts, the at-computer call sites, and the five test files. Ran `same-network-wsl-mode`, `same-network-wsl-listener`, `at-computer-invariant`, `ceremony-credential` (39/39 pass) and the integration `phone-setup-ceremony-credential` (15/15 pass).

Checked and found sound:
- **Bind paths.** No path binds a LAN-reachable address inside WSL with the per-address limit off. NAT binds only after a definite `nat` reading plus the NAT shape check. Mirrored binds only `127.0.0.1`, with `perAddressLimit: true`. Unknown and other modes return before any bind. `deps.bindHost` is a test-only override and production (AgentServer.ts:2570) does not set it. `limitPerAddress` is set together with the bind, and a mismatch forces a rebind (sameNetworkListener.ts:443).
- **Unknown mode.** Unknown never opens. It is never cached, so it is re-read each tick, and it is refused even with the app's word.
- **Order of the refusal.** It comes before the credential is spent (phoneSetupRoutes.ts:350-353) and before state is recorded (sameNetworkListener.ts:315-320). The tests check both.
- **State file.** `windowsAppNetworkRule` round-trips through `readState`. It is dropped by `close()` and by the unused-close branch of the reconcile.
- **Owner queue.** It neither deadlocks nor reorders. No queued action calls another queued action. The 15-second tick never enters the queue, and `closeNow` waits for any reconcile in flight, so a close asked during an open wins. Removing the queue fails the "close during open" test.
- **At-computer checks.** No check in `src/` still keys on a single field. The ratchet has a positive control.
- **Credential read.** `O_NOFOLLOW` gives ELOOP on Linux and macOS, which maps to `unsafe-file`. `O_NONBLOCK` keeps a FIFO from hanging the open. `fstat` checks type, `nlink === 1`, mode and uid on the same handle that is then read. The test spies on the call order.

Findings:
- MINOR — phoneSetupRoutes.ts:519-531: `keyLedger.recordActivation(d, 'at-computer')` runs before `applyConfirm`. The new agreement check in applyConfirm (MobileDeviceKeys.ts:596) can now refuse that activation when a pending device lacks `admission`. That leaves a signed ledger activation row for a device that stays pending, and the route answers a misleading `409 not-pending`. No current path creates such a device (mobilePairingRoutes.ts:1359 always sets admission for computer setups). Fix: check `admittedAtComputer(d)` (or `d.admission`) in the route before writing to the ledger, and decline on a mismatch.
- MINOR — SameNetworkNetwork.ts:237-240,280 (the `.wslconfig` fallback only): `mtime > boot` uses `Date.now() - /proc/uptime`. If the WSL clock runs ahead of Windows (a known drift), a `.wslconfig` edited shortly after WSL started can read as already in effect. Combined with a mirrored→nat edit on a 172.16/12 LAN, that brings back the original bug: the LAN address is bound with the limit off. This only applies on WSL versions that have mirrored mode but no `wslinfo --networking-mode` (early 2.0.x). Consider treating a fallback `nat` reading on a 172.16/12 default route as unknown, or requiring a margin.
- MINOR — tests/unit/at-computer-invariant.test.ts: the ratchet exempts all of `core/MobileDeviceKeys.ts` and matches only single-quoted, single-line comparisons. A new direct check in that file, or one written with `"at-computer"` or a template literal, would pass. Narrow the exemption to the two named lines and accept any quote style.
- MINOR — sameNetworkListener.ts:250: `status().wslMode` stays null until the first open or reconcile has read it. The Windows app cannot learn the mode from `GET /mobile/same-network` before it decides whether to send `windowsAppHandlesNetworkRule`. Consider reading the mode in the GET when it is not cached.
- MINOR (stated in the spec's limits) — in mirrored mode with the app's word, every caller shares 127.0.0.1's budget (6 open, 40 a minute). Any LAN host the pass-through admits can use up the owner phone's budget. This is a denial of service, not a bypass.

**Author's handling of the findings (builder #45):**
- Ledger before activation: fixed. The activation route refuses a phone without `admission: 'at-computer'` (`409 not-at-computer`) before the key ledger writes anything.
- `.wslconfig` clock drift: fixed with a margin. The file must have last changed at least 10 minutes before WSL started (`WSLCONFIG_CLOCK_MARGIN_MS`), else unknown; tested on both sides. Treating every fallback NAT reading as unknown was rejected, because a NAT address always has the 172.16/12 shape, so that would close every WSL without `wslinfo`.
- Ratchet: narrowed to the two named lines of `MobileDeviceKeys.ts` (plus a line marked `at-computer-ratchet-ok`), and it now matches every quote style, with positive controls.
- `wslMode` before an open: `GET /mobile/same-network` reads the mode first.
- Shared loopback budget in mirrored mode: accepted and stated in the spec's limits. These fixes were not re-reviewed.

## Outside review (GPT, codex gpt-6.2-sol, read-only) and what changed after it

The second attempt ran with a neutral prompt and was not refused: `winapp-work/a4/gpt-review-2-20261120T121900Z.md`. Four BLOCKERS, each
checked against the code:

1. **Confirmed, fixed.** With no agent token configured, `authMiddleware` returned `next()` before device authentication, and
   the listener's gate checks only the device record and the route list, so a known home device id reached device routes
   unsigned. Now the middleware judges a same-network arrival FIRST, whatever is configured: the redeem and ping pass
   unsigned (one shared list, `SAME_NETWORK_PUBLIC_ROUTES`, used by the gate too); anything else needs `deviceAuth` to
   answer `ok` (no authenticator: 404; `none`: 401; `/internal/*`: 404).
2. **Confirmed, fixed.** The production document-device lookup never carried `addressKind`, so the page's same-network
   check was dead, and an at-computer phone could sign document decisions. `notADocumentDevice` / `notADocumentDeviceRow`
   (documentPageRoutes.ts) now refuse a home phone and an at-computer phone, from the local record and from a replicated
   activation row (its `approvedVia`, or a `<name>.local:<port>` host, which only home addresses have).
3. **Confirmed, fixed.** On the `.wslconfig` fallback a missing file read as the NAT default, and a file removed after a
   mirrored WSL started leaves no trace. A missing `.wslconfig` (with `wslinfo` unable to answer) is now unknown (closed).
   A file that is there and names no mode, last changed at least 10 minutes before WSL started, still reads as NAT.
4. **Confirmed in part, fixed.** The mint command could replace the file between the spend's check and its path-based
   write or removal, so an old try could overwrite or delete a fresh credential. Wrong tries are now counted in memory
   (never written to the file), and every removal first renames the file aside and continues only if it is the same
   inode that was checked (a newer one is linked back). Only the caller whose rename took the file can succeed. A
   cross-process lock was not added: the server is the only spender, and the remaining outcomes all refuse.

MAJOR leads from the same review: one fixed here (an approval notice is no longer pushed to an at-computer iPhone; the
filter ran for Android only). The rest are recorded for the identity session, not verified or fixed in this round:
the reconcile tick is outside the owner queue (an allow can answer ok while held); `mayMovePort` is read before the
queued open; `closeIfUnused` counts only active home phones while the tick counts pending ones too; the 15-minute
signing window can outlive the 30-minute pending expiry from redeem; a client-sent `deviceKind: 'computer'` is excluded
from the first-phone count. MINOR: the gate's forwarding-header list lacks `CDN-Loop` and `True-Client-IP`; no
`checkContinue`; `canApprove: false` missing from the retry and status answers. These fixes were not re-reviewed.

## Evidence pointers

- `tests/unit/same-network-review-2-fixes.test.ts` (the GPT blockers; each fails without its fix, checked by mutation).
- `tests/unit/same-network-wsl-mode.test.ts` (every mode x NAT address x app's word; every reading source), `tests/unit/same-network-wsl-listener.test.ts` (real TLS listener in each WSL case; serialization), `tests/unit/at-computer-invariant.test.ts`, `tests/unit/ceremony-credential.test.ts`, `tests/integration/phone-setup-ceremony-credential.test.ts` (WSL cases through the route).
- Mutation checks: removing the queue fails two serialization tests; restoring the old WSL per-address skip fails the mirrored test; removing the store's agreement check fails three invariant tests; restoring one direct field comparison fails the ratchet; the old path-then-read credential code fails both new handle tests.
- Live read on this WSL 2.7.12 machine: `readWslNetworkingMode()` returned `{mode: 'nat', source: 'wslinfo'}`, and with `wslinfo` disabled `{mode: 'nat', source: 'wslconfig'}` from the real `.wslconfig` through interop.

## Class-Closure Declaration

- **Class:** `unbounded-self-action` — **closure:** `guard` (enforcement: test).
- **Component:** `src/server/sameNetworkListener.ts` (owner queue + the 15-second reconcile).
- **Citation:** `tests/unit/same-network-wsl-listener.test.ts`.
- **How it converges:** owner actions run once each in order with no retries; the reconcile is unchanged in shape (one per 15 s, serialized); the mode reading runs at most once per reconcile with a 5-second timeout and is cached once definite.

## Third outside review (GPT, codex gpt-6.2-sol, read-only, of 3f13f9b0) and what changed after it

Record: `winapp-work/a4/gpt-review-3-20261120T164056Z.md`. It judged B1 and B3 resolved, B2 and B4 partly, named three
NEW BLOCKERS, and recommended not merge-ready. Each new blocker was checked against the code:

1. **Confirmed, fixed. The `.wslconfig` time and text could come from two versions.** The fallback read the file's time,
   then opened it again by path for the text; a save in between pairs an old (trusted) time with new text. Now the time
   is read again after the text, and any change, or a file gone by then, is `unknown` (closed).
   Over-block: a `.wslconfig` saved during the read reads unknown once; the next 15-second reconcile reads it again.
2. **Confirmed as correctness, not access; fixed.** A phone the production document lookup refuses (home address, or let
   in at the computer) could still get a page code from `POST /mobile/docs/:id/open`, a move or decision challenge
   (`moveGate`), and reach the decision delivery-receipt write; the later signed write then failed with a misleading
   error after spending the challenge. No write succeeded (every write path re-reads `deps.device`). Those three entry
   points now require `deps.device(id)` first (404 / 403, as for an unknown device). Normal owner phones are unchanged
   (the lookup answers them as before).
3. **Confirmed, fixed. Wrong tries reset on restart.** The count moved to memory in the last round. It is now also kept
   in `state/ceremony-credential.json.tries` (named under the credential's name so the never-written-over-HTTP prefix
   rule in `keyMaterialPaths.ts` covers it), naming the hash it counts for, so a newer credential starts at zero and
   the mint command never touches it. If the count cannot be written, the credential is removed (fail closed).
   A spend or removal clears it. No cross-process lock: the server is the only spender and the mint never writes it.

B4's partial residue: the checked descriptor closed before the inode comparison, so a freed inode could be reused by a
newer file and compare equal. The handle now stays open until after any removal, so the checked inode cannot be freed.
The other residue (a failed link-back after an aside rename drops a newer credential) happens only when an even newer
one is already in place, or on an I/O error; either way the app makes a new credential. Accepted.

GPT's REMAINING table marks four open items as merge-blocking (`mayMovePort` read before the queued open;
`closeIfUnused` counting only active home phones; the 15-minute signing window outliving the pending expiry; a
client-sent `deviceKind: 'computer'` leaving the first-phone count). They were left open in the last round and are not
fixed here; they are recorded for the identity session's decision before this draft leaves draft.

Evidence: each fix has a test that fails without it (mutation-checked: removing the re-read time check, the document
eligibility check, the persisted count, and the held handle each fails one test). Neighbour, ratchet, integration and
e2e files for the touched modules were run one at a time, all passing.

**Second pass on these fixes (independent Opus, read-only): concur on all three.** One related MINOR, fixed here:
`documentDecisionRoot` (AgentServer.ts) did not apply `notADocumentDevice`, so a Telegram-approved home-address phone
could be reported `canDecide`, sent a decision push, and counted as a deciding phone while `decideGate` refuses it. The
root walk now refuses such a device (wiring check in `same-network-review-2-fixes.test.ts`). Its other notes (a
replacement `.wslconfig` carrying an old time is not caught, as before; a corrupt count file reads as zero, writable only
by the agent's user) are accepted.

## Builder #47: GPT review 3's four lifecycle blockers and its non-blocking items

Tier 2 (security-sensitive: the home listener's lifecycle and the first-phone admission count). Size: 3 source files
(`sameNetworkListener.ts`, `phoneSetupRoutes.ts`, `mobilePairingRoutes.ts`), about 130 lines; the spec's §4.3; two
new test files (11 unit, 4 integration). One commit attempt planned; no spec review round (the spec text added states
the rules the code already follows).

1. **`mayMovePort` read before the queued open (blocker), fixed.** `openForOwner` takes `mayMovePort` as a function
   too; the route passes one. The listener asks it at the start (early answer) and again at the move, after every wait
   in the open; in that same synchronous step it stops the old server (which sets the bound port to none, so a redeem
   still in flight on an old connection reads no eligible host) and stores the new port. A redeem runs synchronously
   from taking its code to writing its pending phone, so a phone is either seen by the re-check or reaches no listener
   on the old port. Test: integration item 1 holds the move at its network read, redeems on the old port, then
   releases: `409 port-fixed`, the listener stays on the old port.
2. **`closeIfUnused` counted only active phones (blocker), fixed.** It now uses `homeAddressInUse` (an open setup, or
   a home phone active OR pending; the registry turns a lapsed pending row into `expired`, so a waiting phone counts
   only until it expires). Test: a Telegram-path phone waiting in the chat, a later setup cancelled: the listener stays.
3. **Signing window vs pending expiry (blocker), fixed; rule stated in spec §4.3.** The window ends at the earlier of
   15 minutes after the number and the phone's pending expiry (`signDeadline`; the setup records the phone's
   `expiresAt` at redeem). `signBy` reports that deadline. A number typed after the phone's pending state lapsed ends
   the setup (`phone-expired`). Over-block: a number typed in the last minutes of the phone's 30 leaves only those
   minutes to sign (the app signs on its next poll); before, it was told 15 minutes and then refused anyway.
4. **Client-sent `deviceKind: 'computer'` (blocker), fixed.** `activeOwnerPhones` no longer reads it; a browser and
   the app on the agent's own computer are excluded by server-written fields only (`client`, `localBinding`).
   Over-block: an agent whose only owner device is a Mac paired by its own QR code now answers `phone-already-paired`
   to a first-phone setup at the computer; that Mac is an owner device with approval power (`activeOwnerPhone` never
   excluded computers), so it approves the new phone as any owner device does.

Non-blocking items, all cheap, all fixed:
- **Reconcile tick outside the owner queue:** the 15-second tick (and the boot reconcile) now run through the same
  queue as open/allow/close, at most one tick waiting. An owner action no longer joins a tick that read older state.
  Interaction: `stop()` is unchanged (it sets `stopped`, so a queued tick stops the server rather than opening it).
- **Forwarding headers:** the gate's prefix list now includes `FORWARDING_HEADER_PREFIXES` from the browser-device
  check (adds `CDN-Loop`, `True-Client-IP`).
- **`checkContinue`:** the listener handles `checkContinue`, so Node no longer sends `100 Continue` before the gate;
  `writeContinue()` is sent only for a request the gate passed.
- **`canApprove`:** an activation retry by a phone already let in at the computer answers `{status, approvedVia:
  'at-computer', canApprove: false}` as the first success did; `GET /mobile/device` adds `canApprove: false` for such
  a phone (absent for every other device, so other clients see no change).
- **Shared loopback budget in mirrored mode:** not changed. In mirrored WSL the listener binds loopback with its
  per-address limit ON, and every caller arrives through the Windows pass-through from loopback, so the limit counts
  them together (6 open, 40 a minute): enough for one phone's setup, and a noisy caller can crowd out the phone. This
  is the spec's stated limit (§7 Limits, item 4); a per-caller budget needs the pass-through (3c) to enforce it or to
  pass the caller's address, which is 3c's work, not this listener's. Recorded, not fixed.

Signal vs authority: no new blocking authority. Items 1, 2 and 4 make existing refusals read live, server-owned state;
item 3 shortens an existing window to what the device authenticator already enforced.
Multi-machine: unchanged (machine-local by design: the home address belongs to the computer serving the agent).
Rollback: revert this commit; no stored format changes (the setup store is in memory, `phoneExpiresAt` included).

**Second pass on these fixes (independent Opus, read-only): concur on all four blockers and the non-blocking fixes.**
It traced the redeem handler (no await between taking the code and writing the pending phone) and found no remaining
move window; confirmed `signDeadline` (`expiresAt - 1`, refused when `now >` it) agrees with the registry's
`expiresAt <= now` expiry; found no deadlock from the queued tick (`stop()` is not queued). It noted the refusal text
"already has a phone" is inaccurate when the owner device is a QR-paired Mac: cosmetic, left as is.

Evidence (#47): each blocker fix has a test that fails without it (checked by restoring the three source files to
13566719: 9 of 11 unit and all 4 integration tests in the two new files failed). Neighbours: every test file that names
a touched module or the same-network/at-computer surface, plus the repo's ratchet/lint/invariant unit tests, 207
files, one at a time: all pass. Two rig issues were found on the way and are not product changes: this worktree's
`better-sqlite3` binary did not load (rebuilt in place), and a first version of the gate's header list imported
`FORWARDING_HEADER_PREFIXES` at module load, which an import cycle left undefined in 17 files' load order; the gate
now keeps a literal list and a unit test checks it covers every prefix of the browser-device list. `npm run lint` clean.

## Fourth outside review (GPT, codex gpt-6.2-sol, read-only, of 182e8a6c) and what changed after it

Record: `winapp-work/a4/gpt-review-4-20261120T174313Z.md`. It judged N2, L1 and L4 resolved; N1, N3, L2 and L3 partly;
named two NEW BLOCKERS; recommended not merge-ready. Each was checked against the code:

1. **NEW BLOCKER, confirmed, fixed: a home-address approver disqualified an eligible deciding phone.** The phone
   approval route lets an active owner phone approve (a Telegram-approved home phone passes `activeOwnerPhone`), and
   the round-3 decision-root change applied `notADocumentDevice` to every ancestor, so the approved ordinary phone lost
   `canDecide`, its push and its challenge. The root walk moved into `documentDecisionRootOf`
   (`src/server/documentDecisionRoot.ts`, called by `AgentServer.documentDecisionRoot`); it applies the A4 check to the
   deciding phone only and keeps the browser/computer/root checks on the chain. The source-text assertion became
   behavioural tests (a direct home phone and an at-computer phone are refused; the home phone's child keeps
   `telegram`). Under-block: none new; the ancestor's own approval power is the phone approval route's question.
2. **NEW BLOCKER, confirmed, fixed: a failed counter write could erase a counted try.** When the count's write failed
   and the removal's rename failed too, `removeChecked` still forgot the count, leaving the credential usable with a
   fresh count. Now the count is forgotten only once the checked credential is out of its path (re-checked by inode);
   a credential that could neither keep its count nor be removed is refused for the rest of the process; and any
   presentation of a credential already at three counted tries is refused (and removal retried) before the comparison.
   Residue, accepted: a count file that is unreadable or malformed reads as zero (the file is the agent user's own,
   0600, under the key-material rule), and a credential whose count write AND removal both failed regains its tries
   only if the server also restarts within its ten-minute life. GPT's further suggestion (seed the count at mint so a
   missing count fails closed) changes the mint command's contract with the Windows app; not taken here.
3. **L2 partly, fixed:** the automatic close is judged again inside the listener's owner queue
   (`SameNetworkListener.closeIfUnused`), so a setup started while a cancel's close waited behind its open keeps the
   address open. Test: overlapping start/cancel over HTTP.
4. **L3 partly, fixed:** the number route checks the phone's live registry row (a lease move or restart may have
   expired it after the redeem; it ends the setup `phone-expired`); an accepted setup now ends at its signing deadline
   even if the phone never asks; and the deadline sits five seconds before the pending expiry so the activation's
   ledger and registry writes (synchronous, one request) cannot straddle it. Over-block: a phone gets five seconds less
   at the very end of its 30 minutes.
5. **N1 partly, recorded:** a replacement `.wslconfig` that carries the old mtime still passes. Setting a file time
   backwards needs write access to the Windows user's profile, i.e. the Windows user, who can change WSL's mode
   anyway (and gains nothing from fooling this check). Not changed.

Tests: `tests/unit/same-network-review-4-fixes.test.ts` (4) and two integration tests; each fails with the source at
182e8a6c (checked by restoring the four source files and the old root walk).

**Second pass on the round-4 fixes (independent Opus, read-only): concur on all four.** No deadlock from the queued
close (its check is synchronous, nothing calls it from inside the queue, the activation path does not wait on it,
`stop()` is not queued). Two non-blocking notes, accepted: (a) the in-memory refusal of a credential whose count write
and removal both failed does not survive a restart (item 2's residue above); (b) a setup that passes its signing
deadline unpolled reads ended, but its waiting phone is declined only on its next activation call; until then that
phone (which can no longer be let in) keeps the home address open, at most until the registry expires it, 30 minutes
from its redeem. Neighbours (#47, round 4): the same 207 files plus the ceremony-credential and document tests, 213
files one at a time: all pass. `npm run lint` clean.
