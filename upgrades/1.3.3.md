# Upgrade Guide — NEXT

<!-- bump: minor -->

## What Changed

**Graduated Feature Rollout — the InitiativeTracker now populates and drives itself.** Features that ship behind a dry-run/off flag are auto-registered as tracker initiatives (from their approved spec + merge — no one has to remember), and a single twice-weekly driver surfaces an evidence-based promotion recommendation (dry-run → live → default-on) until a human advances it. A feature can never silently reach default-on: the stage is derived from observing the config flag, and the driver never flips it. The tracker is also wired into discoverability so "what are we working on?" is answered from the live board, not memory.

## What to Tell Your User

- Ask "what are we working on?" and I'll answer from the live initiative board, not from memory.
- Features that need time to mature won't stall or be forgotten — there's a standing twice-weekly check that nudges each toward fully-on, with you approving each step.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Self-populating initiative tracker | Automatic — approved+merged specs register themselves |
| Twice-weekly rollout driver | Builtin job; recommends promotion, never auto-advances |
| `ships-staged` spec frontmatter | Declares a feature ships dark → gets a rollout track |
| Initiative discoverability | `GET /initiatives` surfaced in /capabilities + Registry-First |
