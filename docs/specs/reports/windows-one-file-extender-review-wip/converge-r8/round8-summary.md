# Round 8 (operator-authorized extra round, Chief of Staff 2229994d)

Fixed for the 4 round-7 items: Noise KK from maintained libraries (handshake-only signing, no per-frame signatures); cancellation reported separately from outcome-unknown, never auto-retried; `dispatching` written before send, unresolved = possibly executed; owner Lower/Remove accepted at any higher order number.

Round 8 reviewers (codex-cli gpt-6-astra, clean-door claude, internal security + lessons) confirmed items 2 and 4, item 3 mostly, and raised new DESIGN findings caused by the fixes, all now addressed in the text:
- Home-key rotation now replaces the X25519 static key too (bound by the new signing key), atomically, closing the connection; old static key refused (test).
- The software X25519 key is backed by the TPM device key `d` signing the handshake hash once per connection; no application data in handshake messages.
- PC writes `accepted` before running; home-stamped send time; device-scoped callIds; low-water mark; retry returns stored outcome / already-ran-result-lost / outcome-unknown.
- 256 KB chunks split into Noise messages of at most 65,535 bytes with reassembly and a vector.
- Offline release-recovery key for Justin replacing his phone; manifest expiry; minimum build as emergency stop; contradictory release-key sentence removed.
Precision also fixed: order-number jump cap (1,000), mismatch rule scoped, library-choice rule (named, released within 18 months, else KK over libsodium), Accept-CH / Critical-CH and both builds offered, Connect again deletes old keys and state, lifts stored under the mode's protection, invariant restated in Noise terms, Open questions lists Justin's checkbox question.

Status: the fixes for round-8 DESIGN findings have not themselves been re-reviewed. That confirmation pass is combined with the authorized follow-up round for Justin's checkbox answer. Approval stays off.
