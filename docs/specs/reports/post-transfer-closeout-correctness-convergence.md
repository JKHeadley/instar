# Convergence Report — Post-Transfer Closeout Correctness (liveness-gate the stale-ownership kill)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's own `codex` CLI in every review round
(`codex-cli:gpt-5.5`), and the final settled-body round returned `ok` / MINOR ISSUES with zero
material findings. A Gemini-tier pass (`gemini-cli:gemini-2.5-pro`) also ran: it returned `ok` /
MINOR ISSUES on the first and final rounds and `degraded: timeout` on one intermediate round — but
because at least one (in fact most) external round succeeded per family, the spec received genuine
cross-model review and the clean RAN flag applies. This is the no-⚠ clean state.

## ELI10 Overview

I'm one agent that runs on more than one of Justin's computers. A "topic" is a single conversation,
and at any moment it should be served by exactly one machine. A little janitor inside the session
reaper — the **post-transfer closeout** — is supposed to shut down the *leftover* session on a machine
after a conversation has genuinely moved to another machine. The bug this spec fixes: the janitor
decided "should I close this?" by reading ONE thing — a local record of which machine *owns* the topic
— and that record can be **stale and wrong**. It can say "the other machine owns this" when the other
machine has no live worker for the topic at all, while the machine the janitor is about to kill is the
*only* one actually doing the work. So on a real two-machine setup, the closeout could terminate the
sole live worker for a conversation, and the user's chat would go dead. (Justin saw the downstream
symptom: a "Topic N moved to X, but the old session won't close" alert — the breaker escalating the
wrong thing.)

The fix is "ask before you kill." Before acting, the janitor now consults a fresh local snapshot —
built from the same cross-machine `GET /sessions` signal the dashboard already uses — and asks: *does
the machine that supposedly owns this topic actually have a live worker for it right now?* If **yes**,
it's a real duplicate → close the leftover (same as today). If **no**, the local session is the only
worker → **do not kill it**. And — the heart of the fix — if the answer is **unknown** (snapshot
missing, peer unreachable), it *also* refuses to kill. The old code killed on a guess; the new code
refuses to. There's a flip side too: when a move is genuinely confirmed, a separate "you got a message
recently" guard could otherwise block the cleanup forever, so a narrow, named bypass lets a
*confirmed-genuine* leftover shed — guarded by a freshest-interaction check so it can never shed a
session the user is actively talking to. A secondary fix makes the safety-breaker count survive a
session restart so it trips on time instead of taking ~3× too long. Everything ships behind a
default-OFF flag that's live only on a developer agent for dogfooding, so nothing changes on the fleet
until it's deliberately promoted; with the flag off, the reaper behaves byte-for-byte like today.

The main tradeoff: this is a *polling* consistency model, so there's a small bounded window (up to ~4
minutes worst case) where a remote session that just completed could still read as "live." That window
only ever fires on the genuine-move branch — the worst case is shedding a true duplicate a few minutes
early, never the original bug (killing the sole worker of a topic that did *not* move). The fully
race-free guarantee is explicitly deferred to a separate ownership-lifecycle follow-up (release-on-
complete), which is tracked via a durable commitment, not a vague "later."

## Original vs Converged

The spec entered review already well-developed (it had been authored with one cross-model pass folded
in). Review hardened it on several fronts:

- **Owner identity**: originally the liveness lookup keyed on the *display* id (nickname-or-machineId).
  The codex pass flagged that nicknames are mutable/duplicable — a rename could silently flip a fresh
  answer to "unknown." Converged: liveness keys on the **stable `machineId`**, read atomically with the
  display label from a **single** ownership-registry read (`topicOwnerElsewhereInfo`), so the liveness
  key and the audit text always describe the same owner from the same instant (this also closed a
  two-deps TOCTOU the review surfaced).
- **Empty-set semantics**: clarified that a *fresh, reachable* peer with **zero** sessions is a
  definitive `false` (the real stale-owner signal), never `unknown`. Freshness means "the peer was
  reached," never "the set is non-empty."
- **The liveness contract**: the review caught two competing definitions ("merely listed is enough" vs
  "must be serviceable"). Converged to **ONE** authoritative predicate — a *listed, non-terminal*
  session counts (excluding only states the peer itself already marks as ending); an opaque-state entry
  counts as listed (the weaker, observable contract), because reclassifying a briefly-wedged remote to
  `false` would turn a genuine duplicate into an indefinite withhold + noisy audit.
- **Part E shed-bypass**: hardened with a **freshest-interaction hard veto** — the narrow
  `recent-user-message` bypass is passed ONLY if the topic's last *local-receipt* user message is older
  than the snapshot that proved the remote live, with the clock basis pinned to local receipt so the
  comparison is sound. This makes Part E provably unable to shed a session the user just messaged.
- **The dwell state machine**: specified exactly — the confirm streak advances only on *distinct,
  strictly-newer* true snapshot generations (a same-generation re-read does not advance it), and any
  `false`/`unknown` resets it, so an alternating sequence can't accrue a false streak.
- **No Unbounded Loops (P19)**: the snapshot refresher's brakes were made explicit — level-triggered on
  a fixed cadence (no retry storm), a 5s per-attempt timeout, per-pass eviction of departed peers
  (bounded O(pool machines)), and every failure path resolving to the SAFE withhold direction (so a
  dedicated backoff/breaker would only add failure modes).
- **Deferral honesty (P10)**: Parts A/B/D (the broader ownership-lifecycle work) are out of *this*
  scope, now tracked via a durable one-time-action commitment + PromiseBeacon on merge (Close-the-Loop),
  not a bare comment.
- **Multi-machine posture**: every new state surface is now explicitly declared — the `liveRemoteTopics`
  snapshot is **machine-local by design** (each machine reasons from its own fan-out), the per-machine
  dev-gate's half-active behavior is shown to be benign (a gate-OFF machine keeps today's behavior; a
  gate-ON machine is strictly safer; no cross-machine state can be corrupted), and the Maturation-Path
  standard is engaged (ships ENABLED on dev agents via `resolveDevAgentGate`).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | Standards-Conformance Gate: ran (2 flags — P10 No-Deferrals, P19 No-Unbounded-Loops); codex-cli:gpt-5.5 (5 minor); gemini-cli:gemini-2.5-pro (3 minor); 6 internal | ~3 (most already addressed in the authored body) | machineId keying confirmed; empty-set semantics; brakes section; deferral-tracking commitment; multi-machine posture declaration |
| 2 | Standards-Conformance Gate: ran (2 flags — P19, Maturation-Path); codex-cli:gpt-5.5 (5 minor); gemini-cli (degraded: timeout); 6 internal | 2 (FD5 single-dep TOCTOU; Maturation-Path engagement) | single atomic `topicOwnerElsewhereInfo` dep; `lessons-engaged` frontmatter; Maturation-Path paragraph; freshest-interaction veto introduced |
| 3 | codex-cli:gpt-5.5 (MINOR — liveness-contract precision, eligible-states, counter test); gemini-cli (MINOR — fan-out concurrency, clock assumption) | 0 material (hardening nits) | liveness predicate reconciled to ONE contract; dwell state machine specified; partial-rollout honesty; clock-basis pinned |
| 4 (final, settled body) | Standards-Conformance Gate: ran (1 flag — P19, explicitly engaged+justified); codex-cli:gpt-5.5 (MINOR, "generally sound, no fundamental flaws"); gemini-cli:gemini-2.5-pro (MINOR, "no fundamental design flaws") | 0 | none (converged) |

> Note on process honesty: this convergence ran concurrently with another of the agent's own hands
> driving the same spec in the `ownership-follows-live-work` worktree. The two hands folded the same
> cross-model findings; one intermediate codex pass returned SERIOUS because it read a body *between*
> two folds (the FD5/value-type/liveness-contract sections were transiently inconsistent mid-edit), and
> the subsequent fold resolved exactly those three contradictions. The final settled-body external
> round (both families `ok` / MINOR, zero material findings) is the authoritative convergence evidence.

## Full Findings Catalog

### Round 1

- **[gate, P10 No-Deferrals]** Parts A/B/D deferred with only a vague tracked comment. → Resolved:
  "Tracked follow-through" section opens a durable `POST /commitments` one-time-action on merge, re-
  surfaced by the PromiseBeacon (Close-the-Loop). The scope is honestly "stop the dangerous kill"; A/B/D
  were never in-scope.
- **[gate, P19 No-Unbounded-Loops]** Snapshot refresher repeats under peer-unreachable failure without
  stated brakes. → Resolved: explicit brakes section + Frontloaded Decision 7 (level-triggered cadence,
  5s timeout, per-pass eviction, every failure → safe withhold).
- **[codex, minor]** Owner identity = display id is weak (nickname mutable/duplicable). → Resolved:
  stable `machineId` keying via the new `topicOwnerElsewhereInfo` atomic read (FD5).
- **[codex, minor]** Snapshot "populated" ambiguous — empty set must be a valid `false`. → Resolved:
  freshness = "reached," empty fresh set = definitive `false`.
- **[codex, minor]** `false` during a transfer race + reconcile-toward-self may fight an in-flight
  transfer. → Resolved: audit framed as *suspected*-stale with `{ suspectedStaleOwner, ownerMachineId,
  snapshotAgeMs }`; withhold is unconditionally safe; CAS correction is the A/B follow-up's job.
- **[codex, minor]** Topic-keyed breaker state could contaminate a new same-topic episode. → Resolved:
  episode-hygiene clears (terminate-success / topic-home-unowned / pin-conflict) preserved under the
  topic key; count survives only within one continuous episode.
- **[codex, minor]** Fan-out load/duplication. → Resolved: shared bounded fan-out helper; refresher
  constructed only when the gate is on.
- **[gemini, minor]** Staleness-window true-side race. → Resolved: named-and-accepted residual (the safe
  direction; dwell streak requires persistence; fully race-free guarantee deferred to A/B).
- **[gemini, minor]** Alt designs (event bus); glossary/density. → Acknowledged non-blocking.
- **[internal — adversarial]** Fail-closed `unknown` could silently strand a genuine duplicate. →
  Resolved: the withhold is the SAFE direction, audited per-episode; correction handed to the tracked
  A/B follow-up (Close-the-Loop), never silent rot.
- **[internal — decision-completeness]** Two buried implementation either/ors (fan-out helper vs inline;
  GC form). → Resolved: frontloaded a concrete choice with a named internal fallback.
- **[internal — integration]** Machine-local posture of `liveRemoteTopics` undeclared; half-active dev-
  gate hazard. → Resolved: explicit multi-machine posture section.

### Round 2

- **[gate, Maturation-Path]** Default-OFF dark flag without stating it ships ENABLED on dev agents. →
  Resolved: explicit Maturation-Path paragraph (live on echo via `resolveDevAgentGate`, dark on fleet).
- **[codex, minor → material]** FD5 still named a two-dep `ownerMachineIdOf` idea while the body moved
  to a combined dep — a TOCTOU between two registry reads. → Resolved: single atomic
  `topicOwnerElsewhereInfo: { machineId, displayName }`; FD5 corrected.
- **[codex, minor]** Part E local-vs-remote intent / "freshest intent" claim too strong. → Resolved:
  freshest-interaction veto narrowed to "older than the snapshot that proved liveness"; claim scoped to
  local post-snapshot input.
- **[codex, minor]** "Why polling interim" + gate-audit diagnosability. → Resolved: partial-rollout
  honesty note; audit text says "listed non-terminal session," not "healthy."
- **[gemini, degraded: timeout]** No findings (folded what came back; partial pass — does not collapse
  the round to unavailable, as codex succeeded).

### Rounds 3–4 (folds + final settled-body round)

- **[codex R4 — transient SERIOUS on a mid-fold body]** (1) owner-change mid-dwell; (2) contradictory
  streak-type definitions; (3) self-contradictory liveness contract. → All three resolved in the
  subsequent fold: dwell counts distinct strictly-newer generations; ONE streak type
  `{ count, lastTrueReachableAt, lastSeenAt } | -1` with FD4 corrected; ONE authoritative
  listed-non-terminal liveness predicate. (The SERIOUS verdict reflected a body read between two folds,
  not a residual defect — confirmed by the final settled-body round.)
- **[codex final, MINOR — non-material]** Liveness-contract phrasing could be sharper; 4-min true-side
  window; "local-only intent" claim; hotfix blast-radius; can't validate governance claims (truncated
  context). → All non-material: the contract is reconciled, the window is named-and-accepted, the intent
  claim already withholds-toward-safe, the blast radius is the deliberate single-coherent-change scope.
- **[gemini final, MINOR — non-material]** Reframe polling as a deliberate choice (not just interim);
  state low-latency assumption for `recentUserMessageAt`; density. → Non-material framing/observation
  nits; "no change required."

## Convergence verdict

Converged at iteration 4. The final review round on the settled spec body produced **zero material new
findings** — both external families (`codex-cli:gpt-5.5`, `gemini-cli:gemini-2.5-pro`) returned `ok` /
MINOR ISSUES with explicit "no fundamental design flaws," the internal perspectives surfaced only
already-addressed or cosmetic nits, and the only persistent Standards-Conformance flag (No Unbounded
Loops) is explicitly engaged and justified in the spec body and `lessons-engaged` frontmatter (the
refresher's fail-closed-to-safe-direction cadence is the brake; a dedicated backoff/breaker would only
add failure modes). `## Open questions` is `*(none)*` — zero unresolved user-decisions. The spec is
ready for user review and approval.
