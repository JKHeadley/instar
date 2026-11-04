# Convergence Report — Cloud agents: the sign-in key reaches internal model calls, and a dead key is told and recovers

## Cross-model review: codex-cli:gpt-6-astra

Codex read the spec in all three rounds. Its reads covered the spec and the signal-vs-authority doc, not the source. Gemini was unavailable (`gemini-not-authed`). The Claude clean-door read ran in round 1 and is a second read, not a cross-model opinion.

## ELI10 Overview

Cloud agents have one sign-in key. Conversations got it, but the agent's own background checks did not, so those checks always failed. This change gives every Claude process on the server that same key. If the key stops working, Instar confirms it with Claude, tells the operator how to fix it, and restarts stuck conversations once a working key is proven.

## Original vs Converged

The first draft trusted a screen message and a "Not logged in" reply as proof of a bad key, used the normal model door for its check, promised "your message is safe", refreshed any session with a different key, and offered a paste link. The converged spec uses a direct check where only Claude's own 401, seen twice, counts. It treats "Not logged in" as a wiring fault. It promises only what a resumed conversation carries. It refreshes only sessions at the login screen, through the normal work gate. It replaces the paste link with one command.

## Iteration Summary

- Round 1: Standards-Conformance Gate: ran (5 flags). Six internal lenses in three reviewers, codex, Claude clean-door. All returned design findings. Fatal ones: `sessionManagerConfig` is a copy, so a restored key never reached respawns; the notice would be dropped by the hub filter; the breaker would shed the probe; the link would not survive a restart.
- Round 2: Standards-Conformance Gate: ran (4 flags). One all-lens reviewer, codex. Findings concentrated on the restore link, which had no address on target installs, plus recovery scheduling and the work-gate bypass.
- Round 3: Standards-Conformance Gate: ran (4 flags). Codex. After the link was cut: no architecture findings. Four spec details, all closed: shell parity, confirming-probe scheduling, retry exhaustion, conditional person text.

## Proportion

Asked: key reaches internal calls; a dead key is told and recovers. Three rounds, as the brief allows. The review removed more than it added: the paste link and the Secret Drop changes are gone, and the session hash sweep shrank to a check on one path.

## Left behind

- Paste page for restoring from a phone: needs a reachable address on target installs. fb-9d604efd-1ef.
- The three session lanes pass the key in tmux `-e` argv. Pre-existing. fb-02ea7b0b-b49.
- The pipe lane's read tools are unconfined. Pre-existing. fb-63cb98a3-b95.
- The breaker classifies error text that includes the prompt, so a prompt mentioning "quota" can trip it. Pre-existing. fb-0ac13864-9bf.

## Full Findings Catalog

Round 1: key copy in `sessionManagerConfig`; `notify()` category drop and void return; probe shed by breaker or served by the pool; `Not logged in` conflated with rejection; link lost on restart, burned by a bad paste, kept in the secret store; Slack attention channel is public; sweep too broad, `recovery` skips the work gate, forged login text; "message is safe" unbacked; unbounded probes in `ok`; crash mid-sweep; `/health` is public; env file lifecycle; lifeline's frozen config; `writeClaudeToken` dropped `baseUrl`; agent awareness; self-action registry. All addressed or removed with the link.

Round 2: recovery outliving its timer; stale launch key plus printed text bypassing the gate; raw CLI text in logs; link had no address; link lifetime; `secretDrop` not reachable; base URL parity. All addressed or removed with the link.

Round 3: shell parity; confirming-probe scheduling; retry exhaustion; conditional person text. All addressed.

Standards flags kept as stated limits: Mobile-Complete Operator Actions, Always a Multi-Machine Entity, Always Reachable. See the spec's Stated limits.

## Convergence verdict

Converged at three rounds under the brief's rule. Round 3 raised detail only and no architecture. The last edits were not re-read by a reviewer.
