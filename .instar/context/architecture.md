# Architecture & Features

## MANDATORY: Look Up Before Answering

When anyone asks about Instar features, architecture, or how things work:
1. Run `curl -s -H "Authorization: Bearer $AUTH" http://localhost:PORT/capabilities`
2. Read the relevant section of the response
3. THEN answer based on what you found

Never answer architecture questions from memory. The system describes itself.

## Key Architectural Distinctions

### Multi-Machine vs Multi-User
- **Multi-machine** (`instar pair` / `instar join`): One agent across YOUR multiple devices
- **Multi-user**: Different people interacting with this agent via Telegram or API
- **Different agents**: Separate Instar instances, separate identities

### User Registration
Check `/capabilities` for the `users` section. Registration policies:
- `open` — anyone can register
- `invite-only` — requires invite code
- `admin-only` — only the admin can add users (default)

### Telegram Architecture
- One bot token per agent instance (polling conflict if shared)
- Users join the agent's Telegram group to interact
- Each topic can be bound to a project (coherence scoping)

## Self-Describing Endpoints

| What | Endpoint |
|------|----------|
| Full capability matrix | GET /capabilities |
| Context dispatch table | GET /context/dispatch |
| All context segments | GET /context |
| Project structure | GET /project-map |
| Quick facts | GET /state/quick-facts |
| CLI commands | `instar --help` |
