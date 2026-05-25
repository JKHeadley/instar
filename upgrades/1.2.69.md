# Upgrade Guide — the review gate now reads the constitution

<!-- bump: minor -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->

## What Changed

**The constitution stops being a doc nobody checks.**

The living constitution (`docs/STANDARDS-REGISTRY.md`) has been on main for a
while, but nothing actually *read* it when a new spec was written — the
"check this against the standards" step was a prompt the reviewer had to remember,
and on some hosts the tool that runs it isn't even installed. So a spec could
break a standard and slip through: the North Star draft quietly violated **No
Manual Work**, the review missed it, and only Justin caught it. The rulebook
existed with no inspector — the exact "shipped but asleep" trap the rulebook was
written to fight, turned on itself.

This builds the inspector:

- **A registry parser** reads the constitution into structured articles, with a
  **canary** so a formatting change can't silently hide half the rulebook (it
  asserts a sane article count and that anchor articles parse).
- **A conformance reviewer** checks a draft spec against every article and returns
  a rule-by-rule report ("this part might break No-Manual-Work, here's why"). It
  runs on the subscription LLM path (never a raw API client), is degrade-safe (a
  down provider yields an empty report, never blocks spec work), and is
  prompt-injection-hardened (the spec is treated as untrusted data).
- **It SIGNALS, never blocks.** The report advises; the human + the existing
  approval gate decide. Blocking authority is a deliberate later step, gated on
  measured precision.
- **Observability**: `GET /spec/conformance-metrics` shows runs and which standards
  get flagged most — the heat map of where our drafts drift, which itself feeds
  evolution.

Default-on (`specReview.conformance.enabled`); 503-stubs cleanly where the
constitution isn't present.

**Evidence**: 20 new tests across all three tiers (10 unit, 6 integration, 4 e2e)
— 117 related (discoverability/config/route) tests green; `tsc` + lint clean
(including the no-raw-LLM-HTTP guard). The Tier-3 e2e reproduces the motivating
incident in miniature: a spec whose design requires manual work is fed to the gate
and flagged against **No Manual Work**, while a conforming spec is not (no false
positive). The parser is verified against the real on-disk constitution (22
articles, canary green).

Spec: `docs/specs/standards-conformance-gate.md` (approved; Claude-authored +
manual review — full multi-model convergence tooling absent on host, caveat
ratified explicitly). ELI16: `docs/specs/standards-conformance-gate.eli16.md`.
Side-effects: `upgrades/side-effects/standards-conformance-gate.md`.

## What to Tell Your User

- **The rulebook now checks the work**: "When I write a new plan, a checker now
  reads our actual standards and flags anything that might break one — so a plan
  can't quietly violate a rule and slip past. It advises; we still decide."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Spec standards-conformance check | `POST /spec/conformance-check` (`{markdown}` or `{specPath}`) → rule-by-rule report |
| Conformance observability | `GET /spec/conformance-metrics` → runs + per-standard flag counts |
| Constitution parser + canary | `StandardsRegistryParser` (drift-guarded) |

## Evidence

Not a bug fix — a new capability. Verified end-to-end (not unit-mocked) by the
Tier-3 e2e that reproduces the motivating incident: a manual-work-requiring spec
is flagged against No Manual Work, a conforming spec is not. The registry parser
is exercised against the real on-disk constitution (22 articles parsed, canary
green). Signal-only by construction (no `block` path exists). 137 tests green
across the feature + related suites; `tsc` + lint clean.
