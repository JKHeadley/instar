# CLAUDE.md — instar

## What This Project Is

Persistent autonomy infrastructure for AI agents. Every molt, more autonomous.

Transforms Claude Code from a reactive CLI tool into a proactive, persistent agent with scheduled jobs, multi-user messaging, and system monitoring.

Born from the Dawn/Portal project — extracting battle-tested infrastructure patterns into a reusable, project-agnostic toolkit.

## Quick Reference

```bash
pnpm build            # Build TypeScript
pnpm dev              # Watch mode build
pnpm test             # Unit tests
pnpm test:watch       # Watch mode tests
pnpm test:integration # Integration tests (spawns real sessions)
```

## Architecture

```
src/
  core/           # SessionManager, StateManager, Config, FeedbackManager,
                  # UpdateChecker, RelationshipManager, SleepWakeDetector, types
  scheduler/      # Cron-based job scheduling with quota awareness
  monitoring/     # Health checks, QuotaTracker (threshold-based load shedding)
  messaging/      # TelegramAdapter (long-polling, JSONL history)
  users/          # Multi-user identity resolution and permissions
  server/         # HTTP server, routes, middleware (auth, CORS)
  scaffold/       # Identity bootstrap, template file generation
  commands/       # CLI: init, setup, server, status, user, job, add, feedback
  templates/      # Default hook scripts, helper scripts for scaffolding
tests/
  unit/           # Pure logic tests (no tmux/sessions)
  integration/    # Full system tests (may spawn real sessions)
  e2e/            # End-to-end lifecycle tests
  fixtures/       # Test data and mock repos
```

## Development Workflow

### Testing Against Real Repos

This toolkit is meant to be tested against real Claude Code projects. The flow:

1. Make changes in this repo
2. Build: `pnpm build`
3. Test against a target repo:
   ```bash
   # From target repo
   node /path/to/claude-instar/dist/cli.js init
   node /path/to/claude-instar/dist/cli.js status
   ```
4. Or link globally during development:
   ```bash
   # From this repo
   pnpm link --global
   # From target repo
   instar init
   ```

### Test Targets

- `tests/fixtures/test-repo/` — Minimal fixture for unit/integration tests
- `/Users/justin/Documents/Projects/ai-guy/` — Real project (AI Guy chatbot)
- `/Users/justin/Documents/Projects/sagemind/` — Real project (SageMind with multiple users)

### Key Design Decisions

1. **File-based state** — No database dependency. Everything is JSON files.
2. **tmux for sessions** — Battle-tested, survives terminal disconnects, scriptable.
3. **Adapter pattern for messaging** — Telegram first, but the interface supports any platform.
4. **User identity is channel-based** — A user is known by their channel identifiers (Telegram topic, email, etc.)
5. **Jobs are declarative** — JSON definitions with cron expressions, not code.

## Standards

- **Structure > Willpower** (THE foundational principle): Never rely on agents "remembering" to follow instructions in long prompts. Bake intelligence into the architecture:
  - **Session-start hooks** inject context automatically — agents don't need to remember to read files
  - **Programmatic gates** enforce required steps — critical choices happen in code, not in skill prompts
  - **Dispatch tables** route decisions to the right source — agents see "when X → look at Y" at every session start
  - **Behavioral hooks** guard against anti-patterns — deferral detection, grounding-before-messaging, dangerous-command-guard
  - If a behavior matters, enforce it structurally. A 1,000-line prompt is a wish. A 10-line hook is a guarantee.
  - This principle applies to ALL design decisions in Instar. When choosing between "add it to the docs" and "enforce it in code" — always choose code.

- **LLM-Supervised Execution** (`docs/LLM-SUPERVISED-EXECUTION.md`): Every critical pipeline must have at minimum a Tier 1 LLM supervisor. Jobs support a `supervision` field (`tier0`, `tier1`, `tier2`) on `JobDefinition`. Tier 1 = Haiku wrapping programmatic tools with validation after every step.

- **Agent Awareness Standard**: Every feature added to Instar MUST include a corresponding update to the CLAUDE.md template (`src/scaffold/templates.ts` → `generateClaudeMd()`). An agent that doesn't know about a capability effectively doesn't have it. This means:
  1. **API endpoints** — Add to the Capabilities section with curl examples
  2. **Proactive triggers** — Add to Feature Proactivity ("when user does X → use this")
  3. **Registry lookups** — Add to the "Registry First" table if it answers a state question
  4. **Building blocks** — Add to "Building New Capabilities" if it's a tool the agent should reach for

  The principle: agents interact with users conversationally, not through CLIs. If the template doesn't mention a feature, no agent will ever surface it. The template IS the agent's awareness.

## API Authentication

All HTTP API endpoints (except `/health` basic check) require a Bearer token:

```
Authorization: Bearer <authToken>
```

The `authToken` is set in `instar.config.json` during setup. Agents calling the local server API from skills/scripts must include this header.

The feedback webhook (`dawn.bot-me.ai/api/instar/feedback`) uses different auth — `User-Agent: instar/<version>` and `X-Instar-Version: <version>` headers for identification. No Bearer token needed for the external feedback endpoint.

- **No Interactive CLI Commands** (CRITICAL — commands WILL HANG FOREVER): Claude Code's Bash tool cannot handle stdin prompts. Any command that asks for a password, confirmation, or input will hang until timeout. There is NO workaround — you cannot type into a running command.
  - **The `--raw` flag does NOT prevent interactive prompts.** It only changes output format. `bw unlock --raw` STILL HANGS because it still prompts for a password. The password must ALWAYS be a positional argument BEFORE flags.
  - **NEVER** run: `bw unlock --raw` (no password!), `bw unlock` (no password!), `bw login --raw` (no credentials!), `read -s`, `ssh-keygen` (interactive), `npm init` (interactive)
  - **ALWAYS** use: `bw unlock "ACTUAL_PASSWORD" --raw`, `bw login "EMAIL" "PASSWORD" --raw`, `ssh-keygen -t ed25519 -f path -N "" -q`, `npm init -y`
  - **THE PATTERN**: Get user input via conversation FIRST. Then construct the command with their actual input as positional arguments. Never run a command hoping it will prompt the user.

- **No Multi-Choice for Text Input**: AskUserQuestion multi-choice is for DECISIONS between options (pick A or B). NEVER use it to collect free-text input (passwords, emails, tokens, names). When you need text from the user, ask a plain question and wait. Multi-choice for text input makes "Skip" look like the default and buries the actual input option.

## Key Patterns from Dawn

These patterns were earned through real failures. Don't weaken them:

- **tmux trailing colon**: Use `=session:` (trailing colon) for pane-level commands. `=session` (no colon) FAILS SILENTLY for send-keys/capture-pane on tmux 3.6a.
- **Nullish coalescing for numbers**: `maxParallelJobs ?? 2`, NOT `maxParallelJobs || 2`. Zero is falsy.
- **Protected sessions**: Always maintain a list of sessions that the reaper should never kill.
- **Completion detection**: Check tmux output for patterns, don't rely on process exit.
