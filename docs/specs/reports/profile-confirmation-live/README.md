# Real Telegram confirmation proof

The four requested scenarios passed through the real Telegram service on the isolated “Instar demo (live tests)” group. The signed-in user browser ran on the Laptop without opening any chat UI. One throwaway Studio agent polled the demo bot. The source conversation ran on Claude, as Chief authorized after a separate Codex rollout-capture failure. No synthetic owner update or disabled guard substituted for live input.

| Scenario | Actual messages | Result |
|---|---|---|
| Exact yes applies only its selected target | Question 226, user message 232 | PASS |
| Numbered yes changes nothing and gets one registered readable reminder | Question 227, user message 228, reminder 231 | PASS |
| Agent activity does not cancel the pending question | Questions 226 and 227, intervening reminder 231, user message 232 | PASS |
| Two pending changes resolve separately; the reminder itself is answerable | After 232 only A changed; user message 233 replied to 231 and changed B | PASS |

The user message IDs came from Telegram's own response and were also observed by the real bot ingress. Before the numbered answer and after its reminder, both destinations retained their original settings. After the first exact reply, only A used Codex. After the second, both did; the asking conversation stayed on Claude. Runtime files were hashed before the run and compared afterward. Those hashes and the tested source commit f64b4cdff15ec278e021646997ce4e8cde0e1ffa are inside the signed artifact. Later evidence-only commits do not change that runtime source tree.

`final-pass.json` contains the canonical artifact, its SHA-256 hash, Ed25519 signature and runner public key. `LiveTestArtifactStore` wrote and verified it; recomputing `canonicalize(artifact)` from src/core/LiveTestArtifactStore.ts must yield the ledger contentHash, and the supplied public key must verify the signature over that hash. The key is the throwaway runner identity, not a production credential. Message IDs and names are demo-only. No bot token, private signing key, original owner image or private conversation UUID is published.

The earlier results remain visible. `first-failed.json` records missing native reply metadata and failed Codex delivery. `second-reminder-failed.json` records three passed behaviors and the agent's incorrect claim that no question existed. A further aborted attempt produced a correctly named ordinary-chat reminder whose receipt was unregistered; it was not accepted as a completed matrix. The final correction uses the server reminder operation and proves a native reply to its actual receipt. These failures were not turned into passes by rerunning simulated tests.

This is the Chief-required four-scenario Telegram proof, not a full suite, Slack proof, all risk categories or a production-health certificate. The throwaway reported unrelated startup degradations; the inherited Codex generation issue is owned by the delivery post-mortem lane. Full Local Verify remains required against the final pull request head. The demo poller and its test sessions were stopped afterward; the evidence files remain preserved.
