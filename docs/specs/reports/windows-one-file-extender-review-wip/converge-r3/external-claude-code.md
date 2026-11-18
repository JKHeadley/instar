# claude-code ok claude-opus-5-5 SERIOUS ISSUES None
**Verdict: SERIOUS ISSUES**

I based this only on the spec and context included in the prompt. Nothing was truncated.

**1. DESIGN: the PC cannot check the phone's approval when a switch is raised** (§What the agent can do; §The PC checks the agent)
The spec says raising a switch "also needs the owner's presence approval on the phone" and that "the agent can change none." But the PC trusts only the agent's machine key set. Agent sessions run on those machines, so they can reach those keys. The phone's approval therefore reaches the PC as a frame signed by a machine key, which the agent could forge. The rule depends on server code behaving, not on cryptography.
*Fix:* Put the owner phone's presence public key in the sealed drop and pin it on the PC. The PC then accepts a raise only with a presence signature it checks itself. If that isn't done, say plainly that the agent's server is trusted for raises.

**2. DESIGN: the update check pins the signer by name** (§Updates)
"Publisher subject 'Justin Headley'" matches any individual Microsoft has verified under that name. Artifact Signing puts a unique identity-validation ID in each certificate's EKU (an OID under `1.3.6.1.4.1.311.97.`).
*Fix:* Pin that identity OID and the root, not the common name. Also require an RFC 3161 timestamp on the detached CMS manifest signature. The certificates last about 3 days, so without a timestamp the check fails once the certificate expires.

**3. DESIGN: sessions reading outside content can run commands** (§Who may call)
"Sessions handling outside content such as email or web pages" qualify. Marking results "untrusted data" is a label, not a control. A hostile email read by a scheduled job becomes PowerShell on the person's PC. Saying so in one line of consent text does not fix it.
*Fix:* In v1, accept only interactive owner-conversation sessions. Scheduled and outside-content sessions get refused.

**4. DESIGN: most likely failure is tech-support scams** (§The person's journey, step 6)
The file is generic, signed and shows no admin prompt, which makes it a free remote-control tool for scammers. Blocking Connect while known remote-control programs run is beaten by a photo of the QR code, a renamed binary or a browser-based tool. The agent and owner names shown on the PC are chosen by the attacker. Other remote-management tools treat this as their main abuse case.
*Fix:* Name this as a threat with an owner. Add persistent safeguards that don't depend on that one moment:
- at each sign-in, re-show "Connected to <agent>, owned by <owner>" with one-click Disconnect;
- show a toast for every session, not just the first command of a burst.

**PRECISION (left behind)**
- The remote-control blocklist is a brittle detector with blocking power. Either justify it under the signal-vs-authority exemption for irreversible actions, or downgrade it to a warning.
- Revocation-before-admission depends on the lease holder being reachable. When it is down, every PC gets `retry-after`. Say whether that is intended.
- Sequence numbers: state whether they run per connection or per generation, and what happens when the holder machine changes.
- The switch-state MAC protects nothing once Run commands is on, because the agent can sign as that user. Say this beside the MAC claim.
- On industry patterns: the outbound-WebSocket design is the standard remote-management agent pattern (MeshCentral, Intune). It's a sound choice; the spec could say so.
