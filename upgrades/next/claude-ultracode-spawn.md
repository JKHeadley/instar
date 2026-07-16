# Claude ultracode one-shot spawn

## What Changed

The existing one-shot session spawn endpoint now accepts an optional
`ultracode: true` field for Claude Code. Instar activates Claude's supported
per-turn `ultracode` prompt trigger, covering both the normal headless path and
the subscription-rerouted interactive path. The option is rejected when the
explicit or configured default framework is not Claude Code.

Claude's `workflowKeywordTriggerEnabled` setting defaults on. If explicitly
disabled, Instar respects the choice and the workflow mode does not activate.

## What to Tell Your User

“I can now opt a single Claude task into ultracode — Claude's deepest effort
plus dynamic workflow orchestration — without changing your defaults or later
sessions.”

## Summary of New Capabilities

- Opt one Claude one-shot spawn into ultracode with `ultracode: true`.
- Preserve existing prompts byte-for-byte when the option is absent or false.
- Reject the option on Codex/Gemini agents, including omitted-framework requests
  whose configured default resolves to a non-Claude framework.
- Teach both upgraded and newly initialized agents about the opt-in surface.

## Evidence

- Unit coverage proves the prompt transform, dark default, and non-Claude no-op.
- Integration coverage proves strict boolean validation, explicit framework
  refusal, and configured-default framework refusal.
- E2E coverage proves delivery through the real HTTP → tmux → Claude argv path.
- TypeScript build passes.
