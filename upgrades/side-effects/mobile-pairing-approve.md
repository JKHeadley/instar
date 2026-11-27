# Side-Effects Review — approve a waiting phone instead of retyping a code

**Version / slug:** `mobile-pairing-approve`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Implements docs/specs/mobile-pairing-approve.md. `src/server/mobilePairingRoutes.ts`: the one funnel `approvePending`, `approveByNonce`, `declinePending`, the contested marks, `POST /mobile/pairing-approvals/:id/approve`, the redeem and `GET /mobile/device` fields, the allowlist rows, a DM-failure branch that respects an approval made during the wait. `src/server/mobilePairingApproval.ts` (new): the owner phone's device-signed routes. `src/messaging/TelegramAdapter.ts`, `src/server/routes.ts`, `src/server/AgentServer.ts`: the `md:a:` tap and its wiring. `src/core/MobileDeviceKeys.ts`: `approvedVia: 'owner-phone'`, `approvedBy`. `src/core/MobilePush.ts`: `notifyHere`, a push not fanned out. `dashboard-pair/`, `dashboard/phones.js`, nav text: the button. `src/core/PostUpdateMigrator.ts`, `src/server/CapabilityIndex.ts`: awareness and migration.

Tier 2: identity and auth admission. Size: about 500 source LOC with awareness, about 800 test LOC. Effort: two spec review rounds, one cross-model pass. Round 1 found four design defects and round 2 refined the contested rule and named the remote token holder; all settled in the spec before commit.

## Decision-point inventory

- `approvePending` admission — add — pending, MSP, contested, pause, lease, another-phone-waiting, in enumerated states.
- Telegram Approve tap — add — the same verified, owner, private-chat check as the existing Decline.
- Dashboard approve — add — operator session, dashboard-pending, approval path.
- Owner phone approve — add — device signature, owner role, local TLS, presence signature, single-use challenge.
- Contested mark — add — set on a fixed event; removes the tap only.
- Confirm (`POST /mobile/device/confirm`) — pass-through — same answers; on success it marks phones left waiting as contested.
- Redeem — modify — adds fields and a tombstone; the DM wording changes when the feature is on.

---

## 1. Over-block

- Two phones legitimately paired at once, or an abandoned attempt still waiting: Approve is refused with "Decline the one that is not yours". Decline is one tap and the code still works, so this costs one tap.
- An honest phone contested after a stranger reused its link, or left waiting beside a code activation: it needs the code. Correct by design: the system cannot tell them apart.
- A tap accepted by a lifeline still on older code (unproven, before the guard arms) is refused. The code in the same message still works; the lifeline restarts itself.
- An MSP's phone gets no Approve. That is the point of the rule.

## 2. Under-block

- A thief redeems the link before the owner's phone opens it, and the owner taps Approve on an unexpected message without comparing the key. Stated residual in spec §4; the phone shows in Phones and removal is one tap. Number matching would narrow it, at the cost of the plain Approve the operator asked for.
- A compromised agent session tells the owner to tap Approve on a phone key it holds. Stated residual: social engineering, and no boundary exists to cross, because a process running as the agent's OS user can already write the device registry and read the PIN.
- A remote holder of the API token, who could never learn the code, can create a waiting phone and needs one owner tap to get an owner phone. This moves a stated boundary (mobile-device-keys §2.2); accepted with Approve on by default (spec §4), and the off switch restores the code-only boundary.
- The owner declines the wrong one of two phones, or the older expires, and the survivor can be tapped. Accepted: closing it sends every honest retry to the code.
- Two links on two machines on the dashboard path do not trigger the two-waiting rule, because each machine holds its own waits.

## 3. Level-of-abstraction fit

The funnel sits in the pairing service, with the existing registry, ledger and lease. Each surface only proves who is answering and calls the funnel. It reuses `operatorOnly`, `BoundSecretStore`, `verifyPresenceSignature`, `activeOwnerPhone` and the Decline nonce rather than adding parallel ones. No higher gate exists for this decision.

## 4. Signal vs authority compliance

Every check is an exact credential or enumerated-state check, with no pattern matching on content. Each is a deterministic policy over a closed domain, which docs/signal-vs-authority.md allows for an authority. No LLM and no brittle detector holds blocking power. The contested mark can only remove the tap and leaves the code and Decline.

## 5. Interactions

- Decline and Approve share one nonce and one lifecycle, so they cannot both apply.
- The code and Approve race safely: all paths run synchronously to the registry write, and `applyConfirm` rechecks `pending`.
- `scanInbound` voids a pending phone whose code leaks; its nonce is then pruned and a tap reads "ended".
- `/internal/telegram-callback` dedupe applies the same tap id once; a failed attempt can be retried by a new tap, which has a new id, and `failed` consumes nothing.
- The dashboard page's status line was cleared by its own refresh, which hid every button's answer including the existing decline. Fixed in `act()`.

## 6. External surfaces

New fields on the redeem answer and `GET /mobile/device`, which older apps ignore; `canApprove` on each approval row; new device routes; a new `approvedVia` value in the replicated key ledger, which peers store as a string and only display. The Telegram message wording changes; Approve removes its buttons and sends one short follow-up, and Decline replaces its text. New owner DMs: "Two phones tried to use the same pairing link" (once per link), and a record when an owner phone approves with Face ID. A `notice` push ("Something needs you", no phone name or key) goes to every push-registered phone on this machine, MSP phones included, when an owner phone there can answer; `notifyHere` has no way to target owners, as with other hub notices.

## 6b. Operator-surface quality

1. **Leads with its primary action:** on each waiting card, the phone's line, then the key condition, then Approve this phone, with the code below under "If the app asks for a code instead". A card that cannot be approved keeps today's layout.
2. **No raw internals as primary content:** the phone key is the one technical value, shown because comparing it is the safeguard. Refusals show a plain sentence, never an error code.
3. **Destructive actions de-emphasized:** "Not my phone — decline" stays a quiet link-style button on the page, below Approve. Approve itself is the consequential action, so its condition sits directly above it.
4. **Plain language at phone width:** the same button and paragraph classes the page already uses at phone width. Proven by DOM tests only; not yet looked at in a browser at phone width. The wait screen on the app and this page are part of the real-phone test.

## 7. Multi-machine posture

Machine-local by design for the credential (spec §6, marker there): a pending pairing belongs to the machine that redeemed it. Telegram: redeem needs the lease, so taps arrive at the holder; a lease move voids the pairing and a late tap reads "ended". Dashboard: the page and session are on the holding machine. Owner phone: must be paired there, and `owner-phone` is only named when one is. Nothing is forwarded. Generated URLs are unchanged. `notifyHere` avoids telling phones on other machines about something they cannot answer. The `approvedBy` field and contested marks are machine-local, like the row they describe.

## 8. Rollback cost

`mobilePairing.approve.enabled: false` (read live, no restart) restores today's message, answers and code flow and stops the two-phones notice. One difference stays: tapping Decline still replaces the message text, which is harmless. A revert removes the code. Phones approved stay paired as ordinary active rows. The CLAUDE.md lines would remain after a revert until a forward commit removes them; they would then describe a button that is gone, so a revert needs that one-line migration too.

## Older app builds

Checked against the shipped app (`apps/instar-ios/InstarApp/Pairing.swift`, `PairingCode.swift`), source only, not driven on a phone. It reads JSON as loose dictionaries, so new fields are ignored and it never reads `approvedVia`. It does not poll: its Confirm button needs a complete-looking code, and confirm then answers `active` for any code. So Approve keeps the code readable for it: the Telegram message loses only its buttons and a follow-up says to type the code, and the dashboard's "Approved" line repeats it. This corrects the first draft, which erased the code from the chat and would have stranded an older app on its code box.

## Second-pass review

Independent subagent, first read: "Concern raised: the off switch does not restore today's behaviour", with the link-reuse notice unguarded by the switch and the new DMs and push audience missing from section 6. Resolved: both note calls now check the switch and a test covers it; the notice wording is neutral so it is true for an MSP's phone too; section 6 and section 8 now state these, including the one remaining difference (Decline's message edit). No funnel, nonce, allowlist, migration or ledger issue was found. On re-read the reviewer answered: "Concur with the review" (read only; it ran nothing).
