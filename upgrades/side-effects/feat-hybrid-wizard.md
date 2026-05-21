# Side-effects review — Hybrid wizard

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER for Codex-runtime users. The bareword runtime prompt
let users pick Codex, which then spawned Codex with the wizard skill.
Codex ignored the skill's conversational contract and executed setup
non-interactively. Generic agent identity, no walkthrough.

After: precisely targeted. instar's state machine owns the
conversation flow; Codex is restricted per-turn to narrative-only
generation. Claude users see zero change (they keep the existing
SKILL.md-driven spawn). API-key Codex users keep the same auth
posture they had before. The agentic Telegram phase still uses
Codex with full sandbox bypass — that's the right tool for browser
automation.

## 2. Level-of-abstraction fit

A new directory `src/commands/setup-wizard/` holds three files:
- `state-machine.ts` — pure data + transition functions, no I/O.
- `codex-driver.ts` — I/O (codex spawn, readline, CLI subcommands).
- `model-constants.ts` — single constant import target.

setup.ts adds one dispatch branch (~12 LOC). It dynamically imports
the codex driver only when the user picks Codex, keeping the
setup.ts module load lightweight.

The state machine is intentionally a flat record of states; no
class hierarchy, no event emitters. Drivers consume it via simple
lookups. Adding a state is one edit.

## 3. Signal vs Authority compliance

- The user's runtime choice from the bareword prompt remains an
  operator-intent SIGNAL flowing into `enabledFrameworks` and the
  wizard dispatch.
- The state graph's transition functions are deterministic AUTHORITIES
  for "what state comes next" given a user answer. Codex never sees
  the transition function and cannot influence routing.
- `WIZARD_CODEX_MODEL` is the AUTHORITY for which Codex model the
  narrative spawns use, drawn from the existing empirically-probed
  availability table at `src/providers/adapters/openai-codex/models.ts`.
- The agentic Telegram phase respects the existing AUTHORITY for
  Telegram bot creation (BotFather / OpenAI Codex's tool access /
  Playwright MCP).

## 4. Interactions with adjacent systems

- **v1.2.1 runtime prompt** (`promptForFramework`): unchanged. Still
  reads `1`/`2`/`codex` and returns the chosen runtime.
- **`checkFrameworkPrerequisite`**: unchanged. Still validates the
  chosen runtime's binary is detected.
- **`ensureSecretBackend`** (Phase 2.5): unchanged in v1.2.12. Still
  spawns the chosen framework with `/secret-setup` for the secret
  backend choice. A future PR can route secret-setup through the
  state machine too, but for v1.2.12 we keep that scope bounded.
- **Existing wizard SKILL.md**: unchanged. Still owned by the Claude
  path; the Codex path uses it ONLY as a reference target for the
  Telegram-agentic phase prompt.
- **CLI subcommands the wizard calls** (`init`, `user add`, `server
  start`, `autostart install`): unchanged. The driver calls them via
  `execFileSync('npx', ['instar', ...])` the same way the existing
  SKILL.md tells Claude to call them.
- **PR #299's canary**: updated. Previously asserted every `codex exec`
  in setup.ts carries `-m WIZARD_CODEX_MODEL`. v1.2.12 asserts setup.ts
  no longer has codex exec spawns (they moved into codex-driver.ts),
  setup.ts dispatches via `runCodexWizard`, and the driver's codex
  exec spawns still carry `-m WIZARD_CODEX_MODEL`.

## 5. Rollback cost

Low. Three new files in a new directory plus one ~12-LOC dispatch
branch in setup.ts. The old `codex exec` argv shape in setup.ts is
removed; reverting reintroduces it. Claude path untouched.

`git revert` restores the v1.2.11 broken-on-Codex behavior. No state
migration; no agent-installed-files changes; no `PostUpdateMigrator`
work needed.

## 6. Backwards compatibility / drift surface

Fully backwards-compatible.

- Claude-runtime users: zero change.
- Codex-runtime users: now get a working conversational wizard
  driven by instar with Codex-generated narrative. Previously got
  broken non-interactive setup.
- API-key Codex users: auth posture unchanged. `CODEX_MODEL` env
  still overrides the wizard's `-m` flag if they prefer a different
  model.
- No config schema change. No agent file template change. No hook
  change.

Drift surface: the state graph and per-turn narrative prompts. Both
are flat data structures, so drift is visible in PR diffs. The
canary covers the dispatch shape; manual review covers narrative
prompt quality.

## 7. Authorization / Trust posture

No new authority. The per-turn narrative codex spawns use `-s
read-only` (a strictly lower-privilege sandbox than the
`--dangerously-bypass-approvals-and-sandbox` the existing wizard
spawn uses). The Telegram-agentic phase keeps the existing sandbox-
bypass posture so it can drive Playwright. The action states call
`execFileSync('npx', ...)` for `init`, `user add`, `server start`,
`autostart install` — the same CLI surface the existing wizard
calls.

No new auth, no new gate, no new privilege.

## Outcome

Ship. Closes the broken-on-Codex install experience that the v1.2.11
instar-codey log surfaced. Per-framework specialization preserves
each runtime's strengths (Claude's reliable skill-following, Codex's
strong execution mode for agentic phases). Structure-as-guarantee
prevents the regression class. Canary in CI guards the dispatch
contract.
