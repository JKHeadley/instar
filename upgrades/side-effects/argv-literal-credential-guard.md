# Side effects: literal credentials refused by the command guard

## What changes for running agents
- Every agent's dangerous-command guard is rewritten on update (built-in hooks are always overwritten). From then on, a Bash or exec command containing a literal GitHub, Anthropic, Slack or Telegram credential shape exits 2 with a plain explanation and the safe form.
- False positives: a command that writes a fixture holding a real-looking fake token (a heredoc in a test, say) is refused too. The message points at the Write tool. A fake token of a different length, or one assembled at run time, passes.
- No config or stored-data change.

## Signal vs authority
This is a hard stop on one narrow, mechanical property (a credential shape in argv), the same class as the guard's existing always-blocked rules. It never judges intent.

## Rollback
Revert the commit; the next update rewrites the guard without the rule.

## Not covered here
Instar itself also passes session secrets to tmux as `-e NAME=value` arguments (GH_TOKEN, INSTAR_AUTH_TOKEN, the Anthropic key and others), which puts them in a short-lived argv at every spawn. That changes the spawn path of every session and gets its own spec.

Observed while reviewing, not changed here: Codex registers this guard with no argument (`installCodexHooks.ts` `sh(...)`), while the script reads its input from `$1` (Claude's registration passes `"$TOOL_INPUT"`). If Codex does not supply the input another way, this guard, including the new rule, inspects nothing on Codex. Reported to the Chief of Staff as its own item.

Known gaps (the rule stops accidental pastes, it is not an adversary boundary): a token split and joined at run time or base64-encoded passes, and other providers' shapes (OpenAI `sk-proj-`, AWS `AKIA`, GitLab `glpat-`, Slack `xoxe-`/`xapp-`) are not covered yet.

## Second-pass review

**Reviewer:** independent read-only subagent (fresh context) — CONCUR, no blockers. The three writers are behaviourally identical after unescaping init.ts; the block runs before any safety-level branch with no early exit above it; git SHAs, base64 and UUIDs do not match; the refusal never echoes the token. Notes: the init.ts copy is string-checked rather than executed; placeholders like `sk-ant-your-key-here-...` are refused; the Codex question above.
