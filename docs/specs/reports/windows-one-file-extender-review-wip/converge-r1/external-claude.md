# claude (claude-code:claude-opus-5-5, flag: clean-door-anthropic-review: claude-code:claude-opus-5-5)
**Verdict: SERIOUS ISSUES**

1. **DESIGN: the pairing transport is missing (§Pairing and keys).** The spec says the QR holds "the PC's public key and a fresh random nonce, nothing else" and that the existing Mac flow is "reused unchanged". It is not the same flow. In `mac-qr-pairing.md` §2–3 the QR also carries a drop-point slot `r` and a seal key `k`. The phone seals the minted link and the Mac collects it from instar.sh. Here the `.exe` holds no agent address, so the PC has no way to receive the code or learn which agent to redeem against. The Mac's "confirm this agent/host" click (§1.4, a stated mitigation for QR-race attacks) is also gone, and nothing says what the "short code" in step 3 is for. **Resolution:** reuse the `pair-mac` v1 format and the drop point explicitly, with a `platform=windows` field. Keep the PC-side confirm screen showing agent name and host. Either define the short code or remove it.

2. **DESIGN: the PC never authenticates the agent (§Connection).** The PC signs its handshake, but commands that run as the person rest only on TLS to a stored tunnel hostname. If that hostname is lost, reassigned or rotated, or the tunnel provider is compromised, whoever answers there can run code on the PC. A stored address that changes also strands the PC, which then retries forever. **Resolution:** at pairing, pin an agent public key delivered inside the sealed link. Require each command frame to be agent-signed, with a nonce and sequence number. Add an authenticated way to update the address.

3. **DESIGN: most likely real-world failure is antivirus (§Building, §Remover).** A self-copying exe with a per-user Run key, remote PowerShell, screen capture and input injection matches a remote-access-trojan profile. Defender machine-learning detection can quarantine it even when signed. **Resolution:** submit each build to Microsoft for analysis. Make "Defender and SmartScreen verdict on a fresh PC" a release gate. Consider per-user MSIX, which gives clean install and uninstall without admin.

4. **PRECISION: the switches overstate what the person controls (§What the agent can do, Decision points).** With "Run commands" on, PowerShell can read files, take screenshots and send input, so the idle rule and the other switches do not actually confine anything. "A command maps to exactly one switch" is true per route but not in effect. Say so on the consent screen. Also state that the PC, not only the server, refuses commands whose switch is off.

5. **PRECISION: rollback behaviour is undefined (§Rollback).** "Refuses PC handshakes" needs its own refusal code, distinct from `device-revoked`, or flipping the flag wipes every PC. Saying PCs back off at the 5-minute ceiling would make the meaning clear.

6. **PRECISION: signing eligibility is assumed (§Signing).** I believe Microsoft Artifact Signing limits who can enrol (organisations with verifiable history, or individuals in certain regions), but I can't check that from what's inlined. Verify enrolment before calling the cost approved.

7. **PRECISION: alternatives not acknowledged (§Frontloaded Decisions).** User-space Tailscale (tsnet) needs no admin, and established remote-agent patterns already solve outbound control channels. Neither is mentioned. One line each on why they were rejected would help.

My Claude-family-bias lens finds little to flag: the approval and switch flows are proportionate. The real gaps are in transport and server authentication.
