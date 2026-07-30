# Side-Effects Review — a transient-pressure spawn refusal must not destroy the payload it refused

**Version / slug:** `spawn-denial-preserves-payload`
**Date:** `2026-07-29`
**Author:** `echo`
**Second-pass reviewer:** `required (session-lifecycle / spawn surface)`

## Summary of the change

`SpawnRequestManager.evaluate()` is the admission funnel every inbound agent-to-agent dispatch passes
through before a session is spawned to handle it. It has six exits that do not spawn. Three of them
destroyed the inbound payload; three did not. This change makes the whole set consistent, so a refusal
never means data loss.

Before → after, all six exits:

| Exit | Transient? | Before | After |
|---|---|---|---|
| `envelope-too-large` | no — permanent rejection | drops | **drops (correct, unchanged)** |
| cooldown | yes | queues | queues |
| session limit | yes (`retryAfterMs: 60_000`) | **drops** | **queues** |
| memory pressure | yes (`retryAfterMs: 120_000`) | **drops** | **queues** |
| subscription quota | yes | queues | queues |
| spawn threw | yes (`retryAfterMs: 30_000`) | drains queue, then destroys all of it | **UNCHANGED — restoring is unsafe, see §1a. Tracked: CMT-1114** |

Files touched:

- `src/messaging/SpawnRequestManager.ts` — the two missing
  `if (request.context) { #queueMessage(...) }` guards, plus one line making a GLOBAL-cap refusal set
  the truncation marker (§1a finding 2). **Every denial verdict — predicate, `reason` string, and
  `retryAfterMs` — is byte-for-byte unchanged.**
- `tests/unit/spawn-request-manager.test.ts` — 5 tests added (3 positive, 2 pure controls) plus one
  renamed exactly-once control.

**Scope was CUT after second-pass review.** An earlier revision of this change also restored the drained
queue when `spawnSession` threw. Review proved that unsafe and it was removed — §1a below.

Live evidence (this machine, 2026-07-29):

- Codey's `logs/server.log` carries **40** `Spawn denied: Memory pressure too high for new session`
  entries in one day.
- Three of my own dispatches to him were destroyed this way, at `19:45:23.541Z`, `23:18:33.406Z`,
  `23:20:35.503Z`. Each logged `async handleInboundMessage complete: {"handled":true,...,"error":"Spawn
  denied: Memory pressure too high for new session"}` and each returned
  `{"delivered":true,"outcome":"accepted"}` to me.
- Consequence: Codey merged 25 PRs up to `15:01Z` and then produced nothing for eight hours. He was not
  idle — he was **unreachable, and the transport reported success to both ends.**
- His `MemoryPressureMonitor` oscillates 70–78% against the default `elevated: 75` threshold, flipping
  every 30–80 seconds, so roughly half of all inbound A2A dispatches were coin-flipped into deletion.

I explicitly considered and **rejected** raising the pressure threshold, which would have been the
cheap answer. The pressure is genuine, not miscalibrated: swap 16.4 GB used of 17.4 GB (94%), total RSS
7.9 GB plus 7.3 GB held by the compressor on a 16 GB machine, and only ~67 MB safely reclaimable. The
guard is right to fire. The defect is that firing destroyed data.

**Scope grew, then was cut back.** I opened this to fix memory pressure. Auditing the function's other
exits for this artifact found the same defect twice more, so I fixed all three — the third being the worst,
since `#drainQueue` empties the queue *before* the spawn and a throw destroyed everything it had taken,
including payloads the cooldown and quota branches had just rescued. Second-pass review then proved the
third fix UNSAFE (§1a) and it was removed. The remaining two are the ones with the live evidence behind
them: every one of the 40 observed losses was a memory-pressure denial, which happens *before* any spawn
is attempted, so nothing could have been delivered.

## Decision-point inventory

- `SpawnRequestManager.evaluate()` — session-limit gate — **pass-through** — verdict identical in every
  input case; payload retained on the already-denied path.
- `SpawnRequestManager.evaluate()` — memory-pressure gate — **pass-through** — same.
- `SpawnRequestManager.evaluate()` — spawn-failure catch — **untouched** (an earlier revision changed it;
  reverted after review, see §1a).
- `#queueMessage()` global-cap refusal — **modified, non-decision** — still refuses exactly the same
  payloads; now sets the existing `#truncated` marker so the refusal leaves a trace.

No decision point is added, modified, or removed. No threshold, predicate, or priority rule is touched.

---

## 1. Over-block

**No block/allow surface change — over-block not applicable.** Nothing new can be refused. Every
predicate and reason string is unchanged, and pinned tests assert the unchanged verdict (`reason`
contains, `retryAfterMs` exact) *alongside* each new queue assertion, specifically so a later edit
cannot quietly turn one of these into a threshold change.

The nearest real concern is queue *capacity*, in §2 and §5.

---

## 1a. What second-pass review changed (the scope cut)

Review ran BEFORE this shipped and produced one blocking finding and one accuracy finding. Both are
recorded here rather than quietly absorbed, because the first one means an earlier revision of this
change would have made things worse.

**Finding 1 — BLOCKING. Restoring the drained queue on a failed spawn can DUPLICATE delivery.**
The removed code assumed a `spawnSession` rejection proves nothing was delivered. I verified that
assumption against the real implementation and it is false. `SessionManager.spawnSession`:

1. calls `execFileSync(tmux, ['new-session', '-d', …headlessSpec.argv])` — this creates a LIVE process
   already running the framework CLI **with the full prompt**, which is the moment of delivery;
2. that call sits in a `try/catch` that rethrows only tmux-creation failures;
3. **after** that block, it builds the `Session` object and calls `this.state.saveSession(session)`
   — outside any `try/catch` — and only then returns.

So a throw from `saveSession` (disk I/O, a `guardWrite` refusal, a serialization edge) means the payload
was **already delivered** while `spawnSession` reports failure. The restore would have put that payload
back, and the drain loop — 5 seconds later — would have delivered the same instruction to a second live
session. Two real agent processes acting on one instruction.

That is strictly worse than the bug being fixed: a lost message is recoverable by re-sending, a duplicated
instruction can act twice. And the failure modes are *correlated* — `saveSession` I/O failures are more
likely under exactly the memory pressure this change targets, not less.

I considered three ways to keep the restore safely and rejected all three:
- **Gate on `#classifyFailure`'s cause.** The real `spawnSession` never throws `SpawnFailureError`, so
  every production failure classifies as `ambiguous` — the restore would either never fire (useless) or
  fire on the unsafe case (the bug).
- **String-match the tmux-creation error message.** Brittle, and prohibited by the project's own rule
  against matching on text where structure is required.
- **Ask whether the session exists before restoring.** `SpawnRequestManager` has no such accessor;
  `getActiveSessions()` reads persisted state, which is precisely what failed to write.

So the restore was **removed**, not weakened. The prerequisite is upstream: `spawnSession` must stop
reporting failure once the session is live and holding the prompt — a bookkeeping failure after delivery
should be reported without rejecting. That is the same defect class this whole change is about, wearing
the opposite mask: **an operation that succeeded and reported failure.** Tracked: CMT-1114.

What ships is the part with the live evidence: all 40 observed losses were memory-pressure denials, which
occur *before* any spawn is attempted, so non-delivery there is structural rather than assumed.

**Finding 2 — accuracy. My own §2.1 claim was false for the global cap.**
I had written that queue loss now "goes through an accounted, marked, capped path instead of an unrecorded
`return`." True for the per-agent cap. False for the global cap: `#queueMessage` returns `false` as its
first statement, before any marker logic, and **every callsite discards the boolean**. So a global-cap
refusal was the one queue loss with no trace whatsoever. I fixed the code to make the sentence true
(the global-cap path now sets `#truncated`) rather than softening the sentence to match the code.

**Findings the review cleared:** TTL preservation was correct; no ordering bug from moving the drain; and
the three specific claims it checked (verdicts byte-for-byte unchanged, the drain request carries no
`context`, a successful spawn does not restore) were all accurate as stated.

**Reviewer's non-blocking note, now moot:** it observed that restore-at-the-front combined with
front-first truncation could re-discard the very entries being rescued. Removing the restore removes that
question entirely.

---

## 2. Under-block

Framed as under-*fix*, since there is no block surface:

1. **Sustained pressure can still lose content, but no longer silently — and this claim is now true for
   BOTH caps.** `#queueMessage` enforces a per-agent cap (drops oldest, sets `#truncated`) and a global
   cap. Review caught that my first draft of this sentence was FALSE for the global cap: it returns
   `false` as its very first statement, before any marker logic, and **every callsite discards that
   boolean** (`if (request.context) { #queueMessage(...) }`), so a global-cap refusal was the one queue
   loss with no trace at all — exactly the silent-loss shape this change exists to remove. Rather than
   soften the sentence I made the code match it: the global-cap path now sets `#truncated` too. Content
   can still be lost under sustained pressure; it can no longer be lost invisibly.
2. **The 10-minute TTL still applies.** `QUEUE_MAX_AGE_MS` is 10 minutes, and `#drainQueue` filters
   expired entries. A machine wedged above the threshold for longer than that will still drop. On the
   machine where the loss was observed, windows open every 30–80 seconds against a 5-second drain tick,
   so this is not the operating case.
3. **The sender is still told `delivered: true`.** `ThreadlineRouter`'s `handled: true` on denial is
   deliberately untouched here. After this change that report is *approximately* true — the payload is
   accepted for imminent retry rather than deleted — but a cap-drop or TTL expiry remains invisible to
   the remote peer. Fixing it means changing the router's return contract and its callers, a wider blast
   radius than this change should carry. <!-- tracked: CMT-1111 -->
4. **The queue does not survive a restart.** It is in-process memory, so a server restart between
   enqueue and drain loses queued entries. This is the pre-existing behavior of the two branches that
   already queued; this change matches them rather than diverging. <!-- tracked: CMT-1112 -->
5. **`envelope-too-large` still drops, and should.** It is not transient — the payload is over a hard
   byte cap, so queueing it would store the oversized content and re-refuse it every drain tick. Its
   sender deserves an honest rejection, which is a different fix (see §2.3), not a queue slot.

---

## 3. Level-of-abstraction fit

Right layer, and deliberately the smallest one that closes the class.

The loss happened inside `evaluate()`, so `evaluate()` is where it is fixed. Two alternatives were
considered and rejected:

- **Fix it in `ThreadlineRouter`** (have the router queue on denial): wrong layer. The router is one of
  several `evaluate()` callers, so the loss would remain for all the others. Fixing the property at the
  admission funnel covers every caller at once — which is the same argument the constitution's
  fix-the-property-not-the-instance rule makes.
- **Add a retry driver**: unnecessary, and would have been a duplicate. One already exists and is
  already running: `runTick()` plus the `onDrainReady` callback wired in `src/commands/server.ts`
  re-attempt a spawn for any agent holding queued messages, on a **5-second** tick, enabled by default
  (`spawnManager.start()` unless `threadline.spawn.drainEnabled === false`). Codey's log proves it live
  — `09:32:28.013Z` and `09:32:33.021Z` both read `[spawn-manager] drain re-attempt for echo not
  approved: Memory pressure too high for new session`, five seconds apart, for this exact agent.

So this change builds no new machinery. It connects a dropped payload to the retry driver that was
already there and already trying, using the `#queueMessage` primitive that was already being called
twice in the same function.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

Each gate remains exactly the authority it already was, with the same threshold, predicate, and verdict.
No detector is added and no blocking logic is introduced. The change makes existing authorities'
denials **non-destructive**, which strengthens the principle rather than bending it: today a guard's
action is externally indistinguishable from a message-eating bug, so an operator cannot tell a working
guard from a broken one by observing it. After this change, a denial means "not now" instead of
"deleted" — the guard becomes legible.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**No new static heuristic at a competing-signals decision point.** No heuristic is added at all. The
two conditionals introduced are `if (request.context)` — a structural presence check on a field, copied
verbatim from the two sibling branches precisely so the four cases cannot drift apart — and the
global-cap marker, which fires on an already-existing comparison rather than introducing a threshold. No
signal is weighed against another.

---

## 5. Interactions

- **Shadowing:** branch order in `evaluate()` is unchanged. Each new `#queueMessage` call runs
  immediately *before* an existing `return`, so nothing that previously ran is now skipped.
- **Double-fire:** no, and this was the sharpest thing to verify. Three independent reasons, in order of
  how load-bearing they are:
  1. **`#drainQueue` is fully synchronous and deletes the map key before returning** (`this.#pendingMessages.delete(agent)`),
     and there is no `await` between the drain and that delete. So two concurrent `evaluate()` calls for
     the same agent — say an inline inbound and the drain loop's own re-attempt interleaving — cannot both
     receive the same entries: the first takes them all, the second sees an empty queue. This is the
     property that makes the restore safe to add at all.
  2. **The cooldown stamp serializes the common case.** `#lastSpawnByAgent.set` happens *before* the spawn
     and is never rolled back, so a second request for the same agent while one is in flight hits the
     cooldown branch and queues rather than racing.
  3. **Restore only runs when the spawn threw**, meaning nothing in that prompt reached a session, so
     putting the payloads back cannot re-deliver work that already arrived.
  `#drainQueue(agent)` is also called on the spawn path only, after every denial branch — so a denial can
  never drain the queue it just wrote to.
  The drain loop's re-attempt is a synthetic request carrying **no** `context` (verified by reading
  `onDrainReady` in `src/commands/server.ts`), so a re-attempt that is itself refused cannot enqueue a
  duplicate of the payload it is trying to deliver — the two no-context control tests pin exactly this.
  And the restore path only runs when `spawnSession` **threw**, meaning nothing in that prompt reached a
  session, so restoring cannot cause a double delivery. A dedicated control test asserts a *successful*
  spawn drains and does **not** restore.
- **Races:** `#pendingMessages` is a plain `Map` mutated from the single-threaded event loop; `runTick`
  guards re-entry with `#tickInflight`. No new shared state and no new mutation ordering: the queueing
  calls happen on paths that already returned without touching anything else.
- **Feedback loops:** none. Queueing cannot affect the pressure reading, the pressure monitor, the
  session count, or the cooldown/penalty state, so no new call can influence its own gate.
- **Failure-attribution and escalation:** `#applyFailureAttribution` still runs first in the catch, and
  `handleDenial`'s escalation is untouched. The restore is additive to the existing failure path.
- **Global cap: bound preserved, and its refusal is no longer silent.** With the restore removed, nothing
  in this change can exceed `DEFAULT_MAX_GLOBAL_QUEUED` (1000) — `#queueMessage` is the only enqueue path
  and it checks the global total first. The change here is that the refusal now sets `#truncated` (see
  §2.1). Per-agent growth stays bounded by `MAX_QUEUED_PER_AGENT` (10), or
  `DEGRADED_MAX_QUEUED_PER_AGENT_DEFAULT` (1) once `isInfraDegraded()` trips after
  `INFRA_FAILURE_THRESHOLD` (5) infra failures in 10 minutes — so a peer that repeatedly fails spawns has
  its queue footprint reduced, not expanded.
- **One consequence of the marker worth naming:** `isTruncated(agent)` will now report true in a case it
  did not before (global-cap refusal). Its only consumer treats it as an advisory "this agent's queue lost
  something" signal, and `#drainQueue` still clears it on the next successful drain, so the new true is
  more accurate rather than newly load-bearing.

---

## 6. External surfaces

- **Other agents on the same machine:** yes, positively and by design — this is the transport that
  carries work between agents. No interface change: `SpawnResult` fields are identical.
- **Install base:** every agent receives it on update. The behavioral delta is strictly "a payload that
  was previously destroyed is now retried," which is why it ships without a flag — there is no
  configuration under which silently deleting an accepted message is the desired behavior.
- **External systems:** none. No Telegram, Slack, GitHub, or network surface.
- **Persistent state:** none. The queue is in-process memory; nothing is written to disk.
- **Timing / runtime conditions:** delivery timing depends on when pressure clears and on the 5-second
  drain tick — outside our control, honestly bounded by the 10-minute TTL (§2.2). No *new* timing
  dependency: the change joins a path that was already scheduled.
- **Operator surface (Mobile-Complete Operator Actions):** **no operator-facing action** is added or
  touched. Queue depth is already observable via `getStatus().queuedMessages` and `getQueuedCount()`,
  and the existing `threadline.spawn.drainEnabled` kill switch is unchanged.

---

## 6b. Operator-surface quality

**No operator surface — not applicable.** No dashboard renderer, approval page, or grant/secret-drop
form is staged in this change.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, with the reason: this queue holds transient inbound payloads for sessions
that will run **in this machine's own process**, gated by **this machine's own** memory reading and
session count. A payload queued on machine A must be delivered by A, because the session that consumes
it is A's. Replicating it would be actively wrong — it would let machine B spawn a session for a message
A accepted, which is exactly the duplicate-session class the pool's ownership rules exist to prevent.

- **User-facing notices:** none — this path emits no user-facing message, so no one-voice gating is
  needed. (The absence of *any* notice on loss is the honest gap recorded in §2.3, tracked as CMT-1111.)
- **Durable state / topic transfer:** none, so nothing can strand on a transfer. A queued payload dies
  with the process — pre-existing behavior, tracked as CMT-1112.
- **Generated URLs:** none.

The pool-wide question ("did a peer's dispatch reach me?") is already answered by a separate
proxied-on-read surface: `GET /threadline/peers/health`, whose `pendingCount` / `stale` fields are how I
first noticed 126 unacked messages to this peer.

---

## 8. Rollback cost

- **Hot-fix release:** revert this commit and ship as the next patch. Behavior returns exactly to
  dropping payloads on those three exits.
- **Data migration:** none. No schema, file, ledger, or config key is introduced.
- **Agent state repair:** none. Nothing to notify or reset; queued entries are in-memory and expire on
  their own within 10 minutes.
- **User visibility:** none during the rollback window. Rolling back restores the previous silent-loss
  behavior; it cannot corrupt state or leave a half-applied condition.
- **Pre-existing kill switch:** an operator who wants the drain machinery off entirely already has
  `threadline.spawn.drainEnabled: false`, unchanged by this work.

Close to the cheapest possible rollback: one revert, no state.

---

## Conclusion

The review did real work three times, and the most valuable pass was the one that took work away.

First it grew the scope correctly: auditing the function's other exits for the decision-point inventory
found the same defect in two more branches.

Then it corrected a claim I would otherwise have shipped. I had planned to describe the fix as "the
payload survives until the peer sends again," because I assumed no retry driver existed. Reading for §3
found `runTick` / `onDrainReady` already wired and started by default, and Codey's own log showed it
re-attempting for this exact agent every five seconds.

Then second-pass review cut the scope back, and this is the part that matters most. My third fix would
have turned a rare lost message into a rare duplicated instruction, because I asserted "the spawn threw
so nothing was delivered" from the shape of `evaluate()` without reading what the injected `spawnSession`
actually does. It creates the live session with the prompt and *then* does work that can throw. I could
not have found that by re-reading my own diff — I had read it several times and thought it was sound —
which is the whole argument for the gate existing.

What ships is smaller than what I built and better evidenced: the two branches that refuse *before* any
spawn is attempted, where non-delivery is structural rather than assumed, plus one line making the last
silent queue-loss path leave a trace. Four honest limits remain, each with a real tracked commitment
(CMT-1111, CMT-1112, CMT-1113, CMT-1114) rather than a good intention.

Clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer (fresh context, no prior involvement in the change)
**Independent read of the artifact: CONCERN RAISED — resolved by cutting scope.**

- **Duplicate delivery via partial-success-then-throw** — CONFIRMED by my own reading of
  `SessionManager.spawnSession` (tmux `new-session` delivers the prompt; `state.saveSession()` runs
  afterwards outside any `try/catch`). The offending code was **removed**, not softened. §1a finding 1;
  tracked CMT-1114.
- **Global-cap refusal is silent, so §2.1's "accounted, marked, capped" was inaccurate** — CONFIRMED
  (`return false` precedes all marker logic; all callsites discard the boolean). **Code changed so the
  claim is true**, rather than the claim changed to match the code. §1a finding 2.
- **Restored-entries-truncated-first** — non-blocking, now moot with the restore removed.
- Categories the reviewer cleared: TTL preservation, drain-move ordering, and three specific artifact
  claims it checked independently.

I verified both findings against the source myself before accepting them rather than taking the review on
trust; the blocking one reproduces in the code as described.

## Evidence pointers

- **Live repro, three destroyed dispatches:** `instar-codey/logs/server.log` at `19:45:23.541Z`,
  `23:18:33.406Z`, `23:20:35.503Z` — each `handled:true` carrying
  `error: "Spawn denied: Memory pressure too high for new session"`, each returning
  `{"delivered":true,"outcome":"accepted"}` to the sender.
- **Denial volume:** 40 matches for `Spawn denied: Memory pressure` in that log for 2026-07-29.
- **Retry driver proven live:** same log, `09:32:28.013Z` and `09:32:33.021Z` —
  `[spawn-manager] drain re-attempt for echo not approved: …`, five seconds apart. Tick confirmed
  `tick=5000ms` at `[spawn-manager] drain loop started`.
- **Pressure genuinely high (threshold not miscalibrated):** `vm.swapusage` 16385 MB used of 17408 MB
  (94%); `Pages occupied by compressor` 467843 × 16 KB ≈ 7.3 GB; total RSS across 427 processes 7.9 GB
  on 16 GB of RAM; ~67 MB safely reclaimable.
- **Negative control run BEFORE trusting the tests, and re-run after the scope cut:** with
  `src/messaging/SpawnRequestManager.ts` stashed to original, **5 of the new tests FAIL (5 failed / 78
  passed)**; the two pure no-context controls PASS on both old and new code, proving they discriminate
  rather than merely agreeing with whatever is in front of them. With the fix restored: **83/83 pass**.
- **Wider runs, all green:** `spawn-request-manager` + `subscription-quota-gates` +
  `threadline/ThreadlineRouter` + `SpawnAdmission`; `threadline-fixes` + `NovelFailureReviewer`.
- `npx tsc --noEmit` exits 0; `npm run lint` (33-lint chain) passes.
- **The running copy provably has the defect:** both agents' installed
  `dist/messaging/SpawnRequestManager.js` shows the memory-pressure branch returning with no enqueue —
  so this is a live defect in deployed code, not a source-only observation.

---

## Class-Closure Declaration (display-only mirror)

**No agent-authored-artifact defect — not applicable.** This is a defect in hand-written TypeScript, not
in an LLM prompt, hook, config, skill, or standards text. It also adds no self-triggered controller: the
retry driver it feeds (`runTick` / `onDrainReady`) already exists, is already bounded by DRR quantum,
`maxDrainsPerTick`, per-agent and global queue caps, and a 10-minute entry TTL, and is not modified here.
No new firing edge is added: the two queueing calls sit on paths that already returned a denial, and
neither can extend an entry's lifetime.

For the record, the defect's *shape* is the one this project has spent the week cataloguing — an
operation that fails and reports success. The guard that would generalize it does not exist: a rule that
a transient-pressure refusal must never destroy the payload it refused. Three of six branches in one
function had it wrong, and nothing in the repo would have caught any of them. That standards gap is
tracked, not closed here. <!-- tracked: CMT-1113 -->
