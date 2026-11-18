# codex (codex-cli:gpt-6-astra, flag: cross-model-review: codex-cli:gpt-6-astra)
**Verdict: SERIOUS ISSUES**

Review limited to the inlined specs; referenced implementation files were not supplied.

- **DESIGN — “Pairing and keys”; ordinary journey.** The Windows QR contains only a public key and nonce, but the PC must somehow receive the agent address and redemption code. That return channel is unspecified. Mac pairing §§2–6 explicitly supplies a drop slot, separate sealing key, encrypted delivery, and local confirmation of the chosen agent. Windows also omits that confirmation. **Resolution:** specify the complete handover protocol, including authenticated switch choices and local agent confirmation; explicitly identify which Mac mechanisms are reused.

- **DESIGN — Admission invariant versus “reused unchanged.”** Windows requires owner-phone Face ID, “never … an agent decision.” Mac §4 explicitly preserves Telegram and dashboard approval paths; its Security section describes agent-managed trust and computers becoming owner devices. Thus unchanged reuse does not establish the claimed admission boundary or define an extender’s privileges. **Resolution:** define an extender-specific authorization policy, enforce the permitted approval path server-side, and explicitly restrict or justify its access to owner-device APIs.

- **DESIGN — “What the agent can do”; decision-point switch mapping.** Unrestricted PowerShell can read files, capture screenshots, and inject input despite the corresponding switches being off. Routing each API call to one switch therefore cannot enforce the advertised capabilities or idle guarantee. **Resolution:** either present unrestricted command execution as overriding those restrictions, or replace it with constrained operations and enforce capabilities locally. Define precedence between the two input switches.

- **DESIGN — “Multi-machine posture.”** Replacing a socket in one server’s device-id map does not establish the asserted pool-wide single holder. Concurrent connections or partitioned machines can retain competing holders. **Resolution:** specify authoritative ownership with fencing, or explicitly support multiple connections with command deduplication and clear routing semantics.

- **DESIGN — “Remover”; “Rollback.”** Removal steps omit the executable installed under `%LOCALAPPDATA%\Programs\Instar Connect\`. Closing a socket or refusing future handshakes also does not specify termination of already-running commands, so “every copy inert” is unsupported. **Resolution:** define executable cleanup and child-process cancellation; distinguish immediate server revocation from eventual cleanup of an offline PC.

The supplied signal-versus-authority principle permits deterministic invariant checks. No LLM authority is needed for these controls.
