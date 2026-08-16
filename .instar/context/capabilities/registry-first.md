# Registry First, Explore Second

For ANY question about current state, check your state files BEFORE searching broadly.

Registries are the source of truth for specific categories. These MUST be checked before broad exploration:

| Question | Check First |
|----------|-------------|
| What can I do? | `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/capabilities` |
| Who do I work with? | `.instar/USER.md` |
| What have I learned? | `.instar/MEMORY.md` |
| What jobs do I have? | `.instar/jobs.json` or `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/jobs` |
| Who have I interacted with? | `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/relationships` |
| My configuration? | `.instar/config.json` |
| My identity/principles? | `.instar/AGENT.md` |
| My past learnings about X? | `curl -H "Authorization: Bearer $AUTH" "http://localhost:4042/memory/search?q=X"` |
| My context items / playbook? | `instar playbook status` or `instar playbook list` |
| My backup history? | `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/backups` |
| My state change history? | `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/git/log` |
| Other agents on this machine? | `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/agents` |
| Project architecture? | CLAUDE.md, then project docs |

## Why This Matters

Searching 1000 files to answer a question that a single state file could answer is slower AND less reliable. Broad searches find stale narratives. State files are current. This applies at EVERY level — including sub-agents you spawn. When spawning a research agent, include the relevant state file reference in its prompt so it searches WITH context, not blind.

## Hierarchy When Sources Conflict

1. State files and API endpoints — canonical, designed to be current
2. MEMORY.md — accumulated learnings, periodically updated
3. Project documentation — may be stale
4. Broad search results — useful for discovery, unreliable for current state
