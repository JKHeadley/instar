# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

Two Codex-parity follow-ups from the codex-full-parity spec (§7), both hardening the Codex
safety-hook layer that shipped in the previous release:

1. **Live-config drift detection for the Codex safety guards (C4).** A new check
   (`checkInstalledCodexHookTrust`) reads what's ACTUALLY installed on a Codex agent — its
   `.codex/hooks.json` plus the trust state in `~/.codex/config.toml` — and reports `ok` / `drift`
   / `skip`. It confirms the end-of-turn review trio (response-review + claim-intercept-response +
   scope-coherence) is present AND trusted (not disabled), and that the anti-deferral hook hasn't
   drifted back onto the Stop event. The existing canary asserts the *blueprint* (what instar would
   install); this catches *reality* drifting from it — a hand-edited or clobbered config, a
   never-trusted ("dark") agent, or a guard a user turned off — which the blueprint check can't see.

2. **Stop-payload runtime-verified (B1).** The two Codex Stop review-checkers read a
   `last_assistant_message` field. We had confirmed Codex's binary *declares* that field; this
   release confirms it at RUNTIME — a live Codex 0.133 turn was captured and the field held the
   exact agent reply. So those checkers genuinely receive the response on Codex. No code change;
   this closes the schema-vs-runtime gap the convergence review flagged.

## What to Tell Your User

- **Your Codex agent's safety guards now have a reality check**: "There's a new check that looks at
  what's actually wired and switched on for a Codex agent — not just what should be — so a guard
  can't quietly end up uninstalled, untrusted, or turned off without it being noticeable."
- Nothing for you to do — it ships automatically on update.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Codex installed-config drift check (`checkInstalledCodexHookTrust`) | Programmatic — read-only health check of a Codex agent's hooks + trust state |
| Codex Stop review-checkers runtime-verified | Automatic — no action needed |

## Evidence

- **C4**: `checkInstalledCodexHookTrust` reads the on-disk `.codex/hooks.json` + `config.toml`
  `[hooks.state]` (reusing `codexHookTrust`) and returns `ok`/`drift`/`skip`. 5 new unit tests cover
  skip (no hooks.json), drift (untrusted/dark agent), ok (trio present + trusted), drift (a slot
  explicitly disabled), and a clobbered config where `deferral-detector` wrongly sits on Stop. 28
  codex-area tests green; `tsc` clean. Side-effects review: `upgrades/side-effects/codex-parity-c4-canary-drift.md`.
- **B1**: captured a real Codex 0.133 Stop payload from a live `codex exec` turn; payload keys
  include `last_assistant_message`, which held the exact reply ("The quick brown fox jumps over the
  lazy dog."). Confirms `response-review.js` + `claim-intercept-response.js` are fed at runtime on Codex.
