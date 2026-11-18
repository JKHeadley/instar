# claude-code claude-fable-5-2 ok SERIOUS ISSUES
**Reviewer note:** I am Claude (Fable 5.2), not a GPT-tier model, so this review does not provide the cross-model independence the prompt assumes. Findings are grounded only in the inlined spec text.

**Verdict: SERIOUS ISSUES** (one serious, two smaller DESIGN, the rest PRECISION)

**DESIGN**

1. **Updates: the release key is a fleet-wide code-execution root held by an agent.**
   - The same exe serves every person, and it trusts any manifest signed by one Ed25519 key "held in the agent's vault".
   - That manifest also defines which Authenticode publishers are allowed, so the key holder can list any Artifact Signing identity. The Authenticode check therefore adds no independent protection.
   - The spec itself says the agent reads web pages and email, and that its sessions can read each other's credentials. Compromise of one agent's vault means code runs on every connected PC, including Look-only ones.
   - There is no rotation or revocation path for the release key.
   - Resolution: keep the key off the agent (hardware-held or owner-held, or a threshold signature), compile a publisher allowlist into the binary so both checks must pass, and specify key rotation.

2. **Owner-signed records have no freshness (§ "The PC checks the agent").**
   - Order N+1 is valid indefinitely. A home machine that withholds a signed raise can deliver it days later, as long as no other owner-signed order has consumed that number.
   - Lowers from the tray or web console are home-signed frames and do not advance the number, so they do not invalidate the withheld raise.
   - Resolution: bind each order to a PC-issued nonce from the current handshake, or add a short expiry.

3. **Stores vs Remover contradict each other.**
   - `computerExtenders` rows are "accepted only under that machine's pinned identity key", yet after Connect again "the old record is revoked by the new home machine".
   - With the old home dead (the main reason to move), no one can validly write that revocation.
   - Resolution: define a supersede row authorised by the owner's presence signature.

**PRECISION**

- **Mode protection:** a P-256 CNG signing key produces a signature, not a "MAC". Also state what the order number becomes when the state file fails its check; it must never reset.
- **Scam safeguards:** the remote-control process list and the 8/30-second waits are easy to sidestep. A phone-call scammer needs only a QR screenshot or the paste path, and no proximity is proven. State that these are friction, and name signed-binary abuse (reputation loss, certificate revocation) as a release risk.
- **Sign-in notice and session toast:** Windows Do Not Disturb suppresses toasts. Use the program's own window for the per-session signal.
- **Locked or sleeping PC:** no behaviour is defined for screenshot or input on the lock screen or the UAC secure desktop. Add a `pc-locked` result.
- **Look-only credential list:** it omits password-manager databases, Outlook data, other Chromium browsers and `.gnupg`. Say the list is illustrative.
- **`update-required`:** no backoff is specified if the manifest fetch or verification keeps failing.
- **Alternatives:** per-user OpenSSH and embedding an existing agent (MeshCentral, RustDesk) are not weighed. One sentence on why they were rejected would do.
- **Caller filter:** the "who may call" filter and its loss after non-owner input are admitted non-boundaries. The real control is PC-side mode enforcement, and the spec should say so up front.
