# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Ships the shared routine that renders your session clock, and installs it on every agent.

Step 1 added the `/session/clock` endpoint (how long have I been running / how much is left). This adds `emit-session-clock.sh` — the small routine that turns that into a one-line "⏱ SESSION CLOCK: Nh elapsed · Mh remaining (NN%)" string. It has a render mode (format already-computed values) and a query mode (ask the endpoint). The hooks that call it on every turn land next (tracked in issue #682).

## What to Tell Your User

Nothing to do. This is plumbing for the time-awareness feature — a small script that gets installed automatically. You'll see its effect once the per-turn hooks are wired (next step): your agent will quote real elapsed/remaining time instead of guessing.

## Summary of New Capabilities

- New `.instar/scripts/emit-session-clock.sh` — renders the SESSION CLOCK line. `render` mode formats values the caller already computed (no re-resolution); `query` mode curls `GET /session/clock`. Signal-only (pure stdout, never blocks), and only ever echoes the already-sanitized label, never a raw goal.
- Installed on new agents (init) and existing agents (always-overwrite migration), so the whole fleet has the routine ready for the per-turn wiring.

## Evidence

- 7 golden tests (render/percent/clamp/formatting/unbounded/query-unreachable/no-op) + 3 migration tests (installs, always-overwrite, executable) green; secret-drop migration regression (13) green; `tsc --noEmit` clean.
- Spec: `docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md` (Component 2). Side-effects: `upgrades/side-effects/session-clock-step2a.md`. Call-site wiring: #682.
