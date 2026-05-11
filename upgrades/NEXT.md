# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### Project-scope Phase 1a PR 3 — `/project` skill + session-start digest

Final of three PRs scaffolding the project-scope feature. PR 1 added
the type-level fields; PR 2 added the stage-transition validator and
HTTP surface; PR 3 ships the user-invocable surface and the
session-start orientation block so active projects stay visible across
new sessions.

Spec source: `docs/specs/PROJECT-SCOPE-SPEC.md` §§ Phase 1.7 (skill),
Phase 1.9 (session-start + compaction-recovery hooks).

**New files:**
- `src/core/ProjectDigestCache.ts` — synchronous writer that
  snapshots active projects to `.instar/projects-digest.cache`. Top 5
  by `lastTouchedAt`, sanitized strings (control-char strip + 80-char
  per-field cap), atomic write.
- `.claude/skills/instar-project/SKILL.md` — slash-command skill. Phase
  1a ships `/project create`, `/project status`, and `/project next`
  (read-only + create). The mutating commands ship in Phase 1b along
  with the round-runner.

**Wired-in behavior:**
- Server boot now constructs a `ProjectDigestCache` and registers it
  as the digest invalidator on `InitiativeTracker`. Every successful
  project mutation (create / update / status change) re-renders the
  cache file atomically. First boot writes the cache unconditionally
  so the hook scripts always have a well-formed file to read.
- `.instar/hooks/instar/session-start.sh` and
  `.instar/hooks/instar/compaction-recovery.sh` append an
  `--- ACTIVE PROJECTS ---` block at the end of their orientation
  output. They read the cache file (no HTTP, ≤50ms budget), re-sanitize
  each line on read (defense in depth), and fall back to
  `Active projects: state unavailable — run /project status when ready`
  on miss / parse error.

**Cache file shape (`.instar/projects-digest.cache`):**
```json
{
  "generatedAt": "2026-05-11T...",
  "digestLines": [
    "Project [my-project]: 2 of 5 done. Next round: Round 3."
  ],
  "totalActiveProjects": 1,
  "truncated": false
}
```

## What to Tell Your User

PR 3 closes the Phase 1a slice. Your agent now has a built-in
`/project` slash command for inspecting and registering projects, and
a session-start orientation line that keeps active projects visible at
the top of every new conversation.

What you'll see at session start: a short `--- ACTIVE PROJECTS ---`
block with up to five projects, one line each (`Project [id]: X of Y
rounds done. Next round: <name>.`). If you have more than five active
projects, the block ends with `+N more on dashboard.` — open the
dashboard to see the rest. If your agent has no projects registered
yet, the block is empty.

What this changes day-to-day: your agent won't lose track of multi-spec
projects after a session restart or a context compaction. Before this,
the first few features in a project would get attention and the rest
would drift off the radar. Now the project roster is structurally
visible at every new conversation. The same digest re-injects after
context compression, so a long session that hits the compaction window
still keeps the active-project orientation in context.

The `/project` skill itself is Phase 1a's read-only slice: you can
register a project from a markdown plan doc, list all projects, fetch
one with its children, or ask "what's next?" (which currently returns
a placeholder — Phase 1b will wire the real answer). The mutating
commands (`advance`, `halt`, `ack`, `resume`, `abandon`,
`run-round`, `drift`, `accept-partial`, `claim-ownership`) ship in
Phase 1b once the round-runner lands.

Nothing existing changes shape. The `/initiatives/*` routes still
return what they always did. The new session-start block appears at
the end of the orientation output and is plain text. If your agent
doesn't register projects, you won't see any difference.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `/project create <plan-doc>` | Register a project from a markdown plan via `POST /projects` |
| `/project status [id]` | List all projects, or fetch one with its children, via `GET /projects[/:id]` |
| `/project next [id]` | Phase 1a placeholder; returns the spec's 501 response |
| Session-start project digest | Top 5 active projects rendered at every new session start (no extra config) |
| Compaction-recovery digest | Same digest re-injects after context compression |
| Cache file (read-only consumer) | `.instar/projects-digest.cache` — JSON snapshot, atomic writes, sanitized |

## Evidence

Spec: `docs/specs/PROJECT-SCOPE-SPEC.md` §§ 1.7, 1.9.

- `tests/unit/ProjectDigestCache.test.ts` — 19 new tests covering
  empty case, 3-project + 7-project cases, sanitization (control char
  strip + 80-char cap), atomic write, invalidator wiring.
- `tests/unit/project-digest-hooks.test.ts` — 7 new tests exercising
  the bash hook scripts against present / missing / malformed /
  poisoned cache files.
- Side-effects review: `upgrades/side-effects/project-scope-phase1a-pr3.md`.
