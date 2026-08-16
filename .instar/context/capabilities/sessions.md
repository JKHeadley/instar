# Sessions

Spawn and manage Claude Code sessions.

## Endpoints

- **List sessions**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/sessions`
- **Spawn a session**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/sessions/spawn -d '{"name":"task","prompt":"do something"}'`
