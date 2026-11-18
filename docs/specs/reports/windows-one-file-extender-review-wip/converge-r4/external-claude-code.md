# claude-code claude-fable-5-2 SERIOUS ISSUES
**Reviewer note:** I am Claude (Fable 5.2), not a GPT-tier model, so do not count this as cross-model independence. Reviewed only from the inlined text.

## Verdict: SERIOUS ISSUES

**1. DESIGN — The orders channel can be blocked by the party it is meant to bypass (§Connection, "Owner orders…").**
The Mac spec's §5 defines the drop as unauthenticated and first-writer-wins (409 if occupied), "best effort", with "safety never depends on it". Slots here are named by a hash of `d` and the window, and the home machine knows `d`. A cut-off or compromised home machine can therefore pre-fill every orders slot, and the "about two minutes" bound does not hold. The beacon has the same problem: squatting every window is a persistent block, not a one-window delay.
- **Resolution:** have the PC derive slot names from a secret shared only with the phone at pairing, or drop the two-minute claim and state the bound as best effort.

**2. DESIGN — Phone-signed records have no stated replay protection (§The PC checks the agent; §Changing mode).**
Only the move record carries a counter (`moveSeq`). A raise frame is relayed by the agent, so after a later Lower the agent could replay it. Lower/Remove orders, phone-key change and home-key rotation frames also have no stated freshness. Frame sequences are per connection and not stated as bound to the handshake challenge, and TLS terminates at Cloudflare.
- **Resolution:** give every phone-signed record a PC-issued nonce or a monotonic per-device counter, plus `deviceId` and type; bind frame signatures to the handshake nonce.

**3. DESIGN — What authorises self-removal is contradictory.**
Decision points and the integration test say only a revocation row signed by the home key triggers removal. The orders section says a phone-signed Remove runs the remover.
- **Resolution:** pick one rule and say what a superseded home key can still do after a move.

**4. DESIGN — The pinned publisher OID has no rotation path (§Updates, §Building).**
The spec itself anticipates falling back to SageMind signing. Any identity change or re-validation would leave every fielded build unable to update, and "retire by raising the minimum build" would strand those PCs.
- **Resolution:** pin a set of identities, or an offline root that signs the manifest's allowed-publisher list.

**5. DESIGN — The drop becomes a required dependency.**
The Mac spec approved it as "optional (pairing never depends on it)" with a paste fallback. Here pairing has no fallback, and quick-tunnel reconnection needs the non-durable cache.
- **Resolution:** add a typed or pasted short-code path, or record this as a new operator-approved exception.

**6. PRECISION — An alternative design is not discussed.**
Phone-signed machine certificates (the PC accepts any machine key the phone has signed) would meet the "agent cannot add keys" requirement without home binding, moves, forwarding or `retry-after` sync. The move record is already this, restricted to one key.

**7. PRECISION — Residual injection risk is understated (§Who may call).**
An interactive owner session can also fetch web pages, email and tool output, not only pasted content. The consent text should say so.

**8. PRECISION — Restart gating has an unstated availability cost.**
A restarted home machine that cannot reach the lease holder answers `retry-after` indefinitely.
