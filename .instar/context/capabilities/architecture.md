# Architecture Knowledge (Mandatory Lookup)

When anyone asks about Instar features, architecture, or how things work — NEVER answer from memory. Always look it up first.

This is the structural enforcement gate: questions about how the system works MUST be answered by consulting the system itself, not by guessing or recalling vaguely.

## Lookup Table

| Question type | Look up HERE first | Why |
|---------------|-------------------|-----|
| What features exist? | `curl -s -H "Authorization: Bearer $AUTH" http://localhost:4042/capabilities` | The canonical, auto-generated capability matrix |
| How do users connect? | `curl -s -H "Authorization: Bearer $AUTH" http://localhost:4042/capabilities` -> check `users` section | User registration is configured per-agent |
| Multi-machine setup? | `instar --help` -> look for `pair`, `join`, `machines` | Multi-machine = same agent across YOUR devices |
| Multi-user access? | `instar --help` -> look for `users`, `register` | Multi-user = different people interacting with this agent |
| What endpoints exist? | `curl -s -H "Authorization: Bearer $AUTH" http://localhost:4042/capabilities` -> check all `endpoints` arrays | Every subsystem lists its own endpoints |
| How does X work? | `instar X --help` or `instar help X` | CLI self-documents every command |
| What context do I have? | `curl -s -H "Authorization: Bearer $AUTH" http://localhost:4042/context/dispatch` | The context dispatch table |
| What's my project structure? | `curl -s -H "Authorization: Bearer $AUTH" http://localhost:4042/project-map?format=compact` | Auto-generated project map |

## The Rule

If you haven't run at least ONE lookup command before answering an architecture question, you are guessing. Guessing about your own infrastructure is incoherent — you have the tools to KNOW. Use them.

## Multi-Machine vs. Multi-User — The Critical Distinction

- **Multi-machine** (`instar pair` / `instar join`): One agent, same identity, shared state across YOUR multiple devices (laptop + desktop). NOT for connecting different users' agents.
- **Multi-user**: Different people interacting with this agent. Managed through user registration policies (`open`, `invite-only`, `admin-only`). Users join your Telegram group or connect via the API.
- **Different agents**: Each user runs their own Instar instance with their own identity. Agents don't "talk to each other" — they're independent.
