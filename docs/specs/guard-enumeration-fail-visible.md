---
title: "Guard Enumeration Fail-Visible — a guard that cannot look must not report a clean zero"
slug: "guard-enumeration-fail-visible"
author: "echo"
parent-principle: "Verify the State, Not Its Symbol"
eli16-overview: "guard-enumeration-fail-visible.eli16.md"
status: "draft"
approved: false
---

# Guard Enumeration Fail-Visible

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
traces, not durable infrastructure**. The counters are **process-local and reset on
restart**, and the log line's lifetime is the deployment's retention policy. They are
strictly better than the previous state (a fabricated zero and no trace at all), and
they are *not* an exported monitoring metric with its own persistence.

The wording is deliberate: it names the *state* (unknown) rather than the symptom, so a
reader skimming logs sees the thing that matters. A control test asserts the log fires
on failure **only** — a warn on every healthy pass would be noise that trains people to
ignore it.

**What is still not done, stated plainly:** no **exported monitoring metric** (one that
survives restart and can be scraped or alerted on) and no attention item. A broken guard
now leaves in-process counters and a log trace, and answers honestly when queried; it
does not page anyone, and its counters die with the process. Closing *that* requires
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

The question this change answers for itself — *what does this guard report when its
input is invalid?* — is stated here as the reasoning behind the fix, not as a
recommendation that anyone go ask it elsewhere. Raising a fleet-wide obligation this
change does not carry would be an untracked follow-up, and the constitution is right
that those are indistinguishable from abandoned ones.

What the reader should take from this section is narrower and fully contained: for
these two guards, `enabled: true` was never evidence that they worked, and now their
own output says so.
