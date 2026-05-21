# Side-effects review — Wizard codex spawn model pin

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER. The wizard launch and the secret-setup spawn both ran
`codex exec` without `-m`, inheriting Codex CLI's bundled default
(`gpt-5.2-codex`) which OpenAI retired from ChatGPT-subscription
accounts on 2026-04-14. Every ChatGPT-subscription user hit a 400
from OpenAI before the wizard could render. The previously-shipped
runtime prompt (v1.2.1) made this reachable from the most natural
install command, so the bug surfaced on Justin's first end-to-end
test.

After: precisely scoped. Two argv positions add `-m
WIZARD_CODEX_MODEL`. No other code path touched. No over-block: API-
key users who explicitly want a different model can still override
via `CODEX_MODEL` env (Codex CLI honors it) or by editing their
shell init — the constant only sets the wizard default.

## 2. Level-of-abstraction fit

One module-scope constant (`WIZARD_CODEX_MODEL`) in `setup.ts`
captures the wizard's policy choice. Two existing argv builders
consume it. No new abstraction layer.

Importing from `src/providers/adapters/openai-codex/models.ts`'s
TIER_TO_MODEL was considered and rejected — setup.ts has no other
dependency on the openai-codex adapter, and the constant doesn't
need to track every adapter-side update. If the available model
set drifts, the canary will surface the regression via deployed
errors faster than wiring a cross-module import would help.

## 3. Signal vs Authority compliance

The wizard's chosen model is a SIGNAL to Codex. Codex / OpenAI is
the AUTHORITY for "is this model accessible to this auth posture."
The change moves the SIGNAL into instar's explicit control instead
of letting Codex's API-tier default decide for ChatGPT-subscription
users.

Memory `feedback_openai_path_constraints` (2026-05-16) is honored:
no raw OPENAI_API_KEY routing, no API-tier model leakage to the
subscription path.

## 4. Interactions with adjacent systems

- **`src/providers/adapters/openai-codex/models.ts`** — unchanged.
  The adapter's TIER_TO_MODEL map remains the authoritative
  empirically-probed availability table. The wizard's constant
  mirrors one of its entries (`balanced` tier = `gpt-5.3-codex`).
- **`src/core/SessionManager.ts`** — unchanged. Non-wizard codex
  spawns elsewhere in the codebase already pass model selection
  via existing options paths.
- **Existing `instar setup --framework codex-cli`** path —
  unchanged. The bareword prompt path (v1.2.1) and the explicit
  subcommand path both flow through the same `runSetup` function,
  so both pick up the fix in one place.
- **Bareword runtime prompt** (v1.2.1) — unchanged. The prompt
  routes intent (Claude vs Codex); the model flag is downstream of
  the routing decision.
- **`CODEX_MODEL` env var** — Codex CLI honors this env var to
  override `-m`. API-key users who want the frontier model can
  still set it (`CODEX_MODEL=gpt-5.2-codex npx instar`); the
  default for subscription users is now safe.

## 5. Rollback cost

Trivial. One constant, two `-m WIZARD_CODEX_MODEL` insertions, one
canary test. `git revert` restores the pre-fix broken-on-
subscription behavior; nothing else depends on the constant.

## 6. Backwards compatibility / drift surface

Fully backwards-compatible.

- Existing CLI surface unchanged.
- ChatGPT-subscription users: were broken, now work. No regression.
- API-key users: same model selection behavior as before (Codex
  CLI's `CODEX_MODEL` env overrides `-m`).
- No agent-installed-files change → no `PostUpdateMigrator` work.

Drift surface: if OpenAI retires `gpt-5.3-codex` from
ChatGPT-subscription accounts in the future, the wizard will fail
the same class of error. The canary test catches "the model flag
is missing"; an additional follow-up canary should probe the
configured model against the user's auth before launching the
wizard, but that is out of scope here.

## 7. Authorization / Trust posture

No new authority. The fix selects a model already accessible to
the existing auth posture; it does not add OPENAI_API_KEY support,
does not bypass any gate, does not change sandbox or approval
flags on the spawn.

## Outcome

Ship. Closes the broken-from-the-jump Codex install path on
ChatGPT-subscription accounts. Canary test in CI prevents
regression. Single-constant locality keeps the fix small.
