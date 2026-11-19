# codex-cli ok gpt-6-astra SERIOUS ISSUES None
**Verdict: SERIOUS ISSUES**

Review limited to the supplied spec and round-8 summary; implementation sources were not supplied.

- **DESIGN — Retry deduplication can fail after retention expires.**  
  **Sections:** “Agent side → Calls from other machines”; “Tests.”  
  The spec says the PC retains `callId`s for seven days, rejects calls older than its low-water mark, and receives a send time stamped by the home machine. It also permits caller-directed retries. It does **not** require retries to preserve the original timestamp or require the home machine to retain an immutable identity-to-timestamp mapping.

  Consequently, the stated rules permit an old `callId`, whose PC record has expired, to be resubmitted with a fresh home-stamped send time. It passes the age check and can execute again. This contradicts “a delayed duplicate can never run a second time.” The round-8 summary’s claim that the low-water mark resolves this is therefore not established by the supplied design.

  **Resolution:** Bind each device-scoped `callId` permanently to its original issuance time, preserve that binding across retries and recovery, and reject expired identities before dispatch. Alternatively, use a durable sequence-based deduplication protocol. Test a caller retry after PC retention expires, including after home restoration.

- **PRECISION — Initial grant placement contradicts the handshake rule.**  
  **Section:** “The PC checks the agent, not only the reverse.”  
  The encryption paragraph prohibits application data in handshake messages, but the next paragraph delivers the grant “in the first handshake.”

  **Resolution:** Say the grant travels in a post-handshake encrypted transport message, and specify its ordering relative to the PC’s handshake-hash signature and enabling calls.

The restricted extender identity and single-home design are clear. The explicit limits on Full control appropriately avoid treating consent prompts or session credentials as isolation boundaries.
