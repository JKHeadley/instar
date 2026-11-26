# Set up approvals on a paired iPhone

**Version 2 uses one Face ID confirmation.** When you open an attempt on the paired iPhone, the responsible machine starts a local timer. If the attempt is left unused, the machine stops accepting new responses and records a cancellation. Once that cancellation is recorded, an old response cannot approve the phone. An approval already recorded stays in effect. The timer belongs to the machine handling the attempt. It does not promise an exact expiry across machines. Restart or a handover requires a fresh attempt and Face ID.

The notes below describe the earlier disposable prototype where they refer to a clock-based expiry. The version 2 flow stays off until the shared approval system and installed phone key are verified.


The proposed journey lets you prepare an iPhone to approve changes without sitting at Echo’s computer or scanning a code there. It starts from an approval account that you have already accepted. A fresh confirmation in your authenticated Chief of Staff topic names one specific iPhone and one enrollment request. The phone then shows what it will be allowed to do and asks for Face ID.

The link opens the right request. Its address carries no permission on its own. A forwarded or older confirmation, a different phone, or a changed request cannot complete enrollment. The existing Work Board decision remains a separate approval so you can see exactly what it changes.

The first prototype is a synthetic test of the match between the account, topic confirmation and exact enrollment request. It does not create an approval account or change a device. The live path still needs a safe way to establish account authority when no such account exists, plus a test of the installed phone and holder.

The private Telegram link will open the enrollment explanation on your phone. Tapping Start opens that explanation. If the private chat is already an accepted approval account, it can show the exact iPhone nomination directly. A new approval account needs its own explanation and acceptance before it can nominate the phone.

The Accept button in the test is specific to the exact private message that showed the nomination. A different chat, message, owner, or changed nomination cannot use it. The live flow must also record that the button was used, so a retry can recover the same result.

The isolated storage test now records a private Accept tap and its nomination together. A retry of the same tap retrieves the same nomination. A different tap cannot reuse that receipt or create another nomination for the same exact proposal. Turning on approvals from the phone is still a separate step.

The existing local enrollment now gets the first-approver record key from one place in the trust store. The tests verify that concurrent candidates still compete for the same slot and that the store remembers the result after reopening. This gives the future phone path the same key to use.

The trust store now checks that a local enrollment still belongs to the same first-approver slot when it writes the acceptance. An older request cannot claim a later slot after another device was accepted and withdrawn.

The private Telegram Accept check now refuses an offer for an earlier first-approver slot. The phone still needs to check that slot again when it records the final Face ID decision.

The private nomination now saves the exact first-approver slot with the proposal. An old nomination saved without a slot cannot be used to finish enrollment.

The enrollment fixture now checks that changing any part of the owner, phone, or approval request changes the proposal the owner would confirm.

The server and iPhone simulator use the same test bytes for the enrollment confirmation. The test signature is specific to the exact nomination, disclosure, device and paired address.

The existing mobile permission route can now ask a disposable iPhone to sign the separate enrollment confirmation after the test authority checks the exact nomination. The live agent still cannot issue that challenge.

The test server can now verify the signed enrollment response and pass the verified phone keys to its enrollment authority. The live agent still keeps enrollment off.

The disposable server now gives the exact paired phone its enrollment disclosure and lets it recover the earlier receipt. It reports separately whether approvals are still on.

The Telegram adapter now recognizes the private enrollment button and refuses forwarded or group-chat copies. The live bot still needs a nomination authority before the button can do anything.

The test nomination handler now checks that the exact private Telegram approval account was accepted before it offered enrollment and is still active when the owner taps.

The enrollment fixture now compares the saved offer with the current holder and exact phone. It refuses to continue when the holder, keys, address, disclosure, or slot has changed.

The test store can now recover the acknowledged private enrollment offer after restart. It keeps a digest of the button token and refuses attempts to change the offer or reuse the disclosure message.

The test flow now saves the offer only after Telegram acknowledges the exact private message and the offer is still current. A button sent just before the authority changes cannot start enrollment.

The private offer sender checks that Telegram accepted the exact enrollment message in the verified owner's private chat. This check does not activate delivery or enroll a phone.

The bot keeps the one-time Start command out of ordinary conversation. Only a direct message in the verified owner's private chat can reach the enrollment handler.

The server stores a fingerprint of the temporary Start token. A matching Start can open the exact offer once, and the token expires within ten minutes.

The server checks the owner and the machine responsible for enrollment before showing the offer and again when Telegram confirms delivery. If responsibility changes during delivery, the resulting button cannot nominate the phone.

The registry can now check the exact old key and retain evidence of the operation that replaced it. A later retry can recover that evidence from disk. Turning this on still requires both enrollment paths to share one durable reservation.

The two ways to set up a first approval device can share a reservation that survives a restart. Once one operation reserves the slot, a different operation must wait for recovery or a new slot. Production still needs to guarantee that the host has exclusive access to these writes.

The phone writer can now record which approved nomination belongs to the reserved slot. It can recover that exact record after a restart. The trust journal must still confirm the final acceptance before the phone can approve changes.

The version 2 server code can prepare the exact enrollment details the phone will confirm. Both cancellation and acceptance refer to the same attempt and check the exact details before they can proceed.

The new timer closes the attempt to new responses as soon as the machine checks it after the local timeout. If saving the cancellation fails, intake stays closed and the server can retry saving the same request.

The decision code now checks the signature against the exact phone key and preserves whichever exact decision was saved first. A retry can recover that same result. The shared approval system still has to save the decision.

The dark version 2 server handler checks that the phone signing the challenge matches the paired device, then hands confirmation or cancellation to the same shared authority. The authority must resolve the current owner, account, and policy inside its decision. A result is usable only when the witness records the exact operation. An unavailable or mismatched result leaves enrollment pending, and the handler cannot install a key itself.

An isolated test now connects the first-phone handler to the real witness storage code. The test checks that confirming one attempt can claim the first approval slot only in the same write that records the decision. Cancellation leaves the slot available. A previously confirmed decision can be looked up exactly without changing who can approve.

The isolated first-phone test also checks that the witness has the exact staged decision before it records an approval, and that a retry can recover only the original decision.

The unmounted Face ID verifier checks that the signed bytes identify the exact paired phone, dedicated key generation and assurance result. It checks the key and signature format and refuses a signature from the generic presence flow. It does not itself register a key or grant approval rights.

The isolated decision test now submits the dedicated Face ID proof to the witness. Missing eligibility, a changed key generation, or ordinary presence proof leaves the slot untouched. The exact eligible fixture can reserve it.

The new holder lifecycle closes the local approval window before it asks the witness to cancel. When the witness is unavailable, a second attempt stays closed. If approval already won, cancellation cannot reverse it.

The disposable registry can apply the exact approved change in the same write that checks the current witness decision. A changed decision or a handover that wins first leaves the write pending. The ordinary device registry is not touched.

A disposable server can now receive the first-phone proof over the existing signed phone connection. It checks the paired origin and exact device before processing the Face ID signature. Its reply reports what the witness decided. The ordinary device registry is still separate.
