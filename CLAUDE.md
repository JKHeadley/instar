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

- **Testing Integrity Standard** (NON-NEGOTIABLE): Every significant feature requires ALL THREE test tiers. No exceptions.
  - **Tier 1: Unit Tests** (`tests/unit/`) — Module in isolation with real dependencies. Does the logic work?
  - **Tier 2: Integration Tests** (`tests/integration/`) — Full HTTP pipeline. Do the API routes work when the feature is available?
  - **Tier 3: E2E Lifecycle Tests** (`tests/e2e/`) — Production initialization path mirroring `server.ts`. Is the feature actually alive? Returns 200, not 503?
  - **Wiring integrity tests** are required for every dependency-injected component — verify deps are not null, not no-ops, and delegate to real implementations
  - **Semantic correctness tests** must cover both sides of every decision boundary with realistic inputs
  - The Phase 1 "feature is alive" E2E test is the single most important test for any feature with API routes
  - Full spec: `docs/specs/TESTING-INTEGRITY-SPEC.md` | E2E template: `docs/E2E-TESTING-STANDARD.md`

- **Zero-Failure Standard** (NON-NEGOTIABLE): The test suite MUST be green at all times. There is no such thing as a "pre-existing failure."
  - **Every session** must leave the test suite with zero failures, regardless of what was broken when you started
  - **"Pre-existing failure"** is not a valid label — all failures are current failures, and fixing them is your responsibility
  - **Before pushing**: Run `npm test` and verify zero failures. The Husky pre-push hook enforces this automatically.
  - **Before concluding work**: If you modified code, run the full suite (`npm run test:all`) and fix any failures
  - **The principle**: This is a classic responsibility gap where no one claims failures because "someone else caused them." The standard eliminates this gap — if you see a failure, you own it
  - **Enforcement**: Husky pre-push hook (local), GitHub Actions CI with branch protection (remote), Claude Code test-health-gate hook (session-level)

- **Agent Awareness Standard**: Every feature added to Instar MUST include a corresponding update to the CLAUDE.md template (`src/scaffold/templates.ts` → `generateClaudeMd()`). An agent that doesn't know about a capability effectively doesn't have it. This means:
  1. **API endpoints** — Add to the Capabilities section with curl examples
  2. **Proactive triggers** — Add to Feature Proactivity ("when user does X → use this")
  3. **Registry lookups** — Add to the "Registry First" table if it answers a state question
  4. **Building blocks** — Add to "Building New Capabilities" if it's a tool the agent should reach for

  The principle: agents interact with users conversationally, not through CLIs. If the template doesn't mention a feature, no agent will ever surface it. The template IS the agent's awareness.

- **Migration Parity Standard**: Any change to agent-installed files (`.claude/settings.json` hooks, `.instar/config.json` defaults, CLAUDE.md template sections, hook scripts) MUST include a corresponding post-update migration in `PostUpdateMigrator.ts`. New agents get changes via `init`, but existing agents only get them through migrations. A feature that only works for new agents is a broken feature.
  1. **Hook template changes** (`src/data/http-hook-templates.ts`) — Add a migration in `migrateSettings()` that patches existing `.claude/settings.json`
  2. **Config defaults** — Add to `migrateConfig()` with existence checks (only add missing fields)
  3. **CLAUDE.md sections** — Add to `migrateClaudeMd()` with content-sniffing guards
  4. **Hook scripts** — Add to `migrateHooks()` with path migration logic
  5. **Idempotency** — Every migration must be safe to run multiple times (check before patching)

  The principle: instar agents update in place. If `PostUpdateMigrator` doesn't know about a change, deployed agents will silently run stale configurations. This is how the zombie-cleanup-kills-active-sessions bug happened — and why we enforce this structurally with CI.

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

- **NEVER Use AskUserQuestion for Free-Text Input**: AskUserQuestion is ONLY for multiple-choice DECISIONS (pick A or B). NEVER use it to collect passwords, emails, tokens, names, or any free-text input. AskUserQuestion automatically adds escape-hatch options beneath the input, creating a confusing multi-choice menu when the user just needs to type something. **Instead:** Output the question as plain text, then STOP and wait for the user's next message. Their response IS the answer. This is the #1 setup wizard UX failure mode.

## Key Patterns from Dawn

These patterns were earned through real failures. Don't weaken them:

- **tmux trailing colon**: Use `=session:` (trailing colon) for pane-level commands. `=session` (no colon) FAILS SILENTLY for send-keys/capture-pane on tmux 3.6a.
- **Nullish coalescing for numbers**: `maxParallelJobs ?? 2`, NOT `maxParallelJobs || 2`. Zero is falsy.
- **Protected sessions**: Always maintain a list of sessions that the reaper should never kill.
- **Completion detection**: Check tmux output for patterns, don't rely on process exit.
