# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**docs(coverage): second-pass refresh — route + class category bump, sidebar update, floor ratchet.**

Follow-on to the docs-coverage script and per-PR gate (v1.2.21) and the bulk docs refresh (v1.2.22). This release bumps the two categories that were still near the floor: routes (fifteen percent up to fifty-nine) and classes (fifteen percent up to sixty-two).

Five concrete moves:

1. **Route inventory appendix in `reference/api.md`.** Every registered route grouped by prefix, listed by HTTP method and path. The curated sections at the top stay as the front; the inventory is the grep-friendly back.

2. **Class inventory appendix in `architecture/under-the-hood.md`.** Every top-level class shipped under each source subsystem, grouped under subsystem headers. Navigation aid, not a substitute for the per-subsystem feature pages.

3. **Four new feature pages** for the subsystems that previously had zero documentation home: paste handling, privacy routing, the Self-Healing Remediator, and task flows.

4. **Sidebar update** in `site/astro.config.mjs` so the new pages plus the ones from round one (Slack, observability, cross-framework portability, coherence gate, the living system, threadline protocol wire format) actually appear in site navigation when the deploy works.

5. **Floor ratchet** in the docs-coverage script. New floors: overall 55, route 55, command 60, job 85, hook 70, skill 90, class 55.

Spec: `docs/specs/docs-coverage-bump.md`. ELI16: `docs/specs/docs-coverage-bump.eli16.md`. Side-effects review: `upgrades/side-effects/docs-coverage-bump.md`.

## What to Tell Your User

Nothing user-visible. This release further hardens instar's own documentation pipeline. Agents continue to behave identically.

Contributors will notice the docs-coverage CI check has a tighter bar — pull requests now need to keep coverage above the fifty-five percent overall floor and similar per-category floors. Most pull requests pass naturally; a pull request that adds many features without doc updates will get flagged with the offending category named.

## Summary of New Capabilities

This release is pure infrastructure plus documentation. No new runtime capabilities for agents. The new feature pages cover already-shipped subsystems that lacked user-facing documentation.

## Evidence

Coverage script run against current main before and after the changes in this release: before, overall twenty percent, route fifteen percent, class fifteen percent. After, overall sixty-two percent, route fifty-nine percent, class sixty-two percent. All seven categories sit comfortably above their new floors. The script passes its --check mode with the ratcheted thresholds. Lint clean. Local Astro build produces forty-six pages including the four new feature pages.
