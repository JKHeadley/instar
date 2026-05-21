# Side-effects review — Wizard always via Claude

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER. The bareword runtime prompt let the user pick Codex,
which then spawned Codex for the wizard. Codex ignored the wizard
skill's conversational contract and executed the setup non-
interactively — generic agent identity, made-up user, no questions
asked. Real failure mode observed on `instar-codey` on 2026-05-21.

After: precisely targeted. The wizard ALWAYS runs on Claude. The host
framework choice still gates everything else (enabledFrameworks,
scaffold contents, runtime behavior). No over-block: a user who
selected Codex still gets a Codex agent — they just go through a
Claude-driven onboarding wizard first.

A new refusal path catches the case where Claude is missing on a
Codex-target host (Claude is already a top-level prerequisite per
`ensurePrerequisites`, so this is a defense-in-depth check, not a
new blocker).

## 2. Level-of-abstraction fit

Two argv builders in `setup.ts` were ternary on `framework`. Both
collapse to the unconditional Claude form. The `wizardBinary`
assignment moves from a ternary to a single `const = claudePath`
with an upstream null-check. The function signature of
`ensureSecretBackend` keeps the `framework` parameter (renamed to
`_framework` to mark unused) for ABI stability with internal callers
during the transition; future tidy-up PR can drop it.

The `WIZARD_CODEX_MODEL` exported constant from PR #299 is kept as a
deprecated public symbol — it's no longer consumed by setup.ts, but
removing public API would be a SemVer-affecting breaking change for
a non-blocking concern. Future PR can remove it on a minor bump.

## 3. Signal vs Authority compliance

- The user-runtime SIGNAL (from the v1.2.1 runtime prompt) still
  reaches the agent's `enabledFrameworks` config and downstream
  scaffolding decisions. It just no longer governs the interactive
  wizard binary choice.
- The wizard binary is now a constant choice — Claude — based on a
  capability AUTHORITY: Claude reliably honors the wizard skill's
  conversational contract, Codex empirically does not.
- The runtime check `if (!claudePath) { … process.exit(1); }` is a
  hard refusal at the gate, not an inference. The detection result is
  the AUTHORITY.

## 4. Interactions with adjacent systems

- **v1.2.1 runtime prompt** (`promptForFramework` in setup.ts) —
  unchanged. The prompt still asks which runtime the user wants;
  that choice still flows into `enabledFrameworks`. Only the wizard
  binary downstream of that prompt is forced to Claude.
- **`checkFrameworkPrerequisite`** — unchanged. It still validates the
  user's framework choice has its CLI installed.
- **`ensurePrerequisites`** — unchanged. Top-level prerequisites still
  require Claude regardless of framework, so the new refusal in
  setup.ts is a defense-in-depth check rather than a new blocker.
- **`ensureSecretBackend`** — internal change. The function still
  accepts a `framework` parameter (renamed `_framework`) for caller
  stability; the body no longer uses it.
- **`/setup-wizard` slash-command** (`.claude/skills/setup-wizard/
  SKILL.md`) — unchanged. The wizard skill text remains authored for
  Claude-style behavioral contracts, which is now consistent with the
  binary that runs it.
- **`/secret-setup` slash-command** (`.claude/skills/secret-setup/
  SKILL.md`) — unchanged.
- **PR #299 canary** — replaced. The previous canary asserted every
  codex exec block in setup.ts carries `-m WIZARD_CODEX_MODEL`. The
  v1.2.12 canary asserts there are NO codex exec blocks in setup.ts.

## 5. Rollback cost

Trivial. One ternary becomes a const, two ternaries become constant
arrays, one new refusal block. `git revert` restores the v1.2.11
behavior (which is functional but produces the broken Codex wizard
UX). No state migration needed.

## 6. Backwards compatibility / drift surface

Fully backwards-compatible for users.

- A user who selected Claude at the runtime prompt: zero behavior
  change.
- A user who selected Codex: now gets a working conversational wizard
  before their Codex agent is set up. Previously got a broken
  experience; now gets a good one.
- A user on a host without Claude installed: was blocked by
  `ensurePrerequisites` before; now blocked there AND defensively at
  the wizard binary check. No new install path opened or closed.
- API-key Codex users: the wizard runs on Claude, so OPENAI_API_KEY
  is not consulted during setup. Their auth posture is unchanged.

No `PostUpdateMigrator` work needed (no agent-installed-files
change, no config schema change, no hook change).

## 7. Authorization / Trust posture

No new authority. The wizard already ran with
`--dangerously-skip-permissions` on Claude (per the existing
launchArgs); the only change is that this is now ALWAYS the spawn
shape, not framework-conditional. No new sandbox bypass, no new
auth, no new privilege.

## Outcome

Ship. Closes the broken-from-the-jump Codex install UX. Closes the
class of "wizard skill not honored on non-Claude framework" bug
structurally — both interactive micro-sessions in setup.ts now use
the runtime that's known to honor the skill's contract. Canary
prevents regression. Single-purpose change, two callsites,
trivial rollback.
