# Convergence Report — Iris-Audit Session Observability & Config-Application Fixes

**Spec:** `docs/specs/iris-audit-session-observability.md`
**Iterations:** 1 round, 3 independent reviewers (design-correctness, safety/blast-radius, completeness/standards-fit)
**Outcome:** converged — all material findings resolved in-spec; zero remaining material findings.
**Cross-model review:** unavailable (no codex CLI on this host; single-model convergence).

## Method

Three independent subagent reviewers read the spec design (not the implementation
line-by-line) through distinct lenses. Findings were triaged into (a) genuine
spec-design refinements, addressed by editing the spec, and (b) misunderstandings of
the intended phasing, which required no change but are recorded here.

## Findings and resolutions

### Misunderstanding (no change required)

- **"Item 1 token accounting is not implemented" (raised critical by 2 reviewers).**
  By design. The spec covers all four audit items; PR A implements items 2/3/4, PR B
  implements item 1. The spec is intentionally ahead of PR A's code. This is recorded
  in `deferrals-tracked: true` + the HTML deferral marker, and the Phasing section.
  Reviewers conflated "the spec describes item 1" with "PR A's branch must contain
  item 1." No code or design change; phasing prose already explicit.

### Resolved by spec edit

- **[major] restart-all `excludeSession` / snapshot-time ambiguity.** Added explicit
  "snapshot-time set" semantics: targets computed once at request time; a session
  spawned after the snapshot is neither restarted nor excluded; `excludeSession` =
  "the session you're calling from at request time."
- **[major] Thundering-herd bound on large fleets.** Added an explicit fleet-size
  bound: stagger math (N → 500 + (N−1)·750 ms), the realistic instar fleet size, the
  fact that v1 has no fleet-wide concurrency ceiling (per-session rate-guard is the
  only aggregate backstop), and that a max-parallel ceiling is the named tuning knob
  if a deployment ever runs dozens of concurrent sessions. Named as a known bound, not
  silently assumed.
- **[major] Reaper-interaction race.** Clarified that restart-all reuses the exact
  shipped single-`/sessions/refresh` path (kill → `beforeSessionKill` → respawn) and
  introduces NO new reaper coordination surface: a freshly respawned session has
  current activity (not idle-reapable), the old session is marked `killed`. It is N
  staggered single-refreshes — nothing the single path doesn't already do in
  production.
- **[major] Item 2 surprise model switch for agents that set the config.** Added an
  "activation safety" paragraph: the change makes a previously-inert config active;
  effect appears only on a fresh session, only when the field is set, and is auditable
  via `GET /sessions`. Documented as an intended, contract-aligned behavior change —
  not a silent switch.
- **[minor] Invalid model id passes through.** Documented: a typo'd model id surfaces
  as a spawn failure, identical to the existing Codex/Gemini builders (CLI-side
  validation); v1 adds no config-load-time validation.
- **[minor] Migration idempotency pattern undocumented.** Documented the exact
  content-sniff (`!content.includes('Applying config & hook changes to running
  sessions')`) and the revert behavior (already-patched files unchanged).
- **[minor] Missing E2E "feature alive" tier.** Documented that route registration is
  proven by the "503 when not wired" route test (route reached, not 404), matching the
  sibling `/sessions/refresh` test depth; a server-standup E2E adds nothing because
  restart-all introduces no new wiring beyond the already-exercised `SessionRefresh`.
- **[minor] Item 4 awareness content under-specified.** Expanded item 4 design to
  state the three things the CLAUDE.md section teaches.
- **[minor] Deferral-tracking format non-standard.** Added `deferrals-tracked: true`
  to frontmatter alongside the HTML marker.
- **[minor] Async failure visibility / excludeSession auth.** Documented: per-session
  outcomes are logged (matches refresh contract); `/sessions/*` is operator/Bearer-
  gated and `excludeSession` carries no privilege beyond that boundary.

### Parent-principle fit

Reviewer 3 confirmed `parent-principle: "Observability — you can't tune what you can't
see"` resolves to a real `### ` heading in `STANDARDS-REGISTRY.md` (line 214) and is
the strongest single fit; Agent Awareness / Migration Parity / Signal-vs-Authority are
named as supporting articles in the spec's Constitutional Traceability section.
Retained Observability as primary.

## Conclusion

The design was sound on the first pass; the round produced documentation/edge-case
refinements (snapshot semantics, fleet bound, reaper-reuse, activation safety,
idempotency pattern, route-liveness rationale) and one frontmatter standardization.
No structural redesign. Converged.
