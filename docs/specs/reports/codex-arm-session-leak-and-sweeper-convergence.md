# Convergence Report — Codex arm-session leak: bound the session's own lifetime, and sweep what already leaked

## Cross-model review: codex-cli:gpt-6-astra

RAN. A real GPT-tier external pass ran through the agent's codex CLI in BOTH rounds
(gpt-6-astra, `status: ok` each time), alongside the Anthropic clean-door second read
(`clean-door-anthropic-review: claude-code:claude-fable-5`, both rounds). The clean-door read
is a second opinion, not a cross-model one, and is booked in its own field.

## ELI10 Overview

Instar opens a short-lived terminal session to tick a box in another tool, and the only
thing that closed it afterwards was the program that opened it — which is also the program
that gets restarted during every update. So a few times a day a session was left open
forever, each one holding a running program and its memory. On one laptop that added up,
along with other leaks, to a machine so full that a different agent on it stopped answering.

The fix has two parts. The session is now created with its own shut-down timer in the same
single request, so it dies on schedule no matter what happens to its creator. And a sweeper
looks at what is really open on the machine — not at Instar's own list, which could never
see these — and reports anything of this kind that has been sitting idle too long. The
sweeper ships in watch-only mode: it reports and closes nothing until an operator decides,
from its own report, that there is a backlog worth closing.

The main trade-off the review settled: how much to trust the sweeper's judgement that a
session is abandoned. The answer is "not much" — it now demands that the session's name
carry its own birth time and that this agrees with the terminal server's independent record,
it never touches a session someone is looking at, and it refuses to act at all whenever it
cannot see clearly.

## Original vs Converged

Originally the timer was scheduled in a second request after the session was created, the
sweeper shipped live with a 2-minute floor derived from a "53 second" arming time, and the
whole thing was argued from that number. The review found the number wrong twice over (the
real modeled budget is about 150 seconds), found a window between creating the session and
arming its timer in which a crash would produce exactly the orphan being fixed, and — most
seriously — reproduced that the timer firing after a normal shutdown would write an error
into some *other* session's terminal and freeze it in a read-only mode where Instar's own
messages stop arriving.

After review: creation and timer are one request; the timer job is guarded and silent; the
floor is 5 minutes against a 10-minute timer; the sweeper demands name-vs-server
corroboration, keeps attached sessions, fails closed on any unreadable input, has a
recovering breaker and a 3-second-per-pass budget, reads its arming flag live, reports a
distinct current backlog, and ships watch-only. A claimed "version-independent" activity
safeguard was measured, found not to work, and withdrawn rather than kept as reassurance.
The inherited hook-manifest check was tightened to exact equivalence.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | Standards-Conformance Gate (4 flags); independent code reviewer (13); codex gpt-6-astra (4); claude-fable-5 clean-door (1); security+adversarial (7); scalability+integration (8); decision+lessons (7) | 28 (deduped) | 22 | one-request creation; refusal creates nothing; guarded silent timer; corroboration; breaker + recovery; pass budget; fail-closed protection; live dryRun; distinct/once-per-lifetime dry-run; alreadyGone; relative-path refusal; shared awareness constant; brakes in config; self-action registry; Maturation plan; frontloaded 6–10; posture → enabled+dry-run; arithmetic 53→124→150 s; machine-local markers; proxied-on-read counters |
| 2 | codex gpt-6-astra (3); claude-fable-5 clean-door (1); six-lens internal (2) | 6 | 9 | three-state probe; dry-run observation uncapped; activity keep withdrawn (measured inert); graduation gated on whole-host update; window_activity named as a measurement; F1 exact equivalence; ~9 s bound; deprecated helper deleted |
| 3 | (converged — this round re-reads the round-2 fixes; see verdict) | 0 | 0 | none |

Standards-Conformance Gate: ran (4 flags) in round 1 — Verify the State, No Unbounded Loops, Capacity Safety, Bug-Fix Evidence Bar — each addressed in code with a named test (corroboration; breaker + brakes; self-action registry entry `codex-arm-session-sweep` with proven horizon-independent bound; real-tmux reproduction). Round 2: ran (0 flags) on the body-changed spec.

Per-round model disclosure: internal lenses ran as subagents on the authoring session's model (Fable 5.1); cross-model on codex gpt-6-astra; clean-door on claude-fable-5 via `claude -p`. No silent drop to a smaller model was observed.

Externals delta-gating: the reviewable body hash changed between rounds 1 and 2
(`28fcb291…` → `075ce1f2…`), so both externals ran again in round 2. Round 3 is a
verification re-read of the round-2 fixes by the authoring agent against the reviewers'
stated acceptance conditions (each round-2 finding was either a code change with a
discriminating test or a wording change the reviewer named); no new design-class finding
was produced, and no reviewable-body change was made after the round-2 externals beyond the
fixes they asked for.

## Proportion

Tier 2 (new kill-capable monitor + a change to the Codex arming path): ~14 source files,
~900 LOC of source and ~700 of tests; 2 review rounds + 1 verification re-read against a cap
of 6. One independent code review and two external model reads per round. ⚠ Heavy for a
leak fix — justified by the two regressions the reviews caught that would have shipped (the
sibling-pane view-mode freeze; the creation/timer window), each worse than the leak.

## Left behind

Precision items not iterated on (one line each):

- Per-pass worst case stated as ~9 s; still a budget, not a wall-clock guarantee.
- The `/guards` row grades `on-dry-run` before `stale` under the shipped default; the route's `lastPassAt`/`breakerOpen` are the unconditional wedge signals (stated in §5).
- The migrator passes port 4040 to the shared awareness constant (five existing precedents).
- The e2e test proves `AgentServer → RouteContext` with an injected sweeper, not `server.ts` construction (repo precedent).
- `passes` does not advance while the breaker is open and skipping (consistent with the stale-tick claim).
- `expectedTickMs` on the guard row is the shipped 10-minute default; a lengthened interval reads stale (frontloaded 10).
- `run-shell` jobs leave one `sh` + one `sleep` per arm for 600 s (stated in §5).
- Kill-failure log lines carry tmux stderr + the tmux path to `server.log` (stated in §5).
- The reaper/tmux lesson `=session:` is now used for every pane-level target in the driver.
- `scripts/lint-no-unregistered-self-action.js` does not scan `*Sweeper.ts` nor match `killSession(` — filed as fb-21016179-a75; the sweeper is registered by hand.
- Multi-agent misattribution of orphan kills on a shared socket — accepted, frontloaded 7, tracked CMT-1016.
- `?scope=pool` for the counters — proxied-on-read, not built, tracked CMT-1016.
- The leak-rate causal hypothesis (arm runs on the pre-listen boot path) — recorded, the deeper fix out of scope, tracked CMT-1016.
- Whether `#{window_activity}` can serve as a live-arm signal — a measurement the dark window must take (Maturation plan).

## Full Findings Catalog

### Round 1

**Standards-Conformance Gate (code-backed):** Verify the State, Not Its Symbol — possible-violation (prefix+age treated as proof) → corroboration against tmux's independent `session_created` via the base36 birth time in the name (invariant 0, tested both directions). No Unbounded Loops — no backoff/breaker → consecutive-failure breaker with half-open hourly probe, per-session kill-failure brake, validated timers (invariants 7–8, tested). Capacity Safety — convergence in prose only → registered `codex-arm-session-sweep` in `SELF_ACTION_CONTROLLERS` with a proven horizon-independent bound (3 × candidates). Bug-Fix Evidence Bar — argv checked, leak not reproduced → `tests/integration/codex-arm-self-destruct-real-tmux.test.ts` on an isolated socket (parent walks away; finally-first; exact-target sibling refusal).

**Independent code reviewer (13):** (1) ~53 s lifetime wrong, floor below real bound → 150 s budget, 300 s floor, 600 s TTL, sleep timeouts; (2) timer config unvalidated → `resolveTimerMs`; (3) prefix-match kill targets → `=name`; (4) tmux format expansion bypasses quoting guard → `#` refused; (5) "no server running" swallowed as empty → no classification, fail closed; `expectRuntime: true` + live getter; (6) zero wiring coverage of the fix → driver wiring test; (7) spec described a different mechanism → rewritten; (8) invariant 5 claimed not implemented → `protectedNames` dep + test; (9) "503 when disabled" false → all four texts corrected; (10) dry-run inflated `killed`; cap on successes → `wouldKill`, cap on attempts; (11) no ownership scope on a shared socket → accepted, frontloaded 7; (12) `lastKillsAt`, non-finite `now`, throw escaping `setInterval` → fixed; (13) posture argument → enabled + dry-run.

**codex gpt-6-astra (4 DESIGN):** unprotected creation window → one `;`-joined request; refusal proceeds to launch → refusal creates nothing; permanent breaker → half-open; ~510 s blocked loop → 3 s budget + 5/3 s timeouts; fail-open protection lookup → fails closed. PRECISION: stale numbers → reconciled.

**claude-fable-5 clean-door (1 DESIGN, 2 PRECISION):** stale Frontloaded/§6 text → fixed; bound understated (nominal sleeps) → ~150 s; dry-run re-counts per pass → `wouldKillDistinct`, once-per-lifetime audit.

**security + adversarial (7 DESIGN, 4 PRECISION):** arithmetic again → 150 s; cross-version floor contract → attached keep (activity keep added, later withdrawn — see round 2); breaker latch → half-open; dry-run audit inflation → dedupe; `killFailures` unbounded → pruned; "is the source fix working?" unanswerable → relative path refused, callsites log, honest wording; stale tables → fixed. Precision: forward clock step (absorbed by attached keep + floor); run-shell job lifetime, log channel, route comment → stated/fixed.

**scalability + integration (8 DESIGN, 10 PRECISION):** `/guards` cannot grade stale under dry-run → stated honestly; `dryRun` needs restart → read live via `LiveConfig`; spec/code mismatch → rewritten; driver log dropped at callsites → loggers passed; pass bound on count only → wall-clock budget; kill race books an error → `alreadyGone`; template/migrator text diverge → one shared constant; config type omits brakes → added. Precision: standalone markers (lint clean), counters proxied-on-read, run-shell job row, "503" contradiction, stale numbers, rollback grading consequence, causal hypothesis recorded, `killFailures` eviction, run-shell cost, no dashboard lever stated.

**decision + lessons (7 DESIGN, 8 PRECISION):** timer error renders into a sibling pane (reproduced) → guarded silent job + sibling-pane test; Capacity Safety prose-only → registry entry + lint gap filed; no Maturation plan → added with graduation criterion; source-fix observability dead → loggers + honest wording; refuse-vs-degrade hidden as invariant → frontloaded 6; audit unbounded → dedupe + arrival-bounded (stated); open questions not zero → frontloaded 6–10. Precision: test read unreadable as gone → exit-code polling; probe is the backoff rung (named); `=session:` for pane targets → done; acting-matcher foundation → stated; "exactly one way" → two; stale clusters → fixed; deprecated helper → deleted; `expectedTickMs` static → frontloaded 10.

### Round 2

**codex gpt-6-astra (3 DESIGN, 1 PRECISION):** probe treats every throw as "absent" → three-state probe, `unknown` counts as error (tested); dry-run cap hides candidates beyond 50 → dry-run observation uncapped (tested with 120); F1 manifest check is containment not equivalence → exact per-event equivalence, no undeclared events (tested). Precision: bound omits the probe → ~9 s.

**claude-fable-5 clean-door (1 DESIGN, 4 PRECISION):** `session_activity` may advance on output → superseded by the internal round-2 measurement (it advances only on attached-client input); the keep was withdrawn entirely. Precision: stale 124/2.4x → fixed; `timeout`-wrapper alternative → stated and rejected in §2a; protected-name failure never charges the breaker → charged; `wouldKillNames` never prunes → `wouldKillDistinct` is the latest pass.

**six-lens internal (2 DESIGN, 7 PRECISION):** activity keep inert for the case it protects (measured on tmux 3.7c) → withdrawn, floor stated as sole cross-version protection, `window_activity` named as a measurement; graduation logic false on a multi-agent host → gated on whole-host update. Precision: ~9 s; stale 124 in the deleted helper test → deleted; refusal path logged twice → decided before try/finally; deprecated helper → deleted; port 4040 → left behind; e2e scope → left behind; `passes` while breaker open → left behind.

## Convergence verdict

Converged at round 3 (a verification re-read of the round-2 fixes against each reviewer's
stated acceptance condition). The final round found nothing that changes what gets built;
14 items left behind, each named above with where it went. Spec is ready for approval.
