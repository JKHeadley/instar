# Convergence Report — Agent-started sessions are placed by load, and shedding starts before the cap

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI in every round (1-6). Round 1's first attempt from the agent home asked for a retired model and degraded (`error`); it was rerun from the worktree build, which resolved `gpt-6-astra`. Gemini was not authed (`gemini-not-authed`) on this machine, so the external pass is one family.

## ELI10 Overview

Justin asked why sessions are not spread to other machines before the Mac Studio is overloaded. The answer is that when an agent starts a session itself, it always starts on the machine it is on; only conversations started by a person's message get spread. This spec fixes that in steps. First, every session start writes down where it would have gone, so we learn with real numbers how much load could move. Second, helper sessions that ask for it are started on a machine with room when this one is busy. Later steps move sessions an agent starts for a conversation (most of the load), turn the Studio's overload brake on for real, and start moving work off a machine based on sustained load.

The main tradeoff is safety against reach. Moving a session to another machine can break it if it needs files only this machine has, and a hand-off that times out could start the same work twice. So the first step is opt-in per request, never starts anything twice from one machine, never loses a request, and is proven on a throwaway two-machine test rig before Echo uses it live.

## Original vs Converged

Originally, every helper session would be moved automatically when another machine scored a little lower, with a "start locally if anything goes wrong" fallback and a promise to move topic sessions later. Review showed that most of the Studio's load is topic sessions, that a timed-out hand-off can mean the session already started (so a local fallback duplicates it), that many helpers depend on this machine's files, and that the scoring used for ordinary work has no "stay home if there is room" rule. The converged design measures everything first, moves only requests that ask for it, stays home unless this machine is busy, never starts a name twice from one origin, keeps a durable record of where each placed session went (written before the hand-off, re-checked on the pool tick, never ended by elapsed time), forwards follow-up output reads to the right machine, refuses to forward kills (they carry operator proof), and adds a test-agent rung and tracked commitments for the later steps.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | codex, security/adversarial/scalability, integration/decisions/lessons, constitution gate | 16 | 6 | rewrite: shadow first, opt-in, no fallback after unconfirmed, scope to /sessions/spawn, reuse shipped floors, maturation path, tracked steps |
| 2 | codex, six-lens reviewer, gate | 8 | 8 | session-exists no fallback, weight-specific eligibility, quota-blocked excluded, separate standard reservation, 15 s timeout kept, reconciliation, follow-up proxy, test-agent rung |
| 3 | codex, six-lens reviewer, gate | 8 | 4 | placement store defined, same-name serialization, kill not proxied, peer URL resolved at call time, unknown kept, pending written before send |
| 4 | codex, six-lens reviewer, gate | 6 | 5 | reservations feed ranking, heavy reservations, store state machine, guarantee scoped to one origin, legacy duplicate normalization |
| 5 | codex, six-lens reviewer, gate | 5 | 4 | live/unknown re-read, `gone` vs `absent`, names pinned to their first peer, contradiction removed |
| 6 | codex, six-lens reviewer, gate | 3 | 7 | resolved at the cap: unresolved names are read-only (never re-sent), `absent` renamed `not-observed` (claims nothing about starting), `gone` frees the name as local reuse does today |

Standards-Conformance Gate: ran every round (round 1: 3 flags; round 2: 4; round 3: 4; round 4: 3; round 5: 4; round 6: ran, flags folded into Left behind).

Per-round internal reviewer model: claude-opus-5-5 (subagents of this session) every round.

## Proportion

Tier 2 (reclassified from Tier 1 after round 3: it moves sessions between machines). Spec about 90 lines; 6 rounds used of the Tier-2 cap of 6. The round count is out of line with the first step's size, because round 1 changed the design's shape and rounds 2-5 each closed a real duplicate or lost-state path in the record of where sessions went.

## Left behind

Design items resolved at the 6-round cap by narrowing edits, without a seventh review round (recorded so the reader can judge):
- Same-name retries: an unresolved name is read-only (never re-sent anywhere); a `gone` name is free, as local reuse is today. Accepted residual risk: a caller that ignores a `202` and re-sends after a short helper finished can run it twice, the same as on one machine today; not a data-loss path.
- `absent` → `not-observed`: it never claims a session did not start and never authorizes another start of that name for 24 h.
- `gone` entries no longer lock a name, the kill 409 and output proxy apply only to recorded unresolved (or gone, for output) entries.

Accepted as precision / long tail:
- Fixed numbers (1.0 per core, 60 s freshness, 0.25 per-core reservation for 3 min, 200-entry store, 10-minute windows) remain constitution-gate "possible-violation" signals every round. Each is either a shipped, evidenced floor reused unchanged (1.0, 60 s), or a bounded bookkeeping value that never decides where work runs beyond this opt-in route and is re-tuned from the shadow log. Logged as accepted with that reasoning.
- A peer that leaves the pool keeps its `unknown` entries; the full-store state is named in the audit and attention item.
- Duplicate measurement sees concurrent and recently finished copies only; sequential re-runs need per-placement start records (deferred to the maturation review).
- Heavy requests: the pre-filter, not `decide()`, applies the standard reservations; `exists-on-peer` may keep a fresh reservation until its 3-minute expiry (harmless).

## Full Findings Catalog

Round reports are summarized above; each round's raw reviewer output is in the session transcript (machine stewardship, topic 144503). The key design findings and their resolutions are listed in the Iteration Summary's "Spec changes" column.

## Convergence verdict

Converged at the 6-round Tier-2 cap. The final round's three design findings were about the same duplicate-run class and were resolved by narrowing the design (no new mechanism), recorded above for the reader rather than re-reviewed; the remaining items are precision or accepted residual risk with stated reasoning. Spec is ready for review and approval; the first build step is the shadow log plus opt-in topicless placement, proven on the two-machine throwaway rig before any live use on Echo.
