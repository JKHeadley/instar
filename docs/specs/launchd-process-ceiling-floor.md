---
title: "Launchd Process Ceiling — size the fork-bomb belt against the HOST idle floor, not instar's own subprocess count"
slug: "launchd-process-ceiling-floor"
author: "echo"
status: "draft"
parent-principle: "Bounded Blast Radius"
sibling-principles: "The Agent Is Always Reachable — A Guaranteed Reachability Floor; Migration Parity Standard; Verify the State, Not Its Symbol"
parent-spec: "docs/specs/forkbomb-prevention-simple.md"
project: "resource-safety"
depends-on: "installAutoStart (src/commands/setup.ts — writes the agent's launchd plist, the template half of Migration Parity); PostUpdateMigrator (src/core/PostUpdateMigrator.ts — the deployed half); SpawnLimiter (src/core/spawn-limiter.ts — the PRIMARY host-wide concurrent-LLM-subprocess control this belt backstops, never substitutes for)"
review-verdict: "NOT-CONVERGED — hit the 10-iteration cap; round 10 still produced 2 design-class findings (both fixed). See the report."
approved: true
approved-basis: "Justin (verified operator, topic 48000) approved at the cap on 2026-08-19, after being sent the plain-English overview and the full convergence report — which states the NOT-CONVERGED verdict plainly. This records an OPERATOR OVERRIDE of an unmet criterion, not a passing grade: the two-consecutive-clean-rounds criterion was never met."
review-convergence: "2026-08-19T21:15:20.285Z"
review-iterations: 10
review-completed-at: "2026-08-19T21:15:20.285Z"
review-report: "docs/specs/reports/launchd-process-ceiling-floor-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Launchd Process Ceiling — size the belt against the host idle floor

## Problem

The fork-bomb prevention work (`docs/specs/forkbomb-prevention-simple.md`) shipped two controls:

1. **The host spawn cap** (PRIMARY) — a counting semaphore bounding concurrent
   `claude -p` / `codex exec` subprocesses across every compliant instar process
   (default 8).
2. **A launchd `NumberOfProcesses` belt** (BACKSTOP) — an OS-level ceiling that bounds a
   *non-compliant* runaway which bypasses the funnel entirely.

The belt shipped at **512**, a number reasoned against instar's own subprocess count.

That is the wrong denominator. `NumberOfProcesses` maps to `RLIMIT_NPROC`, which the XNU
kernel enforces **per real UID** — across every process the logged-in user owns, including
the GUI desktop, browser, editors, and every other application. A normal macOS desktop
idles at roughly 500–550 user processes.

So the belt sat **below the machine's idle floor**.

### Observed failure (Mac Studio, 2026-08-19)

The failure mode was not a bounded runaway. It was every `fork()` from an
instar-supervised process returning `EAGAIN` on an otherwise idle machine:

- 531 uid processes against the 512 ceiling.
- Agent shell commands refused intermittently for hours, with no alarm attached — a
  command returning empty output was read as an *answer* rather than as a refusal, which
  corrupted the agent's own judgement (it reported a machine "asleep" on the strength of a
  command that never ran).
- Then the agent server itself died on it:

```
[FATAL] Uncaught unhandledRejection — closing databases before crash:
        spawnSync ssh-keygen EAGAIN
libc++abi: terminating due to uncaught exception ... mutex lock failed
```

The operator was unreachable for roughly two minutes and nothing restarted the server
automatically.

**A safety limit that trips while the machine is at rest protects nothing; it just
converts idle into an outage.** It also actively harms the standard it belongs to — it
converts a *Bounded Blast Radius* control into a *Guaranteed Reachability* violation.

## Decision points touched

> *Local terms: an **invariant** decision point has an enumerable answer space, so it is
> deterministic by design; a **judgment-candidate** is one where several live signals can
> genuinely conflict, which under the Judgment Within Floors standard requires a declared
> deterministic floor plus an arbiter.*

| Decision point | Classification | Justification |
|---|---|---|
| The belt's ceiling value | **invariant** | A safety guard on an OS resource limit, deterministic by design. The domain is enumerable: the value must clear the host idle floor and stay under `kern.maxprocperuid`. There are no competing live signals to weigh — it is one number chosen once and applied identically everywhere. |
| The migration's raise-vs-clobber choice | **invariant** | Not a judgment: an operator-tuned value is authoritative over a shipped default, always. Encoded as a strict `<` comparison against the floor, so the rule cannot drift. |
| The boot check's verdict | **invariant** | Five enumerable states from two inputs (the live reading, and the plist values): `raise`, `repair`, `future-repair`, `ok`, `unknown`. The two inputs answer two different questions that do not compete — the live reading answers *is this machine safe now?* and the plist answers *will it still be safe after its next restart?* — so the cross-product is enumerable rather than a weighing of rival signals. The conservative default on the unmeasurable branch is silence, because a fabricated verdict in either direction is worse than none. |

> All three rows above are classified `invariant`, and none is a `judgment-candidate`. Each
> is a deterministic cross-product of bounded inputs with an enumerable answer space — the
> boot check takes two inputs, not one, but they answer two different, non-competing
> questions (is it safe now / will it be safe after the next restart), so the result is a
> lookup rather than a weighing. This spec introduces no point where multiple live signals
> can genuinely conflict, and therefore declares no floor or arbiter.

## Multi-machine posture

*Local terms used below, defined once (round-2 finding — these depend on instar standards an
external reader would not have): a **`unified`** surface behaves identically on every machine
the agent runs on; a **`machine-local`** surface is genuinely per-machine and must not be
replicated. **One-voice gating** means suppressing duplicate user-facing notices so several
machines do not each speak about one shared condition. An **Attention item** is a durable
operator to-do with its own lifecycle — raised once, deduped by key, resolved by the
operator — routed into a single hub conversation rather than creating a new one.*

**Posture: `unified` for the SHIPPED VALUE, `machine-local` for the EFFECTIVE READING.**

`machine-local-justification: hardware-bound-resource`

The shipped ceiling and the migration are `unified` — every machine running this agent gets
the same floor written to its own plist by the same migration on update. There is nothing
per-machine about the policy, and nothing to replicate: the migration runs locally on each
machine from the same shipped code.

The **effective reading** is machine-local, and the justification key is
`hardware-bound-resource`: `RLIMIT_NPROC` is a kernel limit applied to a running process on
one specific machine's kernel. It is not a credential and not a policy — it is a physical
property of that host's running state, and it is meaningless when read on any other. A
peer's reading can never answer "is THIS machine's limit raised yet?", which is the only
question the check asks. Replicating it would be actively wrong: a healthy peer would mask
an unhealthy machine.

Explicitly:

- **User-facing notices** — yes, one, and it is per-machine BY NECESSITY: each machine
  needs its own physical restart, so one-voice gating across machines would be the WRONG
  behaviour — it would suppress the second machine's genuine need and leave a machine
  crashing with no prompt, which is the original incident.

  On the **Bounded Notification Surface** standard (raised in round 2): the cardinality here
  is the operator's own machine count — a small, bounded, human-scale collection where every
  element requires a DISTINCT action from the operator, not a per-element notification over
  an unbounded collection. It is bounded three times over:

  1. **Deduped per machine** on `(machineId, effectiveCeiling, floor)`, so a machine that
     goes un-restarted for a week produces ONE item, not one per boot.

     The `machineId` is the agent's own durable machine identity (the same value the pool
     and the mesh key on), read from config; when absent it falls back to the literal
     `single-machine`, which is correct for the one-machine case. Its failure modes are
     bounded and both tolerable here (round-9 finding): if the id RESETS — a reinstall, a
     cloned disk — the machine re-notifies once, which is the safe direction for a condition
     that still needs acting on. If two machines ever COLLIDED on an id, the second would be
     suppressed while the first's item is open; that is the same exposure every per-machine
     surface in instar already carries, and it is not made worse here.
  2. **Self-extinguishing.** The condition ends the moment the machine restarts, which is
     the very action the notice asks for. It cannot accumulate over time the way a
     detector-over-a-growing-collection can.
  3. **Rides the existing bounded surface.** It is an ordinary Attention item, so it lands
     in the single durable Attention hub topic under the existing single-alerts-topic
     routing and the topic-creation budget. It creates no topic of its own, and the
     pool-scope attention read is the aggregated cross-machine view.

  Aggregating instead into ONE cross-machine summary was considered and rejected: the
  summary would have to be raised by one machine ON BEHALF of others, which requires the
  reading it cannot have (§ the effective ceiling is machine-local and unreplicable), and a
  machine that is down — the likeliest state for a machine crashing on this very bug —
  would be omitted from the summary entirely. A per-machine notice is the only form that
  cannot silently drop the machine it is about.
- **Durable state on topic transfer** — none held. The check reads the live process at boot
  and holds nothing across a transfer; the Attention item is already a per-machine record
  with its own lifecycle. Nothing strands.
- **Generated URLs** — none.

## Frontloaded Decisions

1. **Ceiling value: 2048, static.** Chosen against the host idle floor; install-time
   dynamic sizing rejected with reasons in §1. Decided here, not handed to the operator.
2. **The belt does not catch the June incident class.** Accepted and documented rather than
   sized around, because no value both clears the idle floor and trips before an OOM. The
   spawn cap owns that class.
3. **The migration does not reload launchd.** Accepted: trading a reachability outage now
   for one avoided later is not an improvement. The restart requirement is instead made
   VISIBLE by §3.
4. **The boot check is signal-only.** It never restarts, reloads, or gates. Decided up
   front so no later round can quietly promote it to an authority.
5. **Unmeasurable is `unknown` and silent.** Decided up front; the alternative (defaulting
   to "needs restart") would nag every machine whose runtime cannot report the limit.

## Open questions

*(none)*

## Proposal

### 1. Raise the shipped ceiling to 2048

`2048` is chosen against the correct denominator — the HOST idle floor:

| Bound | Value | Relationship |
|---|---|---|
| Host idle floor (macOS desktop) | ~500-550 | ceiling must clear it with margin |
| **Shipped ceiling** | **2048** | ~1500 headroom over the floor |
| Host spawn cap admits (default) | 8 concurrent LLM subprocesses + children | far below the ceiling |
| `kern.maxprocperuid` (macOS 15) | 10666 | ceiling stays well under it |

#### What this belt does NOT catch (corrected — round 2)

An earlier draft of this spec claimed 2048 "still catches" the 2026-06-20 runaway
(~230-289 concurrent spawns). **That claim is arithmetically false and is withdrawn.**
On top of a ~500-550 idle floor those spawns total ~730-839 — comfortably under 2048. A
repeat of that exact incident would NOT trip this belt.

Worse, the belt cannot be sized to catch it without reintroducing the bug being fixed. At
roughly 400MB per LLM subprocess, ~250 spawns is already an OOM; a ceiling low enough to
trip before that (~800) sits barely 250 above a desktop idle floor that varies by hundreds
depending on open browser tabs and editors. That is the same "fires at rest" failure this
spec exists to remove, with a smaller margin.

**So the honest scope of this belt is: a UID fork-exhaustion backstop.** It catches an
explosion of PROCESS COUNT far beyond anything a working system produces. It is NOT an
OOM-prevention control, NOT the control that catches the June incident class, and it does
NOT meaningfully bound memory blast radius — a non-compliant LLM runaway can exhaust this
machine's memory long before it approaches 2048 processes, and nothing at this layer stops
it. What bounds that is compliance with the spawn-cap funnel, the lint that keeps new
callsites inside it, and the update reach that reaches deployed agents at all. Naming the
belt for what it actually does — fork exhaustion, not blast radius — is the point of this
paragraph.

The control that catches that class is and remains the **host spawn cap** (`SpawnLimiter`,
default 8 concurrent LLM subprocesses) — the PRIMARY control named in the parent spec. It
bounds the exact quantity that OOMed the machine, it bounds it at the right order of
magnitude, and it was already correct. The belt's only job is the non-compliant runaway
that bypasses the funnel entirely; for that case the meaningful property is that a ceiling
exists at all, not its precise value.

Stating this plainly matters more than the number: a belt believed to catch the June
incident would be relied on to, and it will not.

#### The belt is not job-local, and that cuts both ways

`NumberOfProcesses` in a launchd plist sets `RLIMIT_NPROC`, which the kernel enforces per
real UID — NOT per launchd job, and not per process tree. This is the property that caused
the original bug, and it has a second consequence worth naming rather than leaving implicit:

- **Inbound:** unrelated user workload (browser, editors, containers, test runners) consumes
  the same budget, so instar can be starved by processes it does not own and cannot see.
- **Outbound:** an instar runaway raises the shared UID process COUNT, which every other
  process of that user is also measured against. It does NOT impose instar's own 2048 on
  those applications — each inherits its own limit from whatever launched it, typically the
  higher system default. So the collateral is indirect and conditional: other apps begin
  failing to fork only once the shared count approaches THEIR inherited limits or the
  system maximum, not when it approaches instar's. (An earlier draft implied instar's
  ceiling directly capped other apps; that was wrong and is corrected here.)

macOS offers no per-job or per-process-tree process cap to use instead — there is no
equivalent of Linux cgroups `pids.max` reachable from a launchd plist. `RLIMIT_NPROC` is the
only OS-level lever available at this layer, so the choice is this coarse shared budget or
no OS-level belt at all.

That is precisely why the belt must stay a coarse last-ditch throttle set well clear of
normal operation, and why the real bounding of instar's own concurrency belongs to the
in-process spawn cap, which IS job-local and counts only instar's own subprocesses.

#### Why a static value rather than install-time sizing

A tempting alternative is sizing at install/migration time —
`max(floor, current uid process count + headroom)`. It is rejected here, deliberately:

- The reading is a **single sample of a varying quantity**. A machine that happens to be
  idle at install time yields a low ceiling that fires later under normal desktop load;
  one that is busy yields a ceiling so high the belt is meaningless. Sizing from one
  sample re-creates the original bug with a different denominator.
- It makes the ceiling **unpredictable across the fleet**, so an incident on one machine
  cannot be reasoned about from another.
- It is **not measurable at the time it must be decided** — the number that matters is the
  peak the machine will reach over its lifetime, which no install-time sample observes.

**On the name (round-9 finding):** the constant is `LAUNCHD_PROCESS_CEILING_FLOOR`, and
"floor" overstates what it is — it reads as a measured safe lower bound, which it is not.
It is the minimum SHIPPED value. The name is left as-is in this change because renaming an
exported symbol is churn unrelated to the crash being fixed, but the word is reserved: when
the headroom probe (CMT-015) produces real baselines, a measured minimum can take the name
and this constant should become the shipped default it actually is.
<!-- tracked: CMT-015 -->

**2048 is a temporary empirical default, not a validated safe floor for all supported hosts**
(round-6 finding, stated at the top rather than buried). It is derived from observed fleet
idle counts and bounded above by `kern.maxprocperuid`; it is NOT validated against heavy
developer desktops, and the runtime check cannot yet detect the residual risk it leaves (a
host already sitting near 2048), because that needs the headroom probe tracked as CMT-015.
It should be revisited when that probe produces real baselines — which is why a future
change to this value is gated on the probe landing first.

**The supported-host envelope, stated explicitly (round-8 finding):** 2048 assumes a host
whose steady-state UID process baseline sits materially below it — the ordinary desktop and
laptop case, which is every machine on this fleet. A host outside that envelope (a heavy
developer desktop running many containers, parallel test runners, and several IDE helper
trees) is expected to raise the value itself via the escape path above, and §3 will confirm
the raise actually took effect. Naming the envelope is the honest alternative to implying
one value fits every host.

A static value is honest about what it can know. But the honest statement of its coverage
is narrower than "clears every plausible desktop floor" — that claim is not established and
is withdrawn (round 2). 2048 clears the ~500-550 floor OBSERVED on this fleet with wide
margin; it is NOT proven against a heavy developer desktop running containers, several IDE
helper trees, and parallel test runners, where the UID count could plausibly approach it.
`RLIMIT_NPROC` is per real UID, so that unrelated workload is genuinely part of the
denominator.

The residual risk is therefore real and is handled by REPORTING rather than by asserting:
2048 is the shipped default, and the §3 runtime check reads the EFFECTIVE ceiling — so a
host whose real baseline approaches or exceeds the floor surfaces as a live reading rather
than as an assumption in this document.

**The operator's escape path, as a contract (round-4 finding).** A host that genuinely needs
more than 2048 raises the two `NumberOfProcesses` values in that machine's own launchd
agent plist. The contract this spec commits to is that the change STICKS:

- The migration is raise-only by a strict `<` comparison against the floor, so it can never
  lower an operator's value — on this update or any future one.
- The migration is surgical rather than regenerative, so an operator's other hand-added
  keys and formatting survive alongside the raised value.
- A future floor increase would raise a value below the NEW floor and still leave anything
  above it alone; the raise-only property does not weaken as the floor moves.
- §3 reports the effective ceiling, so an operator-raised value is confirmed as actually
  in force after the machine restarts, rather than assumed from the file. This is also the
  VALIDATION path: an edit that was malformed, or that raised only one of the two values,
  shows up as a live reading that did not move — and a half-raised plist is reported as
  `repair`/`future-repair` rather than accepted.

This is deliberately a file the operator edits rather than a new config surface: adding an
instar config key for it would mean instar rewriting the plist from that key, which is
exactly the regenerative behaviour rejected above.

**The Attention notices deliberately do NOT hand out this procedure (round-6 finding).**
None of the three notices names a file, a key, or a command. That is not an oversight to
correct — it is the right call for who receives them. Every operator who sees `raise` needs
a restart and nothing more; every operator who sees `repair` or `future-repair` has an
update-delivery problem, and plist surgery is the wrong first response to it. Handing plist
editing instructions to that reader trades an automatic fix for manual surgery on a file
where a half-edit produces exactly the half-raised state §3 has to report. The escape path
above exists for the rare host that genuinely needs above 2048, and it lives in this
document, where the reader is someone who has already concluded they need it.

### 2. Two write paths, both raise-only

The value is written by TWO paths, and both had to be made raise-only. Missing the second
one is easy — it cost this spec a round of review:

- **`setup` / `installAutoStart` REGENERATES the plist** on install and on any re-run. It
  is therefore a clobber path in its own right: without protection, a re-run would silently
  reset an operator who deliberately raised their ceiling for a heavy host, and the
  escape-path contract in §1 would be false. `preserveHigherProcessCeiling` carries a
  previous value forward when — and only when — it is strictly greater than the template's.
  A stale LOW value is correctly replaced; a deliberate higher one survives.

  **Soft and Hard are not preserved independently:** the highest previous value found is
  applied to any template value below it, so a previously half-raised plist
  (Soft 8192 / Hard 512) comes out uniformly at 8192 rather than preserving the 512. This is
  deliberate — a Hard limit below the Soft limit is an invalid plist, so preserving each
  slot independently would faithfully reproduce a broken file. Raising both to the highest
  intent found is the coherent reading of a half-finished edit.

- **The migration reaches already-deployed agents.** That is the rest of this section.

#### Migration Parity — reach the deployed agents

The template change in `installAutoStart` reaches **new** agents via `setup`. Deployed
agents are reached only by a migration, per the Migration Parity Standard. Without it the
fix is broken for exactly the population that already has the bug.

`migrateLaunchdProcessCeiling` is:

- **Raise-only and floor-gated.** It rewrites a `NumberOfProcesses` value only when it is
  *strictly below* `LAUNCHD_PROCESS_CEILING_FLOOR`. An operator who deliberately tuned
  theirs higher is never clobbered.
- **Idempotent.** A re-run over an already-migrated plist matches nothing and rewrites
  nothing.
- **Surgical, not regenerative.** It replaces the integer in place rather than rewriting
  the plist from the template, so hand-added operator keys survive.
- **Non-reloading.** It does NOT `launchctl unload/load`. The raised ceiling applies to
  what launchd starts next; forcing a reload would restart a running agent mid-update —
  trading one reachability outage for another. The value lands on disk now and takes
  effect at the machine's next restart.
- **Platform-gated.** Non-darwin is a recorded skip, not an error — launchd does not exist
  there.

### 3. Report the EFFECTIVE ceiling, never assume the plist is the state

The plist value is a **symbol**. The **state** that matters is the `RLIMIT_NPROC` the
running agent processes actually inherited — and those diverge for a real, expected window:
launchd applies the raised ceiling only to what it starts NEXT, so a migrated machine keeps
running under the old ceiling until it restarts.

That divergence is not hypothetical; it is this incident. The Studio was migrated at
10:26 and kept crashing under the old ceiling until 12:18, and the only reason it was
restarted at all is that the agent asked the operator by hand. Two other machines carry
the same ceiling and would receive no such prompt. Relying on release-note prose plus an
agent remembering is exactly the "No Manual Work" and "Verify the State, Not Its Symbol"
failure the constitution names.

So the change also reports the effective state:

- **`readEffectiveProcessCeiling()`** reads this process's own soft `RLIMIT_NPROC`. The
  symbol is the plist integer; the state is this number; the corroboration is that it is
  read from the live process rather than from any file instar wrote.
- At server boot on darwin, when the effective ceiling is **below** the floor, one deduped
  Attention item is raised — and it is one of **two distinct notices**, because they ask the
  operator for different things (round-2 cross-model finding):

  | Effective | Plist | Verdict | Priority | What the operator is told |
  |---|---|---|---|---|
  | below floor | at/above floor | `raise` | HIGH | This machine needs one restart to pick up the raised limit. |
  | below floor | below floor, missing, or half-raised | `repair` | HIGH | This machine is unsafe AND a restart will not fix it — the correcting update has not reached it or did not complete. |
  | at/above floor | below floor, missing, or half-raised | `future-repair` | NORMAL | Fine now, and a restart MAY lose that. No hurry, but worth sorting before then. |
  | at/above floor | at/above floor | `ok` | — | Nothing. |
  | unreadable | any | `unknown` | — | Nothing. |

  `future-repair` was added in round 5. A draft treated that row as `ok`, reasoning that
  the plist is "a question about the FUTURE" and this check speaks only to now. But the
  event that turns it into the present is an ordinary restart, and a silent failure waiting
  behind a routine action is precisely the class this spec exists to end. It carries lower
  priority because nothing is broken yet — reporting it as urgent would be its own dishonesty.

  **It claims only what it measures (round-9 finding).** The measured facts are: this
  machine is safe NOW, and its intended launchd symbol is NOT CONFIRMED safe. It is
  tempting to conclude "the next restart will drop it", but that does not follow — an absent
  or unparseable agent plist could mean launchd or shell defaults apply, or that another
  launch path is active, and either could be above the floor. The notice therefore says a
  restart **may lose** the limit the machine is running on, which is exactly the strength of
  the evidence. This is the same discipline as the `unknown` branch, applied to a partial
  reading rather than a missing one.

  An earlier draft returned silence for the `repair` row, reasoning that the migration
  reports it. It reports it **to a log**. A machine whose migration never ran is crashing on
  this exact bug with nobody told — and telling that operator to "restart" would be actively
  wrong advice, since the machine would come back identical. The two states carry different
  dedupe keys, so a machine that moves from `repair` to `raise` is re-told the NEW action.

  Deduped on `(state, machineId, effectiveCeiling, floor)` so an un-restarted week produces
  one item, not one per boot.

  **The key deliberately encodes the ACTION, not the CAUSE (round-8 finding).** A `repair`
  machine whose plist changes from missing, to half-raised, to merely low produces no new
  item, because the operator's next step is identical in all three and the notice text is
  identical too. Re-notifying on a cause change the operator cannot act on differently would
  be noise dressed as diligence. A change that DOES alter the required action — `repair`
  becoming `raise` once the migration lands, or `future-repair` becoming `repair` after a
  restart — changes the state and therefore the key, and is re-told.
- **Unmeasurable is explicit, and never invisible.** If the limit cannot be read (a
  platform without it, a runtime that does not expose it, an error), the result is `unknown`
  and **no Attention item is raised and no claim is made** — the least-harmful action at
  this decision point, since a fabricated "healthy" would silence a real gap and a
  fabricated "broken" would nag every correctly-configured machine forever.

  But silence with no trace would be its own failure: if the reader ever broke on darwin,
  this whole check would vanish fleet-wide while still perfectly "satisfying" its no-item
  contract. So `unknown` **on darwin** — the platform where it is supposed to work — is
  always logged with its reason, as is any error in the check itself. The Attention surface
  stays quiet; the diagnostic does not.
- **Signal, never authority.** The check raises an Attention item and nothing else. It does
  not restart the agent, reload launchd, refuse to boot, or gate any work. A wrong reading
  costs one wrong notice, never an outage — which is the correct blast radius for a check
  whose entire job is to report that a limit is wrong.

This closes the loop the release note could only describe: the machine tells the operator
it needs the restart, instead of the operator depending on an agent to remember.

#### What §3 does NOT detect: live headroom (round-3 finding, stated not hidden)

The check verifies the **limit**. It does not measure the **headroom** — how close the
machine's current per-UID process count sits to that limit. That distinction matters,
because the incident was not "the limit is wrong in the abstract"; it was *531 processes
against 512*. A machine sitting at 1900 of 2048 is about to fail, and this check reports
`ok`.

That gap is deliberate rather than overlooked, and the reason is the failure mode itself:
counting the UID's processes requires enumerating them, which on macOS from Node means
spawning a process — the exact operation that is refused when the limit is exhausted. A
headroom check built that way would return nothing precisely when the answer mattered, and
would report reassuring silence the rest of the time. That is a worse instrument than none,
because it would be believed.

A non-forking count needs a native binding instar does not have. Adding one is real work
with its own review, so it is registered rather than smuggled in here.
<!-- tracked: CMT-015 -->

**The residual risk, named with an owner and a priority (round-4 finding)**, since
"registered" alone is too weak for a resource-safety spec: the next failure mode of this
class is *effective limit correct, headroom nearly exhausted, no notice*. Owner: the agent
that ships this (echo). Priority: below the crash this spec fixes — that one is live on
deployed machines today — and above ordinary backlog, because it is the same incident class
one step along. It is NOT accepted as permanently out of scope; the tracked item is a
non-forking headroom probe, and this spec's `unknown`-is-silent discipline is what keeps the
gap honest until then rather than papered over with a fork-based probe that would lie.

**And it is made blocking rather than merely registered (round-5 finding):** any FUTURE
change to this ceiling value must land the headroom probe first or state in its own spec why
it does not need to. The reason is that a ceiling change is exactly the decision that needs
headroom data — this spec had to pick 2048 without it, which is why its empirical basis is
as thin as round 2 established. A tracked item that never blocks anything is a wish; this one
gates the next decision of its own kind.

Two things bound the risk in the meantime. The spawn cap bounds instar's OWN contribution
to the count at the right order of magnitude, and the `repair`/`raise` verdicts still fire
the moment an exhausted machine's limit is itself wrong — which is the shape this incident
actually took.

#### Plist forms this handles, and what it does when it cannot (round-3 finding)

`raiseLaunchdProcessCeilings` performs surgical value replacement on the XML plist form
launchd agents ship as, matching `<key>NumberOfProcesses</key>` followed by its
`<integer>`, whitespace-tolerant. Explicitly:

- **Multiple declarations** (the normal case — Soft and Hard are separate keys) are each
  evaluated independently, and only those below the floor are rewritten.
- **A half-raised plist** (one value raised, one not) is left as it is by the raise-only
  rule, and is reported by §3 as `repair` rather than silently accepted.
- **A binary plist, an unrecognised structure, or a hand-edit the pattern does not match**
  produces NO match, therefore NO rewrite. The migration then records that the plist
  declares no ceiling it can act on, rather than rewriting anything it did not understand.
- **A parse that reads low but rewrites nothing** is recorded as an ERROR, never as a
  success — the code refuses to claim a change it did not make.

Two alternatives were considered (round-5 finding narrows the earlier claim, which
overstated the tradeoff):

- **Full `plutil`/plist-library parse-and-REGENERATE — rejected.** It normalises formatting
  and key order across the whole file, so an operator's hand-added keys and comments are
  silently rewritten or lost. A pattern that fails to match is a visible no-op; a
  regeneration that succeeds is an invisible rewrite of someone else's file.
- **XML DOM TARGETED replacement — a legitimate alternative, not dismissed.** A proper DOM
  round-trip can preserve comments and unknown keys, so the earlier blanket claim that
  parsing necessarily discards them was too strong. It is not used here for two narrower
  reasons: it adds an XML dependency to a migration path that must run during an update on
  a machine that may already be resource-starved, and it would silently start succeeding on
  binary plists and hand-rolled structures this change has never been tested against —
  turning a safe no-op into an untested rewrite. For a raise-only migration touching one
  integer, the failure direction of the surgical approach is the safe one; if this ever
  needs to edit structure rather than a value, the DOM route is the right upgrade.

#### Every plist-read failure, enumerated (round-3 finding)

The verdict table above uses "plist below floor, missing, or half-raised". Spelling out the
read failures specifically, because they were blurred:

| Effective reading | Plist read | Verdict | Why |
|---|---|---|---|
| unreadable | any | `unknown` | Nothing is known about this machine's state; a guess in either direction is worse than silence. |
| at/above floor | at/above floor | `ok` | Nothing to say. |
| below floor | unreadable, absent, or unparseable | `repair` | The machine IS unsafe, and nothing confirms a restart would help. `repair` says "this needs looking at", which is true whether the cause is a failed migration, a permission problem, or a corrupt file. Saying `raise` would be advice that might not work; saying nothing would leave a crashing machine unreported. |
| at/above floor | below floor, unreadable, absent, or unparseable | `future-repair` | A restart MAY lose the currently-safe inherited limit, because no safe launchd symbol is confirmed. Deliberately "may": an absent or unparseable plist does not prove the next limit is low — defaults or another launch path could apply. (Round-10 correction: this row previously read "lands it below the floor", contradicting the evidentiary standard the rest of §3 sets.) |


> **Carrier (frozen excerpt — the work both markers above point at):** <!-- tracked: CMT-015 -->
>
> **CMT-015** — "(1) HEADROOM PROBE: the ceiling check verifies the LIMIT, not the HEADROOM — a machine at 1900 of 2048 reports fine. A fork-based count fails exactly when the limit is exhausted, so this needs a non-forking (native) process count. Until it lands, any FUTURE change to the ceiling value is blocked on it, because a ceiling change is precisely the decision that needs headroom baselines — 2048 was chos"

## Maturation plan

This change is deliberately NOT a staged, dark-shipped feature, and the plan below says so
explicitly rather than leaving the axis undeclared. Two reasons: the ceiling correction is a
bug fix to a live crash (a dark bug fix is a bug not fixed), and the boot check is
signal-only — it raises a notice and can do nothing else, so there is no destructive action
for a dark window to protect against.

- **test-agent-live:** live from the first build. The unit suites (55 cases across the two
  files) exercise both write paths and all five verdict states, including every uncertain
  branch asserting silence.
- **dev-agent-live:** live on merge, no flag. This agent is the machine the incident happened
  on; the check runs at its next server boot and its verdicts are observable in the boot log
  and the Attention queue.
- **fleet:** live on the release that carries it, no flag. Deployed agents receive the
  migration on update, and the boot check with it.
- **graduation criterion:** already met by construction — there is no gated state to
  graduate FROM. The equivalent evidence is: the migration is raise-only on both write paths
  (verified by test), and the check cannot take any action beyond raising a notice (verified
  by the absence of any restart/reload/gate call in its module and by the boot wiring, which
  only calls `createAttentionItem`).
- **dark-window:** none, and that is the deliberate choice rather than an omission. A dark
  window here would mean deployed machines keep crashing while the fix waits, and would
  suppress precisely the notice that tells an operator their machine still needs its
  restart. The risk a dark window normally buys down — an automated action going wrong — does
  not exist for a component whose only output is a message.

## Acceptance criteria

1. `installAutoStart` writes `2048` for both Soft and Hard `NumberOfProcesses`.
1b. **A setup re-run never lowers an operator's higher value.** `installAutoStart`
   REGENERATES the plist, so raise-only had to be applied on that path too:
   `preserveHigherProcessCeiling` carries a previous value forward only when it is strictly
   greater than the template's. A stale LOW value (the 512 this change fixes) is correctly
   replaced; an operator's deliberate higher value survives install, update, and any future
   template change. Without this the escape-path contract above would have been false —
   the review caught it before it shipped, not after.
2. `readLaunchdProcessCeilings` returns every declared value, and an empty array for a
   plist declaring none (a real state, not an error).
3. `raiseLaunchdProcessCeilings` raises a value below the floor, leaves a value at or
   above the floor byte-identical, and leaves every other byte of the plist untouched.
3b. **The "safe no-op" claim is VERIFIED, not asserted** (round-9 finding). The forms §2
   names as producing no match must each be exercised: malformed XML, an unparseable binary
   blob, a decoy string that only looks like the key. And the forms it claims to handle must
   be exercised too: comments preserved around a raised value, duplicate keys evaluated
   independently, Soft-before-Hard and Hard-before-Soft both raising, and a value nested
   deeper than the template's shape. A safety property no test exercises is a claim, not a
   property.
4. The migration is a no-op on a second run.
5. The migration does not invoke `launchctl`.
6. The migration records a skip on non-darwin.
7. `readEffectiveProcessCeiling` returns the live soft `RLIMIT_NPROC` of the calling
   process — read from the running process, not from the plist bytes. This is the criterion
   that tests the state rather than the symbol.

   **How it is verified, stated honestly (round 2).** The unit suite asserts the reading
   against the OS's own report for the process running the test, and that reading is a real
   launchd-descended value when the suite runs on a machine where the agent is installed —
   which is where this bug was found and where the fix matters. It is NOT verified by a
   purpose-built temporary launchd job with a low test limit: that harness is macOS-only,
   would install and remove a real user-level launchd job as a side effect of running tests,
   and CI runs on ubuntu where it cannot execute at all. So the honest coverage is: the
   reading mechanism is verified everywhere, the launchd-inheritance link is verified on a
   darwin host with the agent installed, and on ubuntu CI the platform branch returns
   `unknown` and is asserted to notify nothing. No criterion here claims the launchd job
   itself is exercised in CI, because it is not.
8. `readEffectiveProcessCeiling` returns `unknown` (never a number) when the limit cannot
   be read, and the boot check raises nothing in that case.
9. The boot check raises exactly one deduped Attention item per distinct condition, matching
   the §3 verdict table row for row:

   | Effective | Plist | Item | Priority |
   |---|---|---|---|
   | below floor | at/above floor | `raise` | HIGH |
   | below floor | below/missing/half-raised | `repair` | HIGH |
   | at/above floor | below/missing/half-raised | `future-repair` | NORMAL |
   | at/above floor | at/above floor | none | — |
   | unreadable | any | none | — |

   All three notifying states carry DISTINCT dedupe keys and DISTINCT text. The `repair`
   text must not tell the operator to restart (it would not help), and the `future-repair`
   text must not present itself as urgent (nothing is broken yet).

   (Round-6 correction: an earlier draft of this criterion said "nothing at all when
   effective is at or above the floor", which contradicted the `future-repair` row added to
   §3 in round 5. An implementation could have passed acceptance while omitting a behaviour
   the design requires — the criteria are the contract, so a stale one is a real defect,
   not a typo.)

## Rollback

- **Code:** pure code change. Revert and ship a patch.
- **On-disk state:** an already-migrated plist keeps `2048`. That is harmless *within the
  supported-host envelope stated in §1* — it is roughly a fifth of `kern.maxprocperuid`
  (10666), and well clear of an ordinary desktop baseline. It is NOT unconditionally
  harmless: a heavy host outside that envelope would still need the operator raise, exactly
  as it does without the rollback. No data migration, no agent
  state repair.
- **The boot check:** reverting removes the Attention item source. Any item already raised
  is an ordinary attention row the operator resolves normally; nothing is orphaned, because
  the check holds no state of its own.
- **User visibility:** none during the rollback window. Reverting restores the previous
  behaviour (a silent restart requirement), which is the pre-change state rather than a new
  regression.

## Review history

Recorded in full in the convergence report at
`docs/specs/reports/launchd-process-ceiling-floor-convergence.md`. It was moved there in
round 8: the history had grown until the spec exceeded the reviewer's own input budget and
began truncating, which is a defect in a document whose purpose is to be reviewed whole.
