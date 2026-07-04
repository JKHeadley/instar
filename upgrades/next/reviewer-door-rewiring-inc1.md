---
user_announcement:
  - audience: agent-only
    maturity: experimental
---

## What Changed

Added a third **spec-converge external reviewer family**: the strongest Anthropic model
(`claude-fable-5`) now reads a spec through the clean `claude -p` door — off the measured-penalized
`opus × coding-harness` pair (INSTAR-Bench v2: Opus-4.8-via-Claude-Code 81.7% vs clean-API 99.1%, a
17.4-point door penalty). This is **inc1** of REVIEWER-DOOR-REWIRING, and ships **dark on the fleet /
live on a development agent** (the `specConverge.reviewers.anthropic.enabled` developmentAgent gate —
absent config keeps today's exact `[codex, gemini]` behavior byte-for-byte).

The reviewer is a **clean-door second read, NOT a cross-model opinion** — it carries `crossFamily:
false` and books into its own `clean-door-anthropic-review` disclosure field, so a claude-only round
can never launder the `cross-model-review` flag. Because a spec under review is untrusted ~60KB text,
the call is **hardened to codex-door parity**: empty allowed-tools (`--allowedTools ''`, an allow-list
not a denylist), `--strict-mcp-config`, a neutral scratch cwd, the prompt via stdin (never argv), an
env allowlist that strips agent secrets (`INSTAR_AUTH_TOKEN`), and a runtime fail-closed preflight
that degrades (never runs unhardened) if the installed CLI lacks the flags. The model argument is the
CONCRETE frontier pin — never the tier word `'capable'`, which resolves to opus.

## What to Tell Your User

Nothing proactive — this is instar-developing-agent tooling that ships off on the fleet. If a user
asks why a spec-converge run now shows a "clean-door Anthropic review" line, or whether the strongest
Claude model reviews specs: on a development agent the spec is now also read by Fable 5 (the strongest
Claude model) through a clean door (separate from the six in-session reviewers), disclosed on its own line and never
counted as a cross-model opinion. It is dogfooded on the development agent first, before any wider
rollout; the "clean door" claim is scoped to *off the measured-penalized coding-harness door*, not
bench-verified-clean (that direct bench is a tracked follow-up).

## Summary of New Capabilities

- **`--family claude-code` clean-door reviewer** in spec-converge — config-gated
  (`specConverge.reviewers.anthropic.enabled`, dev-on / fleet-dark); an optional
  `specConverge.reviewers.anthropic.model` override is validated against the frontier accept-set
  (a non-frontier concrete id like `claude-opus-4-8` is rejected, never silently honored).
- **Cross-model honesty guard** — `crossFamily` is threaded onto the reviewer registry,
  `ReviewerResult`, and `CrossModelDetectionResult` (fail-closed on an unknown id); the aggregate
  flag, both detection paths, and the 7-day externals-mandatory baseline all filter on
  `crossFamily: true`, so the claude family can never masquerade as cross-model.
- **Inbound-safety hardening** for reviewing untrusted spec text (empty allowed-tools,
  strict-mcp-config, neutral cwd, stdin prompt, env allowlist), verified by a STATE-level
  zero-tool-execution test against the real Claude CLI.
- No behavior change while the family stays dark (the fleet default); this only makes the reviewer
  reachable on a development agent.

## Evidence

- `tests/unit/crossModelReviewer-clean-door.test.ts` — detection (static presence reasons only),
  model resolution (default pin, tier-word + non-frontier-override rejection), the §5 lockdown
  battery (a–e), the required-`crossFamily`-field guard, per-family concrete-pin model-arg, and the
  config-gate default (fleet-absent = exactly `[codex, gemini]`).
- `tests/unit/claude-reviewer-inbound-safety.test.ts` — hardened argv/env asserted deterministically
  + a live-claude-gated STATE test proving a benign tool-invoking payload creates ZERO files.
- `tests/unit/model-registry-freshness-reviewer-pin.test.ts` — the freshness-lint tooth on the
  reviewer pin is NOT vacuous (a rotted constant fails the strict lint).
- `tests/integration/clean-door-reviewer-driver.test.ts` — the driver `--family`/`--detect-only`
  paths: clean-door flag shape, trusted-but-disabled refusal, family-present-only-when-enabled.
- `tests/unit/PostUpdateMigrator-anthropicReviewerDisclosure.test.ts` — the SKILL.md content
  migration reaches already-installed agents (idempotent, fingerprint-guarded).
