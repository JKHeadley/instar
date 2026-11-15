<!-- internal-only -->
## What Changed

The step that adds the "Context-Death Self-Stop" anti-pattern note to CLAUDE.md now puts it before the "Feature notes" block instead of after it. Before, an agent whose CLAUDE.md had no "Critical Anti-Patterns" section got a file that changed on every update, once the first feature notes existed.

## What to Tell Your User

Nothing. This is an internal fix to how updates write the agent's instructions.
