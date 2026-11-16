# Side-Effects Review — Pair a computer from an owner phone (QR pairing for the Mac app)

**Version / slug:** `mac-qr-pairing`
**Date:** `2026-11-15`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Spec: `docs/specs/mac-qr-pairing.md`. Tier 2 (it touches device pairing, an identity surface). Size: server ~60 lines in `src/core/MobilePairing.ts`, `src/core/MobileDeviceKeys.ts`, `src/server/mobilePairingRoutes.ts`, `src/server/mobilePairingApproval.ts`; one new site route `site/src/pages/api/pair-drop/[id].ts` (~70 lines), one static page `site/src/pages/pair-mac.astro`, one pinned dependency; one awareness entry; tests in all three tiers. Spec review: 3 rounds (Fable + Astra each round, Standards-Conformance Gate each round).

What changes on the agent: an owner device may call `POST /mobile/pairing-codes` over its device-signed channel with `forDevice.publicKey`. The code it gets is always the owner's, lives 5 minutes, is limited to 5 device mints an hour inside the existing shared 10, and can be redeemed only by that public key (`wrong-device` otherwise, code spent). A redeem that is key-bound, or that says `deviceKind: "computer"`, records `deviceKind: 'computer'` (display only) so the owner's Telegram message and the waiting list name a computer. On instar.sh: a best-effort mailbox that holds a sealed blob for 120 s.

## Decision-point inventory

- Device mint allowed? — owner devices only (existing `ownerOnly` rule machinery) — **added** rule, invariant: minting grants nothing.
- Redeem key equals bound key? — **added**, invariant: refusing costs a re-scan, allowing lets a copied link add another device.
- Device mint limits (5 min, 5/h) — **added**, judgment-candidate with a floor (the agent keeps at least 5 of its 10 hourly mints).
- Drop slot occupied → 409 — **added**, best-effort convenience; never what pairing safety rests on.
- Activation of a device — **unchanged**: every existing approve path, nothing new.

---

## 1. Over-block

- A sixth computer from one phone in an hour is refused (`too-many-mints`); the person waits or pastes a link. Accepted: ordinary use is one or two.
- A device code older than 5 minutes is refused; the phone's words say scan again.
- A real computer whose key differs from the QR's `d` (it cannot: the Mac makes `d` and redeems with it) — no legitimate case found.

## 2. Under-block

- An owner who scans someone else's QR and approves it with Face ID adds that computer. Mitigated by the warning words, in-app-only scanning and the Mac's confirm step; accepted as inherent in the approved flow (spec Frontloaded Decision 11).
- The drop point has no limiter of its own; a platform firewall rate rule is configuration. Abuse can only deny QR pairing; paste still works.

## 3. Level-of-abstraction fit

The change reuses the existing mint route, code store, device registry and the owner-phone approve funnel rather than adding a parallel pairing path. The mailbox is the smallest new piece the approved design needs. No higher gate exists that this should feed instead: activation already has one funnel and it is untouched.

## 4. Signal vs authority compliance

No brittle check gains blocking authority over a judgment. The new refusals are exact tests over recorded state (owner role, key equality, counts with a stated floor). `deviceKind` is display only and decides nothing. Reference: `docs/signal-vs-authority.md`.

## 4b. Judgment-point check (Judgment Within Floors standard)

"Is this my Mac / my agent" stays the person's judgment (Face ID step on the phone; confirm click on the Mac). Key equality is the floor under it, never the judgment itself. The mint limits carry a floor and an arbiter (operator, from observed refusals).

## 5. Interactions

- Shares `MAX_MINTS_PER_HOUR`/`MAX_LIVE_CODES` with the bearer mint; the device cap of 5 keeps the bearer's share.
- The waiting list's `client` gains the value `computer`; older apps read any unknown value as a phone (their existing default), so nothing breaks.
- The Telegram approval message wording branches on `deviceKind`; the code line and buttons are unchanged.
- The activation ledger (`MobileDeviceKeyLedger`) writes `client` only for browsers; `deviceKind` is not written there and does not affect signed rows.
- `wrong-device` runs after take-and-delete and after the bound-origin check, so it cannot be used to probe codes without spending them.

## 6. External surfaces

- New public route on instar.sh: `PUT/GET /api/pair-drop/:id` (ciphertext only, no logging of bodies or ids), and a static `/pair-mac` page. No change to the universal-link association.
- New device-callable route on every agent (owner only).
- Depends on Vercel Runtime Cache (non-durable, per region). Failure mode: QR pairing says "isn't reachable" and paste works.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The operator sees: a QR on the Mac, a confirm step leading with the host, a kept result with Remove, and on the phone a per-agent reason when an agent can't be used and a plain warning before pairing. Telegram's message now names a computer. Every message says what to do next.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Pairing codes and `boundKey`: machine-local by design — machine-local-justification: physical-credential-locality (a code is bound to the minting machine's stable origin; redeem must arrive there).
- `deviceKind`: a field of the existing device registry record; same posture as that registry.
- The mailbox: external, not agent state.
- No user-facing notice is added beyond the existing owner DM (one voice, unchanged).

## 8. Rollback cost

Revert the commit and release. Device codes expire within 5 minutes; computers already paired stay paired (approved the normal way). The site route can be deleted independently; the apps fall back to paste. No data migration.

## Conclusion

Additive, owner-only, no new activation path, a reversible site route. Ready to commit after the second-pass review concurs.

## Second-pass review (if required)

Required (device pairing is an identity/trust surface).

Concur with the review. Traced independently: the new device rule (`src/server/mobilePairingRoutes.ts:2598`) is `statuses: active` + `ownerOnly: true`, so the middleware (`:2874`) refuses pending, MSP, team and unassigned phones, and browser devices are refused because the rule is not in BROWSER_ROUTES (`:2853`); a bearer caller is `principalOf` kind `token`, so `forDevice` is ignored and the bearer mint is unchanged. A device mint forces the owner person and only creates a pending record through the single `svc.codes.redeem` call site; activation still needs an existing approve path. The key check (`:1300`) runs after take-and-delete and after the origin check, so a wrong-key redeem spends the code and cannot probe; `wrong-device` reveals only that the (already spent, 128-bit) code was bound. The device cap is checked and pushed only when `boundKey` is set, inside the shared 10 (`src/core/MobilePairing.ts:116-122`), no off-by-one. `deviceKind` is read only for Telegram wording (`:1365-1369`; code line and buttons unchanged) and the waiting list's `client` label (`mobilePairingApproval.ts:89`); no authority decision reads it. The drop route passes an identity `keyHashFunction`, logs neither body nor id, stores only bounded base64url blobs. Minor, non-blocking: `storeFromEnv()` is called outside the `try` in `site/src/pages/api/pair-drop/[id].ts` (`handle`), so a synchronous throw from `getCache` would surface as a 500 instead of 503, and the full body is read before the 8 KB size check (bounded by the platform request limit). Device mints share the hourly 10, so 5 device mints leave 5 bearer mints that hour, which the spec accepts. No brittle check gains blocking authority over a judgment.

## Evidence pointers

- Results (2026-11-15): `tests/integration/mac-qr-pairing.test.ts` 7/7, `tests/e2e/mac-qr-pairing-alive.test.ts` 1/1, `tests/unit/site-pair-drop.test.ts` 7/7; existing pairing unit tests (`mobile-pairing`, `mobile-app-people-roles`, `mobile-browser-devices`, `browser-device-taps`, `mobile-pairing-word-code`) 138/138.
- Live on the throwaway agent (`mac-proof-1114.dawn-tunnel.dev`, this branch's build): the seeded owner phone's device-signed mint answered 200 with a 5-minute expiry and the owner person; the iPhone app in the simulator paired with the agent and was approved as an owner device.
- Changes after the first draft of this review, reviewed in spec rounds 4 and 5: the Telegram line names the computer's label as its own claim ("it calls itself …"); the drop point reports the cache path it used (`X-Pair-Drop-Store`) and a per-load instance tag (`X-Pair-Drop-Instance`), and refuses the library's per-instance memory fallback (503). Neither changes a decision point above.
- Vercel firewall rule `rule_pair_drop_rate_limit_mac_qr_pairing_tMGnnC` (project `instar`): `/api/pair-drop/` prefix, 60 requests a minute per address, deny. Live check 2026-11-15 16:36 PT: 70 parallel requests from one address, 60 answered, 10 refused with 403. Rollback: delete this rule with the route.
- Full live run on the branch's preview deployment (2026-11-15 16:31 PT, throwaway agent `mac-proof-1114.dawn-tunnel.dev`): signed Mac app QR → simulator iPhone scan → owner-phone mint → sealed drop → Mac confirm → Face ID approve → Mac active and listing the agent's conversations. Also live: drop point unreachable → the Mac's fallback words and a working paste pairing; expired code refused; wrong-key redeem refused (`wrong-device`, code spent); second writer to a slot refused (409); the health check served from the platform cache (`context`) across up to 7 instances (`shared-proven`). Pending: a physical iPhone camera scan and real Face ID (no device attached to the agent's machines).

- Integration: `tests/integration/mac-qr-pairing.test.ts`. E2E: `tests/e2e/mac-qr-pairing-alive.test.ts`. Site: `tests/unit/site-pair-drop.test.ts`.
- Spec reviews: `.instar/lanes/mac-qr/{fable,astra}-r{1,2,3}.md` in the agent home.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
