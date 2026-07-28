---
title: Codex Intelligence-Provider Clean-Call Fix
status: approved
approved: true
approver: justin
approved-at: "2026-05-26T20:42:33Z"
owner: echo
created: 2026-05-26
companion-eli16: CODEX-INTELLIGENCE-PROVIDER-CLEAN-CALL-SPEC.eli16.md
eli16-overview: CODEX-INTELLIGENCE-PROVIDER-CLEAN-CALL-SPEC.eli16.md
review-convergence: "2026-05-26T20:37:02.352Z"
review-iterations: 2
review-completed-at: "2026-05-26T20:37:02.352Z"
review-report: "docs/specs/reports/codex-intelligence-provider-clean-call-convergence.md"
---

# Codex Intelligence-Provider Clean-Call Fix

## Problem

Instar makes ~1,500+ small internal LLM "judgment" calls per agent per day — message
classification, terminal-output analysis, view-metadata, arc extraction, usher,
coherence checks, commitment detection, session synthesis, etc. All of these route
through the agent's configured `IntelligenceProvider`.

For Claude agents this is cheap and clean. `ClaudeCliIntelligenceProvider.evaluate()`
passes `--setting-sources user`, with the explicit comment: *"Exclude project/local
CLAUDE.md to prevent identity context from contaminating classification and evaluation
prompts."* The judgment call runs on a clean notepad — no identity, no project hooks.

`CodexCliIntelligenceProvider.evaluate()` has **no equivalent**. It runs:

```
codex exec --model M --sandbox read-only --cd <workingDirectory> --skip-git-repo-check <prompt>
```

where `workingDirectory` is the agent's project directory (e.g.
`/Users/justin/Documents/Projects/instar-codey`, passed by
`intelligenceProviderFactory`). Because `codex exec` runs *in the project dir*, it:

1. **Loads `AGENTS.md`** — the agent's full ~26 KB rendered identity — into every call.
2. **Fires the project's `.codex/hooks.json` hooks** — `session_start`,
   `user_prompt_submit`, `stop` — on every call (confirmed in the live agent's
   `~/.codex/config.toml` `[hooks.state]` bound to the project path).

### Evidence (2026-05-26 diagnostic)

`~/.codex/sessions/` rollout logs for 2026-05-25: **1,601** `codex exec` spawns in one
day, up to 12/minute. Tallied by task prompt, ~1,550 were internal judgment calls
(notification-protocol job 496, terminal-output analysis 305, view-metadata 229,
arc-extractor 133, message-classifier 73, usher 61, coherence 12, commitment-detect 18,
synthesis 9, …). Only ~48 were real work (inter-agent messages). A sampled 21:52
classifier rollout re-injected the 26 KB identity + a full `SESSION START` block to
output a single word: `normal`.

### Downstream damage

- **Notification/standby spam** ("actively working / message delivered / still working"):
  the `session_start` hook firing on ~1,550 spawns/day makes instar's monitoring layer
  think real sessions are constantly starting.
- **Delivery failures** ("couldn't deliver — please resend"): 12 heavyweight spawns in a
  single minute saturate the machine, so a real inbound message can't get a process slot.
- Cost: every one-word judgment pays a full 26 KB identity load + hook chain.

This is the dominant Codex-specific defect. It is plumbing, not behavior — the Codex
integration is making the agent put on its full uniform to answer "what time is it" 1,500
times a day.

## Fix

Mirror the Claude provider's clean-notepad guarantee inside
`CodexCliIntelligenceProvider`. Judgment calls must run with **no project identity and no
project hooks**.

**Mechanism (primary):** run `codex exec` with `--cd` pointed at a dedicated, empty,
instar-managed **scratch directory** that (a) contains no `AGENTS.md` and (b) has no
`.codex/hooks.json`. With no `.codex/hooks.json` at or above that path, no project hooks
fire; with no `AGENTS.md`, no identity loads. `--skip-git-repo-check` (already present)
keeps it runnable in a non-git dir.

- The scratch dir is created via `fs.mkdtempSync(<os.tmpdir()>/instar-codex-intel-scratch-)`,
  cached for the process, and **re-verified each call** (recreated if a tmp-reaper deleted
  it during a long-lived process).
- **Security — why `mkdtemp`, not a fixed name (convergence finding).** Codex discovers
  hooks by walking *up* from the cwd and fires any `.codex/hooks.json` it finds, and
  `project_doc_max_bytes=0` does **not** gate hooks. On Linux `os.tmpdir()` is the
  world-writable `/tmp`, so a *fixed, guessable* dir name could be pre-created (or
  symlinked) by another local user with a planted `.codex/hooks.json`, re-introducing hook
  execution under the agent's identity. `mkdtempSync` defeats this: it appends an
  unguessable random suffix, creates the dir with mode `0700` owned by this process, and
  refuses to follow a pre-existing path — so nothing can be planted in the cwd these calls
  run in. (On macOS `os.tmpdir()` is already a per-user `0700` dir, but instar ships to
  Linux hosts too, so this hardening is required, not optional.)
- The provider no longer stores `workingDirectory` (the field is removed). It is retained
  on the options *type* for API compatibility (the factory still forwards it), but it is
  never used as the exec cwd — these calls "don't depend on cwd content" per the existing
  comment. Verified: of the three construction sites (`reflect.ts`, `route.ts`,
  `server.ts`), only `route.ts` passes a `workingDirectory` and it uses that value solely
  for its own `PreferenceStore` DB path, never for the codex cwd — so dropping it breaks
  nothing.

**Belt-and-suspenders:** also pass `-c project_doc_max_bytes=0` to hard-disable project-doc
loading even if a stray `AGENTS.md` ever sits *above* the scratch path on the walk-up. This
is a real, stable Codex config key already used elsewhere in instar
(`src/providers/adapters/openai-codex/control/contextScopeControl.ts`); the primary
mechanism does not depend on it (it covers the `AGENTS.md` walk-up case, not hooks — hooks
are closed by the unguessable dir name above).

Scope: one file (`src/core/CodexCliIntelligenceProvider.ts`), plus a tiny private
scratch-dir helper. No config/hook/template migration is required — this is a code-only
change. Per the Migration Parity Standard, code-only changes reach existing Codex agents
through the normal update path with no migration step; this is noted explicitly so a
reviewer does not expect a `PostUpdateMigrator` entry.

## Testing

This change is a spawn-arg / cwd contract on a single provider class — it adds no HTTP route
and no dependency-injected server component, so the routed-feature "feature is alive" E2E
tier does not map. Coverage is the unit contract plus the mandatory live reproduction.

- **Unit (`tests/unit/CodexCliIntelligenceProvider.test.ts`, present in this change):** uses
  a fake-codex shim that echoes its argv, and asserts:
  - `--cd` is the instar scratch dir and is **not** the passed `workingDirectory`;
  - the scratch dir exists and is empty (no `AGENTS.md`, no `.codex/`);
  - `-c project_doc_max_bytes=0` is passed;
  - the scratch dir is created with mode `0700` (not group/other accessible);
  - the dir name is random-suffixed (unguessable), not a fixed path;
  - the dir is recreated if deleted mid-process (tmp-reaper recovery);
  - the existing arg-shape + non-zero-exit + env-allowlist tests still pass.
- **Live / bug-fix evidence bar (REQUIRED — unit tests are not evidence):** reproduce on a
  real Codex agent. Before the change: trigger a classify call and confirm its rollout loads
  the 26 KB identity + a `SESSION START` block. After the change: confirm the rollout for the
  same call is bare (no identity, no session_start). This is the test-as-self gate and must
  be captured before ship.

## Explicitly excluded (covered elsewhere)

- The **cadence** of internal judgment calls (~1,550/day even when each is cheap) is a
  separate, framework-shared optimization, addressed by its own future spec — not changed by
  this fix. <!-- tracked: topic-13435 -->
- The verbose-narration and force-push-punting symptoms are separate Codex-guidance gaps,
  owned by the framework-onboarding mentor system spec. <!-- tracked: topic-13435 -->

## Connection

This is the Phase 0 prerequisite of the framework-onboarding mentor system. It ships first so
the mentor loop runs on a healthy system rather than amplifying the leak.
