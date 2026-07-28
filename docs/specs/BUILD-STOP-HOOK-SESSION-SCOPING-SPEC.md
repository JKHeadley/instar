---
title: "Build Stop-Hook Session-Scoping"
slug: "build-stop-hook-session-scoping"
author: "echo"
review-iterations: 1
review-convergence: "2026-05-26T16:20:00Z (independent code-grounded review; 3 findings incorporated)"
review-completed-at: null
approved: true
approved-by: "justin"
approved-at: "2026-05-26T16:33:59Z"
approval-channel: "telegram topic 13352 (build stop-hook session-scoping) — Justin replied 'go' to the ELI16 + spec handoff, approving both defaults (minimal restart handling; hook + build-state.py owner-stamp in one PR, SKILL --owner-session flag as fast-follow)"
---

# Build Stop-Hook Session-Scoping

**Status:** spec — draft, awaiting convergence + approval
**Owner:** Echo
**Date:** 2026-05-26
**Spec topic:** Telegram 13352 ("build stop-hook session-scoping")

## Problem

The `/build` skill installs a **Stop hook** (`.instar/hooks/instar/build-stop-hook.sh`)
whose job is to keep a session from quitting mid-build. It reads
`.instar/state/build/build-state.json`; if a build is active and not in a
terminal phase, it returns `{"decision":"block"}` and feeds the session a
"continue working" prompt.

**The bug: the hook has no notion of *which* session owns the build.**
`build-state.json` carries **no ownership field** — no `sessionId`, no `owner`,
no `tmux`, no `pid`, no `heartbeat`. There is exactly **one** build-state file,
in the main checkout. So when Echo runs several Claude Code sessions at once
(its normal mode), a build started by session A fires its "keep working"
stop-hook into **every** session's Stop event, including unrelated session B —
trapping B and pressuring it to drive a build it has no part in.

**Why it keeps biting:** this is the same defect class as the (already-fixed)
autonomous stop-hook leak — a *session-continuity guard that is not actually
scoped to a session*, so it leaks across the concurrent sessions Echo runs.

**The sharper harm — budget drain (read `build-stop-hook.sh`):** the hook
*mutates the shared state file on every fire* — it increments
`reinforcementsUsed`. A misfiring non-owner session therefore doesn't just emit
noise; it **spends the owning build's reinforcement budget**. When the shared
counter hits its max (3 SMALL / 5 STANDARD / 10 LARGE), the hook stops
protecting the **owner** too. The only clean exits the current hook honors —
no state file, terminal phase, or counter-exhausted — all either ignore
ownership or, if forced, clobber the live owner. There is no safe per-session
bail today.

**Confirmed incidents (from project memory `bug_build_state_not_session_scoped`):**
- 2026-05-23, 2026-05-24: a long-running build leaked its stop-hook into two
  unrelated session types (a Codex-enforcement session, then an inter-agent
  msg-spawn session), each time pushing the wrong session to drive the build.
- 2026-05-26: a SessionReaper `/build` running in tmux `echo-sessionreaper`
  (worktree `.instar/worktrees/build-session-reaper`) fired its stop-hook 4+
  times into a separate MoltBridge-restoration session of mine.

**Current stopgap (NOT the fix):** a local edit to
`.instar/hooks/instar/build-stop-hook.sh` adds a worktree-path guard — if
`build-state.worktree.path` is set and `$PWD` is not inside that worktree,
approve exit without incrementing. This is a **local, gitignored, deploy-only**
patch that any instar update overwrites, and it only covers *worktree* builds
(it does nothing for a non-worktree build leaking across two main-checkout
sessions). It bought time; it is not durable and not shipped.

## Goals

1. A non-owner session's Stop must **approve exit WITHOUT incrementing**
   `reinforcementsUsed` — zero budget drain on the owner.
2. The **owner** session keeps full stop-hook protection, unchanged.
3. The fix is **shipped** (in the source-of-truth template that deployed agents
   receive on update), not a local hook edit.
4. Graceful degradation: builds with no owner stamp (legacy / un-stamped) must
   not regress — the hook goes quiet (approve, no increment, no adopt). It must
   never trap a session and never invert ownership; forfeiting protection for an
   un-stamped build is acceptable, trapping the wrong session is not.
5. **No new manual step** for the agent running `/build` (per the
   no-manual-work standard). Owner identity is captured structurally at build
   start, not by asking the agent to remember to stamp it.

## Non-Goals

- Unifying the build hook and autonomous hook into one shared ownership library.
  The autonomous hook already has a mature, separately-tested ladder; bash hooks
  don't share code cleanly, and a premature abstraction is discouraged. This
  spec makes the build hook *consistent with* the autonomous design without
  merging them. (Tracked as a future consideration, not this work.)
- Changing the build pipeline's phases, protection levels, or worktree workflow.
- Restart-resume adoption semantics as elaborate as the autonomous hook's
  liveness-gated `adopt-dead` path. A `/build` is normally one continuous
  session; we add a minimal restart tolerance (see §Design) but not the full
  transcript-mtime liveness machinery.

## Design

The autonomous stop-hook
(`.claude/skills/autonomous/hooks/autonomous-stop-hook.sh`) already solved this
exact class. Its proven primitives, which this design mirrors:

- **tmux session name is the stable address.** `tmux display-message -p '#S'`
  resolves "my" tmux session both at build-start and inside the hook. It
  survives a memory-limit restart (instar respawns into the *same* tmux name),
  which the Claude session UUID does not.
- **Claude session UUID is the precise backstop.** The hook receives
  `.session_id` on stdin; the owner's `$CLAUDE_CODE_SESSION_ID` is the same
  namespace. UUID disambiguates two builds sharing a tmux name across a restart.
- **Fail-open on unknown identity.** If the hook cannot resolve its own
  identity at all, it approves exit — never trap an unknown session.
- **Test seams.** `INSTAR_HOOK_TMUX_SESSION` / `INSTAR_HOOK_NO_TMUX` override
  tmux resolution; stdin `session_id` is injectable. We reuse the same seams so
  the build hook is unit-testable without a live tmux.

### 1. Stamp the owner at build start (`playbook-scripts/build-state.py`)

In `cmd_init`, add an `owner` block to the initial state:

```json
"owner": {
  "tmux": "<tmux display-message -p '#S', resolved by build-state.py itself>",
  "session": "<CLAUDE_CODE_SESSION_ID, passed by the SKILL; may be empty>",
  "stampedAt": "<iso8601>"
}
```

- `owner.tmux` is resolved by `build-state.py` **itself** at init time (it runs
  in the owner's tmux pane as a Bash tool call), so **no SKILL change is
  required** for tmux-scoping to work. This is the load-bearing identifier.
- `owner.session` is a precision add-on. `$CLAUDE_CODE_SESSION_ID` is set in the
  Bash tool's top-level shell but is **not exported to child processes** — this
  is documented in `.claude/skills/autonomous/SKILL.md:107` ("Running `bash
  setup-autonomous.sh` creates a subprocess that does NOT inherit
  `CLAUDE_CODE_SESSION_ID`"). So `build-state.py` (a python subprocess) cannot
  read it from the environment; the SKILL passes it explicitly via a new optional
  flag `--owner-session "$CLAUDE_CODE_SESSION_ID"`. If absent, `owner.session` is
  left empty and tmux-scoping still fully works.
- Add an optional CLI flag pair to `init`: `--owner-session` (and accept the
  resolved tmux as self-discovered, with `--owner-tmux` as an override seam for
  tests). Resolution is best-effort and must never fail `init`.

### 2. Owner-comparison in the hook (`build-stop-hook.sh` + inline twin)

Insert ownership resolution **after** the no-state-file and terminal-phase
early-exits, **before** the reinforcement-counter mutation:

```
HOOK_INPUT=$(cat)                       # hook now reads stdin (it currently does not)
HOOK_SESSION = .session_id from stdin
MY_TMUX      = resolve_my_tmux()        # tmux #S, with INSTAR_HOOK_* seams

OWNER_TMUX    = state.owner.tmux        # "" if absent
OWNER_SESSION = state.owner.session     # "" if absent

# (a) Owner fields present → scoped decision:
#       IS_OWNER = (OWNER_TMUX    != "" AND OWNER_TMUX    == MY_TMUX)
#               OR (OWNER_SESSION != "" AND OWNER_SESSION == HOOK_SESSION)
#       if NOT IS_OWNER:
#           echo '{"decision":"approve"}'; exit 0     # <-- THE FIX: no increment
#       # else fall through to existing block/increment logic (owner protected)

# (b) Both owner fields empty → legacy / un-stamped build.
#     CONSERVATIVE NO-ADOPT: approve exit WITHOUT incrementing. Do NOT bootstrap-
#     claim ownership. (See "Why conservative-no-adopt over bootstrap" below.)
#     Net effect for un-stamped builds: the hook stops draining budget and stops
#     trapping any session — it simply goes quiet. Protection for un-stamped builds
#     is forfeited; correctness (never trap/invert) is preserved. New builds in a
#     stamping-capable environment never hit this path.

# (c) Identity-unknown fail-open: if MY_TMUX == "" AND HOOK_SESSION == "",
#     approve exit (cannot prove ownership either way; never trap an unknown session).

# Minimal restart tolerance: ONLY on a CONFIRMED tmux-owner match where
# OWNER_SESSION != HOOK_SESSION (UUID rotated by a restart): reconcile
# owner.session = HOOK_SESSION, then continue protecting. The reconciling WRITE
# is gated strictly behind the tmux-owner match so a non-owner can never clobber
# owner.session. No user-facing note (a /build resume is not a user-visible event;
# the build prompt re-drives on resume). No liveness probe.
```

The existing counter logic (lines 28–79 of the current hook) is unchanged for
the owner path. **The hook must read stdin** (it currently does not) to obtain
`.session_id`; verify during implementation that the Stop event delivers
`session_id` on stdin to this hook (the autonomous hook proves Stop-hook stdin
delivery works — `autonomous-stop-hook.sh:31,40`).

### 3. Retire the worktree-path stopgap (it is topology-fragile)

The shipped hook supersedes the local worktree-vs-`$PWD` guard, and the `$PWD`
heuristic is deliberately NOT carried forward. Reason: a Stop hook runs with
cwd = the directory where `claude` was launched, **not** wherever the agent
`cd`'d during the turn. In the common topology — owner launches Claude at the
main checkout root and `cd`s into the worktree via Bash calls — the owner's
`$PWD` at hook-fire time is the main root, so a `$PWD`-based test would
mis-classify the **owner** as non-owner and approve it to exit mid-build. The
2026-05-26 stopgap only appeared to work because that incident's owner happened
to be a *separately-launched* worktree-rooted session. The stamped **tmux
session name is cwd-independent** and is the correct, robust owner key;
`$PWD`-scoping is dropped.

### Why conservative-no-adopt over hook-bootstrap

A hook-only "first Stop adopts ownership" (bootstrap) design is self-contained,
but **in this bug's actual incident pattern it inverts ownership.** The
documented incidents show the real owner busy mid-build (not hitting a Stop for
a long stretch) while *non-owner* sessions Stop repeatedly. Bootstrap would let
a non-owner Stop first → it claims ownership → it gets trapped, AND the real
builder, on its eventual Stop, is then seen as a non-owner and approved to exit
mid-build. That is strictly worse than today. So we **do not bootstrap.** For an
un-stamped build the hook goes quiet (approve, no increment): protection is
forfeited but correctness — never trap, never invert, never drain — is preserved.

**Init-time stamping is therefore the load-bearing mechanism, and it is sound in
the environment where this bug actually bites.** The bug is an *Echo-environment*
problem: it requires (a) many concurrent Claude sessions for one agent and (b)
all of them sharing one `build-state.json` + one hook in the same checkout —
which is precisely the instar **repo checkout** Echo works in, where
`playbook-scripts/build-state.py` is committed and present. There,
`build-state.py` resolves and stamps `owner.tmux` at `init` with zero added
steps, and the hook compares against it. Deployed (npx-installed) agents do not
reproduce the bug: they rarely run concurrent sessions, and the build SKILL's
project-root-relative `python3 playbook-scripts/build-state.py` invocation only
resolves inside a repo checkout anyway (see Migration Parity §2 / Open Question
#1). The conservative no-adopt path guarantees that even where stamping is
absent, the hook never regresses.

**The hook still ships to everyone** (always-overwrite twin), so the leak-and-
drain behavior is removed universally; stamping (build-state.py) rides its own
deploy path and only *adds* owner protection where the bug can occur. An optional
**phased ship** (see Open Question #3): PR-1 = hook (guaranteed deploy; removes
leak+drain everywhere via the conservative path); PR-2 = `build-state.py`
owner-stamp (adds owner protection in the repo-checkout environment); PR-3 =
SKILL `--owner-session` precision flag. Each phase is independently safe; if
phased, follow-ups are same-spec tracked commitments, never orphan notes (per
the no-out-of-scope standard). <!-- tracked: ACT-155 -->

## Migration Parity (NON-NEGOTIABLE — per the Migration Parity Standard)

Three artifacts change; each must reach deployed agents on update:

1. **`src/templates/hooks/build-stop-hook.sh`** — canonical template.
   **AND** the **duplicated inline copy** `getBuildStopHook()` in
   `src/core/PostUpdateMigrator.ts` (~line 6937). These two MUST be kept
   byte-identical. `migrateHooks()` writes the inline copy to
   `.instar/hooks/instar/build-stop-hook.sh` on **every** migration run
   (always-overwrite built-in hook, line ~1605) → all deployed agents receive
   the new hook automatically. **Action:** edit both; add a sync assertion to
   the test suite (a unit test that reads `src/templates/hooks/build-stop-hook.sh`
   and asserts it equals `getBuildStopHook()` output) so they cannot drift.

2. **`playbook-scripts/build-state.py`** — shipped in the npm tarball
   (`package.json` `files` includes `playbook-scripts`) and registered as
   built-in manifest item `playbook-script:build-state.py`. **Finding (resolves
   the prior open question):** there is **no code path that copies
   `playbook-scripts/` to a deployed agent's project root.** `instar playbook`
   runs scripts from the *package* dir (`playbook.ts:208`,
   `getPackageDir()/playbook-scripts/`); `playbook eject` writes to
   `.instar/playbook/scripts/` only on demand (`playbook.ts:1049`). The build
   SKILL, however, invokes `python3 playbook-scripts/build-state.py` via a
   **project-root-relative path** — which only resolves inside an instar **repo
   checkout** (where the file is committed). **Consequence for this spec:** the
   `build-state.py` owner-stamp change updates with the repo checkout itself (the
   only place it's exercised for this bug). No new migration is required for
   deployed agents because they don't run this file from project root. The
   project-root-relative invocation being non-portable to npx-installed agents is
   a **pre-existing, separate issue** — noted here, explicitly out of scope.
   Because the hook degrades conservatively (no-adopt) when `owner` is absent, a
   `build-state.py` that hasn't picked up the stamp never causes a regression.

3. **`.claude/skills/build/SKILL.md`** (built-in skill; canonical content
   currently emitted from `src/commands/init.ts`) — update the
   `build-state.py init` invocation to pass
   `--owner-session "$CLAUDE_CODE_SESSION_ID"`. Per the Migration Parity
   Standard §5, updating existing built-in *skill content* requires a dedicated
   idempotent `PostUpdateMigrator` migration (installBuiltinSkills never
   overwrites). **This change is the precision add-on (session-UUID), not the
   load-bearing fix** — tmux-scoping works without it — so it MAY be deferred to
   a follow-up if convergence prefers a smaller first cut. If deferred, track it
   as a same-PR commitment, not an orphan note (per the no-out-of-scope standard).
   <!-- tracked: ACT-155 --> Per the approved phasing, the SKILL flag is tracked as ACT-155.

4. **Idempotency:** every migration safe to run repeatedly (check before patch).

## Testing (Testing Integrity Standard — all three tiers, NON-NEGOTIABLE)

**Tier 1 — Unit:**
- `build-state.py init` stamps `owner.tmux` (mock tmux via seam) and
  `owner.session` (from `--owner-session`); init still succeeds when tmux/flag
  absent (empty fields, no crash).
- Hook decision matrix (using `INSTAR_HOOK_TMUX_SESSION` + injected stdin
  `session_id`):
  - owner tmux match → `block`, `reinforcementsUsed` incremented.
  - non-owner tmux + non-owner session → `approve`, **`reinforcementsUsed`
    UNCHANGED** (the core regression assertion).
  - owner via session UUID only (tmux empty) → `block`.
  - identity-unknown (no tmux, no session) → `approve` (fail-open).
  - legacy/un-stamped state (no owner block) → `approve`, **counter UNCHANGED,
    owner NOT written** (conservative no-adopt — assert no bootstrap occurs).
  - owner-tmux match but session UUID rotated → `block`, `owner.session`
    reconciled; assert the reconcile WRITE happens ONLY on the tmux-match path
    (a non-owner with a mismatched session never writes `owner.session`).
- Template/inline sync assertion (artifact 1 above).

**Tier 2 — Integration:** drive the hook repeatedly against one real
`build-state.json` from two simulated identities; assert the non-owner identity
never advances the counter and the owner can still reach `max` and then exit.

**Tier 3 — E2E lifecycle:** reproduce the **original failure** (per the bug-fix
evidence bar): an active build owned by tmux A; fire a Stop with tmux B's
identity; assert `approve` + counter unchanged; then fire with tmux A; assert
`block` + counter advances. This is the "feature is alive, scoped, and the leak
is closed" test.

## Test-as-Self Gate (required before merge)

Per the test-as-self standard: build the dist, shadow-install onto a live agent
on this machine, restart, then drive a **real two-session scenario** (start a
`/build` in session A; cause a Stop in unrelated session B; confirm B exits
cleanly with no counter drain and A stays protected). Validate, **restore the
prior dist**, then merge. Green unit tests alone are not sufficient evidence.

## Rollback

The change is contained to the hook + (optionally) build-state.py init + SKILL
line. Rollback = revert the three artifacts; the always-overwrite migration then
restores the prior hook on the next update. No state-schema migration is
destructive: the added `owner` block is additive and ignored by the old hook.

## Standards-Conformance Pass

Explicit check against Instar standards (per the spec-review-against-standards
requirement):

- **Structure > Willpower:** the fix is a code gate in the hook, not a prompt
  instruction asking the agent to "remember whose build this is." ✓
- **No-manual-work:** owner identity is captured structurally (`build-state.py`
  self-resolves tmux at `init`; SKILL passes the UUID it already has). No new
  step the agent must remember. The fail-open path means a missed capture
  degrades to a no-op, not a trap. ✓
- **Signal vs authority:** the hook is a low-context filter making a *binary
  ownership* decision from stable, locally-verifiable identifiers (tmux/UUID) —
  it is not arrogating higher-level judgment; it only refrains from blocking a
  session it cannot prove it owns. Conservative-by-construction (fail-open). ✓
- **Near-silent notifications:** no new user-facing messages. The restart
  reconciliation is silent (unlike the autonomous hook's restart note, since a
  `/build` resume is not a user-visible event). ✓
- **3-tier testing + wiring integrity:** all three tiers specified, including
  the template/inline sync assertion and the original-failure reproduction. ✓
- **Migration parity:** every changed artifact has a named deploy path; the
  hook (always-overwrite twin) reaches everyone, `build-state.py` rides the repo
  checkout where the bug occurs, and the conservative no-adopt path guarantees no
  regression where stamping is absent. ✓
- **Bug-fix evidence bar:** the E2E test reproduces the original cross-session
  leak and asserts it stops; test-as-self on a live agent is a merge gate. ✓
- **No out-of-scope trap:** phasing is optional and, if chosen, the follow-ups
  are same-spec tracked commitments. ✓ <!-- tracked: ACT-155 -->

## Review Findings Incorporated (independent review round 1)

An independent code-grounded review surfaced three issues, all addressed:
- **(was CRITICAL) Bootstrap inverts ownership in the real incident pattern** —
  the owner is busy mid-build and a non-owner Stops first. **Resolution:**
  dropped bootstrap entirely; un-stamped builds use conservative no-adopt
  (approve, no increment, never claim ownership). See §"Why conservative-no-adopt".
- **(was CRITICAL) `build-state.py` has no copy-to-project-root path for deployed
  agents** — **Resolution:** documented that the bug is an Echo repo-checkout
  problem (where the file is committed); stamping rides the checkout; deployed
  agents don't reproduce the bug; the conservative hook path prevents any
  regression. See Migration Parity §2.
- **(was MAJOR) `$PWD`-based worktree scoping is topology-fragile** (Stop hooks
  run from the launch root, not the cd'd worktree) — **Resolution:** `$PWD`
  scoping dropped in favor of the cwd-independent stamped tmux name. See §3.
- Confirmed-good by review: the `getBuildStopHook()` inline twin exists, is
  byte-identical to the template, and is always-overwritten
  (`PostUpdateMigrator.ts:~1605,~6936`); the `CLAUDE_CODE_SESSION_ID`
  non-export claim is documented (`autonomous/SKILL.md:107`); the early-exit
  ordering matches the autonomous ladder.

## Open Questions (for convergence)

1. Restart tolerance: is the minimal tmux-match + session-reconcile sufficient,
   or do we want the autonomous hook's liveness-gated adoption for parity?
   (Default: minimal — a `/build` is normally one continuous session.)
2. First-cut scope: one PR for hook + `build-state.py` stamp (both land in the
   repo checkout together), with the SKILL `--owner-session` precision flag as a
   tracked follow-up? Or all three at once? (Recommendation: hook +
   `build-state.py` in one PR; the SKILL flag is a small fast-follow.)
   <!-- tracked: ACT-155 --> Resolved: one PR now (hook + build-state.py); SKILL flag tracked as ACT-155.
