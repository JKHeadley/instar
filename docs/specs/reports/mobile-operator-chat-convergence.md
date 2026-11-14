# Convergence Report — Mobile operator chat

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra (codex CLI) reviewed all six rounds; Gemini installed but not signed in, so single-family. Internal reviewer (all six lenses, combined, code-grounded) in rounds 1 and 2.

## ELI10 Overview

From the Instar iPhone app you can reply to any of your agent's conversations, and the agent treats it like a message you typed in Telegram. The message goes through the exact same steps as a Telegram message (so "stop everything" works from the app), is labelled as coming from the app, never quietly changes who the agent thinks its operator is, and is delivered at most once even if the app retries. A copy is also posted into the Telegram topic so both places show the whole conversation.

## Original vs Converged

- **Originally** the plan was "extract the Telegram handler unchanged and call it". **After review**, the shared steps move into a core that returns typed outcomes, the Telegram route keeps its request-specific steps, and two tests pin today's Telegram replies and the per-source differences, because the handler has 14 exits and many places that read the lifeline proof.
- **Originally** the copy in Telegram was posted first and its id reused. **After review**, the message is ingested first and the copy is best-effort through its own producer, because posting first could leak secrets, double the history and produce "ghost" messages the agent never received.
- **Originally** a restart mid-request would re-run delivery. **After review**, a request is never re-run: the server records "entered" durably before delivering and answers "outcome unknown" if it cannot know, so a restart can never deliver twice or repeat an emergency stop.
- **Added:** refusals for invite codes, desktop approval codes and credential-shaped text from the app; no operator auto-bind, serve-progress stamp or standing-authorization evidence from app messages; provenance carried across machines; history readable across machines; app messages only on the machine currently receiving Telegram messages; payload and age rules for request ids; atomic check-and-reserve.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | internal, codex | 14 | 6 | Core with typed outcomes; trust table; refusals; ingest-first mirror; ledger namespace; bind/serve-progress/standing-auth exclusions; pool provenance and reads |
| 2 | internal, codex | 6 | 2 | Never re-run; in-flight 202; lease check at send; future-age bound |
| 3 | codex | 2 | 1 | eventId identity; definite vs uncertain failures |
| 4 | codex | 2 | 1 | Preflight separate from core; abandoned vs active records |
| 5 | codex | 2 | 1 | Look up before preflight; fsync durability; credential wall named |
| 6 | codex | 2 | 1 | Atomic check-and-reserve; credential policy stated as lexical |

## Proportion

Tier 2. Spec ~150 lines; six rounds (cap). The inbound pipeline is the most sensitive path in instar, and every round found a real delivery or authority problem.

## Left behind

- Topic-profile "yes" confirmations from the app fail in a never-bound topic (stated in the spec).
- Emergency stop from the app has the same reach as from Telegram today (this machine's sessions).
- The credential wall refuses examples and revoked keys by design.

## Full Findings Catalog

Round 1 internal: 18 findings (handler exits, trust mapping, /desktop and tlinv1, secret leaks via mirror, serve-progress, async rejection, double history row, stall/promise side effects, origin hold/ghost/footer, tone gate on standby, ledger namespace, LogEntry schema, second auto-bind, pool routing/provenance/reads, idempotency states, small gaps, step inventory). Round 1 codex: ingestion vs mirroring states, mirror before scan, eviction. Round 2 internal: replay re-delivers, in-flight retries, confirmations limit, boot ordering, crash test. Round 2 codex: recovery state, commit boundary, send-time lease, future skew, id grammar. Rounds 3–6: as in the table.

## Convergence verdict

Converged at round 6 (cap). The round-6 design findings (atomic reservation, explicit lexical policy) were fixed in the spec; no safety or data-loss item remains open. Ready for build.
