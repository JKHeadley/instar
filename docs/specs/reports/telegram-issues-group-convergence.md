# Convergence report — Telegram issues group

## ELI10

Justin asked for bug topics to live in their own Telegram group ("Echo Bugs") so they
stop cluttering the main topic list. The design gives those topics their own number
range inside Instar (ten billion plus Telegram's topic number) and translates only where
Instar talks to Telegram. Two review rounds checked it against the real code.

## Iterations

| Round | Reviewers | Build-changing findings | Outcome |
|---|---|---|---|
| 1 | internal (code-grounded), codex-cli:gpt-6-astra, clean-door claude-code:claude-fable-5 | 6 | all folded |
| 2 | internal (code-grounded), codex-cli:gpt-6-astra | 1 | folded |

Reviewer models: internal reviewer ran on the authoring session's model (claude-opus-5-5).
Gemini was not available (not signed in), so the GPT family was the only cross-family read.

## What changed the build

Round 1:
1. Sends sealed into origin records (forward to lease holder, held notices, mesh relay,
   legacy import) bypass the adapter → translate in `TelegramOriginService.prepareBot`.
2. The lifeline's own sends (notices, typing) → translate in `TelegramLifeline.apiCall`.
3. The issues group's General topic has no thread id → normalization always sets the
   field for an issues-chat message.
4. Prompt-gate edits without a thread id → store the relay chat and pass it.
5. An issues-range id with no issues chat configured → refuse, never send to main.
6. Both functions made idempotent (codex: double normalization).

Round 2:
7. Origin preparation runs at boot before the adapter exists → no process-wide registry;
   the origin layer uses its live config snapshot; legacy import guards each row.

## Left behind (would not change the build)

- Two machines configured with different issues groups: documented as a config rule
  (same as `chatId`), no cross-machine binding check.
- Browser transport: stated out of scope (bot transport only).
- Code-revert behaviour: documented (Telegram rejects; no misroute).
- Setup automation through the operator's Telegram Web was called fragile by the
  clean-door reviewer; kept, because operator chores are the agent's by standing rule.
- 80/20 applied by hand (CMT-917): stopped after round 2 because round 2's remaining
  findings were documentation only.

## Convergence verdict

Converged at iteration 2. No finding in the final round changes what gets built.
