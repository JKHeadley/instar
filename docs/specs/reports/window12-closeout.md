# Window 12 — close-out

**Status: NOT MERGED, deliberately.** The endpoint set for this window was two consecutive clean readings
of the frozen tree. It did not arrive, and this document says so rather than presenting the work as
finished. Every number below is derived by command, not recalled.

---

## What the window was for

Three things, in the order they were prioritised: an operating rule (*count, never assume*), a candidate
constitutional standard, and a bounded continuation of the adversarial reading loop on the outbound
message guard.

---

## 1. The standard — RATIFIED

**Article 89, *A Metric Must Measure the Work, Not the Question*.** Drafted, placed as a tree node under
*Iterative Audit to Convergence*, and ratified by Justin on 2026-08-10. It passed every birth requirement
the constitution imposes: declared parentage acknowledged bidirectionally by its parent, an honest
enforcement fingerprint (`moments: none` — nothing today records the question alongside the measurement),
and a `documented-only until` countdown of 2026-09-10 tracked as `STD-COUNTDOWN-metric-measures-the-question`.

The registry now holds **89 articles across 11 families**, and the enforced ratio moved 0.75 → **0.7416**.
The ratio FELL, which is the honest direction: ratifying an unenforced standard should lower enforced
coverage rather than raise it.

**The article earned its keep on the loop that produced it.** Load-bearing findings per reading ran 5, 7,
9, 8, 6 — rising before falling. Because the question was held near-identical across five readings by
design, that rise could not be an artefact of a changing question, so it was a fact about the work. That
is the article's own test, applied to the exam that birthed it.

---

## 2. The guard — substantially hardened, measured

The outbound Telegram guard went from a per-sender check to a single structural boundary.

| property | before | after |
|---|---|---|
| where the check runs | in each sender, before formatting | one door, on the serialised request |
| Bot API `fetch` call sites | 6 senders, each checked separately | **15 call sites, one door**, lint-confined |
| what proves it | a lint that could not resolve its own claims | a boundary lint + a runtime closed-world refusal |
| classified methods | lists existed, unenforced after the move | **19** (6 reader-visible, 13 bodyless), refused if unknown |
| tests on the surface | — | **110** |

### Ten ways a payload could have reached the network unchecked, closed

Each was a real path, found by reading or self-audit, not a hypothetical:

1. Any encoding other than a JSON string body — query, form, multipart (pass 36)
2. A case-variant method spelling, which Telegram dispatches and the field map missed (pass 36)
3. An unclassified method, silently undecided after the boundary move deleted the closed-world check (pass 36)
4. Body values overriding query values, when Telegram sends the query's (pass 37)
5. A URL fragment read as payload, masking an invisible query value (pass 37)
6. URL spellings `fetch` normalises — explicit `:443`, whitespace, upper-case host (pass 37)
7. Two direct Bot API fetches in the live tree that the lint printed "confined" over (pass 37)
8. A repeated parameter key resolving to the last value where Telegram takes the first (**self-audit**)
9. The same duplicate defect surviving in JSON and multipart after the first repair (pass 38)
10. A percent-encoded path, and `URL`/`Request` inputs the type signature forbade but the runtime accepts (pass 38)

**Over-refusals fixed alongside them** — each one destroys a real message, so they matter equally:
entity-decoding and delimiter-stripping approximations of Telegram's parsers; wholesale refusal of
multipart on a false "cannot read without consuming" premise; and the visible-first duplicate case.

---

## 3. Systemic findings — the ones worth carrying past this branch

- **A guard that nothing guards.** The new boundary lint ran in CI but was absent from `REQUIRED_LINTS`,
  the shrink-only list that stops a merge silently dropping a guard — and so was its predecessor, for as
  long as it existed. The guard on the agent's outbound path was itself unprotected the whole time.
- **Green about only what you touched.** A full-suite run (3,059 files, 48,010 tests) found 12 failures
  that every targeted run had been blind to. Targeted greens had been reported all night.
- **A sweep must search the CLAIM, not one of its spellings.** The same predicate claim was caught in
  three consecutive readings because each sweep searched one notation. It existed in four: a regex, an
  abbreviation, a capitalised prose sentence, and a plain sentence asserting the opposite.
- **Re-read the acceptance criteria before claiming done.** A commitment was marked delivered against
  remembered scope; its written criteria showed one unmeetable as stated and one untouched.

---

## 4. Open items — dated debts, owned

| item | what remains | tracked as | due |
|---|---|---|---|
| Rendering fidelity | The HTML branch both over- and under-refuses; deciding it needs Telegram's parse result, not a better regex | **CMT-1260** | 2026-09-01 |
| Vendored codepoint table | Predicate uses runtime `\p{...}` escapes, so its verdict depends on the host's Unicode version | **CMT-1261** | 2026-09-01 |
| Relay refusal conflation | `relayOutbound` treats only 422 as a refusal; every other status reads as "unreachable". Located and pinned by three tests, not fixed | **CMT-1247** | 2026-08-17 |
| Per-sender guard residue | One survives: the tokenless relay hands the message to another machine, so the door cannot see it. Structural, not an oversight | — | n/a |
| Redirect crossing | A non-Bot URL redirecting into a Bot API method is classified once. Left open as a stated judgment, reasoning in the door's header | — | n/a |
| Route-context path test | The demo sender's behavioural test needs a route harness | **CMT-1248** | 2026-08-17 |
| Instrument gap | `load-assess.sh` is used as the general hold/run gate but assesses CPU only; the binding constraint all window was memory and swap | **ACT-1758** | 2026-08-25 |

---

## 5. The red that stays red

`tests/unit/standards-coverage-ratchet.test.ts` fails one assertion: all six family audits must be
current, and **Building** and **The Substrate** are stale because this branch amended both.

Refreshing them legitimately requires a real multi-reviewer family convergence — the existing audit
artifact records four reviewers, a convergence report, and 52 resolved findings. That needs LLM capacity
this machine could not provide tonight.

The test's own comment states that editing the expectation "would be forging the acceptance the record
exists to prove." A rushed convergence would be the same forgery with more steps. **It stays red into the
next window, named**, which is the only honest option available.

---

## 6. Numbers

Derived by command at close:

- **45** commits since the window opened
- **5** adversarial readings dispatched (passes 34–38), each with its question archived BEFORE the reading
- **38** verdicts archived in total, contiguous — the archive guard confirms 38 cited, 38 filed
- **10** side-effects increments written this session (73–82)
- **110** tests on the guard surface; **166** in the affected area; full lint chain green; type check clean
- **1** test deliberately red, named above

---

## What I would tell the next session

The guard is much stronger than it was and is not finished. Every reading for the last three passes found
real defects in code written to fix the previous reading — which is a property of the work, not of the
readings. The convergence is genuine but slow, and the honest position is that it needs more rounds than
one window holds.

Do not merge this to claim the window. Read `pass38-verdict.md`, then the stated-open list in
`pass38-question.md`, and continue the pair from there.


---

# ADDENDUM — the window did not end here

The close-out above was written at hour fifteen, when work was parked on a memory constraint. **That was
wrong, and the operator corrected it:** the constraint was real but not binding. A second machine with
137 GB — eight times the one everything had been running on — was completely idle the entire time. The
deferral was not "we lack capacity"; it was "we never asked whether the capacity could move."

What that correction bought, all of it after the close-out was written:

## The convergence stopped being blocked

It was never blocked by capability. Five real blockers stood in the way, none of them the memory number:

1. `node` absent from the remote shell's PATH — every credential lookup exited 127, which is the whole
   reason the other agent's lanes looked "unreachable" for hours.
2. The laptop's checkout points at a different remote and cannot authenticate non-interactively, so it
   could not fetch the branch at all. Routed around by shipping the inputs over the existing channel.
3. **The other agent's session API accepted a prompt, recorded it, and handed the underlying tool an
   empty one** — three lanes reported `running`, then `completed` in three minutes having written
   nothing. A lane that reports success while doing nothing is worse than one that fails.
4. The tool is installed as a version-manager shim, invisible to every non-interactive shell.
5. It refuses to run outside a repository without a flag, and waits on stdin that never arrives.

## Eight family reviews, four lenses, both families

| lens | Building | The Substrate |
|---|---|---|
| internal consistency | 2 | 2 |
| obligation reachability | 14 | 10 |
| falsifiability | 23 | 18 |
| cost of compliance | 11 | 10 |

**64 findings, none touched, all archived for ratification.** Both families peaked on the third lens and
fell on the fourth — two independent series reversing at the same point, which is the closest thing to a
convergence signal the window produced. The caveat stays attached: each lens asks a different question, so
the numbers measure the questions too.

## The standing rule the operator set, and what it caught

*A cross-family or high-confidence finding gets a cross-cutting verification lens BEFORE it is reported
up.* It caught two overstatements of mine, and in both cases the overstatement was the more quotable
version:

- Two alleged cross-family contradictions, **refuted** — they were artifacts of reviewers structurally
  unable to read the other side.
- "The registry has no precedence mechanism", **refuted** — it has status precedence across every family
  and a stated cross-family tradeoff, and all four alleged collisions are locally resolvable. The
  surviving claim is a narrow residual, framed at that width in
  `docs/proposals/precedence-gap-for-novel-collisions.md`. The originally proposed fix was also unsafe:
  it would have frozen the live user channel during a gate outage.

## The guard, continued

Passes 39-45 ran on the laptop. Findings closed since the close-out include: a request carrying its METHOD
in a parameter; a DNS-root-dot host spelling; escaped duplicate JSON keys; a test-environment root; a
mutable body reference; a **second read** of the body introduced by the very line meant to fix the first;
and a method carrying reader-visible content in more than one field.

**The near-miss worth keeping:** I judged Telegram's `rich_message` a fabricated field because it postdates
my knowledge, and was one message from reporting a real bypass as a hallucination. Fetching the live
documentation showed it real. Acting on a fake field and discarding a real one were one verification
apart — and the instinct to dismiss it *felt* like rigor.

Then pass 44 showed the repair had the right field and the **wrong shape**: `rich_message` is a structured
object, my checker tested for a string and returned early, so the closed-world table named a field nothing
inspected. A field listed in the map READS as handled — an omission announces itself, a wrong-shaped
handler hides.

## Derived at this close

- **67** commits since the window opened
- **16** questions archived, **45** verdicts archived, contiguous
- **18** laptop reviews archived
- **42** tests on the door; **18** egress call sites behind it; **19** classified methods
  — **as measured on 2026-08-12 at the close of window 12.** This is a historical record; the figures are
  pinned to that moment on purpose and are NOT maintained.

  They were re-derived by command rather than carried forward, after pass 47 finding 6 caught the headline
  table two methods short of the code.

  **And the correction went stale inside the same window, which is the point.** That paragraph originally
  read as though the numbers were simply current. Window 13 then added nine more tests to the door, so
  "42" was accurate when written and wrong two hours later — a stale count inside the very note explaining
  that a count written once and quoted afterwards is a claim rather than a measurement. The fix is not a
  fresher number, because a historical document should not chase one. The fix is saying WHEN it was
  measured, so a reader knows whether to re-derive.
- Full lint chain green, type check green

## Status, unchanged

**Still NOT merged.** No clean pair. Pass 45 returned five new findings — the lowest of the series, and
the first reading to separate NEW findings from previously-stated-open ones, which is the measure that
actually shows whether repairs are gaining. The family-audit red still stands, honestly, and the 64
findings now standing in front of it are the reason refreshing it this morning would have been a forgery.
