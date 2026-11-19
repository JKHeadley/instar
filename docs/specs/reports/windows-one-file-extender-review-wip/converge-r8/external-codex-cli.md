# codex-cli ok gpt-6-astra SERIOUS ISSUES None
**Verdict: SERIOUS ISSUES**

Review limited to the supplied text; no implementation was available to verify.

- **DESIGN — “Agent side / Calls from other machines”: duplicate execution remains underspecified.** The spec durably records dispatch intent on the home machine, but says only that the PC “keeps the `callId`s it has run for 7 days.” It does not require the PC to persist acceptance **before** execution, or define how a caller-made ID establishes its age. A PC crash between an operation’s effects and recording its ID could permit execution again. **Resolution:** specify a durable PC-side acceptance journal written before execution, atomic duplicate admission, immutable request identity and expiry, and recovery that reports unresolved accepted calls as outcome-unknown without executing them again. Test crashes at these boundaries.

- **DESIGN — “The PC checks the agent / Home key rotation”: signing-key rotation leaves transport-key rotation undefined.** The source explicitly makes Noise authenticate separately pinned, long-term X25519 keys; its rotation procedure replaces the home signing key but says nothing about replacing those transport keys. Consequently, the text does not establish that rotating a compromised home identity removes the old holder’s ability to establish a Noise connection. **Resolution:** bind replacement X25519 keys into the owner-approved rotation record, specify atomic replacement and termination of existing connections, and test that the old transport identity cannot reconnect.

- **PRECISION — “Encrypted channel” and round-seven supporting context:** the supporting review asks for a concrete protocol **and library**. The revised body supplies `Noise_KK_25519_ChaChaPoly_SHA256`, but still names only “a .NET Noise library” and “a maintained Noise library.” **Resolution:** name the selected implementations and versions, with the interoperability proof as an implementation prerequisite.

The supplied earlier findings about per-frame TPM signatures and cancellation implying no effects are **already addressed** in this revision: frames use Noise transport protection, and cancellation explicitly carries `outcome-unknown`. I would not repeat those as outstanding defects.
