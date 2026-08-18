---
title: "Closeout activeness bypass on a confirmed move (a busy duplicate must not be unreapable)"
slug: "closeout-activeness-bypass-confirmed-move"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions. A duplicate session on a machine that provably does not own the conversation is wrong PRECISELY WHILE it is busy; a guard that reads 'busy' as 'protect' makes the wrongness self-perpetuating."
parent-spec: "docs/specs/post-transfer-closeout-correctness.md (Part E — the narrow-bypass precedent this extends)"
status: draft
author: Echo
date: 2026-08-17
risk-class: safety-critical (the changed decision terminates a LIVE local session); mitigated by reusing the already-reviewed confirmed-move + freshest-interaction preconditions verbatim, lifting ONLY the two positive-evidence activeness reasons (never the uncertainty reason), and leaving every intent-bearing guard vetoing
eli16-overview: "docs/specs/closeout-activeness-bypass-confirmed-move.eli16.md"
lessons-engaged:
  - "P2 Signal vs Authority — this adds NO new detector and NO new authority. It widens one already-authorized bypass set inside an existing guarded terminate call; the kill still routes through `SessionManager.terminateSession` and every non-bypassed KEEP-guard still vetoes."
  - "P10 Comprehensive-First / No Deferrals — the first-draft fix (lift `active-process` alone) was verified INSUFFICIENT against the real guard cascade before writing code; the cascade's next activeness reason is handled in the same change rather than deferred to a follow-up outage, and the uncertainty reason is excluded by name rather than swept in."
  - "Close the Loop — the residual (why the non-owner spawns at all) is NOT silently dropped; it is registered as a beacon-enabled commitment (CMT-2027) with a dated re-surfacing cadence, not a bare marker."
---

# Closeout activeness bypass on a confirmed move

## Terminology

**"Activeness"** in this spec means *process-liveness evidence* — the guard cascade's positive
observations that something is executing inside the session (a non-baseline child process, or the
main process showing CPU/IO movement). It is deliberately distinct from *intent* evidence (an open
commitment, a live subagent, a structural build) and from *uncertainty* (inspection failed).

Other local terms used here, defined once:

- **KEEP-guard / the cascade** — the ordered list of named reasons never to end a session, evaluated
  top-down in `ReapGuard`; the first non-bypassed reason that matches vetoes the kill.
- **`structural-long-work`** — the keep-reason for a build or autonomous run in progress on the
  topic or project.
- **The closeout** — the reaper's post-transfer sweep that closes a session whose conversation is
  owned by another machine.
- **P19 breaker** — this project's convention that a repeated failing action must give up loudly
  rather than retry forever; here, after N vetoed closeout attempts it stops and raises one operator
  notice.
- **The binding-verdict seam (`SpawnAdmission`)** — the checkpoint that makes the router's ownership
  verdict binding at every session-creating callsite, so a routing decision and a spawn cannot
  disagree.

## Problem (verified live, 2026-08-17, operator-reported)

Telegram topic 46473 is hard-pinned by the operator to the **Laptop**, `pinState: actuated`.
Both machines agree on the owner. Despite that, the **Mac Mini** twice held a live session for
that topic, answering the same operator message the Laptop was answering.

The mesh detected this correctly and could not act on it. From the Mini's own records:

- `DuplicateSessionReconciler` decided `owner:m_cc2ec…(hard-pin)`, rule `pin-store hard pin`,
  `dryRun:false` — three times on 2026-08-17 (19:11Z, 19:16Z, 22:10Z).
- The post-transfer closeout then fired against the correct session with the correct reason and
  was **refused by the guard**. Reap-log, verbatim:

```
{"ts":"2026-08-17T19:15:47.277Z","type":"skipped",
 "session":"🛠 Instar Dev Fixes (laptop)",
 "reason":"topic moved to Laptop — closing the leftover session on this machine (post-transfer closeout)",
 "disposition":"skipped:active-process","skipped":"active-process",
 "machine":"m_4cbc0d4a0c557cf7e221882f9b42518f"}
```

- Both episodes ended only via `reaped … "reason":"operator-kill"` — a human (19:19:01Z) and then
  this agent by hand (22:12:42Z). **Nothing in the system can close it.**

### Why it is self-perpetuating

`ReapGuard.evaluate()` returns `keep('active-process')` for any session with a non-baseline child
(`src/core/ReapGuard.ts` ~line 207). A duplicate session has a non-baseline child *because it is
answering the user*. So the more actively wrong the duplicate is, the more protected it is. The
existing closeout accepts that: `post-transfer-session-closeout.md` chose "a KEEP-guard veto is
audited and retried next tick — eventual closeout, never a forced kill", and named this exact hole
in its own text ("an `active-process` veto keeps a busy duplicate alive precisely BECAUSE it is
doing duplicate work"). The retry is bounded by `topicMovedVetoBreakerAttempts` (default 5), after
which the P19 breaker opens, raises one attention item, and **stops trying** — a permanent duplicate
awaiting a human.

### Why the obvious one-line fix is insufficient

`SessionReaper.#attemptCloseoutTerminate` already passes `bypassRecentUserMessageForConfirmedMove`
on a liveness-confirmed move (`src/monitoring/SessionReaper.ts` ~line 918). The tempting fix is to
add `bypassActiveProcessKeep: true` beside it. **That does not close the duplicate.** The bypass
mechanism (`SessionManager.ts` ~line 1451) skips a bypassed reason and *continues down the
cascade* — and immediately below `active-process` sit two more positive-evidence guards:

```
if (hasActiveProcesses(...))            → keep('active-process')
if (mainProcessActive(...) === undefined) → keep('process-uninspectable', 'low')
else if (mainProcessActive(...) === true)  → keep('main-process-active')
```

A busy duplicate's main process is burning CPU, so lifting `active-process` alone re-vetoes as
`main-process-active`. The wall moves; the duplicate survives. This was checked against the real
cascade before any code was written.

## Decision

Add **one** narrow, named bypass that lifts the **two POSITIVE-evidence activeness reasons** —
`active-process` and `main-process-active` — and nothing else.

**It is NOT a boolean.** Two consecutive review rounds objected that a bare flag is too
authority-dense for a kill path: it asserts "four preconditions held" while carrying no evidence
that they did, and nothing at the authority can tell a correct caller from a wrong one. Defending
the boolean a third time would be the exact failure this project has learned to distrust — a
recurring objection is a signal to remove the mechanism, not to argue it better. So the option
carries its own evidence:

```ts
bypassActivenessForConfirmedMove?: {
  ownerMachineId: string;            // the remote owner the record named
  selfMachineId: string;             // this machine, as the caller believes it to be
  reachableAt: number;               // the liveness proof this decision rested on
  lastUserMessageAt: number | null;  // the freshness value compared against it
  dwellTicks: number;                // confirmations accumulated before deciding
  requiredConfirmTicks: number;      // the dwell threshold in force at decision time
  expiresAt: number;                 // reaper-stamped; the authority refuses a stale assertion
};
```

**Read the boundary first, so the table below is not over-credited.** AUTHORIZATION for this bypass
rests entirely on the existing capability boundary: the option lives only on
`SessionTerminateAuthorityOptions`, the birth-bound closure minted during `SessionManager`
construction, and the public `terminateSession` copies inert fields only. A caller outside that
closure cannot request the bypass at all. The evidence object does NOT authenticate anyone — it is
freshness and audit hardening on top of a boundary that already decides who may ask.

Within that boundary, `SessionManager` cannot query the ownership registry or topic state — that
coupling is genuinely unwanted on the kill path — but it CAN validate the assertion's shape,
internal consistency against trusted local identity, and freshness, and it does. The bypass is
granted only if ALL hold:

| Check at the authority | What refusal prevents |
|---|---|
| the object is present and every field is the declared type | a malformed assertion silently lifting a guard |
| the machine's OWN identity is known (`actualLocalMachineId`) | granting a bypass on pure self-report when there is nothing to compare against |
| `selfMachineId === actualLocalMachineId` | an assertion built for, or replayed onto, a different machine |
| `ownerMachineId !== actualLocalMachineId` | **a machine bypassing on evidence that names IT as the owner** |
| `lastUserMessageAt === null` or `lastUserMessageAt <= reachableAt` | the freshest-interaction invariant being trusted rather than re-checked |
| `dwellTicks >= requiredConfirmTicks` (and `requiredConfirmTicks >= 1`) | a kill decided on less dwell than the policy in force required |
| `now <= expiresAt` | a stale or replayed assertion acting on old evidence |

Any failure → **no bypass** (the ordinary guards veto — fail toward not killing), and the refusal is
recorded with the failing check named.

**The identity checks compare against the machine's own identity, not against the assertion's other
field — and that distinction is the whole point.** A previous draft of this spec checked only
`ownerMachineId !== selfMachineId`, both caller-supplied, and claimed that made a self-owned bypass
"structurally impossible". It did not: a caller running ON the owner machine could pass
`{ ownerMachineId: 'other', selfMachineId: 'not-this-machine' }` and sail through. That claim was
wrong and is withdrawn. Comparing BOTH fields against `actualLocalMachineId` is what actually closes
it, and an unknown local identity fails CLOSED rather than trusting the claim.

With that correction the rollback trigger stops being a rule someone must remember to audit for and
becomes a condition the authority refuses. Structure over willpower, applied to this spec's own
safety rule — but only because the check now rests on something the caller cannot choose.

**Honest scope of the dwell check.** `requiredConfirmTicks` is carried BY the assertion, so the
authority verifies internal consistency ("this decision met the threshold it says was in force"),
not the threshold itself. The threshold remains the reaper's policy. That is a genuine limit of what
an authority without registry access can verify, and it is stated rather than dressed up as an
independent check.

**What provenance actually rests on — stated precisely, because the validation alone does not carry
it.** The checks above catch a *malformed or internally inconsistent* assertion and a *wrong-machine*
one. They do NOT prove the assertion came from the reaper: a caller able to invoke the authority
could fabricate a plausible owner id, fresh timestamps and sufficient dwell. What prevents that is
not the validation, it is the **existing capability boundary**: `bypassActivenessForConfirmedMove`
lives only on `SessionTerminateAuthorityOptions`, the birth-bound closure minted during
`SessionManager` construction and handed into the boot composition root's lexical scope. The public
`terminateSession` copies only inert fields and never spreads the caller object, so ordinary callers
cannot reach the option at all — the same boundary already protecting `localPostTransferCloseout`
and `bypassRecentUserMessageForConfirmedMove`.

**Who can actually reach the option (the inventory, since the boundary is the safety story).** The
birth-bound `SessionTerminateAuthority` closure is minted once during `SessionManager` construction
and handed to the boot composition root's lexical scope; there is no later getter or binder. From
there it is passed to exactly the components wired at boot that need kill authority — the
`SessionReaper`'s `terminate` dep is the one that forwards this option, and `server.ts` is the only
place that forwards it (it names the field explicitly rather than spreading the caller object, so a
new option cannot ride in unnoticed). Every other caller reaches sessions through the PUBLIC
`terminateSession`, which copies inert fields only. Tests 6 and 8 pin both halves: the public path
cannot carry the option, and no callsite may set it outside the confirmed-move closeout context. A
future internal caller wanting this bypass must therefore add a forwarding line in `server.ts` and
break test 8 — visible in review rather than silent.

So, crisply: **the evidence object is an auditable, freshness-checked ASSERTION — not a proof of
provenance.** It buys three things (a decision recorded with the evidence it rested on; refusal of
stale/replayed calls; refusal of wrong-machine calls) and does not buy authentication of the caller.
Authentication is the closure's job and always was. The accurate claim is: *a caller outside the
birth-bound closure cannot request this bypass, and a caller inside it cannot request it on evidence
that is malformed, stale, or names the wrong machine.* It is NOT "misuse cannot construct evidence
that passes" — an earlier draft said that and it was too strong. Introducing a branded/private-factory token beyond the existing closure was
considered and rejected: it would add a second capability mechanism alongside one that already
governs this exact path, without changing who can reach it.

When every check passes:

```ts
bypassedReasons.push('active-process', 'main-process-active');
```

### `process-uninspectable` is deliberately NOT in the set

An earlier draft of this spec bundled `process-uninspectable` into the same "activeness family".
That was wrong, and the correction is the substantive one this review produced. That reason fires on
`mainProcessActive(...) === undefined` — the inspection **failed**. It is UNCERTAINTY, not evidence
of activity, and the guard itself marks it `confidence: 'low'` for exactly that reason. The argument
this spec makes ("busy is the symptom of duplication, not work worth protecting") is an argument
about a session we can SEE is busy; it says nothing about a session we cannot see at all, and
extending it there would be the "a check that can't tell 'no' from 'couldn't tell'" failure this
codebase has hit repeatedly.

So when the main process cannot be inspected, the closeout **withholds** — the duplicate survives
that tick, the veto is audited as `skipped:process-uninspectable`, the dwell retries, and the P19
breaker escalates to the operator if it persists. That is a real, named limitation of this spec, not
an oversight: an uninspectable duplicate is still not auto-closable. Fail toward not killing.

`SessionReaper.#attemptCloseoutTerminate` passes it **under the identical precondition that already
governs the recent-message bypass** — no new predicate is introduced:

```ts
const res = await this.#deps.terminate(session.id, reason, bypassRecentForMove
  ? { bypassRecentUserMessageForConfirmedMove: true,
      bypassActivenessForConfirmedMove: {
        ownerMachineId, selfMachineId, reachableAt, lastUserMessageAt,
        dwellTicks: count,
        requiredConfirmTicks: this.cfg.topicMovedConfirmTicks,
        expiresAt: now + CONFIRMED_MOVE_ASSERTION_TTL_MS,
      },
      workEvidence: [], localPostTransferCloseout: true }
  : { localPostTransferCloseout: true });
```

### The precondition, restated (all four must hold)

1. The topic is owned by **another** machine (ownership registry), and
2. `closeoutLivenessGate` **confirmed** the remote owner holds a live session for it
   (`confirmedMove === true` — the stale and `unknown` readings still WITHHOLD and never reach
   `terminate`), and
3. the local topic's freshest user message is **older** than the `reachableAt` that backed that
   confirmation (the Part E freshest-interaction veto — if the user just typed to the LOCAL
   session, no bypass is granted and the ordinary guards veto), and
4. the confirm dwell (`topicMovedConfirmTicks`, default 2) has elapsed.

### The check-to-kill window (TOCTOU), stated rather than assumed away

The four preconditions are evaluated by the **reaper**; the kill is performed by the **authority**,
which re-evaluates the KEEP-guards but NOT ownership, liveness, or message freshness. So a bare
boolean carries a decision made microseconds earlier. This shape is inherited — the existing
`bypassRecentUserMessageForConfirmedMove` is exactly the same — but the activeness bypass raises the
stakes (it ends live compute), so the window is characterised here instead of relied upon.

- **The invariant, not a duration.** Earlier drafts called this window "sub-millisecond". That was
  a measurement claim the spec cannot support: synchronous JavaScript can still be delayed by CPU
  work, and a refactor can widen it silently. The claim is withdrawn and replaced by the property
  that is actually enforceable: **the freshness read and the `terminate` call occur in the same call
  stack with no async yield between them**, and the assertion carries an explicit
  `CONFIRMED_MOVE_ASSERTION_TTL_MS` (30 s) that the authority enforces regardless of how long the
  path actually took. Test 12 pins the no-yield invariant; the TTL bounds the damage if it is ever
  broken. Risk is bounded by the TTL, never by an assumed duration.
- **What re-validates inside it.** The authority re-runs the full guard cascade at kill time. A user
  message that arrived in the window and is queued for delivery trips **`pending-injection`**, which
  is NOT bypassed and vetoes the kill. That is the specific guard covering the specific race, and it
  is re-read fresh rather than inherited.
- **The residual, honestly.** A message that arrived and was already injected in the window would
  set `recent-user-message`, which IS bypassed on this path — so it would not veto. The exposure is
  therefore "a message both arrived AND completed injection inside the same-call-stack window,
  immediately after a 4-minute dwell". Bounded by the no-yield invariant and the TTL, never by an
  asserted duration. Real, not zero, and not closed by this spec.
- **What the evidence object adds.** The assertion carries `expiresAt`
  (`CONFIRMED_MOVE_ASSERTION_TTL_MS`, a code constant — never config, per the safety-bounds-in-code
  precedent). A call delayed or replayed past it is refused, so the window is bounded by a value the
  authority enforces rather than by an assumption about call latency. The authority also re-checks
  the freshness invariant from the evidence itself, so an assertion internally inconsistent with its
  own preconditions cannot lift a guard.
- **What it deliberately does NOT add.** The authority still does not re-query ownership or topic
  state; that would import the ownership registry and topic-message state into the kill path to
  close a same-call-stack window whose realistic worst case is one lost turn on a session that
  resumes with its conversation intact. The evidence is validated, not re-derived — and a
  re-derivation would itself be a snapshot taken microseconds later, so it buys less than it looks.

### Why that precondition is sufficient for THIS action (not merely inherited)

The parent spec's precondition was designed to lift `recent-user-message`. Lifting *process
activeness* is a strictly stronger action — it ends live compute — so reusing the precondition has
to be argued, not asserted by analogy. The argument, stated so it can be attacked:

1. **What the precondition actually proves.** `confirmedMove` proves another machine holds a live
   session for this conversation. The freshness veto proves the user has not addressed the local
   session since that proof. Together they establish that *the canonical worker for this
   conversation is elsewhere, and the local session is not currently the user's interlocutor.*
2. **What the local compute therefore is.** A topic-bound session's work product is a reply into
   that topic. Two live sessions on one topic both deliver into it — that is the observed harm
   (the operator received two answers). So local compute here is not merely redundant, it is
   actively harmful output, and letting it finish is not a neutral cost.
3. **What is NOT proven — and what covers it.** The precondition does NOT prove the local session
   holds nothing of value. Three categories could: live subagents, an active build/autonomous run,
   and an open commitment. **All three retain their vetoes** — they are deliberately outside the
   bypass, so the valuable-work case is protected by name rather than by the accident of a busy
   process tree.
4. **The residual, stated without overclaiming.** What remains is local compute that has no
   subagent, no structural long-work, no open commitment, and no user message since the liveness
   proof. The **conversation** is recoverable: it is preserved and resumes via `claude --resume`,
   the close is announced by the existing reap-notify path, and a mid-work close is queued by the
   mid-work resume queue.

   **In-flight tool side effects are NOT transactional, and this spec does not claim otherwise.**
   A session killed mid-tool-call can leave partial external state — a half-written file, an
   interrupted push, an external API call whose request was sent but whose result is unrecorded.
   The guards cover the *structured* cases by name (subagents, builds/autonomous runs, open
   commitments); they do **not** cover an ordinary in-flight tool call, and no guard in this
   codebase does. That is a real cost of this change, not a modelled-away one.

   Three things bound it, and none of them is "it can't happen":
   - **The dwell.** The closeout fires only after `topicMovedConfirmTicks` (default 2, ~4 min) of
     sustained confirmation, so this is never an instant kill on a momentary overlap.
   - **The side effects being interrupted are UNSANCTIONED side effects — but not necessarily
     identical ones.** This session is, by the precondition, the non-owner copy of a conversation
     whose canonical worker is elsewhere, so its writes are writes nobody asked this machine to
     make. An earlier draft went further and called them "duplicate" side effects, framing the
     choice as *partial duplicate vs. completed duplicate*. **That was wrong and is withdrawn:**
     two sessions answering the same message can diverge — different tools, different files,
     different external calls — so the interrupted work may be unique rather than redundant, and a
     partial unique side effect can be materially worse than a completed one. The honest statement
     is that this change can interrupt work that no other session will finish or repair.
   - **SOME partial state is diagnosable — and much of it is not.** Destructive git and filesystem
     operations funnel through `SafeGitExecutor` / `SafeFsExecutor`, which maintain audit trails, so
     a kill landing mid-operation there leaves a record to reason from. That covers git and fs and
     **nothing else**: an arbitrary shell command, a package manager, a cloud CLI, a webhook, a
     database write, or any external API call is NOT funnelled and leaves no such trail. An earlier
     draft implied the audit trails bounded the residual generally; they do not, and the honest
     statement is that a kill can leave unaudited partial external state.

   The alternative — leaving it — is not "safe": it is the status quo in which the operator gets
   two answers, the duplicate keeps producing duplicate side effects for as long as it lives, and
   only a human kill ends it.

Only then is "this session is busy" reinterpreted as *evidence of duplicated work* rather than
*work worth protecting*.

### What still vetoes (unchanged)

`protected`, `spawn-grace`, `recovery-in-flight`, `pending-injection`, `relay-lease`,
`open-commitment`, `active-subagent`, `structural-long-work` — plus the lease gate, the protected
set and the CAS. In particular **`active-subagent` and `structural-long-work` are deliberately NOT
bypassed**: a duplicate holding live subagents or an active build/autonomous run represents real
work whose loss is not obviously cheaper than the duplication, so that case keeps its existing
behavior — veto, audit, and escalate through the P19 breaker to a human. This spec narrows the
"unreapable forever" class; it does not eliminate every member of it, and says so.

## The amplification risk (shipping a cleanup for a cause we do not yet understand)

This spec makes a duplicate easier to kill while the reason duplicates get CREATED is still open.
That ordering deserves to be stated plainly rather than buried in the residual note, because the
objection is real: if the upstream ownership/routing evidence is wrong in some not-yet-understood
way, this change acts on that wrongness faster and more forcefully than before.

**Why the risk is bounded rather than open-ended.** The bypass changes nothing about WHICH session
is selected — selection is entirely upstream (ownership record + liveness confirmation + dwell), and
is unchanged by this spec. It changes only whether a session already selected as the loser may be
closed while busy. So a wrong *selection* was already capable of killing an idle session before this
change; the new exposure is precisely "a wrong selection can now also kill a BUSY session." That is
a real widening and is not dismissed — but it is a widening of an existing decision's reach, not a
new decision.

**Why waiting for the creation fix is the worse trade.** The failure this spec addresses is
happening now, is operator-visible (two answers to one message), and currently has no resolution
other than a human noticing and killing a session by hand. Holding the cleanup until the creation
cause is understood leaves the *only* automatic remedy disabled for an unbounded period — and the
creation-side investigation may take a while precisely because its decisive evidence was
unreadable. A cleanup that works is also the thing that keeps the incident survivable while the
cause is chased.

**What bounds it in practice:** the `bypassedReasons` audit field above makes every use of the new
authority countable; the named rollback trigger fires on the specific shape a wrong selection would
produce; and the whole path stays behind the existing `closeoutLivenessGate` and
`topicMovedCloseout` switches, either of which restores today's behaviour without a deploy.

## Rejected alternatives

### 1. "Fix the spawn fence instead; don't touch the reaper"

The structurally cleaner fix for duplicate sessions is an admission fence: never START a session for
a conversation this machine does not own. Instar HAS that fence (`SpawnAdmission`, the binding-verdict
seam), it was in `enforce` mode on the machine that duplicated, and it admitted anyway. So the
argument "just fence the spawn" is not a hypothetical better design — it is a shipped design that
did not hold on 2026-08-17.

Why the fence alone is not sufficient even once repaired:

- **A fence prevents; it does not remediate.** Any duplicate that exists for any reason — a fence
  bug, a split-brain window, a manual spawn, a version-skewed peer running older admission code —
  needs a cleanup path. Today that path is defeated by the very busyness that makes the duplicate
  harmful, which means the system has prevention and no remedy.
- **It is unavailable right now.** The fence's failure mode is not yet understood (see *Residual*);
  its decisive evidence was unreadable. Gating the cleanup on that investigation leaves the only
  automatic remedy disabled for an unbounded period.
- **They are complements, not substitutes.** Prevention reduces frequency; remediation bounds
  duration. This spec is the remediation half and says so; CMT-2027 carries the prevention half.

**CMT-2027 acceptance criteria** (so the prevention half cannot close vacuously): identify why
`SpawnAdmission` returned the `router-consumed` allow arm for a topic hard-pinned to another
machine; state whether that arm should consult ownership (as the `queued`/`placement-blocked` arm's
`livePinnedRespawnOwner` check already does) or whether the router's verdict was itself wrong; and
land either a fix or a written finding that the arm is correct and the fault lies upstream.

### 2. Quiesce before kill (graceful cancellation)

The lifecycle-correct answer to "stop a duplicate worker" is not termination, it is **quiescence**:
tell the losing session to stop starting new tool calls and stop emitting user-visible output, let
in-flight work drain for a bounded grace period, then terminate only if it is still busy. That
separates the two things this spec currently conflates — *stop producing duplicate output* (urgent,
safe) and *end the process* (not urgent, not safe). It would also dissolve the side-effect residual
above almost entirely.

It is rejected **for this change**, on mechanism rather than on merit:

- **No such channel exists.** There is no supported way to tell a running claude-code session "stop
  emitting, finish what you hold". Building one means a new in-session control path plus a
  drain-state the reaper can observe — a new subsystem on the session-lifecycle critical path, not
  an option on an existing call.
- **It would be a new decision point with real authority**, requiring its own convergence, its own
  floors, and its own failure analysis (what if quiesce is ignored? what bounds the grace? what if
  the session quiesces and the owner then dies?). That is a larger and genuinely riskier change than
  the one this spec makes.
- **The harm it would reduce is not the harm that is happening.** The observed, repeated failure is
  a duplicate that cannot be closed AT ALL, for hours, until a human intervenes. A bounded bypass
  makes it closable. Quiesce would make closing it *gentler* — valuable, and strictly downstream of
  being able to close it in the first place.

This is a design worth building, not a deferral of this one's scope, and it is deliberately NOT
folded into the spawn-prevention item — otherwise it disappears the moment the cleanup starts
working. It has its OWN beacon-enabled commitment, **CMT-2028**, whose acceptance criteria are:
either the control channel + bounded drain + observable drain-state ship, or a written finding that
it is infeasible with the reason stated.
<!-- tracked: CMT-2028 -->

### 3. An outbound OUTPUT fence instead of a kill

The observed harm is "two answers to one message". A narrower instrument targets exactly that:
refuse or quarantine user-visible OUTPUT from a session whose conversation this machine does not
own, at the outbound messaging authority, and let the process drain or be reaped later on ordinary
idleness. No in-session control channel is needed, because the fence sits on the path the output
already takes.

This is a genuinely good idea and it is NOT dismissed — but it does not replace this change:

- **It fences replies, not side effects.** A duplicate that pushes a branch, writes files, or calls
  an external API does so without producing a user-visible message. The fence would leave every one
  of those unfenced while making the duplication invisible — arguably worse, because the operator
  would stop seeing the symptom that reveals it.
- **It does not reclaim the machine.** The 2026-08-17 duplicate ran for hours; a fence would have
  let it keep running indefinitely, consuming an LLM account's quota and a machine's CPU on work
  nobody would ever read.
- **It is a new decision point with real authority** on the outbound path (refusing user-visible
  output is not a small guarantee to change), so it needs its own convergence rather than riding
  this one.

Where it genuinely wins is as the FIRST rung of the quiesce work: it is materially simpler than an
in-session control channel and buys the "stop producing duplicate output" half immediately. It is
therefore folded into CMT-2028's scope as the preferred first increment, rather than left as a
comment here.

### 4. `origin: 'operator'` on the closeout terminate It is a HEAVY bypass that skips `protected`,
the lease gate and the entire KEEP-guard cascade (`SessionManager.ts` ~1006-1072) — it would also
blow past `active-subagent`, `structural-long-work` and `open-commitment`. Rejected for the same
reason `post-transfer-closeout-correctness.md` rejected it for Part E: the correct instrument is a
named, minimal bypass, not an authority escalation.

## Decision points touched

One decision point is MODIFIED; none is added.

| Decision point | Classification | Justification |
|---|---|---|
| "May the post-transfer closeout terminate this local session?" (`SessionManager.terminateSession` KEEP-guard cascade, as reached from `SessionReaper.#attemptCloseoutTerminate`) | **invariant** | Deterministic by design and deliberately so. The point is an enumerable-domain safety floor: a fixed, ordered list of named keep-reasons, each a boolean predicate over local state, with `protected` first and never bypassable. This change does not introduce competing signals to weigh — it moves TWO already-enumerated reasons (`active-process` and `main-process-active`, never the uncertainty reason `process-uninspectable`) from "always vetoes" to "does not veto under four already-reviewed, already-deterministic preconditions". There is no ambiguity for an arbiter to resolve: each precondition is a boolean the system already computes (`ownerElsewhere`, `confirmedMove`, `lastUserMsgAt <= reachableAt`, dwell ≥ `topicMovedConfirmTicks`). Making it a judgment-candidate would replace a bounded, auditable floor with an LLM call on a session-kill path — strictly worse on both safety and latency. |

The *judgment* in this area (which duplicate should win) already lives upstream in
`DuplicateSessionReconciler`'s evidence ladder and is unchanged here; this spec only lets the
mechanical closeout act on a conclusion that layer has already reached.

## Multi-machine posture (Cross-Machine Coherence)

**No new feature or state surface is introduced, so there is no new posture to declare.** This
change adds one internal, evidence-bearing option to an existing in-process function call and widens
an existing bypass set. It persists nothing, reads no new state, exposes no route, emits no notice, and
generates no URL.

The behaviour it modifies is `unified` in the sense the standard cares about: the closeout's
*evidence* — the ownership record and the remote owner's liveness snapshot — is already
cross-machine, already replicated, and already reviewed under the parent spec
(`post-transfer-closeout-correctness.md`). Every machine in the pool runs identical POLICY over that shared ownership/liveness evidence.
Outcomes can still differ per machine, and that is correct rather than a divergence defect: the
remaining KEEP-guards (`active-subagent`, `structural-long-work`, `pending-injection`,
`relay-lease`, `process-uninspectable`) are predicates over LOCAL session state, so one machine may
close while another withholds because their local sessions genuinely differ. The policy is unified;
the local facts it is applied to are not, by construction.

The *execution* is necessarily performed by the machine holding the session — a process on one
machine's disk can only be terminated by that machine. That is a property of process control, not a
declared machine-local data posture, and it is unchanged by this spec (the closeout already worked
this way).

Single-machine installs and dark pools are strictly inert: `topicOwnerElsewhere` returns null, the
closeout block never runs, and the new option is never constructed.

## Open questions

*(none)* — the one unresolved matter (why the non-owner machine spawns the duplicate) is out of
this spec's scope, is recorded under **Residual — NOT fixed here** with a tracked marker, and is
not a decision parked on the user: it needs further investigation by the agent, not an answer from
the operator. This spec is completable in a single run without stopping to ask.

## Frontloaded Decisions

1. **Bypass BOTH positive-evidence activeness reasons, and only those.** Verified against the real
   guard cascade: lifting `active-process` alone re-vetoes as `main-process-active`. Decided before
   writing code; a test pins it. `process-uninspectable` is excluded — it is uncertainty, not
   activity — and a second test pins that exclusion so a later simplification cannot quietly widen
   the set.
2. **Reuse the existing confirmed-move precondition verbatim rather than inventing a new one.**
   No new predicate, no new config knob, no new tuning surface — the change rides preconditions
   that already passed review under the parent spec.
3. **Do NOT bypass `active-subagent` / `structural-long-work`.** A duplicate holding live subagents
   or an active build represents work whose loss is not obviously cheaper than the duplication;
   that case keeps today's behaviour (veto → audit → P19 breaker → one attention item to the
   operator). Stated as a deliberate limit rather than left implicit.
4. **Record the bypass in the audit rather than inferring it from an absence.** The successful
   `reaped` row names the lifted reasons, so over-application is countable instead of looking
   identical to the fix working.
5. **Ship the cleanup before the creation-side cause is known.** Argued in *The amplification
   risk*: the harm is live and currently has no automatic remedy, and the bypass widens an existing
   decision's reach rather than adding a new decision.
6. **The assertion is a validated evidence object, not a boolean.** Raised by two consecutive
   review rounds; a third defence would have been the recurring-objection failure. The authority
   validates shape, internal consistency and freshness, which makes the primary rollback condition
   structurally unreachable rather than a rule to remember.
7. **No new config knob.** The assertion TTL is a CODE constant, not config — a safety bound in
   config is a safety bound an emergency edit can silently remove. Rollback rides the existing
   `closeoutLivenessGate` and
   `topicMovedCloseout` switches plus a plain revert. A new knob would be a new safety bound an
   emergency edit could silently remove.

## Observability

No new log stream, but ONE new audit field. The existing closeout audit distinguishes:

- success → `reaped` with `rule: 'topic-moved-away'`, `confirmedMove: true`, `snapshotReachableAt`
- veto → `reap-skipped-topic-moved` with `skipped: <reason>` (the field that proved this bug)
- give-up → `closeout-breaker-open` + one attention item

**New: the successful `reaped` row records the DECISION, not just the outcome** —
`bypassedReasons` (the exact set lifted), plus the evidence the decision rested on:
`ownerMachineId` (the remote owner the record named), `selfMachineId`, `snapshotReachableAt` (the
liveness proof), `lastUserMessageAt` (the freshness value compared against it), and `dwellTicks`.

Recording only `bypassedReasons` would leave the rollback trigger below unusable: it names a
condition ("a bypassed close on a topic whose owner record named THIS machine") that cannot be
evaluated after the fact from mutable external state. The row must carry its own evidence or the
trigger is a rule nobody can check — the same "a check that can't tell" fault in audit clothing.

This is not decoration. "`skipped:active-process` disappeared" is a symptom shared by two very
different outcomes: the bypass working, and the bypass being over-applied to sessions that were
never duplicates. Without recording which kills used the bypass, those are indistinguishable in the
audit — the same "a check that can't tell success from failure" fault this spec exists to fix. With
the field, over-application is directly countable: `reaped` rows carrying `bypassedReasons` should
be rare, always carry `confirmedMove: true`, and always correspond to a topic the ownership record
says is owned elsewhere.

**The rollback trigger, operationally defined** (a trigger nobody can evaluate is not a trigger):

- **Primary — refused at the authority, on the ASSERTION.** The trusted-identity checks
  (`selfMachineId === actualLocalMachineId` AND `ownerMachineId !== actualLocalMachineId`) refuse
  any bypass whose *assertion* names this machine as the owner. Note precisely what that is and is
  not: the authority does NOT re-read the ownership record, so it refuses "the assertion says this
  machine owns it", not "the record says so". The reaper reads the record and stamps the assertion
  from it, so the two coincide unless the reaper is wrong — which is exactly the case the audit is
  for. The `reaped` row carries both machine ids from the validated assertion, so the condition is
  evaluable from the row itself. If such a row EVER appears, the validation is broken: revert
  immediately.
- **Interrupted-work trigger (the side-effect residual's own criterion).** Revert if ANY
  activeness-bypassed close is followed by an operator report of lost or half-completed work on that
  topic, or if a `reaped` row carrying `confirmedMoveEvidence` is followed within an hour by a
  failed/partial external operation traceable to that session. **This trigger is explicitly
  BEST-EFFORT**: the spec has already stated that arbitrary shell / cloud-CLI / webhook / database
  side effects leave no trail, so a genuinely silent loss can evade it. It is a net worth having,
  not a guarantee — and saying so is the point, since a trigger presented as complete would be the
  same overclaim this spec keeps correcting. This residual gets its own trigger
  because the rate trigger below only detects a wrong SELECTION — it would stay silent on a
  correctly-selected duplicate whose interruption still cost real work.

  **The proactive half already exists and is load-bearing here.** The closeout passes no
  `disposition`, so it defaults to `terminal` — which means an activeness-bypassed kill goes through
  the normal reap-notify path and the user is TOLD their session was shut down, with the reason
  ("topic moved to <machine> …"), rather than finding out from a silence. Combined with the
  `confirmedMoveEvidence` audit row, a lost-work report can be traced to a specific decision. This
  is a mitigation the design inherits rather than one it invents, and it is named here so a future
  change to `disposition` on this path is visibly a change to the safety story.

  **Why there is no pre-kill guard for it.** The only in-process signal that a tool call is in flight
  IS `active-process` — the very reason this spec lifts. On a confirmed non-owner that signal means
  duplication, which is the premise; it cannot simultaneously be the trigger that stops the kill.
  That tension is irreducible at this layer, and it is the strongest argument for the quiesce design
  (CMT-2028), which resolves it by draining rather than by observing. Until then the mitigation is
  the ~4-minute dwell, this trigger, and an honest statement that in-flight tool work can be lost.

- **Secondary — rate, with a fully specified query.** Revert if, on any SINGLE machine,
  **≥ 3 activeness-bypassed `reaped` rows occur within 24 hours for which no
  `DuplicateSessionReconciler` loser decision exists for the same topic in the preceding hour.**
  Unpaired kills are the signature of a wrong selection.

  The correlation is deliberately **machine-local**, because a cross-machine join is exactly where
  this would break:
  - **Sources:** that machine's `logs/reap-log.jsonl` (rows with `confirmedMoveEvidence`) joined to
    that machine's `logs/duplicate-reconciler.jsonl`. Both are written by the same process on the
    same disk.
  - **Join key:** the bound topic id. No machine ids are joined across hosts, and no peer log is
    fetched — so peer clock skew cannot affect the result.
  - **Clock tolerance:** one hour of lookback against a single local monotonic-ish clock; a ±5 min
    skew within one host's own log stream is immaterial at that window.
  - **Missing reconciler log — the case that already happened.** On 2026-08-17 the Mini had NO
    `logs/duplicate-reconciler.jsonl` at all despite the reconciler running. An absent or unreadable
    reconciler log means the trigger is **UNEVALUABLE, not satisfied and not cleared**: it must be
    surfaced for manual review rather than silently reading as "no unpaired kills". A rule that
    turns missing evidence into a pass is the same "can't tell 'no' from 'couldn't tell'" fault this
    spec was written to fix, and it would have mis-fired on the very incident that produced it.

## Rollback

Plain code revert (three edits, no schema, no persisted state, no migration). Behaviour is also
reachable without a revert: `monitoring.sessionReaper.closeoutLivenessGate` off returns the
closeout to its opts-less call, and `topicMovedCloseout: false` disables the closeout entirely.
Nothing durable is written by this change, so a revert needs no repair. A wrongly-closed session is
recoverable rather than lost: the closed session's conversation resumes via `claude --resume`, and
the reap-notify + mid-work resume queue paths already cover a mid-work close.

## Test plan

Tests are numbered continuously across tiers so a finding can cite one number unambiguously.

Unit (`tests/unit/`):

1. `terminateSession` with `bypassActivenessForConfirmedMove` lifts **exactly** `active-process` and
   `main-process-active` — asserted per-reason, and asserted that `protected`, `open-commitment`,
   `active-subagent`, `structural-long-work`, `recovery-in-flight`, `pending-injection` and
   `relay-lease` still veto with the assertion set.
2. **The regression this spec exists for**: a session with BOTH a non-baseline child and an active
   main process terminates with the assertion, and is vetoed (`main-process-active`) when only
   `bypassActiveProcessKeep` is set. This test must FAIL against the tempting one-line fix.
3. **The uncertainty guard holds**: with the assertion set and `mainProcessActive()` returning
   `undefined`, the terminate is **vetoed** with `skipped: 'process-uninspectable'`. This pins the
   round-1 correction — a later "simplify by lifting the whole family" edit fails here.
4. The reaper builds the assertion **only** when the freshest-interaction veto is satisfied; with a
   user message newer than `reachableAt`, neither bypass is passed.
5. The assertion is never built on the stale or `unknown` liveness readings (those paths never reach
   terminate — asserted by the terminate spy receiving no call).
6. **External forgery**: a call through the PUBLIC `terminateSession` carrying
   `bypassActivenessForConfirmedMove` (forced through a cast) does NOT lift the guard — the public
   wrapper copies only inert/public fields and must not be extended to carry this option.
7. **Authority validation**: each check REFUSES independently with its reason named — a fabricated
   `selfMachineId`, an `ownerMachineId` equal to the real local machine, an unknown local identity,
   `lastUserMessageAt > reachableAt`, `dwellTicks < requiredConfirmTicks`, `now > expiresAt`, and a
   malformed/partial object. Includes an explicit regression asserting the WITHDRAWN
   caller-vs-caller comparison would have passed a forged pair that the trusted-identity check
   refuses.
8. **Callsite invariant**: every callsite setting `bypassActivenessForConfirmedMove` also sets
   `localPostTransferCloseout` and reaches terminate only on the `confirmedMove` path — so a future
   callsite that borrows the option without the closeout context is a test failure.
9. The successful `reaped` audit row carries `bypassedReasons` AND the decision evidence
   (`ownerMachineId`, `selfMachineId`, `reachableAt`, `lastUserMessageAt`, `dwellTicks`,
   `requiredConfirmTicks`) — asserted field-by-field, because a row that records the outcome without
   the evidence cannot answer the rollback trigger. A non-bypassed closeout reap carries neither. A
   REFUSED assertion records `confirmedMoveAssertionRefused` with its named reason.
10. **The TOCTOU invariant is pinned**: the assertion is still unexpired at the moment `terminate`
    is invoked, and no async yield intervenes between the freshness read and the call. A refactor
    introducing an `await` there fails this.

Integration (`tests/integration/`):

11. Closeout end-to-end against a guard reporting a busy duplicate on a confirmed move: the session
    closes, the reap-log records `reaped` with `rule: 'topic-moved-away'` and `confirmedMove: true`,
    and no `closeout-breaker-open` is raised.

E2E (`tests/e2e/`):

12. Reaper lifecycle wiring: the `terminate` dep closure actually forwards the new option from the
    reaper to the authority, and the `selfMachineId` dep resolves to the real mesh identity (a
    wiring-integrity test — the failure mode where the option is defined, passed, and silently
    dropped by the closure, or where the identity getter is never wired so every assertion refuses
    as `local-identity-unknown`).

### Found while building the test plan (folded in, not deferred)

Test 12 was written to catch "the option is defined, passed, and silently dropped
by a wiring layer". It immediately caught exactly that, one layer deeper than the
spec anticipated: `ReapLog.normalizeEntry` is a strict allowlist, so the decision
evidence was written to `reap-log.jsonl` and then **stripped on read** — the
durable audit would have looked correct on disk and been empty to every reader,
including `GET /sessions/reap-log`.

The same audit found **two pre-existing fields** with the identical defect:
`viaClaim` (documented in the agent template as the remote-close audit trail —
"the owning machine's reap-log entry carries `viaClaim`", a guarantee that was
false on read) and `evidenceSource` (the GAP-B revival-eligibility tag). Both are
fixed here rather than left behind: the fault is in a function this change
already edits, and knowingly shipping past a known read-path data loss is the
deferral this project treats as deletion.

Fixing five fields and trusting the next author to remember the sixth is
willpower, so the invariant is now **ratcheted**: test 13 parses the declared
`ReapLogEntry` fields and fails if any is absent from the normalizer. Every new
field must survive the read or the build goes red.

13. **Read-normalizer ratchet**: every field declared on `ReapLogEntry` survives
    `normalizeEntry`. Asserted structurally, so a field added without a
    normalizer clause fails the build instead of silently vanishing on read.

**A clock note, deliberately preserved in the tests.** The reaper stamps
`expiresAt` from its INJECTED clock; the authority validates against `Date.now()`
— a trusted clock, as a safety check must use. In production these are the same
clock. The integration test therefore runs on real wall time rather than a fake
clock: driving it on a fake clock makes every assertion refuse as `expired`,
which is a true statement about the code and would be a misleading test failure
to suppress by loosening the authority's clock.

## Round-4 review — NOT converged, and the approach itself is contested

Round 4 (six internal reviewers + codex `gpt-5.5`; gemini degraded) produced roughly
fifteen DESIGN-class findings. Recording them here because the round's verdict is that this
spec's chosen primitive — terminate the busy loser — is the wrong one, and that verdict must
not be lost between sessions.

### Folded into code this round (hardening that stands regardless of the direction chosen)

- **TTL ceiling enforced** (codex 1). The authority checked only `now <= expiresAt`, which
  bounds nothing when the CALLER supplies `expiresAt`. It now also refuses
  `expiresAt > now + TTL + skew` (`ttl-exceeds-ceiling`). The spec claimed twice that the
  authority enforced the TTL; that claim was false until this fold.
- **The assertion is bound to ONE session** (security 1). It carried no `sessionId`, so a valid
  assertion for topic A would have authorized killing any local session for its whole TTL —
  with an audit row naming topic A's owner. Now `sessionId` + `topicId`, refusal
  `session-mismatch`, and a caller supplying no target gets no bypass.
- **The liveness EVIDENCE has a maximum age** (security 5, integration 7, adversarial 10). The
  TTL bounded only the reaper→authority hop; `lastUserMessageAt <= reachableAt` compared two
  caller-supplied values, so an arbitrarily old or future proof satisfied every other check.
  Now bounded against the authority's own clock (`liveness-proof-stale`,
  `liveness-proof-in-future`) by `MAX_LIVENESS_EVIDENCE_AGE_MS`, derived from the snapshot's
  staleness bound.
- **The confirmed-move bypass set fails as a UNIT** (security 2). `recent-user-message` was
  lifted on a bare boolean BEFORE the assertion was validated, so a refused assertion still
  left its sibling lifted — applying this spec's own argument exactly halfway.
- **The audit row records the set APPLIED, not a hardcoded literal** (security 6, lessons 2).
  The row emitted `['active-process','main-process-active']` whenever the assertion validated,
  regardless of what the guard actually skipped — which made the spec's own rollback trigger
  count legitimate transfers as over-application.
- **Machine ids are shape-clamped** (security 7) before landing in the world-readable log.
- **A narrow, safe-direction off switch** (`closeoutActivenessBypass`, decision-completeness 3,
  integration 5, adversarial 6). Both pre-existing levers are strictly wider than this change:
  one also withdraws the liveness gate AND the Part E bypass, the other reinstates the bug this
  spec fixes. Distinct in DIRECTION from the TTL: loosening a bound must not be config-reachable;
  disabling this fails toward NOT killing and must be reachable without a deploy.

### The three findings that block shipping

1. **Mutual annihilation** (adversarial 1). `remoteOwnerHasLiveSession` proves the peer HAS a
   session for the topic — never that the peer AGREES on ownership. In a symmetric split-brain
   with no hard pin, both machines see owner=other + liveness=true (each looking at the other's
   copy), both dwell, and both activeness-close. The conversation dies on BOTH machines. The
   `active-process` veto was the only thing that made this impossible while both copies were
   busy. The spec's multi-machine section never analyses the symmetric case.
2. **The kill loop is unbounded** (adversarial 2, scalability 1, integration 8). The P19 breaker
   counts only VETOED attempts and is deleted on success, so a succeeding bypass resets every
   brake. With the creation cause explicitly unknown (CMT-2027), the expected steady state is
   spawn → ~4 min of work → bypassed kill → respawn, indefinitely — consuming a
   `maxReapsPerHour` budget SHARED with the idle pipeline, so closeout thrash can starve
   pressure relief exactly when pressure is what needs relieving. Neither stated rollback
   trigger fires: a thrash loop is correctly selected every cycle, so every kill is paired.
3. **"Not currently the user's interlocutor" is materially overstated** (adversarial 5).
   `reachableAt` is the snapshot REFRESH timestamp and slides forward every tick, so the
   freshest-interaction veto protects only a message newer than the last refresh (0-240s) —
   while the ordinary guard it replaces uses a 30-minute window. Combined with the ~4-minute
   dwell, the typical case is a session composing a long reply to a message sent four minutes
   ago being killed mid-tool-call. The §Why-sufficient conclusion does not follow from the
   predicate.

### The withdrawn claim that changes the decision

Rejected alternative #2 states there is "no supported way to tell a running claude-code session
'stop emitting, finish what you hold'", and that building one means a new subsystem on the
session-lifecycle critical path. **That is false and is withdrawn** (lessons 4). Instar ships
canonical `PreToolUse` `Bash` and `mcp__.*` hook entries, installed and migrated for every agent,
and `PrHandLease` already uses exactly that funnel to make a live session STAND DOWN from a
`git push` when another hand holds the lease. The output half has a shipped authority too (the
outbound messaging gate). Both halves of quiesce are hook-shaped, not subsystem-shaped.

That claim was the load-bearing justification for choosing termination over quiescence, so the
cost/benefit the spec presents is wrong in the direction that matters. It is the same failure
shape recorded elsewhere in this project: a wall asserted without checking the toolkit against it.

**Round-4 verdict: NOT converged.** The recommendation carried to the operator is to build the
stand-down (re-scoped CMT-2028: PreToolUse ownership gate + outbound ownership fence) rather than
ship the kill. The operator's decision governs which direction the next round reviews.

### Remaining round-4 findings, unfolded (they bind whichever direction is chosen)

- The rollback trigger has no owner, cadence, or mechanism — prose where the residual got a
  beacon-enabled commitment (decision-completeness 1).
- `## Decision points touched` claims "none is added"; `validateConfirmedMoveAssertion` is a new
  decision point and is unclassified (decision-completeness 2).
- `## Multi-machine posture` says the change persists nothing; it persists three fields served by
  the pool-scoped `GET /sessions/reap-log` (integration 1).
- The Agent Awareness + Migration Parity obligations are unmet — `generateClaudeMd` and
  `migrateClaudeMd` are untouched (integration 2, 3).
- The dev-gated posture (live on a dev agent, dark on the fleet) is unstated, and the
  `closeoutLivenessGate` registry justification still claims the gate is "strictly more
  conservative" — with this change, gate-ON now CAUSES kills gate-OFF would never make
  (integration 4, adversarial 6, lessons 7).
- The resume-queue mitigation cited in §Residual and §Rollback cannot fire — `workEvidence: []`
  is authoritative and `ResumeQueue.classify` excludes `topic moved` by name. Four reviewers
  raised it independently (security 3, integration 6, lessons 1, adversarial 3). Non-revival is
  CORRECT here; the claim is what is wrong.
- The dwell is not owner-scoped: a mid-dwell ownership flip carries the count over
  (adversarial 7).
- `open-commitment` does not veto past the 8h stale window, so "all three retain their vetoes"
  is unconditional where the code is not (adversarial 8).
- The P19 breaker is cleared on every non-`true` liveness tick, so a flapping snapshot defeats
  the bound the spec states as unconditional (scalability 2).
- Three named bypasses on one cascade is one missing standard, not three fixes; P14 (Distrust
  Temporary Success) is not engaged (lessons 3).
- CMT-2028's registered text does not cover the output-fence increment the spec assigns to it,
  and its frozen excerpt is truncated (lessons 5, decision-completeness 6).
- Spec/code drift: the checks table, §Observability field names (`confirmedMoveEvidence.*`, not
  top-level `snapshotReachableAt`), and test-plan item 7 all trail the implementation
  (codex 4, security 4/9, scalability 4, integration 9, adversarial 11/12).

## Deferral carriers (frozen excerpts)

Each deferral marker in this document names a registered commitment. The
carrier's immutable text is inlined below so a reader can check the carrier
actually covers the deferral without needing API access — a marker id alone is a
claim, not evidence. The machine-checked ledger is
`docs/specs/carriers/closeout-activeness-bypass-confirmed-move.json`, generated
from the live registry; a typed excerpt cannot satisfy it.

> **CMT-2027** — Determine WHY a non-owner machine spawns a session for a hard-pinned foreign topic (SpawnAdmission router-consumed arm allows without consulting ownership; the deciding route verdict log line was unreadable on the peer). This is the duplicate-CREATION half; the closeout spec only fixes the persistence half.
>
> _(status: pending · owner: agent · blockedOn: none)_

> **CMT-2028** — Design and build cooperative quiescence for a losing duplicate session: a control channel that tells it to stop emitting user-visible output and stop starting new tool calls, a bounded drain, and a drain-state the reaper can observe — so ending a duplicate stops interrupting arbitrary in-flight tool work. Acceptance: either the channel ships, or a written finding that it is infeasible with the rea
>
> _(status: pending · owner: agent · blockedOn: none)_

## Residual — NOT fixed here

This spec closes the *persistence* half only: a duplicate, once created, can now be cleaned up.
It does **not** stop the non-owner machine from creating the duplicate in the first place. On
2026-08-17 the Mini's `SpawnAdmission` recorded `admitted: 1, routerVerdictsConsumed: 1,
refused: 0` for this topic — i.e. the seam consumed a router verdict on the generic
`router-consumed` arm, which allows unconditionally without consulting ownership
(`SpawnAdmission.ts` ~line 351), unlike the `queued`/`placement-blocked` arm which does carry a
live-hard-pin check. Why the router produced a spawn-here verdict for a hard-pinned foreign topic is
**not yet determined** — the deciding `[session-pool] route topic … → action=` line is in a
server log that exceeded the file-serving limit and could not be read from the peer, and no
`logs/duplicate-reconciler.jsonl` exists on that machine to corroborate. That investigation is
tracked separately and must not be inferred from this spec's evidence.

**Close the Loop — the resurfacing cadence is durable, not a marker.** The residual is registered as
commitment **CMT-2027** (`owner: agent`, `blockedOn: none`, beacon-enabled with a dated
`nextUpdateDueAt`), so the PromiseBeacon re-surfaces it on a cadence and the check-in reconciler
posts a reminder if it goes quiet. A tracked marker alone would be exactly the rot this standard
names — captured once, never revisited. The loop closes when the creation-side cause is identified
or the commitment is explicitly withdrawn with a reason; it cannot lapse silently.
<!-- tracked: CMT-2027 -->
