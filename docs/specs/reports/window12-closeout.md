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
| classified methods | lists existed, unenforced after the move | **17** (4 reader-visible, 13 bodyless), refused if unknown |
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
