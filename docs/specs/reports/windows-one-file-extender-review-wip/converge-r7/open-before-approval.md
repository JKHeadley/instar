# Round 7 (post-convergence delta): what must be resolved before approval

Approval is held (Chief of Staff 7cb7a4ce) until Justin answers whether Connect is built into the Windows app's Pair screen from the start; that answer may restructure the PC side. Round 7 ran on the changed body (codex-cli gpt-6-astra, clean-door claude, one internal lessons+decision reviewer).

Resolved in the delta (this commit): goal-based offer rule (desktop app for "Instar on this computer", Connect for "my agent uses this PC", in the awareness entry); PC window first line states the use case; examples fixed; Windows app exists but is unreleased (echo/windows-app-m1 657aa31).

Open DESIGN findings on the already-converged body (round 6 was the Tier-2 cap; security-class findings at the cap go to the operator, not left behind):
1. Handshake: pick a concrete existing protocol + library (e.g. Noise IK with one binding signature) and name it correctly; sign the handshake transcript only, then AEAD with nonce/sequence checks (per-frame TPM signatures would cap throughput). Cross-language test vectors.
2. Disconnect/cancel semantics: report cancellation separately from outcome; cancelled never means "no effect"; no automatic retry of non-idempotent work.
3. Cross-machine call recovery: persist dispatch intent before send; unresolved = possibly executed; defined dedupe retention and refusal of expired retries.
4. Owner Lower/Remove must not be blockable by the strict last+1 order number: exact +1 for authority-adding orders, any higher number for authority-reducing ones.
Precision (left behind unless trivial): Stop/Job Object limits (WMI, Task Scheduler, COM, explorer); update scheme freeze + key-loss path or adopt TUF roles; Arm detection via Sec-CH-UA-Arch; awareness test for the offer rule; file the Windows-app plan row + commitment; owner/date for retire-the-file and borrowed-PC detection; "installs nothing" wording in the comparison report.
