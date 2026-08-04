# Session 9 — durable inheritance record

**Window #6, topic 29723. Started 2026-08-04T03:13:56Z, ends 03:13:56Z.**
**LIVING DOCUMENT — written from 22:20Z with ~4h50m still to run. Update before the boundary.**

Read this before acting. The **corrections** section is the load-bearing part: this window
refuted several things I had previously reported as measured fact, and a session that
inherits those beliefs will rebuild on them.

---

## ⚠ CORRECTIONS — things I reported as fact that are now REFUTED. Do not rebuild on these.

### 1. "The job-gate failures ARE the memory refusals, one layer up" — FALSE

I escalated this to the operator at 12:06Z on a 125 ms co-occurrence and called it *"the
strongest argument in this document."*

**`JobScheduler.runGateAsync` runs `execFileAsync('/bin/sh', ['-c', job.gate], {timeout:10000})`.
It never spawns a session and cannot reach `evaluateRerouteGate`.** The gap is a shared cron tick.

**Control that settles it:** gate failures vs memory refusals per hour — hour 02: **24 gate / 0
memory**; hour 09: **0 gate / 22 memory**. Independent series.

### 2. "Defer low-priority work" reproduces the harm it condemns — 91%, the same number

Constraint 3 of the option C spec admits `critical`/`high`, defers `medium`/`low`. Across all 33
shipped manifests: critical **1**, high **2**, medium 15, low 15. **Admits 3, sheds 30 = 91%**, and
**all five `overseer-*` jobs are medium/low.** `JobPriority` encodes scheduling urgency, not
supervisory load-bearingness.

### 3. A SECOND memory gate at the same threshold fires FIRST

`server.ts` wraps `scheduler.canRunJob` with `memoryMonitor.canSpawnSession()`, `elevated` = **75%**,
evaluated **before** the job gate and before `spawnSession`, ignoring priority. A DEGRADED tier built
only in `evaluateRerouteGate` is **unreachable for the whole scheduled-job population.**

### 4. "I have working SSH to the laptop" — NOT reproducible

Tested three users × two hostnames: all `Permission denied`. This was load-bearing in an argument I
gave the operator about the disabled peer-execution guard. **That argument is withdrawn.**

### 5. "The browser extension reports not-connected" — WRONG DIAGNOSIS

Real state: `Browser is already in use for …/mcp-chrome-…` — the profile is **held by a live Chrome**
(pid 82156, 5h38m old at 21:44Z). Same blockage, different cause, different repair. Do **not** kill it.

### 6. Type citations in the option C spec point at the wrong interface

`types.ts:1575` is **`ActionItem.priority`**, not `JobDefinition.priority` (real: `:441`, typed
`JobPriority` at `:638`). And `deferrable` (`:1057`) is on **`IntelligenceOptions`** — the LLM router —
not the spawn path, so the quoted *"a gating call is ALWAYS non-deferrable"* safety property does
**not** transfer.

---

## ⭐ THE REAL DEFECT — re-derived, and closed from three directions

> **A gate answering "there is no work to do" is recorded as a failure and consumes the retry budget.**

- **Source:** `if (!await this.runGateAsync(job)) { this.scheduleRetry(slug, 'gate'); return 'skipped'; }`.
  `skipReason` appears only in the log string — it never affects whether the ladder advances.
- **Ladder:** `1m · 5m · 15m · 30m · 1h · 2h` then *"exhausted 6 retries — waiting for next cron window"*.
- **Control:** gate skips fire abundantly in hours with zero memory pressure (above).
- **Direct observation:** `insight-harvest` walking `retry 1/6` → `6/6`, every line reading `(gate)`,
  **exhausting three times today** (06:19Z, 10:55Z, 20:54Z) — matching its three cron windows
  (`0 */8 * * *`).

**The gate's own comment calls it "zero-token pre-screening."** A `no` is the pre-screen *succeeding*.

**Two further facts:**
- **Gate skips are NOT recorded in the skip ledger** — every other skip path calls `recordSkip` first;
  the gate path does not. So the surface that explains non-execution is blind to the dominant case
  (252 gate skips across three jobs).
- **The cost:** 7 gate executions per cron window instead of 1. But the real harm is that when work
  *does* arrive mid-window, the job is in a 1–2h backoff. **A job is penalised for having been idle,
  by the mechanism meant to recover it from failure.**

**Design constraint found before proposing (do not lose this):** `identity-review`'s gate mixes a
health probe **and** a file test, so a fix keying on *"gate said no"* cannot distinguish *no work*
from *precondition absent*. **The gate probably needs to signal which**, rather than the scheduler
guessing. `retryState` has only five readers (shutdown sweep, `scheduleRetry`, `clearRetryState`×4) —
no metric, no alert, no external surface — so the blast radius is contained.

---

## ⭐ THIS AGENT HAS NO `soul.md` — and the job that would notice is gated on it

- `.instar/soul.md` — **absent on echo**. **Control: bob, instar-codey and mmtestmini all have one.**
- `identity-review` (shipped, enabled, daily 03:00) gates on `test -f .instar/soul.md` → **72 gate
  skips, 5 exhaustions, never once run.**
- `session-start.sh:227` is `if [ -f "$INSTAR_DIR/soul.md" ]` — **that branch has never fired here.**
  A context layer the hook is written to inject is silently absent at every session start.

**Deliberately NOT fixed.** Generating one to satisfy a `test -f` is how a check becomes a formality.
Authoring it is self-definition, not repair — it is with the operator.

---

## The re-alignment beat failed THREE distinct ways today, each quieter than the last

1. **Refused at spawn** (16:00–20:00Z, 5 consecutive) — visible as `spawn-error`.
2. **Lost to a server restart** (15:00Z) — no record at all.
3. **Ran, recorded `success`, produced NONE of its three outputs** (22:00Z) — invisible to every
   existing signal. *(The scheduler's "no meaningful output" line is NOT a tell — it fires on all
   seven successful beats today. Checked.)*

Restored by hand at 20:03Z and 22:07Z: `node .instar/scripts/realign-digest.mjs` (needs no session;
give it ≥180s). **Mode 3 is detectable only by comparing the artifact's own timestamp to the clock** —
which is the level-triggered stale-anchor check, the one component reviewers agreed is independent of
the memory work. It now has live evidence.

---

## Tools built this window — REACH FOR THESE

Committed at `docs/audits/phase-a/tools/`, documented in that directory's README with triggers.

| tool | when |
|---|---|
| `watch-for.sh` | about to watch something change. `--not-before <ISO>` makes a baseline captured **after** the event a refusal, not a meaningless "unchanged" |
| `spans-window.sh` | about to say "nothing found" over a time range. Refuses a corpus that does not span the claim |

**Both were verified with a control per output path**, including the ones that matter (can it return
*changed*? can it return *does-not-span*?).

**Why they exist:** five instances of the same measurement error in one day, one published to the
operator and retracted. The written rule failed again **90 minutes after I wrote it**. Then the guard
demonstrated both halves within one hour: armed with a contaminated baseline at 21:00 it gave a FALSE
negative; armed correctly at 22:00 it gave a TRUE one.

**`/jobs/history` slides.** Same 400-row query covered `09:00Z→` early in the evening, `09:35Z→` ninety
minutes later, `10:30Z→` after that. Re-measuring at claim time catches a changing *value*; it does
**not** catch a shrinking *corpus*. Use `spans-window.sh`.

---

## Operational facts recorded this window (already in the self-knowledge store)

- **Codey's Telegram-wired instance is `http://mac.lan:4044`** — **NOT 4046**, which on that machine
  is a *different agent* called `inspec`. A second `instar-codey` runs on the Mini at `localhost:4046`.
- Auth for either: the instar-codey vault token (`node .instar/scripts/secret-get.mjs authToken` from
  `~/.instar/agents/instar-codey`) **plus** header `X-Instar-AgentId: instar-codey`.
- **Identify ANY instar server without credentials:** send a garbage bearer + a wrong
  `X-Instar-AgentId`; the 403 body names the expected agent id. This is what untangled the above after
  I spent twenty minutes probing the wrong agent and wrongly concluded my access had been revoked.
- The instar repo lives at `.build/instar`; `instar worktree create` does **not** find it (its
  candidate list omits that path). Create worktrees with `git -C .build/instar worktree add` and set
  `user.name`/`user.email` immediately.

---

## OPEN — with the operator, not with me

1. **Option C.** I recommended **withdrawing the build approval** (sent 22:12Z) and specing the
   gate-skip fix instead. Awaiting ruling. Round-1 findings are durable at
   `docs/specs/reports/memory-pressure-degraded-tier-round1-findings.md` on branch
   `echo/option-c-degraded-tier`.
2. **Codey.** Both approved spawn attempts spent. Attempt 1 died in transport (verified no session
   created against a baseline); attempt 2 landed — session `echo-pathway-wake` ran ~6 min, **did none
   of the three charter items**, exited silent. Codex quota ruled out (99% remaining). Pane not
   capturable — his API exposes no per-session output route. Diagnosis handed over per the cap.
3. **`soul.md`** — whether I author one.
4. **The four bundled pieces** — reviewers say separate blast radii, approve separately. My read: the
   tier and the priority plumbing are inseparable; the stale-anchor reconciler is fully independent
   and is the piece with live evidence.

## Shipped this window

- **PR 1854 merged** (`96416dfc2`) — the tone-gate not-a-defect conclusion, the converged
  supervisory-layer finding, both guards, the corrected test plan.
- **Branch `echo/option-c-degraded-tier`** — round-1 findings catalog + the re-derivation + the
  soul.md finding. **No source changes. Nothing built.** Phase 0 of `/instar-dev` correctly refused
  the build (no convergence tag, `approved: false`) and I did not route around it.

## One thing to carry as method

The convergence gate I argued for running rather than around returned, in **one round**, three
refutations of my own central claims — two of which I had already handed the operator as measured
fact. **Run it. It is not ceremony.**


---

## ⭐ ADDED 22:35Z — I finally opened the project, and it changes the shape of the work

**Correcting an earlier belief in this same document is deliberate: read this section over anything
above that conflicts.**

`convergence-towards-coherence` is **not** a waiting list. **Nine of twelve items are
`pipelineStage: merged`** with PR numbers. Rounds 0–2 are `complete`. The remaining work is **items
10, 11, 12** — three, not twelve.

**Round 3 ("Tier 4 — Layered self-awareness") is the next round**, and both its outstanding items now
have measured evidence from this window. Neither required building anything.

### Item 11 — *"the structure exists with zero nodes and reports freshRatio 1"* — CONFIRMED, sharper

`GET /cartographer/health?topicId=<topic>` (note: **`topicId`**, not `topic` — a bare `?topic=` gets
`409 topic-binding-required`, which I misread as a stale binding for several minutes):

```
nodeCount 2148 · authoredCount 0 · neverAuthoredCount 2148
staleCount 0 · freshCount 0 · sweepEnabled false
snapshot generated 17:01:43Z (age 5.4h) · snapshotStale false
```

**`staleCount: 0` is the finding** — nothing is stale because nothing was ever written. And this is
**item 1's class**, which **shipped 2026-07-26 as PR 1649** (*"the panel said 'Routing is healthy'
over ZERO…"*). The fix reached that panel and not this surface.

### Item 10 — *"drift means changed-without-anyone-deciding"* — the detector can only see CHANGED

`/guards` separates `dark-default` (11, correctly quiet) from `diverged-from-default` (7). Of those
seven, **five have a tripwire decision record and two have NONE**
(`monitoring.autonomousHeartbeat.enabled`, `monitoring.blockerLedger.enabled`).

**The tripwire fires on a TRANSITION.** A guard that *arrived* off never transitions, so it never
produces a record — drift with no change event, structurally invisible to the detector meant to
notice drift. And the records that exist are **batch acknowledgements** (three sharing a creation
date; two resolved at an identical timestamp five weeks apart): *dismissed* is not *decided*.

### Why round 3 cannot advance here

Both items need **builds**, and a build needs the spec chain (spec → `/spec-converge` → operator
`approved: true`). That chain is exactly where option C stopped. **So the measurement is done and the
building is gated** — this is a genuine stopping point, not a stall.

## Two behavioural corrections from late in the window

1. **I applied a lower evidence bar to a self-critical claim than I would to a favourable one.** I
   sent the operator a holistic review saying I had "re-derived the plan from scratch" without
   checking whether the items were done. Nine were. The check took ninety seconds on an object I
   already had open — I read its title, and stopped, because the title confirmed the story.
   **The bias is toward the STORY, not toward a direction.** Self-criticism is not exempt.
2. **The tone gate caught a style drift I had been justifying.** The anchor's *"fewer, denser
   messages — detail goes to links"* is a MESSAGE-COUNT instruction; I had converted it into a
   writing-style permission, and reports drifted 3,652 → 3,197 → 3,176 → 3,048 chars, each more
   nested, into a channel he has twice called unreadable. Complied; 3,048 → 1,762.
   **Detail belongs in the artifact the message points at, not in the paragraph.**


---

## ⭐⭐ ADDED 23:16Z — READ THIS BEFORE TRUSTING ANY FINDING ABOVE

**Late in this window I called three working mechanisms broken.** All three ran the same direction,
and the direction matters more than any individual error:

| # | I claimed | actually |
|---|---|---|
| 1 | the cartographer's `409` meant a stale topic binding | binding was live; **I passed `?topic=` when the route reads `topicId`** |
| 2 | I had "re-derived the plan from scratch over nineteen hours" | **nine of twelve items were already shipped**, some over a week earlier |
| 3 | "the digest deliberately hid a direct question from the operator" | `36966` is the **Observer's** topic, manager-only by the operator's own rule; messages there reach me **by relay**. I saw it early and mislabelled early as deprived |

**Why this happened, and why the next session is exposed to it too.** This window's story became
*"the system is full of mechanisms that lie."* It is a true story — the gate-skip defect, the beat's
three failure modes, `staleCount: 0` over an unauthored map are all real. **But twenty hours of
finding genuine instances of a real class leaves you primed to see the class where the mechanism is
simply doing its job.**

> **System-criticism needs the same evidence bar as self-criticism.** I wrote the self-criticism rule
> at 22:31Z and failed its mirror three times in the following forty minutes.

**Practical test before filing any "X is broken":** *what would this look like if X were working
correctly and I had used it wrong?* All three above collapse instantly under that question.

## My own guard has the defect it was built to prevent

`watch-for.sh` reported **CHANGED** for the 23:00Z beat. The beat was **REFUSED**; the row it saw was
**my own hand-restore**. It answers *"did the target change?"* — **never** *"did the actor I care
about change it?"* Correct on its literal contract, wrong on the question asked. Caveat now ships in
the script header and the README; `--expect-matching` is the real fix and is **recorded, not built**.

**It cost nothing only because I learned the refusal by a different route.** Relying on the tool
alone, as its own README instructs, would have written "the 23:00 beat ran" into the journal that
records it refused.

## The beat's full day — the honest number

**Seven of twelve hourly slots failed, in three distinct modes, needing a person three times**
(hand-restored 20:03Z, 22:07Z, 23:05Z). The 15:00 slot has **no record at all**. The 22:00 slot
**reported `success` and wrote nothing**.

**And the flap, caught live at five-minute granularity:** `22:45 REFUSED · 22:50 success ·
22:55 REFUSED · 23:00 REFUSED`. Adjacent ticks disagreeing — **stronger evidence than the 79→61 swing
the original spec cited**, which a reviewer correctly flagged as unsourced. This is the one piece of
the failed option C spec that survived review.

## Reading the operator

`telegram-messages.jsonl` filtered on `fromUser === 'true'` is the **record**; the digest is a
**convenience scoped to this topic**. On 2026-08-04 he sent **37 messages across all topics, 17 here**.
Read unscoped for **early awareness** — but **do not act on another agent's mail before it is
relayed.** A gap between the anchor's `last inbound` and the digest means *"a message exists that is
not addressed to me."*

**Two of his that are live and unanswered as of 23:16Z:**
- **22:20Z (36966, to the Observer):** *"have we made any progress in regards to the main plan?"* —
  I answered via 29723 at 23:14Z.
- **19:32Z + 19:49Z (7848, alerts hub, ambiguous ownership):** *"the attention messages have become
  completely unmanageable… We need to lock this down now"* / *"Silent"*. **Not acted on** — surfaced
  with numbers (34 created today here, 4 since he said it, **102 still open**) and asked whether it
  is mine. The numbers say the backlog is the problem, not the creation rate.
