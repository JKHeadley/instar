---
title: "Guard Enumeration Fail-Distinguishable (slug: fail-visible) — a guard that cannot look must not report a clean zero"
slug: "guard-enumeration-fail-visible"
author: "echo"
parent-principle: "Verify the State, Not Its Symbol"
eli16-overview: "guard-enumeration-fail-visible.eli16.md"
status: "draft"
approved: false
---

# Guard Enumeration Fail-Distinguishable

*(slug and filename remain `guard-enumeration-fail-visible` — see the overclaim note below.
The title carries the accurate word so every downstream reference that quotes it inherits the
correction rather than the aspiration.)*

## The normative contract, in one screen

*Round-7 review: this document mixes design, review history, and process doctrine, and the
actual contract is hard to extract. Everything binding is collected here; every later section
is **non-normative** — rationale, evidence, or history.*

**This section is AUTHORITATIVE. If a later section disagrees with it, the later section is
wrong.** The first draft of this note said the opposite — that the detail sections outranked
this one — which round-9 review correctly called out as defeating the entire purpose of a
normative summary. It also had a specific failure mode this document had already
demonstrated three times: when the contract lives in prose spread across 900 lines,
contradictions accumulate faster than review removes them (the persistence claim was found
wrong in rounds 1, 6 and 8, each time in a *different* paragraph). A single authoritative
section is the structural fix; deferring to the prose was reproducing the defect.

**Result type** (internal, shared by both guards):

```ts
type WorktreeEnumeration<T> = { ok: true; worktrees: T[] } | { ok: false; error: string }
```

`error` is **already sanitized** at construction (message only, control chars stripped, single
line, ≤300 chars). Callers must narrow on `ok` — that is the point of the type.

**HTTP fields** — `GET /worktrees/agent-reaper`, `GET /orphaned-work`:

| Field | Success | Failure |
|---|---|---|
| `enumerationOk` | `true` | `false` |
| `enumerationError` | `null` (always present) | sanitized string |
| `reclaimable` / `orphanedCount` | `number` | `null` |

Both return **200** in both cases. Branch on `enumerationOk`, never on a count.

**Which surface to POLL — binding guidance, not a preference.** Automated, repeating polling
belongs on **`GET /guards`**. The two live routes above are **manual diagnostics**: they
enumerate synchronously per request and can block the server's event loop for up to 30s
(see *Bounded reads*), so a monitor or dashboard on a short interval turns a slow git into an
availability incident. `/guards` reads in-memory state recorded by the background pass and
carries no such cost.

This constraint is stated **here, in the normative section**, rather than deferred with the
hazard itself: round-8 review observed that the earlier draft told clients to branch on
`enumerationOk` from the live routes while acknowledging those routes are dangerous to poll —
promoting an endpoint and warning about it in different sections. The field contract above is
correct for *whoever calls* those routes; it is not an invitation to call them on a timer.

> **UNRESOLVED — and the reviewer is right.** Round-9 review answered the paragraph above
> with: *"tracking `CMT-1123` is not a technical guardrail."* That lands, because it is this
> project's own **Structure > Willpower** standard turned against this document — a written
> instruction not to poll an endpoint is precisely the "1,000-line prompt is a wish" that the
> standard rejects. Nothing here *prevents* a dashboard from polling the blocking route.
>
> This is the single most-repeated finding of the entire review run — raised in rounds 4, 5,
> 7, 8 and 9, escalating each time from "subprocess multiplication" to "event-loop stall" to
> "and this spec makes it more attractive to poll." It is recorded as an **open finding on
> this spec**, not as something the guidance above closes. The minimal honest options are a
> route-level concurrency bound or the cached-read/live-probe split; both are `CMT-1123`, and
> neither is implemented here. A reader deciding whether to approve this change should weigh
> that gap directly rather than treating the polling guidance as a mitigation.

**`GET /guards`** gains the effective state **`on-blind`** — *the guard ran but its
enumeration failed, so its verdict carries no information*. It sits below `on-stale` and
`on-dry-run` and above `on-confirmed` in the precedence table, and joins the
load-bearing-uninspectable set. Two optional runtime fields carry the detail:
`verdictUnknown` (strict boolean; **absent** means *not applicable*, never *verified fine*)
and `verdictUnknownReason`.

**Persistence** — the failure *history* (`enumerationFailures`, `lastEnumerationFailureAt`)
survives restart; the *current blind state* does not. `on-blind` is process-local.

**Non-goals, each tracked — with the acceptance criterion that closes it.** Round-9 review
noted that citing IDs reads as process faith to anyone who cannot see the tracker, and that
tracking is not itself closure. Correct on both counts; the IDs are out-of-band and are
**not evidence that anything is done**:

| Item | Owns | Closed when |
|---|---|---|
| `CMT-1103` | alerting | an operator learns of a blind guard **without querying** — exported metric or attention raise — plus `enumerationErrorCode`, and a migration of the persisted failure history to carry it (not just future responses) |
| `CMT-1122` | fleet audit | every guard deriving safety from filesystem/process enumeration has its invalid-input behaviour asserted by test, or a recorded reason it is exempt |
| `CMT-1123` | availability | `GET /worktrees/agent-reaper` can no longer block the event loop — async execution, a concurrency bound, or a cached-read/live-probe split |

**Known gap, not a non-goal:** in the reaper's shipped **dry-run** default, a restart erases
the blind state entirely and the row is indistinguishable from a healthy guard until the
first pass. `on-blind` should therefore never be described as delivered without the
qualifier *"current process, after its first completed pass."* Closing it means persisting
the last enumeration outcome (`CMT-1103`).

## What this spec's own title overclaims — read this first

**"Fail-visible" names the destination. This change delivers fail-DISTINGUISHABLE.**

Cross-model review raised an overstatement in three consecutive rounds — the durability
claim (round 1), the thesis language (round 2), and now the title itself (round 3). Three
independent catches of the same shape is not three separate slips; it is a systematic bias
in this document toward describing the destination as if it had been reached. Naming it at
the top, because a reader who only reads the title should not be misled by it.

**What is actually true after this change:**

- A guard that could not look no longer reports the same value as one that looked and found
  nothing. That collapse is gone — structurally, at the type level. **This is the whole of
  what ships.**
- Anyone who READS the surface can now tell the two apart.
- **Nothing makes them look.** The transport still returns `200`, the counters are
  process-local, and there is no exported metric and no alert. A reader who polls neither
  surface nor the logs still learns nothing.

So the honest verb is *distinguishable*, not *visible*. Visibility — a durable last-known
state, an exported metric, or an operator raise — is `CMT-1103`, and this spec does not
deliver it. **The slug and filename are kept** to avoid breaking the PR, the convergence
report, and every existing reference; renaming files would be churn that buys accuracy the
paragraph above already buys. The claim is narrowed in prose instead, which is where the
overstatement actually lived.

**`CMT-1103` is hereby a stated prerequisite for anyone calling this work "fail-visible."**
Until it lands, the accurate description of the state is: *the false all-clear is removed;
the alarm is not yet built.*

## Live reproduction on the production agent, 2026-07-29

Measured on this agent's running server while writing this spec — not a historical anecdote:

| Observation | Value |
|---|---|
| `GET /worktrees/agent-reaper` → `worktrees` / `reclaimable` | `0` / `0` |
| Worktree directories actually present under the agent home | **38** |
| Disk they hold | **18 GB** |
| `git worktree list` run from the agent home | `fatal: not a git repository` |
| `git worktree list` run from inside a worktree (real root `.build/instar`) | **16** worktrees, listed fine |
| Reaper config | `enabled: true`, `dryRun: true` |

An enabled guard is reporting a clean zero while 18 GB of worktrees sit in front of it, and
git enumerates them perfectly well from the correct root.

**The cause, isolated with a positive control.** The reaper is constructed with
`instarRepo: config.projectDir` — the agent home. That directory is not a git repository;
the repository that *owns* these worktrees is the checkout nested inside it. The two calls,
run back to back:

```
git -C <agent-home>              worktree list --porcelain  → fatal: not a git repository
git -C <agent-home>/.build/instar worktree list --porcelain  → 16 worktrees, listed fine
```

The control matters: it rules out "git is broken" and "there is nothing to list," leaving
exactly one explanation — the guard is asking the wrong directory. (On a normal install
`projectDir` *is* the repository, which is why this went unnoticed; it diverges only where
the agent home contains its own checkout.)

**A second fact, and it makes the fix harder than "point at the right repo":** the agent home
contains **two** instar checkouts, and they share one `.worktrees` directory —
`.dev/instar` owns 20 of the worktrees and `.build/instar` owns 15. Across both, 36 of the 38
directories are live registered worktrees; only 3 are unregistered by either (~1.5 GB).

So the reaper's model — one repository, enumerated once — does not match the layout it is
deployed into. Pointing it at either checkout alone would still leave it blind to roughly
half the tree, while *reporting a confident number* for the half it can see. That is a
subtler instance of the same defect: not a visible failure, but a partial enumeration
presented as complete.

*(This correction is itself worth recording: the first pass of this analysis queried one
checkout, found 22 directories missing from its list, and labelled them orphans. They were
live worktrees of the other repository. An absence measured against one source was read as a
fact about the world — the same error class this spec exists to remove, committed while
documenting it.)*

**The part that is the whole argument:** from the outside, *I cannot tell which failure this
is.* `reclaimable: 0` is consistent with "there is genuinely nothing to reclaim" and with
"enumeration failed and the old code swallowed it into `[]`." Those are different problems
with different fixes, and the current API cannot distinguish them — which is precisely the
defect, observed live rather than reasoned about. After this change the same call answers
`enumerationOk: false` with the reason, and the ambiguity is gone.

It also explains an operational symptom this repo has already paid for twice: worktrees
accumulating unreclaimed (the 2026-07-02 25 GB accumulation) behind a reaper that was
enabled, running, and reporting nothing to do.

*(Secondary note for `CMT-1123`: this also made the route's latency unmeasurable — the
enumeration fails instantly, so the per-worktree evaluation never runs and the event-loop
cost never materialises. The hazard is real but currently masked by the very blindness this
change exposes.)*

## The defect, stated once

A guard whose input is a **path** can fail in two ways that are indistinguishable to
every reader:

1. It looked, and there was nothing to report.
2. It could not look at all.

`AgentWorktreeReaper` and `OrphanedWorkSentinel` both collapsed (2) into (1). Their
shared enumeration — `agentWorktreeGit.listWorktrees` — wrapped `git worktree list`
in `try { … } catch { return []; }`. Any failure of that command produced an empty
list, which the reaper rendered as `reclaimable: 0` and the sentinel as
`orphanedCount: 0`. Both surfaces simultaneously reported `enabled: true`.

**An error wearing the costume of an all-clear.**

## Why this needs a spec rather than a patch

This class has now reached production **twice, with unrelated causes**:

| | cause | symptom |
|---|---|---|
| 1 | `SourceTreeGuard` blocked every reaper git call | reported 0 reclaimable |
| 2 | `config.projectDir` named a nonexistent user directory | reported 0 reclaimable against 73 real worktrees |

The first was fixed **at its cause** — permit the reads — and a regression test was
added for that specific blocker. The swallow survived, so the class recurred with a
different cause roughly a month later. The second occurrence hid, for an unknown
duration:

> **Correction to this spec's own history (added 2026-07-29, after the fact).**
> Occurrence 2 was **not** newly discovered by this work. It was found and reported
> **28 hours earlier**, on 2026-07-28, with the same diagnosis — the two-layer swallow,
> the resolver that cannot find the repo, and a seventeen-site sweep — and the finding
> was filed. Six days before *that*, `ACT-935` ("a check that CANNOT run must not be
> indistinguishable from one that ran clean") recorded the same class with a different
> first example. **The author of this spec then rediscovered all of it and wrote it up
> as new.**
>
> This is left in rather than quietly corrected, because it sharpens the argument the
> spec is making. The defect is not merely that a guard fails silently; it is that a
> silent failure **produces no durable pressure toward its own fix**. Occurrence 2 was
> *seen, diagnosed, and filed* — and still shipped unfixed for another day, because
> nothing about the system made the open finding resurface. A spec that says "this
> recurred twice" understates it: it recurred twice, was *caught* a third time, and
> still required a fourth pass to become code.
>
> Read that way, `enumerationOk: false` + a log line + a counter are not bookkeeping.
> They are the minimum machinery by which this defect can ever generate the evidence
> that gets it fixed.

- 73 worktrees (50 genuinely reclaimable, ~29 GB) reported as nothing to reclaim.
- One worktree holding **292 uncommitted lines** on `PermissionPromptAutoResolver`
  — an always-on safety floor — reported as no stranded work, idle 20 hours.

Fixing cause (2) as well would leave the property intact and invite occurrence (3).

## The rule

> **A guard must be able to say "I could not look", distinctly from "I looked and
> found nothing". A signal that cannot be determined must never resolve to the
> permissive answer.**

This is not new to the codebase — it is already `isClean`'s documented contract in
the *same file*: *"FAIL-CLOSED on any error: cannot determine cleanliness → treat as
dirty (KEEP) … a transient `git status` failure must never make a worktree look
reapable."* The enumeration simply never received the same treatment.

## What changes

**`agentWorktreeGit.listWorktrees` returns a typed three-state result instead of
swallowing.** Both consumers were *already* written to distinguish these cases —
`reap()` aborts the pass, each `snapshot()` reports the failure — but the deps layer
never let the failure reach them. The result type both activates that existing handling
and makes it unskippable for any future caller (see below).

**`AgentWorktreeReaper.snapshot()` stays non-crashing but stops fabricating.**
The route must never 500, so the catch remains; what changes is what it reports:

| field | before | after (enumeration failed) |
|---|---|---|
| `reclaimable` | `0` | `null` |
| `enumerationOk` | *(absent)* | `false` |
| `enumerationError` | *(absent)* | the git error text |

`null` is the load-bearing choice. Zero is a **measurement**; this is an **absence**.
Callers that want a number must decide what unknown means for them rather than
inheriting a fabricated zero.

**`OrphanedWorkSentinel.snapshot()` gets the identical contract.** This was missed in
the first draft and caught by external review — a material omission, because the
sentinel *shares* the reaper's enumeration (`orphanedWorkGit` delegates to
`base.listWorktrees`) and so inherited the same swallow at its own `catch`:

| field | before | after (enumeration failed) |
|---|---|---|
| `orphanedCount` | `0` | `null` |
| `enumerationOk` | *(absent)* | `false` |
| `enumerationError` | *(absent)* | the git error text |

For a backstop whose entire purpose is noticing work nobody else will, reporting the
reassuring answer precisely when blind is the worst available failure direction. Fixing
only the reaper would have repeated this spec's own criticism — addressing an instance
and leaving the property.

### Response contract and consumers

Both `snapshot()` returns are **API response shapes**, served directly by
`GET /worktrees/agent-reaper` and `GET /orphaned-work` (each `res.json(...snapshot())`,
no intermediate mapping). So the count fields widen from `number` to `number | null`
for clients.

Consumers were enumerated rather than assumed, and the enumeration was **widened past
`src/` after external review pointed out that source-only is not enough for an HTTP
contract change**:

- **In `src/`:** both routes pass the snapshot straight through (`res.json(...)`, no
  intermediate mapping); no other call site consumes either `snapshot()`.
- **Outside `src/`:** `orphanedCount` is read by three test files (unit, integration,
  e2e) — all pass, because a healthy enumeration still returns a real number and the
  e2e's `orphanedCount === 1` assertion is untouched. `reclaimable` is read only by the
  reaper's own unit test; the other matches in `tests/` are unrelated bare-word hits in
  different features (verified individually, not by count).
- **No OpenAPI/client schema exists** in the repo, and no dashboard/frontend file
  references either route (`grep` over `*.html`/`*.tsx`/`*.jsx`).
- **Typecheck** (`tsc --noEmit -p tsconfig.json`) is clean with the widened types.

Scope of the compatibility claim, stated honestly: it covers **typed in-repo consumers
plus the test suite**. An out-of-repo script that parsed these routes and assumed a
number is not something this repo can see; the mitigation is that the widening is
breaking-by-design rather than silent.

Widening is deliberate and breaking-by-design for anyone typed against `number`: that
compile error is the point. A client that silently coerced `null` to `0` would
reproduce the defect one layer out.

### `enumerationError` — exact shape and trust boundary

Both surfaces build the field through **one shared helper**,
`summarizeEnumerationError` (exported from `AgentWorktreeReaper`), so the two cannot
drift apart. Its contract is deliberately narrow:

- **`Error.message` only — never a stack.** A non-`Error` throw is `String(err)`.
- **Control characters stripped first** (C0 and C1, `U+0000–U+001F` and `U+007F–U+009F`).
  A whitespace collapse alone leaves `ESC` intact, and git/path output can carry ANSI
  escape sequences that a terminal reading the server log would interpret. Caught by
  external review; sanitizing at the source is cheaper than trusting every downstream
  renderer.
- **Single line.** All remaining whitespace runs collapse to single spaces.
- **Length-clamped** to `MAX_ENUMERATION_ERROR_CHARS` (300), ellipsis-truncated. An
  unbounded upstream git error must not become an unbounded HTTP response field.

**Where sanitization happens: at the enumeration boundary, once** (round-6 review asked
whether `WorktreeEnumeration`'s `error: string` is raw or already sanitized — a real
question, since logs, events, HTTP, and future automation have different trust needs).

Verified in the source: `summarizeEnumerationError` is applied **inside `listWorktrees`
itself**, at the point the failure is constructed, and again in the reaper's defensive catch
for a dep that throws in violation of its contract. So:

> **`listWorktrees` only ever returns the sanitized public string.** There is no raw variant
> in the type, and no consumer needs to re-sanitize.

That is the deliberate choice over an internal-raw-plus-per-boundary-sanitizer design. A raw
field in the shared type would mean every consumer — response, log line, event, and any
future automation — has to remember to sanitize, and one that forgets leaks ANSI escapes into
a terminal or an unbounded string into a response. Sanitizing at construction makes the unsafe
form unrepresentable rather than merely discouraged, which is the same reasoning as the
three-state result itself.

The cost, stated: a future consumer that genuinely needs structure (an error *code* for
automation) cannot recover it from the clamped string. That is exactly why
`enumerationErrorCode` is required — not optional — in `CMT-1103` rather than parsed back
out of this field.

**The counter-proposal, and why it is not taken now.** Round-7 review argued for carrying a
structured error internally today — `{ ok: false, error: { message, code?, path? } }` — with
only the public route flattening to text, on the grounds that sanitizing at construction
"bakes in an API shape future automation cannot use."

Half of that is right and half overstates. Right: a structured internal error is where this
ends up, and `enumerationErrorCode` is already committed to. Overstated: **nothing is baked
in**, because `WorktreeEnumeration<T>` is an internal type with two consumers in one
repository — widening it later is a compile-error-guided refactor, not a published-contract
break. The thing that *would* be baked in is the HTTP field, and that stays a flat sanitized
string under either design.

The reason to wait is that the structured version only pays off once a `code` taxonomy
exists, and inventing that taxonomy is the part with real design content: the known triggers
(repo missing / git unavailable / permission denied) are exactly what a reviewer of
`CMT-1103` should argue about, not what this change should guess at while adding a reporting
state. Shipping `code?: unknown` now would create a field with no producer and no
enumeration — the unconsumed-affordance pattern this document rejects elsewhere.

**What that concedes:** if `CMT-1103` slips, the sanitized string is the only cause data
anyone has, and it is not machine-parseable. That is a real cost of sequencing, named rather
than argued away.

The message does contain the absolute repo path (and therefore a username) and command
details. Both routes are **Bearer-authed and operator-facing** — the same trust tier
that already serves session names, file paths, and config state. That detail is
retained deliberately: the 2026-07-29 occurrence would have been diagnosed instantly by
reading it, and a sanitized error code would have hidden exactly the fact that mattered
(*which path* it could not reach).

The boundary that must hold: these strings are **operator diagnostics, not user-facing
copy**. Anything relaying them onward (a chat reply, a notification) is already subject
to the outbound path-leak guard — that is where filtering belongs, not at the diagnostic
source, where it would blind the reader it exists to serve.

**The log line has a wider audience than the route, and that is accepted knowingly.**
External review made the point: a Bearer-authed response has one reader, whereas the
server log may be shipped to centralized logging with a broader one. The same path and
username therefore land in both. This is accepted rather than mitigated because the
server log **already** carries agent-home paths throughout — session names, worktree
paths, config locations — so this line adds no category of information the log did not
already hold, and splitting it (sanitized log, full response) would put the *less*
useful text where the diagnosis actually happens. If the log's trust tier is ever
tightened, this line should be revisited with the rest of them, not alone.

**Where the helper lives.** `WorktreeEnumeration`, `MAX_ENUMERATION_ERROR_CHARS`, and
`summarizeEnumerationError` sit in their own module (`worktreeEnumeration.ts`), not in
the reaper. Having the sentinel import its diagnostics *from the reaper* would couple
two independent guards through an accident of which was written first. Neither owns the
contract. (`AgentWorktreeReaper` re-exports them so existing importers are unaffected.)

### The typed three-state result — structure, not convention

`listWorktrees` returns `WorktreeEnumeration<T>`:

```ts
type WorktreeEnumeration<T> =
  | { ok: true;  worktrees: T[] }
  | { ok: false; error: string };
```

The three states — success-nonempty, success-empty, failure — are now explicit, and
**a caller cannot reach `worktrees` without first narrowing on `ok`.** Forgetting the
failure branch is a compile error, not a silent zero.

**An earlier draft of this spec chose a throw instead, and defended it** — both
consumers already had catch blocks, so throwing was the smaller diff against a
safety-adjacent risk floor, with the caller obligation documented in JSDoc. Two
independent reviewers rejected that in the same round: the external cross-model pass
("`listWorktrees` remains a deceptively simple name for a function that can now throw")
and the constitutional gate, which named it precisely — *the spec knowingly leaves the
future-caller safety property to JSDoc and convention instead of adopting the typed
three-state result it identifies as the structural way to force callers to
distinguish.*

They were right, and the reason is this document's own thesis. A spec whose argument is
*fix the property, not the instance* cannot fix the property with a comment. Under
**Structure beats Willpower**, a documented obligation is a wish; a type is a
guarantee. The earlier draft would have left the next caller exactly as unprotected as
the one that wrote the original swallow.

Scope of the refactor, since it touches deletion-capable components: it is confined
entirely to the **enumeration boundary**. `evaluate()`, the keep/reap classifier, and
the removal path are untouched — **the deletion-eligibility logic is unchanged**, so
the set of worktrees that can be removed is the same before and after. (An earlier
draft said "byte-identical", which external review correctly called an overclaim:
`reap()`'s *operational* behaviour does change — it now aborts the pass on a failed
enumeration instead of processing an empty list. That is the intended change; the
wording just claimed more than it should.) Four call sites and ten test fakes narrow on
`ok`; nothing else moves.

### A hazard this change created, and closed

Making enumeration failure reachable turned a previously-**dead** `emit('error')` into
a live one — and Node's `EventEmitter` special-cases `'error'`: **emitting it with no
listener throws.** Nothing subscribes to either component in production, and `reap()`
and `scan()` wrap their bodies in `try { … } finally { … }` with no `catch`. So the
throw would have escaped as an unhandled rejection from the interval callback —
**precisely in the enumeration-failure case this change exists to handle.**

The fix is a named, non-special event: `enumeration-failed`, carrying `{ error }`.
Same information, no special-casing, and a caller who is not listening is unaffected.

Two tests pin it, both verified to fail against the `emit('error')` version: `reap()`
resolves normally with **zero** `'error'` listeners attached, and the named event fires
with the reason. This is worth recording rather than quietly fixing — a change that
makes a dormant path reachable inherits whatever was wrong with that path, and here the
dormant path was fatal.

A defensive `try/catch` remains at both snapshots for a dep that throws in violation of
its contract (the route must never 500), with a test covering it. That is a backstop,
not the mechanism — the type is the mechanism.

## Out of scope — and where it is tracked

This spec does **not** fix the path resolution that triggered occurrence (2). Both
guards assume `config.projectDir` *is* the instar repo — true for an agent whose home
is the checkout, false for one whose worktrees belong to a separate build checkout.
That is a distinct change with a distinct risk profile. **This spec ensures the next
such mis-wiring is visible rather than silently reassuring**; it does not prevent it.

**That out-of-scope work is registered, not deferred** (No Deferrals / Close the Loop):

- Handed to `instar-codey` as a build brief over Threadline on 2026-07-29
  (thread `4421c0fe-d155-422b-a6a2-20cd71a21ed9`), including the earning test and the
  squash-merge trap that defeats an ancestry-based merge check.
- Surfaced to the operator as an open HIGH attention item,
  `stranded-work-act1426-v3`, which carries both the 292 stranded lines and the
  misconfiguration that hid them.

Neither reference is a promise to remember; both are durable records that resurface
independently of this spec or its author.

**The fleet-wide "ask every path-input guard what it reports on invalid input" audit is
deliberately NOT proposed here as a work item.** Raising an obligation this change does
not carry would be exactly the untracked follow-up the constitution forbids. The
generalisation is recorded as a *lesson* in the rule section above, where it costs
nothing and claims nothing; if it is ever worth running as an audit, that is its own
scoped change with its own registration.

## The `/guards` follow-up — built, and a deliberate divergence from the convergence report

The convergence report for this spec carried one unresolved finding: the change ships
response fields, a named event, a log line and counters, but no *live* state that survives a
restart and nothing that pages anyone. (The failure *history* does persist — the persistence
model has the field-by-field split.) Its proposed home:

> the existing guard-posture surface (`GET /guards`), where a guard whose enumeration is
> failing should read `errored` rather than `on-confirmed`.

**That suggestion is NOT taken, and the reason matters more than the outcome.**

`errored` means *this guard's status could not be READ* — its getter threw, or returned a
value that is not a status. A guard whose **enumeration** failed is perfectly readable. It
is reporting a true and specific fact about itself: *I looked and could not see.* Routing
one into the other would render "I could not look" identically to "I looked and found
nothing" — **the exact collapse this spec exists to remove, reproduced one layer up inside
the surface built to expose it.** Taking the report's wording literally would have made
`/guards` commit the defect that `/worktrees/agent-reaper` had just stopped committing.

**What was built instead:** a distinct `on-blind` effective state, fed by an explicit
`GuardRuntimeStatus.verdictUnknown` (+ `verdictUnknownReason`) that a guard sets about
itself. It ranks **below `on-stale`** (a guard that stopped ticking is the deeper failure;
a blind guard is at least alive) and **above `on-confirmed`** (blindness must never render
as protection). It generalises: any guard that enumerates something can go blind, not only
this reaper.

**Two defects surfaced while wiring it, both recorded because neither was findable by
reading:**

1. **The reaper was never instrumented at all.** It appeared in the guard manifest with
   `expectRuntime: false` and registered no runtime getter, so `/guards` reported
   `runtime: null, runtimeReason: "not-instrumented"`. It could not reach `on-confirmed` —
   which means the report's premise ("should read `errored` rather than `on-confirmed`")
   described a state this guard could never occupy. Wiring a signal into a getter that did
   not exist would have been inert. Fixed by adding `guardStatus()`, registering it, and
   flipping `expectRuntime: true` so a config-on reaper that fails to construct reads
   `missing` instead of being silently uninstrumented.
2. **A blind pass made the guard look dead.** The failed-enumeration branch returned early
   without advancing the tick timestamp, so a reaper that ran and ticked but could not see
   reported `on-stale` — "stopped ticking", a different and wrong fact about itself. Fixed
   by recording the pass on the failure path: the pass happened, it simply produced no
   verdict.

**One boundary resolved by consistency rather than preference:** `on-dry-run` outranks
`on-blind`, so a dry-run blind guard still reads `on-dry-run`. The precedence table already
makes the identical call for `on-stale` ("watching but toothless; stale stays visible in the
runtime block"). Promoting blindness above dry-run while leaving staleness below it would be
an inconsistent, unilateral change to an established rule outside this change's scope. The
blindness is not lost: the closed runtime projection carries `verdictUnknown` and its reason
onto the row regardless of the headline state.

**What this does and does not close — corrected after cross-model review (round 1).**

The first draft of this section claimed `on-blind` gives the failure a *"durable,
restart-surviving home."* **That was overclaimed, and the external reviewer caught it.**
Verified against the implementation rather than argued:

- **`/guards` recomputes blindness LIVE on every read.** The row is derived from config plus
  the guard's current runtime each time the endpoint is hit; nothing about the state itself
  is stored.
- **The runtime input is PROCESS-LOCAL.** `AgentWorktreeReaper.lastEnumerationOk` starts
  `null` and is never restored at construction. Only the failure *history*
  (`enumerationFailures`, `lastEnumerationFailureAt`) is persisted and reloaded.
- **Therefore, after a restart the guard is neither blind nor confirmed-clean until its
  first pass completes.** `null` deliberately means *no pass yet* — distinct from both
  `true` and `false`, and pinned by the test "a reaper that has NEVER run does not claim a
  clean verdict."

**Stated exactly, since the whole spec is about not overstating what a signal proves:** the
DURABLE artifact is the failure history; the LIVE state is `on-blind`; the two are different
things and the earlier wording ran them together.

**And the thesis is narrowed to match, per round 2.** This change makes silent failure
*answerable* and *recorded* — it does NOT yet make it *pressing*. There is no exported
metric, no alert, and no persisted last-known state; a reader who polls neither surface nor
the logs still learns nothing. The spec's opening argument that silent failure must create
durable pressure toward repair describes the DESTINATION, and this change is one step of it:
it removes the false all-clear. Turning that into pressure is `CMT-1103`'s scope, and
claiming otherwise here would be the same overstatement the reviewer caught once already. A restart therefore resets the *reported
state* to its base until the next pass — a real, remaining gap, named here rather than
papered over. Closing it would mean persisting the last enumeration OUTCOME (not just the
failure count, which cannot distinguish "failed and recovered" from "failing now") — a
distinct change with its own risk surface, deliberately not smuggled in here.

It also still does not PAGE anyone — an operator-facing raise remains out of scope under
*Self-Heal Before Notify* and remains tracked as `CMT-1103`.

**Three further review findings, addressed:**

- **"Three-state" overstates the type guarantee.** Accurate. Only the *failure* variant is
  structurally distinct; success-empty vs success-nonempty still requires reading
  `worktrees.length`. The name is kept for continuity with the existing type, but the
  guarantee is restated honestly: the union makes the FAILURE branch unskippable, and that
  is the only structural claim it earns.
- **`enumerationError` is string-only.** Deliberate at the API boundary — the string is
  sanitized before it leaves the process, and a structured error object is a wider trust
  surface than this change needs. The reviewer is right that a future self-heal path would
  want machine-readable detail (`code`, `path`); that belongs with the escalation work under
  `CMT-1103`, not here, and is recorded rather than silently declined.
- **A local discriminated union rather than an ecosystem `Result`.** Chosen because the
  requirement is one call site and a compiler-enforced narrowing, and a dependency would add
  a supply-chain surface for a fifteen-line type. Recorded because "why not the standard
  library for this" is a fair question that the spec previously left unanswered.

## Response contract for UNTYPED clients

Round-3 review: widening a count to `number | null` is sound for TypeScript, but the real
consumers include shell scripts, `jq` filters, dashboards and monitors that have no types at
all. "Breaking by design" is not a migration signal for them.

**The rule, stated for a client with no compiler:**

```
GET /worktrees/agent-reaper
{ "enumerationOk": true,  "reclaimable": 3,    "enumerationError": null }   # trust the count
{ "enumerationOk": false, "reclaimable": null, "enumerationError": "..." }  # count is UNKNOWN
```

**Key on `enumerationOk === true` BEFORE reading any count.** A client that reads
`reclaimable` without checking will see `null`, and in most untyped languages `null` coerces
to `0` or empty — which reproduces the exact false zero this change exists to remove, one
layer out in the consumer. That is the migration hazard, and it is why the field is `null`
rather than absent: a missing key is easier to coerce silently than an explicit null.

**Considered and declined:** adding `status: "unknown"` alongside. It would be friendlier to
careless clients, but two fields encoding one fact is a divergence waiting to happen — the
same two-sources-one-truth defect round 2 caught between `/guards` and the reaper route.
One authoritative field, documented, is the smaller risk.

**Exact field presence, both routes** (round-4 review: the examples above imply a contract
without stating it, and an untyped client cannot infer required-vs-optional from two samples).

| Field | Success | Failure | Notes |
|---|---|---|---|
| `enumerationOk` | `true` | `false` | **Always present.** The only field a client should branch on. |
| `enumerationError` | `null` | `string` | **Always present**, never absent on success — see the null-vs-missing reasoning above. Bounded to 300 chars. |
| `reclaimable` | `number` | `null` | `GET /worktrees/agent-reaper`. Present in both; meaningless unless `enumerationOk === true`. |
| `orphanedCount` | `number` | `null` | `GET /orphaned-work`. **Identical rule** — the sentinel is the second guard this spec covers, and the table said "both routes" while listing only the reaper's count. |

On `GET /guards`, the same fact is carried by two OPTIONAL fields inside `runtime`, and the
asymmetry is deliberate: `verdictUnknown` / `verdictUnknownReason` are **absent** on a healthy
guard rather than `false` / `null`. `/guards` returns a row per guard across a heterogeneous
fleet, where most guards have no enumeration to fail — emitting `verdictUnknown: false` on
every row would assert "this guard checked and can see" for guards that never look at
anything. Absent there means *not applicable*; on the reaper route, present-and-null means
*applicable and currently unknown*. A client must therefore treat a missing `verdictUnknown`
as "no claim made", never as "verified fine".

**`enumerationErrorCode` is deferred to `CMT-1103`, and REQUIRED there, not optional.** The
known trigger is path resolution, and automation cannot distinguish "repo missing" from "git
unavailable" from "permission denied" through a sanitized human string. No self-heal or
alerting work may proceed on the string alone.

## Surface freshness semantics — where the two reads differ, and why

Cross-model review (round 2) found that the two surfaces reporting this guard read
**different sources**, and can therefore contradict each other. Verified by reading both
rather than reasoning about them:

| Surface | Source | Freshness |
|---|---|---|
| `GET /worktrees/agent-reaper` (`snapshot()`) | Enumerates **live**, per request (`deps.listWorktrees()`) | As of this request |
| `GET /guards` (`guardStatus()`) | The last **background pass** (`lastEnumerationOk`) | As of the last scheduled pass, or `null` before the first |

**They can disagree, and the disagreement is BY DESIGN.** A live route hit may enumerate
successfully while `/guards` still reads `on-blind` from a pass that failed an hour ago —
and the reverse, if the repo broke since that pass. The divergence window is bounded by the
pass interval (default 24h, plus the one-time ~15-minute initial pass after boot).

**Why the guard is NOT recomputed live on read.** A route hit must never change what
`/guards` reports. If posture were computed per request, the guard's state would become a
function of *who polled it and when* rather than of the guard's actual condition — a
dashboard refresh could clear a blind state, and the failure counter would measure polling
frequency instead of failures. That is the same class of self-deception this spec exists to
remove, so the coupling is refused deliberately.

**The precedence, stated so an operator is not left to guess:**

- `/guards` answers *"is this guard's protection trustworthy?"* — a posture question, so it
  is deliberately pass-based and lags.
- `/worktrees/agent-reaper` answers *"what does the reaper see right now?"* — an operational
  question, so it is live.
- **When they disagree, both are correct about different questions.** `/guards` is the one
  to trust for "should I believe this guard's verdicts", because a guard that failed its last
  real pass has not been protecting anything since, whatever a fresh read reports.
- Before the first pass, `/guards` reports neither blind nor confirmed — `null` means *no
  pass yet*, which is a third thing and is pinned by test.

**Honest remaining gap:** nothing currently surfaces the divergence itself to an operator.
Someone reading only one surface will not know the other disagrees. Naming it here rather
than claiming the semantics are self-evident; a reconciling view belongs with the escalation
work under `CMT-1103`, not smuggled into this change.

## Bounded reads — "cannot look" includes "never returns"

Round-4 review raised that the design handles an enumeration that FAILS but says nothing
about one that HANGS, and that a live route shelling out per request can stall a handler
under a git lock or a slow filesystem. The premise about the code turned out to be wrong,
but nothing in the spec or the tests said so, which is its own defect.

**Verified against the source, not assumed:**

- The default git read is bounded — `SafeGitExecutor.readSync(..., { timeout: 30_000 })`
  in `defaultReadGit`. A hung `git worktree list` is SIGTERMed at 30s.
- `execFileSync` reports that kill by **throwing**, so a timeout arrives at exactly the same
  `catch` as a missing repo and produces the same `{ ok: false, error }`. A hang is therefore
  already fail-visible, not a hole.
- Both halves are now pinned: a timeout-shaped throw is asserted to land in the `ok: false`
  branch, and a source guard asserts the 30s bound is still present. Neither is discriminating
  evidence for `on-blind` — they are regression guards, and are labelled as such in the file.

**The live route's cost is real, WORSE than the previous draft of this section said, and
still deliberately not addressed here.**

Round-4 review framed this as multiplied git subprocesses. Round-5 review pointed out that
is the mild reading, and it was right. Traced through the actual call path:

```
router.get('/worktrees/agent-reaper', (_req, res) => {   // NOT async
  res.json(ctx.agentWorktreeReaper.snapshot());          // → listWorktrees()
})                                                        // → readGit()
                                                          // → SafeGitExecutor.readSync()
                                                          // → execFileSync   ← BLOCKING
```

The handler is a **synchronous callback** ending in `execFileSync`. So a hung `git worktree
list` does not slow that one request — it **stalls the entire Node event loop for up to 30
seconds**.

**And the enumeration is only the first of the blocking calls.** `snapshot()` runs
`evaluate()` over every worktree returned, and `evaluate()` shells out again per worktree —
`isInUse` (`lsof`, 15s bound), `isClean` (`git status --porcelain`), and `isMerged`
(`git cherry`). **No hang is required for this to hurt** — the happy path alone is seconds of
event-loop block, every request.

**Corrected fan-out arithmetic (2026-07-30).** An earlier draft of this section claimed
`1 + up to 3N` spawns, "~115 on this agent's 38 worktrees". That figure was wrong in both
directions. It is corrected here rather than quietly swapped, because the error was mine and
the shape of it matters:

- `isInUse` is **memoized for 10s**, so the process listing costs **one** spawn per request,
  not N. The `3N` term was too high.
- `isMerged` **re-resolves the default branch from scratch for every worktree**, with no
  memoization, walking up to four candidate names and probing each two ways. Where the first
  candidate resolves this is one extra spawn per worktree; on an agent lacking that remote it
  is up to five before one succeeds. Real per-worktree cost is therefore closer to **seven**
  on a fleet agent — *higher* than the claimed worst case. The multiplier was in the wrong
  place, not merely mis-sized.

**Measured on a live server, not reasoned about** (independently reproduced by a second
session of this agent running on the Laptop, 48 worktrees). Idle health check ≈ **17 ms**.
While a single request to this route was in flight, that same health check took **10.6 s**,
and the route itself 10.9 s — a ~620× degradation of every unrelated route, timer and
heartbeat, from **one** request, with nothing pathological required. `/orphaned-work` has the
identical shape and measured **3.7 s**. The gates short-circuit cheapest-first and 34 of those
48 worktrees stopped early at the dirty check, so **10.6 s is the cheap case**: a tidier agent
whose worktrees are mostly clean pays the full merged comparison on all of them.

**The code's own exemption for this is false.** A comment on that path permits the blocking
scan on the grounds that the reaper "ships off and in dry-run" and so "is not on any live
agent's hot path." That reasoning only ever covered the background timer — the read route is
constructed unconditionally and runs the full pass whether or not reaping is armed. The
posture it assumes also no longer holds: `GET /guards?scope=pool` reports this manifest key as
`on-dry-run` on the Mac Mini but `on-unverified` on the Laptop, i.e. an agent where the guard
is **armed**. The exemption is a documented safety claim that was never re-checked after the
config diverged, which is why the hazard is in scope for this spec's record rather than merely
tracked out of it.

This materially enlarges `CMT-1123`. Converting the single enumeration to async would leave
the bulk of the blocking in place; the real fix is an execution-model change across the whole
evaluate path, which is why it is a spec of its own rather than a patch appended here. Every other route, every timer, the lease heartbeat, and the mesh probes are
frozen for the duration. In a codebase that already treats event-loop starvation as a named
failure class, describing this as "a dashboard polls too often" understated the blast radius
by a wide margin, and the correction is recorded rather than quietly swapped in.

This spec does **not** add caching, rate-limiting, backpressure, or async execution to that
route.

The reason is scope, stated plainly rather than dressed up: that route enumerated live before
this change and still does. This change alters what the route *reports*, not how often or how
expensively it *reads*. Adding a cache here would also directly contradict the
freshness-semantics section above, which refuses to let a route's answer be a function of who
polled it. Rate-limiting is the correct lever and it belongs with the escalation work under
`CMT-1103`, where the polling client is actually known.

**Why it is still out of scope here — and now TRACKED rather than merely declined
(`CMT-1123`).** The blocking pre-exists this change byte-for-byte: the route enumerated live
before, through the same synchronous path. This change alters what the route *reports*, never
how it *reads*. Fixing the hazard means moving to async execution — a change to the reaper's
execution model that touches every caller and deserves its own spec rather than riding in on
a reporting fix.

Round-7 review sharpened the risk in a way that earns the tracking: **this spec makes the
hazardous route more operationally important**, so once operators learn it is the source of
truth they will poll it harder and amplify a pre-existing problem. "It was already broken" is
a reason not to fix it *here*; it is not a reason to leave it unowned. `CMT-1123` carries the
three candidate fixes (async execution, route-level concurrency limiting, or splitting into a
cached last-pass read plus a deliberate live-probe endpoint) and is deliberately **separate
from `CMT-1103`** — this is an availability hazard, not an alerting gap, and folding them
together would let the louder one absorb the other.

Caching *inside this route* remains the wrong answer regardless: it would directly contradict
the freshness rule above, which refuses to let a route's answer depend on who polled it. The
cached-read-plus-live-probe split avoids that by making the two questions two endpoints.

**What is NOT claimed:** that the live route is safe under arbitrary poll rates, or that it
is safe under a single slow call. It is bounded per call at 30s, not bounded in aggregate,
and that 30s is server-wide rather than request-local. Async execution and route-level
concurrency limiting are the real levers and are tracked on **`CMT-1123`**.

*(One owner per problem, so a reader is never sent two places: **`CMT-1123` owns
availability** — async execution, concurrency limiting, the cached-read/live-probe split.
**`CMT-1103` owns alerting** — paging, exported metrics, `enumerationErrorCode`, the custom
header. An earlier draft cited `CMT-1103` on this line, which is the drift round-8 review
caught.)*

**`/guards` does not inherit this cost**, and that is structural rather than lucky:
`GuardRegistry` requires every runtime getter to be a synchronous in-memory read — no file,
process, or git I/O — and `guardStatus()` returns fields recorded by the background pass. The
new state adds no per-request enumeration to `/guards`.

## Decision points touched

> **Terms used below, in plain language** (round-6 review: this document leans on names that
> only mean something inside this codebase's constitution). **Decision point** — any place
> the code chooses between outcomes that affect behaviour. **`invariant`** — that choice is a
> fixed rule over facts you can look up, with one right answer. **`judgment-candidate`** — the
> choice weighs competing signals, so it needs a declared safe default and a named decider.
> **`on-confirmed` / `on-blind` / `on-stale`** — states a guard reports about itself:
> *working and verified*, *ran but could not see*, and *has not run recently*.
> **`proxied-on-read`** — the data lives on another machine and is fetched when asked, rather
> than copied ahead of time.

Every decision point this spec introduces or modifies, classified per **Judgment Within
Floors**. All three are `invariant`, and the justification is the same in each case: they
are deterministic predicates over directly-observable state with a conservative default,
not choices among competing signals. Naming them `judgment-candidate` would be the mirror
error — inviting an arbiter where there is nothing to arbitrate.

| Decision point | Class | Justification |
|---|---|---|
| **Enumeration outcome** — did `listWorktrees` succeed? | `invariant` | A git invocation either returned a list or it did not. There is no second signal to weigh, and the whole point of the change is that this must NOT be inferred. The three-state result makes the failure branch structurally unskippable. |
| **Reap eligibility** — keep vs reap-eligible | `invariant` | A conjunction of three independently-observable predicates (merged AND clean AND not-in-use), each fail-closed. The conservative default is explicit and total: **any** ambiguity → KEEP. A judgment layer here would only ever loosen a deletion gate, which is the wrong direction for an irreversible action. |
| **Guard effective state** — which of the ten states a guard reads as | `invariant` | A first-match-wins precedence table over already-resolved facts (config, runtime, tick age, verdict-known). Deterministic by design and closed-vocabulary; `on-blind` occupies a fixed slot in it rather than being arbitrated per guard. |

**Contested in both directions, as the standard requires.** The reap-eligibility row is the
one a reviewer should push on, because irreversible deletion is exactly where a judgment
layer is usually warranted. It is `invariant` deliberately: the failure mode worth
preventing is deleting unmerged work, and every plausible arbiter makes that *more* likely
by trading the AND-gate for a weighing. The floor here is the design.

## Multi-machine posture

Per **Cross-Machine Coherence**, each surface this spec touches declares its posture. The
default is `unified`; a `machine-local` claim carries a justification key from the closed
taxonomy.

| Surface | Posture | Notes |
|---|---|---|
| **Worktree enumeration + per-worktree verdicts** | `machine-local` | `machine-local-justification: hardware-bound-resource` — a git worktree is a directory of files on one machine's physical disk. "The worktrees on machine A" and "on machine B" are different sets by construction; there is no coherent unified value to replicate, and attempting one would assert a peer's filesystem from local evidence. |
| **`/guards` row + the `on-blind` state** | `proxied-on-read` | Already merged by the existing `GET /guards?scope=pool` fan-out. No new replication path is introduced — a peer's blindness surfaces through the read that already exists. |
| **`GuardPostureSummary.onBlind` count** | `proxied-on-read` | Rides the existing 30-second heartbeat. Declared **optional** on the wire precisely so an un-upgraded peer's silence reads as *cannot report* rather than *zero* — replicating the spec's own absent-vs-zero rule onto the mesh boundary, where getting it backwards would be self-defeating. |

**Bidirectional check, honestly applied.** The taxonomy warns that an infeasible `unified` is
as much a finding as an undefended `machine-local`. The enumeration genuinely cannot be
unified — the resource is the disk. The two reporting surfaces genuinely can be, and are,
via a merged read that predates this change. Neither key is `operator-ratified-exception`,
so no escape hatch is used.

**Rejected alternative:** replicating enumeration RESULTS between machines so any machine
could report any machine's worktrees. Rejected because a stale replicated "0 reclaimable"
is indistinguishable from a fresh one — the exact defect this spec removes, re-created at
the mesh layer.

## Open questions

*(none)* — every decision this change required was resolved in-spec. The two items formerly
parked here (which state a blind guard should occupy, and whether the report's `errored`
suggestion should be taken literally) are now answered in the `/guards` follow-up section
above, with the reasoning recorded rather than the conclusion alone.

## Safeguards

- **The deletion-eligibility logic is unchanged.** `evaluate()`, the keep/reap
  classifier, and the removal path are untouched, so the set of worktrees that can be
  removed is the same before and after. (Not "byte-identical" — see below; `reap()`'s
  operational path does change.)
- **`reap()`'s behaviour on enumeration failure changes deliberately**: it previously
  processed an empty list (doing nothing, silently); it now aborts the pass and reports.
  Both outcomes delete nothing, so the change is safe in the deletion sense — but the
  reporting is the point, and calling it "unchanged" would understate it.
- **It emits `enumeration-failed`, NOT `error`.** An unlistened `'error'` emit throws in
  Node; see "A hazard this change created, and closed".
- **The routes still return 200** on enumeration failure — justified below, not merely
  asserted.
- **No new authority and no new destructive capability.** Strictly fewer silent states.

### Why 200 and not 503

"The route must never 500" does not by itself justify 200, and returning 200 for a
broken guard is exactly what makes status-only monitoring miss it. The reason is that
**the route is not reporting its own health — it is reporting the guard's.** The HTTP
request succeeded: the server was reachable, the handler ran, and it produced a complete
and truthful answer. That answer happens to be *"the guard could not look."*

A 503 would say "this endpoint is unavailable", which is false and would break the
callers that *can* read the honest body. The degraded state is carried in the payload,
where it is machine-readable and cannot be confused with a transport failure.

The cost is real and is named in the limits below: a monitor keying only on status codes
sees nothing. That is the trade — a truthful body over a status code that would lie in a
different direction.

**The middle options, explicitly rejected or deferred** (round-5 review: the 200-vs-503
argument is coherent but reads as a binary, when the useful alternatives sit between them and
would let a commodity monitor notice without any status code lying):

| Alternative | Disposition |
|---|---|
| A `Warning` response header alongside the 200 | **Deferred to `CMT-1103`.** Genuinely the cheapest way for a header-inspecting monitor to catch this, and no lie is involved — the request DID succeed. Not taken here only because it is an alerting affordance with no consumer yet, and adding an unconsumed header invites treating it as coverage. |
| A problem-detail sidecar (RFC 9457) | **Rejected.** That shape describes a FAILED request. This request succeeded and returned a complete answer, so the semantics are wrong regardless of convenience. |
| A separate health endpoint / status projection for guards | **Already exists — this is `GET /guards`**, which is precisely the posture surface, and the `on-blind` state is how it reports this condition. The gap is not a missing projection; it is that nothing polls it unprompted. |

**On the `Warning` header specifically** (round-6 review pressed that deferring it was
under-argued and asked for a concrete compatibility reason). There is one: the `Warning`
header was **deprecated and removed from the HTTP specification in RFC 9111 (2022)**, which
struck it from RFC 7234 as underused and error-prone. Recommending it as "the standard
low-cost degraded-success signal" is out of date; new code should not adopt a field the
spec has retired.

The remaining option is a **custom** header (`X-Guard-Enumeration: failed`). That is
genuinely cheap and carries no compatibility risk — but it is non-standard, so no commodity
monitor recognises it without being configured, which is the same configuration step that
would let it key on the response body it already receives. It buys convenience, not the
detection this spec lacks.

Round-7 review pressed a second time and asked for it to be **registered separately from
metrics and paging** rather than folded into them. That distinction is fair and is taken: the
header is a *degraded-success signalling* question, whereas `CMT-1103` is *does anyone find
out unprompted*. They are different problems and the second does not subsume the first. The
header is therefore recorded here as an explicit, separately-argued option on `CMT-1103`'s
docket rather than as an unnamed part of "the alerting work" — and it stays unimplemented in
this change for the reason above: an unconsumed header is an affordance that reads as
coverage.

**Where I am willing to be wrong:** if an operator turns out to already run header-keyed
monitoring, the cost/benefit inverts immediately and the header should just be added. That is
a fact about the deployment, not about the design, and I have not checked it.

So the honest position is narrower than "we chose 200": a header is the real unclaimed
option and is tracked, one alternative is semantically wrong, and the third is already built.
None of them close the nobody-is-watching gap, which stays where the boundary table puts it.

## Observability — making the failure recorded, not just answerable

External review raised the sharpest remaining point — a fail-visible field may still be
*"visible in JSON, invisible in operations."* Both routes still return **200** on a
failed enumeration (they must; the route cannot 500), so a monitor keying only on status
codes sees nothing. And the constitutional gate went further: an `enumeration-failed`
event that **nothing subscribes to** is a detected failure that can rot — a Close the
Loop violation, and it was right.

So the failure is recorded, not merely exposed. Four surfaces, in ascending
persistence:

1. **The response** — `enumerationOk: false`, count `null`, bounded error text.
2. **A named event** — `enumeration-failed` with `{ error }`, for any subscriber.
3. **A log line**, via an injectable `warn` dep defaulting to `console.warn` (the
   sibling-monitor pattern), landing in the server log:
   `[agent-worktree-reaper] enumeration FAILED — reclaimable is UNKNOWN, not zero: …`
   Its persistence is whatever the deployment's log retention gives it — a trace, not a
   guarantee.
4. **Snapshot-local counters** — `enumerationFailures` and `lastEnumerationFailureAt`,
   on both snapshots. These make the guard's own health *auditable across time* rather
   than momentary: a log line only helps someone reading at the right moment, and the
   defect this change addresses went unnoticed for an unknown duration precisely because
   nothing counted it.

   The counter increments **only on background passes** (`reap()` / `scan()`), never in
   `snapshot()` — which runs on every route hit and would otherwise turn the count into a
   measure of how often someone polls. `enumerationOk` reports the *current* state; the
   counter reports *history*. A test asserts four `snapshot()` calls over a broken
   enumeration leave the count at zero while still reporting `enumerationOk: false`.

**Precision about what these are, because it matters:** items 3 and 4 are **observable
traces, not durable infrastructure** — the log line's lifetime is the deployment's
retention policy, and none of this is an exported monitoring metric. They are strictly
better than the previous state (a fabricated zero and no trace at all), and no more.

### The persistence model, stated once and authoritatively

An earlier draft of this section said the counters are "process-local and reset on
restart" while the `/guards` section said the failure history *is* persisted and reloaded.
**Both cannot be true, and the contradiction survived a round of review that was
specifically about this claim** — the round-1 correction fixed the `/guards` section and
never reconciled this one. Verified field by field against the source:

| Field | Survives restart? | Drives |
|---|---|---|
| `enumerationFailures` | **YES** — persisted and reloaded | the historical count |
| `lastEnumerationFailureAt` | **YES** — persisted and reloaded | when it last failed |
| `lastEnumerationOk` | **NO** — starts `null` | `verdictUnknown` / `on-blind` |
| `lastEnumerationError` | **NO** — starts `null` | the operator-facing reason |
| `lastPassAt` | **NO** — starts `0` | tick freshness (`on-stale`) |

**The consequence, which is the part that matters: `on-blind` does NOT survive a restart.**
The history of *how often* enumeration has failed persists; the *current* blind state does
not. A restarted server has forgotten that the guard was blind.

**For a LIVE guard it fails in the safe direction, by construction rather than luck.** With
`lastEnumerationOk` back to `null` there is no `verdictUnknown`, but `lastPassAt` is also
back to `0` — and a `0` tick while enabled is precisely the `on-stale` input. So a restarted
blind live guard reads **`on-stale`**, not `on-confirmed`. It is still loud; it is loud about
the wrong thing ("stopped ticking" rather than "could not see") until the first post-restart
pass re-establishes the truth, which the ~15-minute initial-pass delay bounds. **Pinned by
test**, deliberately: if a later change ever persisted `lastPassAt` without also persisting
the enumeration outcome, a restarted blind guard would read `on-confirmed` — this spec's own
defect returning through the back door.

**In DRY-RUN — which is the reaper's shipped default — the restart case is weaker, and this
is the honest statement of it.** `on-dry-run` outranks both `on-stale` and `on-blind`, so a
restarted dry-run guard reads `on-dry-run` with **no blindness recorded anywhere**: the
runtime block that normally carries `verdictUnknown` through a dry-run row is empty, because
the process has forgotten. It is therefore indistinguishable from a healthy dry-run guard
until the first pass.

That gap is real and is **not closed here**. It is not a regression — before this change
there was no blind state at all, in any posture — but it is the one combination
(dry-run + restart + still-blind) where the feature delivers nothing. Closing it requires
persisting the last enumeration outcome, which is the same work the `/guards` section defers
to `CMT-1103`. Recorded rather than left for a reader to discover, because "the default
deployment posture" is exactly where an unstated gap does the most damage.

*(Found by a test that failed for the right reason: the first draft asserted `on-stale` using
a dry-run fixture and read `on-dry-run`. The fixture was wrong, but the failure exposed a
property of the shipped default that reasoning alone had missed.)*

**What is therefore NOT claimed anywhere in this document:** that `on-blind` is durable,
restart-surviving, or a last-known-state record. It is a live, process-local state derived
from the most recent background pass of *this* process.

The wording is deliberate: it names the *state* (unknown) rather than the symptom, so a
reader skimming logs sees the thing that matters. A control test asserts the log fires
on failure **only** — a warn on every healthy pass would be noise that trains people to
ignore it.

**What is still not done, stated plainly:** no **exported monitoring metric** (one that can
be scraped or alerted on) and no attention item. A broken guard now leaves a persisted
failure history, a log trace, and an honest answer when queried; it does not page anyone,
and its *current blind state* dies with the process while that history survives — see the
persistence model for the field-by-field split. Closing *that* requires
choosing an escalation path, and under **Self-Heal Before Notify** an operator-facing
raise needs a self-heal step, brakes, and a severity class — a design with its own risk
surface, not a line appended here.

**That gap is REGISTERED, not deferred** (Close the Loop): commitment **`CMT-1103`**,
agent-owned, beacon-enrolled, so it resurfaces on a cadence until it reaches deliberate
closure rather than living in this document's prose. The convergence review is what
surfaced it — twice, from the constitutional gate — and registering it is the honest
response to a gap this change genuinely should not swallow whole.

The improvement delivered is bounded and real: the previous behaviour answered
*dishonestly* when asked and left no trace, which no downstream alerting could have
corrected.


## Tests that earn it

Verified to fail on the pre-change tree by reverting the source files and re-running —
not asserted.

**Reaper:**

1. `snapshot` reports `reclaimable: null` / `enumerationOk: false` when listing throws.
2. **The discriminating control:** a healthy enumeration still reports a real count and
   `enumerationOk: true`. Without this, an implementation that always returned `null`
   would satisfy (1) while reporting nothing useful — the same "refuses everything"
   failure a refusal-only test cannot detect.
3. `listWorktrees` returns `{ ok: false, error }` on git failure, never an empty list.
4. The route surfaces the same distinction over HTTP, still with status 200.
4b. A dep that **throws** in violation of its contract still produces `null`, not a
    clean zero — the defensive backstop behind the type.

**Sentinel** (added after external review caught the omission):

5. `snapshot` reports `orphanedCount: null` / `enumerationOk: false` on a failed
   enumeration.
6. The matching control: a genuinely-empty machine still reports `orphanedCount: 0` with
   `enumerationOk: true`. **Zero when measured, null when unmeasurable** — the pair is
   what makes the distinction real rather than a blanket null.

**The hazard this change created** (verified to fail against the `emit('error')` version):

7. `reap()` resolves normally with **zero** `'error'` listeners attached — the condition
   that makes an `'error'` emit fatal.
8. The named `enumeration-failed` event fires with the reason.

**Observability:**

9. A failed pass warns once, naming *UNKNOWN, not zero*; a healthy pass warns not at all
   (the control — a warn on every pass would be noise that trains people to ignore it).
10. The counter reaches 2 after two failed passes, and stays at **0** across four
    `snapshot()` calls over a broken enumeration — proving it measures passes, not polls.

**The error summarizer:**

11. Control characters stripped; newlines collapsed; clamped to the max length with an
    ellipsis; a non-`Error` throw handled.

Existing suites remain green: `agent-worktree-reaper`, `AgentWorktreeDetector`,
`InstarWorktreeManager`, `OrphanedWorkSentinel`, plus the reaper's integration and e2e
files.

## Scope of the claim

This change fixes the enumeration property for **these two guards only**. It makes no
claim about, and creates no obligation toward, any other guard in the fleet.

What the reader should take from this section is narrower and fully contained: for
these two guards, `enabled: true` was never evidence that they worked, and now their
own output says so.

**The fleet-wide audit: previously declined, now TRACKED as `CMT-1122`.** Earlier drafts
argued that raising a fleet-wide obligation this change does not carry would be an untracked
follow-up, and that untracked follow-ups are indistinguishable from abandoned ones. Round-7
review called that what it was: *process compliance dressed as risk management*. The argument
proves only that an **untracked** obligation is bad — it says nothing against a **tracked**
one, and the defect class has now recurred at least twice, which is precisely the evidence
that should raise an audit rather than suppress it.

So the obligation is registered instead of declined: enumerate the guards that derive safety
from filesystem or process enumeration, assert each one's behaviour on invalid input, and fix
or record why not. `CMT-1122` owns it. This spec still changes only the two guards named
above — the scope of the *change* is unmoved; what changed is that the scope of the *risk* is
no longer quietly dropped at this document's edge.

**Acceptance criterion, stated as a boundary** (round-4 review: the narrowed title is
honest, but the document still spends most of its length on visibility-adjacent surfaces
while the operational failure mode — nobody queries them — stays open).

This change is complete when **a client that asks gets a truthful answer**. It is NOT
complete for operational detection, and no combination of its parts adds up to that:

| Claim | Status here |
|---|---|
| A caller reading the API can distinguish "no worktrees" from "could not look" | **Delivered** |
| A guard's posture reflects a failed enumeration | **Delivered for the last completed background pass of the current process** — process-local, lost on restart, and lagging by up to the pass interval. See the persistence model. |
| The failure is recorded for later inspection | **Delivered** (passive) |
| Someone finds out without asking | **NOT delivered** — `CMT-1103` |

The logs and counters this spec adds are **passive diagnostics**: they reward
an operator who already suspects something and goes looking. Calling them "observability"
without that qualifier is the flattering reading, and it is the reason the pattern named at
the top of this document kept recurring — each individually-true visibility claim summed to
an implication of operational safety that no part of it delivers.

A blind guard on an unwatched machine stays blind and silent. That is the honest state after
this change, and it is why the paging work is tracked rather than described.
