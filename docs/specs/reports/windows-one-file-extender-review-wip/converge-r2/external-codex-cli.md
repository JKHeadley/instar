# codex-cli ok gpt-6-astra SERIOUS ISSUES None
**Verdict: SERIOUS ISSUES**

Review limited to the inlined specifications; implementation source was not supplied. These are design-contract findings, not observed runtime failures.

- **DESIGN — “The person’s journey” / “Pairing hand-off.”** Windows puts Face ID approval before PC redemption. The referenced Mac protocol explicitly approves a pending device row created **after** redemption; minting is not approval. The proposed reuse therefore does not implement the stated journey. **Resolution:** either move Face ID after redemption or define a new presence-signed preapproval bound to the code, device key, role, owner and expiry, including cancellation and replay semantics.

- **DESIGN — “The PC checks the agent” / “Multi-machine posture.”** The PC pins one agent identity key, while replicated rows are signed by their writing machine under that machine’s pinned key. The spec does not establish how the PC trusts another machine’s revocation signature or authenticates a replacement socket holder. Server-side trust in replicated rows does not automatically supply that trust to the PC. **Resolution:** define whether identity is agent-wide or machine-specific and specify the PC-verifiable delegation chain for handshakes, commands, address changes and revocations. Test removal and reconnection through a different machine.

- **DESIGN — “Connection, liveness and one holder per PC.”** Connections receive generation numbers, and the highest generation wins, but allocation, persistence and competing connections are unspecified. Replication alone does not establish a unique monotonic generation; equal or regressed numbers leave the fencing claim unsupported. **Resolution:** designate the generation authority—potentially the PC itself—and define atomic connection replacement, restart behavior and partition recovery. Test simultaneous holders and delayed registry updates.

- **DESIGN — “Rollback.”** Disabling the feature unmounts routes and refuses new handshakes, but the spec says nothing about existing sockets or running commands. An already-connected PC has no specified transition to the promised parked state. Unmounting `/computers` also needs an explicit exception to return `feature-off` at its handshake endpoint. **Resolution:** retain a refusal endpoint; on disable, reject new work, define cancellation of active work, notify connected PCs and close their sockets.

The deterministic authorization design is appropriate here; the supplied spec does **not** exhibit an LLM-as-authority problem.
