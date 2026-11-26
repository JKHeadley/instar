# First-phone Face ID approval key

Status: dark protocol, with transcript positions agreed by Identity and Apple. No existing enrollment evidence qualifies automatically.

## Key and device binding

The native iPhone app creates a dedicated P-256 signing key in the Secure Enclave using private-key usage and `biometryCurrentSet`, with device-only storage and passcode-set accessibility. It requires Face ID as the device's biometric type, a fresh biometric-only context for each explicit signing action, and no passcode fallback. Failure, cancellation, lockout, an unavailable key or a changed biometric set stops the action. The old presence key stays separate. This key is never backed up, exported, or silently recreated for an enrolled record. Apple's [current biometric set policy](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset) invalidates the key after Face ID re-enrollment.

Provisioning begins only on the canonical HTTPS route of the current paired owner iPhone using its existing transport signature. The holder issues a fresh single-use registration challenge for an exact device ID, transport-key digest, owner revision, holder generation and incarnation, policy revision, canonical origin, dedicated public-key digest and the policy value `face-id-current-set-v1`. The app signs the exact holder-issued registration transcript with the candidate key after the local Face ID check. The admission record needs independent affirmative eligibility for that exact installed app, paired transport key and candidate public-key digest. Until a deployed verifier for that evidence exists, the binding remains pending. A device signature or app-provided policy string alone cannot establish eligibility.

The registration proof signs a compact UTF-8 JSON array with these positions in order.

```text
["instar.first-phone-approver.face-id-registration.v1",
 registrationId, nonce, holderMachineId, holderEpoch, holderIncarnation,
 ownerId, ownerGeneration, policyRevision, origin, deviceId, deviceKeyHash,
 faceIdKeyHash, expectedFaceIdKeyGeneration, "face-id-current-set-v1"]
```

Use the v2 nonce and canonical-origin rules and a separately issued, single-use registration ID. Encode holder epoch and binding generation as nonnegative decimal strings without leading zeroes. Generation zero represents an empty initial binding. The transport submission supplies the registration ID, public key, local assurance literal and dedicated signature. The holder reconstructs the signed bytes from its own stored challenge. The pinned installed-device rehearsal may use explicitly provisioned, independently checked evidence for the exact tuple. General rollout requires a verified way to establish eligibility for each binding.

Commit the candidate public key and its fingerprint as a purpose-specific binding on the exact device record. For the dedicated key, use canonical P-256 DER SPKI with an uncompressed point and lowercase hexadecimal SHA-256 of those exact DER bytes. The existing transport-key binding continues to use its established encoding. The shared synthetic vector in `tests/fixtures/first-phone/face-id-challenge-v2.json` pins both transcript types and the dedicated key encoding. Compare the verified owner, holder, policy, device identity and prior binding generation during the conditional write. The record carries the binding generation, policy ID and eligibility evidence reference. Initial registration grants no approver authority. Replacing or withdrawing a binding advances its generation and invalidates outstanding attempts through witnessed cancellation. Replacement requires a fresh authorized registration and eligibility check. The app never submits a new approval key to the approval endpoint itself.

## Confirmation profile

This is the Face ID profile of the ordered version 2 ceremony. Its confirmation transcript has a distinct domain `instar.first-phone-approver.face-id.v2` and preserves the existing ordered challenge fields in their original order, with the following changes. Replace the old presence-key digest in its original position with `faceIdKeyHash`. Append `faceIdKeyGeneration` as the canonical positive decimal string and `localAssurance` as the literal `face-id-current-set-v1` after the slot key. Encode the array as compact UTF-8 JSON using the existing v2 encoding rules. The app signs those exact bytes with the registered Face ID key and includes `localAssurance` and `faceIdSignature` in the signed transport submission alongside the challenge key, challenge digest and operation ID. The signature uses canonical unpadded base64url of strict low-S DER. The Face ID key signature covers the local assurance literal as part of the challenge. The literal reports the result of the approved app's local policy and is not Apple attestation of the specific biometric event or key ACL.

The server resolves the key from the verified device record, checks the exact binding generation and eligibility again at the commit boundary, compares the submitted assurance literal, and verifies the dedicated signature. The legacy v2 transcript and generic presence key cannot satisfy this profile. Keep the attempt key derivation stable so both confirmation and cancellation share the same reservation. Include the full revised transcript in the challenge digest used for the witnessed request and receipt. Failure leaves approval unavailable. No path substitutes a passcode, generic presence proof, bearer or another device.

## Evidence before enablement

Share a new synthetic Node and Swift vector for exact transcript bytes, digest, and signature. Check wrong key, generation changes, wrong domain, missing or changed assurance, transport identity substitution, and cancellation against a previously signed response. On an installed iPhone, verify a real dedicated-key sign with Face ID and refusal during fallback, cancellation, and when the enrolled biometric set changes, using a disposable enrollment for destructive tests. Keep production off until both the installed-device evidence and witness and registry fencing are verified.
