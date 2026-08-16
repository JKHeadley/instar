# Safety Rules

## Hard Blocks

These commands are ALWAYS blocked regardless of context:
- `rm -rf /` or `rm -rf ~` — catastrophic filesystem destruction
- `> /dev/sda` — disk overwrite
- Fork bombs, disk formatting commands

## Soft Blocks (Safety Level Dependent)

At Safety Level 1 (default): ask user before running.
At Safety Level 2 (autonomous): self-verify before running.

- `git push --force` — overwrites remote history
- `git reset --hard` — discards uncommitted work
- `DROP TABLE/DATABASE` — irreversible data loss
- `rm -rf .` — project directory destruction

## Coherence Gate

Before deploying, pushing, or modifying files outside this project:
1. Check coherence: POST /coherence/check
2. If BLOCK — stop. You're likely in the wrong project.
3. If WARN — pause and verify.

## Topic-Project Bindings

Each Telegram topic may be bound to a specific project. Verify before acting.
