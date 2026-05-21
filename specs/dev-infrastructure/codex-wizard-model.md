---
title: "Wizard codex spawn — pin --model to subscription-supported"
slug: "codex-wizard-model"
author: "echo"
eli16-overview: "codex-wizard-model.eli16.md"
review-convergence: "2026-05-21T19:10:00Z"
review-iterations: 1
review-completed-at: "2026-05-21T19:10:00Z"
review-report: "docs/specs/reports/codex-wizard-model-convergence.md"
approved: true
---

# Wizard codex spawn — pin --model to subscription-supported

## Problem statement

First end-to-end install attempt via `npx instar` → runtime prompt →
"Codex CLI" on a ChatGPT-subscription Codex install
(`instar-codey`, v1.2.9) failed immediately with:

```
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account."}}
```

Cause: `src/commands/setup.ts` spawns `codex exec` for both the
setup-wizard launch and the secret-setup micro-session without
passing `-m`/`--model`. Codex CLI's bundled default is
`gpt-5.2-codex`, which OpenAI retired from ChatGPT-subscription
accounts on 2026-04-14 (API-only since).

The codebase already knows this. The Codex adapter at
`src/providers/adapters/openai-codex/models.ts` maps canonical tiers
to ChatGPT-subscription-compatible models — empirically probed
against Justin's account on 2026-05-15:

- ✅ working on ChatGPT auth: `gpt-5.2`, `gpt-5.3-codex`, `gpt-5.4`
- ❌ rejected on ChatGPT auth: `gpt-5`, `gpt-5-codex`, `gpt-5.2-codex`
  (Codex CLI's default), `gpt-5.3`, `gpt-5.4-codex`

The setup wizard just didn't apply that knowledge to its own spawn.

Memory `feedback_openai_path_constraints` (2026-05-16) was already
explicit: "Codex must route via ChatGPT subscription OAuth; raw
OPENAI_API_KEY is forbidden as a routine path." The wizard spawn
omission violated that constraint by leaving model selection to
Codex's API-tier default.

## Proposed design

Three changes in `src/commands/setup.ts`:

1. **New exported constant `WIZARD_CODEX_MODEL = 'gpt-5.3-codex'`.**
   The "balanced" tier from the adapter's TIER_TO_MODEL map.
   Exported so the canary test can import and assert against it.

2. **Wizard launch spawn** (the main setup-wizard prompt) adds
   `-m`, `WIZARD_CODEX_MODEL` to the codex argv right after
   `--dangerously-bypass-approvals-and-sandbox`.

3. **Secret-setup micro-session spawn** (Phase 2.5, configures
   Bitwarden / etc) adds the same.

A new unit test, `tests/unit/setup-codex-model-canary.test.ts`,
pins this as a structural contract:

- Asserts `WIZARD_CODEX_MODEL` is NOT `gpt-5.2-codex` and matches a
  known-working ChatGPT-subscription model pattern.
- AST-greps every `framework === 'codex-cli'` exec block in
  `setup.ts` and asserts each contains `-m WIZARD_CODEX_MODEL`.
- Refuses any single- or double-quoted `gpt-5.2-codex` literal in
  the source (comments referencing the retired model are fine).

If a future PR adds a third codex spawn in setup.ts without the
flag, or removes the flag from either existing spawn, the test
fails in CI.

## Decision points touched

- The wizard spawn now carries an operator-intent SIGNAL (the model
  name) instead of inheriting Codex's API-tier default. AUTHORITY
  for model availability remains with the Codex backend; we are
  only choosing the SIGNAL we send.
- No new auth path. The fix selects a model the existing
  ChatGPT-subscription auth path accepts. Raw OPENAI_API_KEY routing
  is still forbidden per `feedback_openai_path_constraints`.
- No public CLI surface change. `instar setup --framework codex-cli`
  and the bareword `npx instar` prompt path emit the same user-
  visible behavior — they just now reach the wizard step instead of
  bouncing off Codex's 400-error.

## Open questions

None. The fix is one constant + four lines of argv across two
spawns, plus a canary test.

## Out of scope

- A runtime probe that asks the user "which Codex model do you want
  to use?" and persists the choice. The pinned default works for
  every ChatGPT-subscription user we know of; persistence is
  premature optimization until a user reports needing it.
- Aligning the wizard spawn's model with the canonical
  TIER_TO_MODEL map by importing from the Codex adapter. That
  would create a setup.ts → adapter dependency for one string
  literal; the constant in setup.ts is the right size for now. If
  the available model set drifts, both sources need updating, but
  the canary test will surface drift via deployed-user error
  reports faster than the import wiring would.
- An offline probe in `instar setup --framework codex-cli` that
  shells `codex exec -m <name> "echo ok"` against the user's auth
  before launching the wizard. Useful as a follow-up; out of scope
  for this hotfix.
