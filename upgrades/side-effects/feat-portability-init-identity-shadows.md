# Side-effects review — Init non-Claude identity shadows (Gap 1)

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER — a non-Claude install got no identity file at init. After: no
over-block. claude-code is explicitly excluded so the rich CLAUDE.md is never
touched; only AGENTS.md/GEMINI.md are added. No new under-block: a no-canonical
state is a clean no-op, matching prior behavior (nothing was written then
either).

## 2. Level-of-abstraction fit

The render logic lives in IdentityRenderer (where all shadow rendering lives).
init just calls it. Correct altitude — init orchestrates, the renderer renders.

## 3. Signal vs Authority compliance

Canonical `.instar/AGENT.md` is the AUTHORITY. The shadow files are derived
SIGNAL copies carrying the auto-generated banner. The helper never invents
identity; it copies the canonical body. No brittle filter gains authority.

## 4. Interactions with adjacent systems

- **generateClaudeMd / CLAUDE.md** — untouched (excluded by design).
- **ensureFrameworkIdentityFile** (runtime spawn) — unchanged; this closes the
  init-time window before first spawn, the two are complementary and both
  idempotent so double-render is harmless.
- **Gap 6 (migrator/renderer unification)** — independent; this PR does not
  pre-empt or block it.
- **PostUpdateMigrator** — not touched. Existing installs are unaffected (they
  already self-heal at spawn via ensureFrameworkIdentityFile).

## 5. Rollback cost

Low. One new exported function + two call sites + one test file. `git revert`
restores prior behavior; no state migration, deployed agents unaffected
(runtime self-heal path unchanged).

## 6. Backwards compatibility / drift surface

Fully backward-compatible. Claude-code installs: identical behavior (CLAUDE.md
written exactly as before; AGENTS.md/GEMINI.md additionally appear but are
inert for Claude Code). Non-Claude installs: strictly better (identity present
from init). Drift surface: none — shadows are deterministic renders of
canonical, idempotent.

## 7. Authorization / Trust posture

No new authority. The helper reads canonical AGENT.md and writes derived
shadows under projectDir — the same write surface init already owns. Best-
effort: a render failure cannot break init or escalate anything.

## Outcome

Ship. Narrow, additive, verified against actual code, idempotent, fully
tested, trivial rollback. First of the v1.0.9–v1.0.14 portability hardening
series the v1.0.8 notes committed to.
