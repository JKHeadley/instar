# Side effects — codex-arm session leak: self-destruct + sweeper

Spec: `docs/specs/codex-arm-session-leak-and-sweeper.md`
ELI16: `docs/specs/codex-arm-session-leak-and-sweeper.eli16.md`

This artifact was rewritten after the independent second-pass review (below). The first
draft's safety argument rested on a wrong number — "~53 s legitimate arm lifetime" — and
several of its claims described a design the code did not implement. Everything here is
re-derived from the code as it now stands.

## The change

1. `src/core/codexHookArm.ts` — `ARM_SESSION_TTL_MS` (600 s) and `armSessionCreateArgv()`,
   which builds the arm session's creation as ONE tmux request:
   `new-session … ';' run-shell -b "sleep 600; '<tmux>' kill-session -t '=<session>'"`. The
   timer is a detached job of the **tmux server**, so it survives the node process; and
   because it is in the same request as the creation, there is no window in which the session
   exists without it (the cross-model review found the first draft issuing them as two calls).
   If the argv cannot be built safely (`#`/`'`/a relative tmux path), NO session is created and
   codex is NOT launched — arming without a net is the leak. The `finally` teardown is kept and
   uses the exact `=session` target. The driver's blocking `sleep` calls gained a 15 s timeout
   and are funnelled through `withSyncOp`. Both production callsites now pass a logger, so the
   "created with self-destruct / refused" line reaches the update log. The trust state
   machine, prompt regexes and readback are untouched.
2. `src/monitoring/CodexArmSessionSweeper.ts` (new) — lists tmux sessions with
   `#{session_created} #{session_activity} #{session_attached}`, keeps only names that
   **corroborate** (base36 suffix decodes to a time within 5 min of tmux's own creation
   record), keeps anything attached, and kills the rest older than a clamped threshold. Dry-run by
   default (observation uncapped; live kills capped), read live each pass.
3. Wiring: config type, construction + `start()` + a live guard-registry getter in
   `src/commands/server.ts`, an `AgentServer` option, a `RouteContext` field,
   `GET /codex-arm-sweeper`, a `guardManifest` row with `expectRuntime: true` and
   `dryRunConfigPath`, a `CapabilityIndex` prefix note, ONE shared CLAUDE.md section constant
   (`CODEX_ARM_SWEEPER_CLAUDEMD_SECTION`) used by both `templates.ts` and
   `PostUpdateMigrator.ts` so fresh and updated agents read the same text, and the
   parity-tracker entry in `tests/unit/feature-delivery-completeness.test.ts`.

## 1. Over-block — what legitimate thing does this kill that it shouldn't?

**A live arm in progress.** The modeled worst-case legitimate lifetime is ~150 s (every
`tmux` call has a 10 s timeout, every `sleep` a 15 s timeout; the 50 s deadline is set after
creation and launch; a final iteration can enter at deadline−ε). The sweeper floor is 300 s
(~2x) and the self-destruct TTL 600 s (~4x). An earlier draft put the floor at 120 s — *below*
the real bound — on the strength of a "53 s" figure, and a second draft said 124 s by counting
nominal sleeps. The budget is not a wall-clock guarantee (parent scheduling gaps under memory
pressure are unbounded), which is why the sweeper ALSO keeps any ATTACHED session whatever its age. A
"recent-activity" keep was tried and withdrawn: tmux's `session_activity` moves only on an
attached client's input, never for the detached send-keys-driven arm it was meant to protect
(measured, tmux 3.7c). The 300 s floor is therefore the sole protection for a sibling agent's
live arm on another instar version — a cross-version contract, stated as such in the spec.

**A session that merely wears the prefix.** The prefix is a symbol anyone can type. The
sweeper requires the name to corroborate itself against tmux's independent creation record
(invariant 0); `instar-codex-arm-SCRATCH` fails the shape check, `instar-codex-arm-zzzzzzz`
fails the time check. Both are kept and counted under `keptReasons`.

**A longer-named sibling.** tmux resolves `-t name` by prefix/fnmatch; a kill for `…-aaa`
with no exact match killed `…-aaabbb` on tmux 3.7c. Both kill paths now use `=name`, which
refuses without an exact match. Proven on a real tmux in the integration test.

**A protected or standing session.** Read live from `sessions.protectedSessions` +
`sessions.standingSessions` every pass and kept (invariant 5). Unreachable through
invariants 0+1 today; asserted as code.

## 2. Under-block — what does this still miss?

- **Other leaked session families.** The same census found 33 finished `dawn-evolve-*`
  sessions holding 20 GB. Another system's; its agent diagnosed and fixed its own reaper
  (an MCP-server allowlist enumerated by name that missed `npm exec @…/mcp@latest`). No
  generic "kill anything old" behaviour is introduced.
- **A renamed arm session.** `tmux rename-session` would defeat the corroboration; nothing
  in instar renames one. Under-reaping is the safe direction.
- **An undateable row** (`session_created` unparseable) is dropped by the parser and so is
  invisible to the sweep forever. Same direction.
- **The machine-wide view**, and `?scope=pool`. Tracked <!-- tracked: CMT-1016 -->.
- **A tmux server started under a different socket** than the node process uses: the
  `run-shell` job inherits the *server's* environment, so the inner `tmux` would miss
  silently. The driver's log line records that a schedule was *issued*, not that it fired;
  the sweeper is the backstop for exactly this.

## 3. Level-of-abstraction fit

The self-destruct belongs in `codexHookArm` — the only place that knows the session exists and
how long it may live. The sweeper is deliberately NOT in `SessionReaper`: the reaper's world
is `SessionManager`'s registry and an arm session is never in it; a sweeper built there would
have reaped zero of the 41 measured orphans. It is also not merged into `McpProcessReaper`
(processes by ancestry vs tmux sessions by corroborated name).

## 4. Signal vs authority (`docs/signal-vs-authority.md`)

The sweeper holds kill authority in live mode, so its logic must not be brittle. It is a
string-shape check, a base36 decode compared with an independently recorded timestamp, an
integer age comparison, and a set lookup — no LLM, no TUI scraping, no inference about
whether work is in flight. The target class is provably transient and produces no durable
work (the authoritative arming outcome is the parent's `config.toml` readback). The moment
anyone widens this to a class that might be working, it must become a signal into the
reaper's keep/kill authority instead. It ships dry-run precisely so the first thing it does
on any machine is *report*.

## 5. Interactions

- **SessionReaper / McpProcessReaper**: disjoint object sets; no race for the same target.
- **The driver's own `finally`** runs first in the happy path; the scheduled kill then finds
  no exact match and no-ops inside `run-shell`'s detached shell.
- **Other instar agents on the same host** share the default tmux socket as one uid, so each
  agent's sweeper sees every agent's arm sessions and two sweepers (or a sweeper and the
  self-destruct) can race for one orphan. The loser's exact-target kill fails; a `has-session`
  exit-code probe tells "already gone" from a real failure, so it books `alreadyGone`, not an
  `error`, and the retry brake is not charged. A live arm from a sibling on ANOTHER instar
  version is protected by the 300 s floor (≈2x the modeled budget) and by the attached keep if
  anyone is looking at it — the floor is the contract, and the spec says so. The
  residual is misattribution of an orphan kill to the wrong agent's counters/audit — stated in
  the spec; a pid-ancestry or `CODEX_HOME` scope is the next refinement, noted not built.
- **Guard-Posture Tripwire**: `dryRunConfigPath` is declared, so the shipped dry-run grades
  `on-dry-run`, and an operator who disables it is graded against `defaultEnabled: true` as
  intended for a default-on guard.
- **Re-entrancy**: `sweep()` is synchronous; the `sweeping` flag is a cheap guard against a
  future async refactor, not a load-bearing property. The interval callback is wrapped so a
  throw cannot escape as an `uncaughtException`.
- **Event-loop cost**: the pass is synchronous and bounded by `maxPassMs` (3 s, which the
  list's time consumes) plus one overrunning kill (3 s timeout) plus its failure probe (3 s)
  — ~9 s worst case; ~10 ms + ~0 ms
  per kill on a healthy tmux. `withSyncOp` lets the lifeline's supervisor attribute the block
  cross-process; the in-process SleepWakeDetector is protected by the bound, not the marker.

## 6. External surfaces

- `GET /codex-arm-sweeper` (authed). **503 only when not wired**; a disabled sweeper answers
  200 with `enabled: false`. All four awareness texts say so.
- `logs/codex-arm-sweeper.jsonl` — session NAMES (`instar-codex-arm-<base36 ms>`), age,
  dryRun flag. No content, paths or credentials.
- A `/guards` row with a live getter; a wedged sweeper grades stale.
- CLAUDE.md section for new agents (`templates.ts`) and existing ones (`PostUpdateMigrator`,
  content-sniffed on `/codex-arm-sweeper`, idempotent), tracked in the parity test.
- No config migration: defaults live in code, so an absent key yields shipped behaviour.
  `resolveTimerMs` guards the timer periods against `null`/string/NaN from JSON. `dryRun` is
  read live each pass; `enabled` applies at the next start and, being default-on, grades
  `diverged-from-default` when switched off — deliberately visible.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local, `hardware-bound-resource`** for the kill, the tmux-server timer job and
the audit log — process-table entities on one host. The route's COUNTERS are operational
state whose correct posture is proxied-on-read (`?scope=pool`), not yet built; the row's
`enabled`/`dryRun`/`lastTickAt`/`stale` are already pool-visible via `GET /guards?scope=pool`.
No durable state crosses a topic transfer; no notice is emitted; no URL is generated.
<!-- tracked: CMT-1016 -->

## 8. Rollback cost

`monitoring.codexArmSessionSweeper.enabled: false` (next server start) or leave `dryRun`
at its default. The source fix is one extra `tmux run-shell` call; reverting the commit
removes it for every arm that starts afterwards. **Caveat:** a revert does not cancel
`run-shell` jobs already scheduled in a running tmux server — those fire once, up to 600 s
later, against sessions the old code would have left leaking. No durable state beyond the
append-only audit.

## Second-pass review

Required: kill authority; "sweeper" is in the guard/sentinel family.

**Round 1 — independent code reviewer (2026-10-25 20:42 PDT; given the code, not the
conclusions): "Concern raised: the safety floor is built on an arithmetic error…"** plus
twelve further findings. **Round 1 — spec convergence**: the constitutional gate (4 flags),
Codex gpt-6-astra (4 DESIGN: unprotected creation window, permanent breaker, ~510 s blocked
event loop, fail-open protection lookup), Claude Fable clean-door (1 DESIGN, 2 PRECISION),
and the security/adversarial, scalability/integration and decision/lessons lenses.

**Resolution:** every DESIGN finding was fixed in code with a named test — creation and timer
in one request; refusal creates nothing; breaker half-open with hourly probes; 3 s pass
budget + 5 s/3 s timeouts; protected-name lookup fails closed; attached/recent-activity keep;
`alreadyGone` via `has-session`; `dryRun` read live; dry-run counts distinct names and audits
once; `killFailures` pruned; relative `tmuxPath` refused; callsites log; one shared awareness
constant; brakes in the config type — or stated honestly in the spec where it is an accepted
limit (multi-agent misattribution; the `on-dry-run`-before-`stale` grading order; the causal
hypothesis for the leak rate). The arithmetic was corrected twice (53 → 124 → ~150 s) and is
now stated as a modeled budget, not a guarantee. Concurrence on the revised artifact is
recorded in the convergence report.

_Re-read 2026-10-25 22:38 PDT after the release-note "What to Tell Your User" wording was made plain-language; nothing in the review changes._
