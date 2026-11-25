---
title: Enroll a first approver on the paired phone
slug: phone-only-first-approver
status: draft
tier: 2
---

# Enroll a first approver on the paired phone

An iPhone paired through Telegram can already prove possession of its device and presence keys. Approving changes is a separate permission. Ordinary chat pairing does not include it. The [Trust Is Earned by Work and Granted Only by the Person standard, In practice](../STANDARDS-REGISTRY.md#trust-is-earned-by-work-and-granted-only-by-the-person) allows an accepted approval account to authorize a first device. The approved App Trust Approval implementation spec describes the local path. Before enabling remote enrollment, update its first-device contract to document this accepted-account path and its separate phone presence check. The current acceptance service implements local app pairing and nomination by a current approving device. It has no route from an accepted approval account to a first phone acceptance.

An existing accepted approval account can approve an exact first-device nomination. Bind it to the current owner, holder generation, agent origin, device ID, device and presence key hashes, approved disclosure, expiry and first-acceptance generation. Reuse the existing authenticated private approval account flow for that exact nomination. Ordinary pairing history, a forwarded link and a dashboard PIN cannot supply its approval. If an accepted account is unavailable, keep the existing local enrollment path. No phone-only link is currently live for that case.

After account approval, a locator may open the paired agent in Changes to approve. It conveys no authority. The iPhone retrieves the verified nomination, shows the exact disclosure and takes a fresh Face ID confirmation. Consume the account nomination and first-acceptance generation with the phone presence proof, in a single durable decision. Record whether the nomination was stale, already used or accepted. Device or owner change, revocation, new first acceptance, wrong holder, missing nomination or expiry refuses. The pending Work Board policy remains a separate decision with its own exact display and confirmation. A single chat message can contain the journey without treating consent to enroll as consent to change the policy.

## Proposed phone text

**Turn on approvals on this iPhone**

Allow this iPhone to approve changes for Echo. Each change will be shown before you confirm it. You can turn approvals off in Changes to approve. Echo’s computer stores the list of devices that can approve. The list is not independently verified.

**Turn on approvals with Face ID**

After enrollment, show the exact **Review how the agent starts work cards** decision. If no request was created because there was no approver, reissue the unchanged saved policy proposal through the normal approval service and show the fresh request. If a current exact request already exists, reopen it. Verify both states.

## Frontloaded decisions

Reuse accepted-account authority and existing device presence. No agent enrollment, raw link approval, approval-account bootstrap, new authority migration or live issuance is in the first fixture. For a true single-open journey with no accepted account, the owner needs an independently verified enrollment authority first. The fixture can simulate a current account and proves the two proofs are required before making changes to the trust store.

## Decision points touched

- Invariant. The authenticated approval account nominates one exact current phone under the existing first-device standard.
- Invariant. The active paired phone must prove fresh owner presence over the exact nomination.
- Invariant. Enrollment must not apply the Work Board policy. It remains a separate signed effect.

## Open questions

Confirm the installed app's locator capability and verify the current owner's account acceptance on the serving holder. Define a locally verified recovery path if no accepted account is available. Any additional first-device authority needs review before implementation.

## Authenticated Chief of Staff nomination

The phone-only proposal starts from Justin's current Telegram-verified owner identity. The server prepares a short-lived first-device nomination and shows the exact authority change in the authenticated Chief of Staff topic. It names the paired phone and its key fingerprint, explains that the phone will be able to approve future exact changes, and distinguishes the pending Work Board decision. Justin's confirmation binds that nomination, not a general approval inferred from conversation. The screen and topic text use the same versioned disclosure.

Owner identity is established from the current owner registry, the authenticated Telegram ingress envelope and the exact configured Chief of Staff chat and topic. The server needs positive evidence of the direct sender, authentic ingress, source message ID, exact nomination challenge, and pinned proposal and key digests. Forwarded content, generic owner text, a session summary, a copied challenge and ordinary Telegram-pairing history do not count. Reject a stale owner generation, changed keys, changed holder, expiry, an existing approver, and any mismatch. A server-rendered locator carries no owner authority. The phone requires an existing owner device transport signature and a fresh Face ID presence signature from that device over the nomination and its disclosure.

The Trust Is Earned by Work standard names an accepted approval account as remote first-device authority. The current trust service accepts Telegram account decisions only in an authenticated private chat where chat and sender IDs match. A Chief of Staff forum confirmation is valuable operator-origin evidence but does not meet that private account rule. Use the authenticated topic decision as a prerequisite for the holder to issue a Start locator for the exact owner, paired phone and request. A private callback without an issued locator is refused. A topic confirmation by itself cannot nominate or enroll the phone. Under current policy, separately accept an approval account in the existing private Telegram flow if needed, then have that account approve this exact nomination before the phone confirms it. Any proposal to let the forum confirmation alone grant first-device authority needs an explicit review and owner-ratified change to the governing rule. Do not reinterpret or write a broad existing account acceptance from a group topic.

## Synthetic implementation order

First verify strict equality of the authenticated topic event and the prepared nomination with a disposable owner, phone, topic and key digests. No trusted ingress or write path is mounted in this test. Then prove one durable nomination and one-use enrollment compare-and-set at the current serving holder. Finally verify the native locator, the displayed disclosure and fresh owner presence against the exact record. The existing Work Board request retains its own signature and receipt. No host access or QR scan is part of the proposed owner journey.

### Review boundary

The synthetic fixture models a previously accepted approval account as a separate input. It pins that acceptance ID and requires it to predate preparation and confirmation. It also requires independently resolved approval of the exact proposal from that account. Recording account acceptance and nomination from the same topic event would not demonstrate that the account was already accepted. The live design still needs a decision on separate phone-only account acceptance versus a reviewed change to the governing standard. A holder must also share one first-acceptance slot across the existing local path and the nomination path.

Use one durable first-acceptance decision for local enrollment and remote nomination. Race both paths against the same generation and prove one accepted device survives restart. The owner can recover the outcome from that winning record after a lost response.

An eligible local key replacement that begins with no current approver competes for that same first-acceptance generation. If it commits first, it advances the generation and invalidates the pending phone nomination. If phone enrollment commits first, the replacement must reread the new state and may proceed only under the existing local replacement rules for an occupied slot. Verify both commit orders and the records after reopening. Removing key material does not itself change the durable slot. The verified holder must record withdrawal of the last acceptance before a fresh nomination can target the next empty slot. An earlier nomination remains stale.

The current iPhone presence key permits the existing device-policy fallback. A request for Face ID specifically requires separate evidence that the installed native flow uses the biometric-only prompt and a compatible key policy. The server cannot infer Face ID from a generic presence signature. Keep the proposed Face ID wording and enrollment off until native review and physical verification prove the promised behavior.

## Private Telegram entry

A private bot link carries only a random, short-lived Start locator. When the owner taps Start, the holder verifies the exact token against the current owner account, the private Telegram sender and chat, current holder and lifetime. The link never approves anything. Ingress must also exclude bot, forwarded, edited and alternate-sender updates, and the holder must use an acknowledged disclosure message and a one-use callback bound to that message.

If the private approval account is already accepted, the button can say **Approve this iPhone** and authorize only the exact nomination. If the private account has never been accepted, show the account authority and withdrawal disclosure first. The current rule requires that acceptance to precede the exact nomination. Start cannot double as consent to that disclosure. For a previously unaccepted account, Start locates only the enrollment request. After account acceptance commits, the holder prepares a fresh nomination with the new acceptance ID and live slot. Any proposal prepared before the acceptance remains ineligible. Both Telegram steps can occur on the same phone, with no host access or QR, followed by Face ID in Instar. A draft to collapse the two private-chat decisions into one explicit consent event requires separate review before release.

Use the same server-rendered agent name, paired device name and key fingerprint in the private Telegram nomination and on the iPhone. The Telegram button names the nominated phone even if the owner is reading the message on another device. Suggested disclosure: **Allow Justin’s iPhone, key 0123-4567-89AB-CDEF, to approve changes for Echo. You’ll confirm on that iPhone with Face ID.** Verify two pending nominations separately so each signed decision can apply only to the exact phone named in its disclosure. The pending Work Board policy is shown separately after enrollment.

## Holder and replacement recovery

The server must have affirmative evidence that it is the current verified holder for issuance, nomination, and the final acceptance write. Bind the holder epoch to the proposal, and make the durable writer check it at commit. Absence of a lease provider cannot authorize any of these operations.

The existing local replacement changes the device key before the trust journal records the replacement. Before enabling phone enrollment alongside that path, require both contenders to share one durable slot decision. Local replacement must reserve the slot before mutating the key and pin the prior key, proposed key and exact operation ID. A lost race changes no key. A pending reservation blocks both first-device paths. Recovery checks the durable key state and trust journal for that exact operation before completing or releasing it. An ambiguous outcome leaves both paths unavailable and cannot generate a successful receipt.

The disposable simulator proof may use a previously accepted synthetic approval account and a single isolated durable holder. It must keep the current unfenced replacement path unavailable, prove that refusal, and simulate the competing reserved write and crash outcomes without production keys, routes or an owner locator.
