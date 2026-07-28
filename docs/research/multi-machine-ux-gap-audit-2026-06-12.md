# Multi-Machine UX Gap Audit — working draft (2026-06-12, autonomous run, topic 13481)

Goal frame (Justin): "multi-machine support should be as seamless as possible from the
user's perspective" — one coherent being across machines. Every finding below is a place
the seam shows.

## Confirmed live findings (verified today on the real pool)

### F1 — Inbound delivery ignores topic ownership (CRITICAL, partially covered by existing spec)
- Evidence: src/commands/server.ts onTopicMessage → `telegram.getSessionForTopic(topicId)` →
  inject locally. No placement/ownership consultation anywhere in the path.
  Live-proven 2026-06-12: topic 13481 pinned+owned by Mac Mini at 20:03Z; messages at
  20:16Z and 20:17Z injected into the laptop session (`[telegram→session] Injecting into
  echo-instar-exo` in logs/server.log).
- Consequence: a transferred topic keeps being served by the OLD machine while the
  ownership/pin layers claim otherwise. The "move" flips paperwork, not the conversation.
- Coverage: the durable-inbound-message-queue spec (converged, .worktrees/durable-msg-queue,
  CMT-1118) owns the queue + hold-still policy and the wrong-place-delivery diagnosis.
  REMAINING for unified spec: the dispatch-to-owner integration — route() placement must be
  consulted at delivery time and the message must travel to the owner machine (mesh), not
  just queue locally. Verify scope boundary against that spec's "what we're building".

### F2 — Live transfer of an actively-used topic never completes (CRITICAAL)
- Evidence: reap-log 20:03→20:25Z, ~every 2min: post-transfer closeout tries to close
  echo-instar-exo ("topic moved to Mac Mini"), refused each tick (active-process /
  pending-injection / structural-long-work). Because F1 keeps feeding the old session,
  it stays active forever → closeout can never fire → session never migrates.
- Consequence: for the user, "move this conversation to the mini" silently does nothing
  observable (worse: the system internally disagrees with itself for hours).
- Also: the closeout reaper takes 2-minute swings at a session doing real work — only
  the keep-guards protect it. With F1 fixed (messages stop feeding the old session),
  the closeout completes naturally; the spec should also define "drain + handoff" for an
  ACTIVE session (planned-handoff semantics) rather than waiting for idleness.

### F3 — Transfer-back cannot re-place ownership; pin/owner diverge silently
- Evidence: POST /pool/transfer {topic:13481,to:"Laptop"} twice → ok:true but
  placedOwnership:false both times; placement stuck at owner=Mac Mini, pinnedTo=Laptop
  for 10+ minutes. By design `place` CAS refuses to steal an active record; the pin only
  drives re-placement on the NEXT inbound message — but nothing surfaces this pending
  state, and consumers disagree meanwhile: the closeout reaper keys on OWNER (kept
  attacking the laptop session) while routing keys on PIN.
- Consequence: a "move it back" lands in a half-state with no convergence deadline and
  no honest status surface. Need: a reconcile step (owner machine releases on seeing a
  conflicting pin) or transfer API draining the release through the owner via mesh, plus
  a `pendingReplacement` flag in GET /pool/placement.
- Follow-up evidence (20:42Z same day): the divergence persisted 20+ minutes with the
  post-transfer closeout still firing every 2 minutes against the working session
  (held off only by keep-guards + manual session protection). The documented self-heal
  ("the pin drives re-placement on the next real message") never fired — no inbound
  arrived after the transfer-back, and the delivery path that would carry one is the
  same path F1 shows ignores placement. In practice the half-state has NO bounded
  convergence path.

### F4 — Subscription-account pool is machine-local (known, from this conversation)
- The 5-account pool (registry .instar/subscription-pool.json, configHome paths) exists
  on the laptop only. The Mini has a single login: no swap cushion, no continuity
  guarantee at a quota wall there. Quota-aware placement DOES work pool-wide (heartbeats
  carry quotaState — verified live).
- Spec item: account-pool follow-me — per-machine enrollment inventory surfaced in /pool,
  placement aware of per-machine pool DEPTH (not just current blocked state), and a
  security-reviewed design for syncing/enrolling logins across machines.

### F5 — Attention queue is machine-local and unmerged
- Evidence: GET /attention has no machine field, no ?scope=pool (83 local items).
  An attention item raised on the Mini (e.g. its guard-posture tripwire) is invisible on
  the laptop dashboard and to the laptop agent.
- Spec item: pool-scope merged read (like /sessions?scope=pool, /guards?scope=pool),
  machine-tagged items; decide single-surface story for /ack.

### F6 — The named tunnel fronts ONE machine; cross-machine links break
- Evidence: GET /tunnel → https://echo.dawn-tunnel.dev fronts the laptop. Private views,
  dashboard links, secret-drop URLs generated on the Mini are unreachable through it.
- Spec item: either tunnel-aware routing (the fronting machine proxies /view/:id and
  dashboard traffic to the owning machine — streaming relay already proves the path) or
  per-machine tunnels with honest URL selection. Decide; ship dark.

### F7 — Idle machine vs broken machine are indistinguishable on the dashboard sessions view
- Evidence: 2026-06-12 12:10 PDT — Justin read "no Mini sessions" as a regression after
  the stale-tiles fix; the Mini was healthy but idle. The sessions view shows nothing for
  a machine with zero running sessions.
- Spec item: explicit per-machine empty-state ("Mac Mini — online, no active sessions",
  "offline since …"). Small, high-trust win.

### F8 — Mini scheduler had zero jobs after incident recovery (2026-06-11 finding)
- One machine's scheduled jobs are invisible to and unreconciled with the pool: nothing
  noticed a standby machine running NO jobs for a week (incident fallout), and there is
  no cross-machine view of "which jobs run where".
- Spec item: jobs surface with machine attribution + pool-scope read; posture-style
  divergence detection ("machine X runs 0 jobs but its config declares N").

## State-store inventory (code sweep, 2026-06-12 — swept the agent-home checkout which
## trails main; items below were re-calibrated against what is KNOWN shipped on main:
## secretSync, commitments sync (P1.5), working-set handoff (P2) exist and are NOT gaps)

### Machine-local stores with user-experience impact (gap candidates for the spec)
- F9  Correction/preference learning (`.instar/correction-ledger.db`, `.instar/preferences.json`)
      — preferences learned on one machine don't follow to the other; the agent "forgets
      who you are" after a machine handoff. HIGH user-visibility.
- F10 Learnings / semantic memory (`.instar/semantic.jsonl` + `.db`) — lessons learned on
      machine A never reach machine B.
- F11 Knowledge base (ingested docs + search index) — "what do we know about X?" answers
      differently per machine.
- F12 Relationships + user registry (`.instar/state/relationships/`, `.instar/users.json`)
      — the agent's model of WHO PEOPLE ARE diverges across machines. HIGH.
- F13 Evolution action queue + TaskFlow registry (`.instar/task-flows.db`, explicit
      v1 no-sync) — self-improvement items invisible across machines.
- F14 Topic resume map — standby machine doesn't know a topic is active elsewhere
      (interacts with F1-F3).
- F15 Playbook context items — adaptive context doesn't follow.
- F16 A2A sent/received logs — machine-local by partial design (P3 names the holder
      honestly); keep as by-design with the mesh view, NOT a spec item.

### Per-machine BY DESIGN (do not spec): identity files snapshot, config, security log,
### nonce store, job RUN history, telemetry/observability ledgers, Telegraph registry
### (public URLs), self-knowledge facts (machine-specific truths), shared-state ledger
### (documented design decision).

## Behavioral sweep findings (calibrated against current main — sweep ran on the
## agent-home checkout which trails main; items already fixed on main were dropped:
## pool-scope sessions dashboard, capacity heartbeats)

- F17 Autonomous runs are machine-local; topic transfer mid-run = stranded state +
      double-spawn risk (`.instar/autonomous/<topicId>.local.md`, AutonomousSessions).
      LIVE-RELEVANT: this very run sat in that exact hazard today (topic pinned to Mini
      while an autonomous run executes on the laptop). Spec item: autonomous-run
      ownership rides the coherence journal (category exists: autonomous-run) +
      transfer-time check: refuse or migrate an active run, never strand it.
- F18 PresenceProxy (the 🔭 standby voice) has no machine-ownership gate (PromiseBeacon
      HAS one at emission time) — both machines can answer for the same topic =
      double-voice. Spec item: same ownership filter as PromiseBeacon.
- F19 PromiseBeacon's gate compares ownerMachineId but commitments may be created
      without it populated — gate silently inert. Spec item: populate at creation +
      backfill.
- F20 Topic→session registry is per-machine with no transfer-time dedup of the
      auto-spawn path: a message arriving on the new owner spawns a NEW session while
      the old machine still holds one (post-transfer closeout helps but is reactive and
      blockable — see F2). Spec item folds into F1/F2 dispatch design.
- F21 Job double-run protection is best-effort (claims broadcast fire-and-forget;
      partition = run independently) + jobs without `machines` scope run on EVERY
      machine; a standby machine's read-only StateManager makes state-writing jobs
      crash mid-run. Spec items: machine-role check at spawn; claim durability;
      explicit per-job placement policy surfaced to the user (ties F8).
- F22 Model-tier escalation + job model severity files are /tmp-local per machine —
      an escalated topic that moves de-escalates silently. Spec item: escalation state
      rides the topic (topic-profile carrier exists — "[topic-profile-pull] transfer
      carrier wired" already in logs; verify coverage includes escalation + thinking).
- F23 RateLimitSentinel recovery state is in-memory per machine — failover can
      double-notify "rate limited". LOW. Spec item: optional; fold into double-voice
      family (F18).

## Already covered / by design (do NOT re-spec)
- Durable inbound queue + hold-for-stability: converged spec in flight (other session).
- Working-set file handoff (P2), commitments merge/forward (P1.5), threadline holder
  honesty (P3), secrets sync, exactly-once ingress, session streaming + remote close +
  guard posture (shipped #1061/#1067/#1068/#1072/#1075).
- Self-knowledge facts: per-machine BY DESIGN (machine-specific truths).
