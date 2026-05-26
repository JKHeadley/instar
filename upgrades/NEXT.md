# Upgrade Guide — NEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

**The `/build` skill now stamps the exact owning session at init** (fast-follow to the v1.3.0 build stop-hook session-scoping fix). Step 1 of `/build` now passes `--owner-session "$CLAUDE_CODE_SESSION_ID"`, so the stop-hook can scope by the precise Claude session UUID in addition to the tmux session name.

This is a precision add-on: tmux-name scoping (shipped in v1.3.0) already does the load-bearing work of keeping a build's "keep working" nudge from leaking into your other concurrent sessions. The session-UUID just tightens it (e.g. disambiguating two builds that share a tmux name across a restart). If `$CLAUDE_CODE_SESSION_ID` is empty, tmux scoping still works — no regression.

Deployed agents get the change via a surgical, idempotent migration that appends the flag to the installed build skill's init line.

## What to Tell Your User

- **No action needed.** This just tightens the per-session build scoping that already shipped — your concurrent sessions stay out of each other's builds.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `/build` stamps owning session UUID | Automatic — Step 1 init passes `--owner-session "$CLAUDE_CODE_SESSION_ID"`. |
| Deployed-agent migration | `migrateBuildSkillOwnerSession()` — idempotent line-patch appends the flag to the installed build SKILL.md. |

## Evidence

- **End-to-end (real environment):** ran the SKILL's exact init command —
  `python3 playbook-scripts/build-state.py init "…" --size SMALL --owner-session "$CLAUDE_CODE_SESSION_ID"` —
  in a live Bash shell. Observed `build-state.json` `owner.session` stamped with
  the real session UUID (`d07cf1b4-…`), confirming `$CLAUDE_CODE_SESSION_ID` is
  live in the shell and the command captures it. Before this change the init line
  omitted the flag, so `owner.session` was always empty (tmux-only scoping).
- **Migration (deployed agents):** 5 unit tests — appends the flag to the init
  line; idempotent (second run no-ops, single occurrence); no-op when SKILL.md
  absent or has no init line; bundled SKILL.md already carries the flag.
- **No regression:** full CI-mirror suite green (18409 passed, 0 failures on a
  clean re-run). Empty/unset `$CLAUDE_CODE_SESSION_ID` → `--owner-session ""` →
  tmux scoping (the v1.3.0 load-bearing path) still works.
