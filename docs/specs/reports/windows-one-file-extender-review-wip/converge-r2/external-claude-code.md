# claude-code ok claude-opus-5-5 MINOR ISSUES None
**Verdict: MINOR ISSUES.** There are three DESIGN findings, so the spec goes back for another round.

**D1 — DESIGN: Which key the PC pins is unclear (§Pairing hand-off, §PC checks the agent, §Multi-machine).** The PC pins a single "agent identity public key". The replicated `computerExtenders` rows are signed by each writing machine under that machine's own key. And any machine with the newest generation may become the socket holder. If identity keys are per machine, a holder other than the one that paired can't sign challenges, command frames or revocations the PC will accept. Rotating the agent key is also never covered. **Fix:** say whether there is one agent-wide key or a set of machine keys. If it's a set, define how the PC learns new machine keys and how a rotation is signed, and test a holder change across machines.

**D2 — DESIGN: No failover when the origin's machine dies (§Connection).** Mac pairing ties the stable origin to one machine. Here, "address moved" is accepted only over a live socket. If that machine dies, the PC sits in the reconnect ladder for up to 7 days, even though other machines in the mesh are healthy. The holder/generation design suggests failover, but nothing provides it. **Fix:** pin a signed list of origins, or an origin that routes to the whole mesh. Otherwise, state that there is one machine per PC and drop the multi-holder wording.

**D3 — DESIGN: The update check breaks within days (§Updates).** Microsoft Artifact Signing issues short-lived certificates that rotate every few days. A manifest "signed by the same certificate" fails after the first rotation. Authenticode also isn't a normal way to sign a JSON manifest. **Fix:** check the publisher's subject and its Artifact Signing identity rather than one specific certificate. Sign the manifest as a detached CMS signature checked against that same identity rule.

**P1 — PRECISION: File chunks may not be authenticated (§Results and files).** Command frames are signed, but the 256 KB chunks are "never through whole-body signatures". A named tunnel decrypts traffic at the tunnel provider, so file writes *to* the PC could be tampered with in transit. Consider an authenticated key exchange at the handshake followed by encryption with a session key on every frame, chunks included. That is standard practice (Noise, or TLS channel binding) and replaces per-frame ECDSA signatures and hand-rolled sequence checks.

**P2 — PRECISION: The install step is never stated.** The file runs from Downloads, yet removal deletes `%LOCALAPPDATA%\Programs\Instar Connect\` and HKCU Run entries. Spell out the copy-to-install step and the start-at-login entry.

**P3 — PRECISION: iPhone only.** Only iOS gets "Connect a Windows PC". Android owners can't connect, and the spec doesn't say so. State it as out of scope or track it.

**P4 — PRECISION: This is a known pattern.** An outbound agent connection with no listening port is how Azure Arc, AWS SSM Agent and RMM tools work. The design is sound. Citing that lineage would also justify not using SSH or Tailscale.

Lens check:
- **Model-family blind spots:** the consent and Face ID flow fits the risk. Everything is deterministic rules with no LLM making decisions, which correctly stays outside the signal-vs-authority principle.
- **Context:** none of the inlined context was truncated.
