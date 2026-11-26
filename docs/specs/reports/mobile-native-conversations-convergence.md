# Convergence Report — Native app conversations without Telegram, with signed records

## Cross-model review: codex-cli:gpt-6-astra (RAN — six rounds, every round returned findings, all folded in)

Every round ran the external Codex reviewer (gpt-6-astra) against the spec with mobile-device-keys.md, mobile-operator-chat.md and mobile-push.md as context, plus the Standards-Conformance Gate. Internal multi-lens reviews (security, scalability, adversarial, integration/multi-machine, decision-points, decision-completeness, verify-the-state) ran in rounds 1 and 6, on this session's model (Claude Opus 5.5). The internal reviews read the source code and caught the largest factual error (round 6: the conversation registry does not yet replicate between machines).

## ELI10 Overview

The Instar iPhone app can already chat with an agent, but only by borrowing Telegram: a conversation is a Telegram topic, replies travel through Telegram, and the pairing code arrives in a Telegram chat. This spec gives the app its own conversations, stored by the agent, so an agent with no Telegram at all can still be reached from the phone, and it lets the app continue Telegram and Slack conversations beside them. Every message sent from the app is saved with the phone's own signature and a matching receipt from the agent's machine, so anyone can later check it really came from the operator's paired phone; the app's 📱 mark comes only from that check.

Review changed the design a lot. Conversations became a set of replicated events in their own files (not registry entries, which do not replicate yet), with a SQLite index for reads. Sending follows the exact order the existing chat route uses for safe retries, and the message and its proof are written to disk before anything is dispatched. The server no longer refuses or rewrites messages on a pattern guess: only exact pairing-invite and desktop-code tokens are removed, and whether to send a password-looking text is the operator's call in the app. Machine key rotation, clock skew and crash recovery between the device registry and the new key ledger all have stated rules.

The main tradeoff: this is a large feature (five increments), and conversation history is kept and replicated forever unless the operator deletes it.

## Original vs Converged

- **Originally**, app conversations were registry entries that "already replicate". **After review**, the registry only gives each machine a local alias; conversations live as events in a replicated, append-only store with a rebuildable SQLite index, because registry replication is not built.
- **Originally**, the stored message kept a server-written label. **After review**, it keeps the phone's signed bytes, the key ledger (signed per machine, with crash-safe write order and reconciliation), and a machine receipt over the whole canonical request, verified with key-rotation history; five verdicts, and `unknown` never shows as `failed`.
- **Originally**, the message was logged after dispatch. **After review**, authenticate → look up → emergency stop (reserved, never rate-limited) → preflight → reserve → durable commit → intercept → dispatch → delivery event, with boot recovery and lookups that read current delivery state.
- **Originally**, credential-shaped text was refused, then redacted. **After review**, the server never alters or refuses content except exact invite and desktop-code tokens; the operator decides on credentials in the app.
- **Originally**, ownership and replies were unspecified. **After review**, the owner is the pool placement or, with the pool dark, the serving-lease holder, recorded per machine with `bind-app`; non-owners forward.
- **Originally**, pairing without Telegram was a sentence. **After review**, a dashboard-PIN path with in-memory code display, no lease dependency, and every message labelled with how its phone was approved.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | Codex (5 design), internal panel (13 design, 11 polish), gate (2 flags) | 18 design | Full rewrite: UUID identity, reservation contract reuse, ledger as its own signed store, dashboard pairing detail, store without rotation, outbound pipeline reuse, config/rollout/tests |
| 2 | Codex (4 design), gate (3 flags) | 4 design | Contract order, durable message before dispatch, opaque cursors, ownership-based reply eligibility, store replicated by default, no text guard |
| 3 | Codex (4 design), gate (2 flags) | 4 design | Event ids and delivery reduction, receipt over the full request, backward browse, Slack persist-before-dispatch, credential fails toward delivery |
| 4 | Codex (4 design, 1 precision), gate (1 flag) | 4 design | No credential stored on redaction, events route allowlisted, fsync + torn tail, lifetime by receipt time |
| 5 | Codex (3 design, 1 precision), gate (2 flags) | 3 design | Stop before rate limit, operator override, Slack evidence in the store, SQLite index, mutation recovery |
| 6 | Codex (4 design), internal panel (6 design, 7 polish), gate (1 flag) | 10 design | Store as source of truth for conversations, auth-time rate limit skipped for sends, key-rotation-aware verification, owner with pool dark, canonical Slack keys, credential decision moved to the app, ledger write order |
| Standards-Conformance Gate | ran every round (1–3 flags each, all addressed) | — | recorded per round above |

Round cap: 6 (Tier 2). Stopped at the cap with every round-6 finding applied in the spec text.

## Left behind

- No seventh review round was run on the round-6 edits (the cap). The round-6 changes are structural (store as source of truth, ownership rule); the build's tests listed in the spec exercise each of them, and the first increment's PR review is the next independent read.
- Native conversation history is kept and replicated indefinitely unless the operator deletes it; size is reported in `/health`. A retention policy is a separate decision if it grows.
- Attention items on an agent without Telegram have no store to push from (feedback fb-4ce98e0f-293); this spec pushes agent replies regardless.

## Convergence verdict

Converged at the round cap (iteration 6) with all design findings applied. No open questions remain. The spec is ready for approval under the standing rule that only constitution changes need the operator.
