# ELI16: Gemini Modal Safe Rejects

Gemini sometimes pauses in a terminal box and asks for a choice.

Some choices are safe defaults. For example, when `npx` says it needs to
install `instar@1.3.270` and asks `Ok to proceed? (y)`, pressing Enter just
accepts the package-runner default for the Instar CLI command the agent already
started. Prompt Gate now recognizes that exact shape and presses Enter.

Other choices are not safe defaults. The important one is:

```text
Allow execution of: ...
1. Allow once
2. Allow for this session
3. No, suggest changes
```

That prompt means "may I run this command?" The command can be model-generated,
wrong, or nonsense. Auto-yes would be arbitrary code execution. This change
therefore has no auto-yes path for execution approvals. If Prompt Gate sees the
exact execution-approval modal and can find the reject option, it chooses the
reject option.

The reject is visible. The server logs the rejected command text and reports an
observable Prompt Gate event, so a mentor can tell that the agent was stopped by
a safety decision instead of silently stalling.

Near misses still do not get answered automatically. Arbitrary package installs
and execution prompts without the known reject option fall back to the normal
relay path.

