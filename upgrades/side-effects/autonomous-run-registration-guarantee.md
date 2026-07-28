# Side-Effects Review — Autonomous-Run Registration Guarantee (GAP-B, PR1)

**Spec:** docs/specs/autonomous-run-registration-guarantee.md (converged R1 + approved — operator full pre-approval, Justin 2026-06-15). **Parent:** An Autonomous Run Must Outlive Its Session.
**Scope:** PR1 only — the deterministic read-path correction (D1 precedence chain + D2 server-side topic resolution). Ships LIVE (no flag; a pure accuracy fix to an existing read).
**Files:** src/server/stopGate.ts, src/server/routes.ts, tests/unit/stopGate.test.ts, tests/integration/stop-gate-autonomous-topic-resolution.test.ts

## What changed

1. **stopGate.ts (`readAutonomousActive`):** replaced the single oldest-legacy-path existence check with a fixed precedence chain — (1) the per-topic canonical path .instar/autonomous/TOPIC.local.md, only when a topicId resolves; (2) the .instar legacy single-file; (3) the .claude oldest-legacy single-file. autonomousActive is true if ANY exists. The historical autonomousStateFile override still wins as the sole path read (back-compat). New optional HotPathInputs fields: topicId and stateRoot.
2. **stopGate.ts (`resolveTopicForTmux`, new exported pure fn):** inverts topic-session-registry.json's topicToSession map on a tmux name — the SAME inversion the bash stop hook uses. Pure, injectable reader, fail-open to null on any read/parse error.
3. **routes.ts (`resolveTopicForStopGate` helper + two getHotPathState callsites):** resolves the Claude session UUID to its tmux name via the session manager's claudeSessionId record, then to a topicId via resolveTopicForTmux, and passes topicId + stateRoot into both hot-path reads.

## Blast radius

Server-only. The single behavior touched is the stop-gate's autonomousActive read — which it computes for two consumers: the hot-path stop decision input and the StopNotifier unattended-session gate. No agent-installed file changed; no new HTTP route, no new config key, no new state file, no schema change. A single-machine or non-autonomous agent simply reads the same three paths and gets the same answer it would expect.

## Reversibility

Fully reversible. This is a read-path change with no persisted side effects — nothing is written, migrated, or stamped. Reverting the two source files restores the prior single-path read exactly; there is no on-disk state to unwind.

## Signal vs authority

The stop-gate's autonomousActive is a SIGNAL that informs the stop decision and the unattended-notice gate — it is not itself an authority that blocks or commits anything. This change adds NO new authority: it makes the existing signal MORE accurate by reading the canonical per-topic path a modern autonomous run actually writes. It never blocks a message, never gates a session, never spawns or kills anything. A more-accurate "this is an autonomous run" reading only changes whether the existing revive/notify machinery engages — the machinery's own authorities are unchanged.

## Failure modes

The one boundary that matters is the topic-resolution miss (no session record, corrupt/missing registry, unknown tmux name). It resolves to undefined/null and the read falls back EXPLICITLY to both legacy paths — it can never coerce a miss into a silent autonomousActive:false (the no-silent-fallbacks ratchet). Three @silent-fallback-ok catches are annotated and justified: a session-manager read failure (resolver returns undefined → legacy fallback), a per-path stat error (the chain continues to the next path, never short-circuiting the whole read), and a corrupt/missing registry (resolveTopicForTmux returns null → legacy fallback). All three are test-covered on both sides of the boundary.

## Migration parity

NONE required. No agent-installed file changed — this is server code only (the stop-gate read and the route resolver). Existing agents pick up the corrected read the moment their server runs the new code; there is no .claude/settings.json hook, .instar/config.json default, CLAUDE.md section, hook script, or built-in skill to migrate.

## Tests

- tests/unit/stopGate.test.ts — D1 precedence (per-topic wins; a different topic does not activate; fall-through to each legacy path; none-exist false; topic-less still reads both legacy paths; override-is-sole-path back-compat) and the D2 unresolved-topic boundary both sides (HIT reads per-topic; MISS-with-legacy stays true; MISS-with-nothing is the genuinely-inactive false) plus resolveTopicForTmux inversion (hit, unknown-name miss, null/empty, corrupt-registry fail-open).
- tests/integration/stop-gate-autonomous-topic-resolution.test.ts — the full HTTP hot-path: UUID→tmux→topic resolution feeds the canonical per-topic read end to end.

## What's scoped to the follow-on PR

PR1 covers the read-path correction only — the gate now SEES a registration that already exists on disk. The dev-gated registration-guard that auto-writes a TTL-bounded provenance stub when a run starts without one (D3) is specified separately in the spec's PR2 section, with its own dev-gate rollout and sign-off. <!-- tracked: autonomous-run-registration-guarantee -->
