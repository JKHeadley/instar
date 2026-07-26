# Side-Effects Review — a decision log that refuses a decision which does not say why

**Version / slug:** `decision-journal-principle-required`
**Date:** `2026-07-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `see Phase 5`

## Summary of the change

Operator directive (topic 29723, 20:4xZ): decide against the goal hierarchy instead of escalating,
log the reasoning for later review, and **enforce it via infrastructure rather than by remembering**.

Investigating what to build produced the finding that the machinery already exists — hierarchy
(`GET /intent/org`, `/intent/tradeoff-resolve`), recorder (`DecisionJournal`, `POST /intent/journal`),
and drift detector (`IntentDriftDetector`) — and had recorded **zero decisions, ever**. What is
missing is not machinery; it is anything that forces its use or reveals its disuse.

Then, using it, I produced the defect this PR fixes:

- I POSTed `reasoning` and `checkedAgainst`. **Neither is a field.** The route spread `...rest`
  straight through with no validation, so both were persisted where no reader consumes them. The
  write returned 201. I then told my operator the reasoning was recorded — believing it.
- `principle`, the typed field documented as *"Which AGENT.md principle or intent guided the choice"*,
  was empty on all five entries.
- `stats()` therefore reported `topPrinciples: []` — **byte-identical to an empty journal.** The
  instrument built to detect unreasoned decisions could not distinguish its own worst case from a
  clean slate.

Adds `validateDecisionSubmission()` (pure) + `principledCount`/`unprincipledCount` on
`DecisionJournalStats`, wires the validator into `POST /intent/journal`, and registers the behaviour
change for new and existing agents.

## Refusal evidence (constraint 2)

```
REFUSAL 1 — unwire the validator from the ROUTE (`if (false && !verdict.ok)`)
  UNIT:        Tests  11 passed (11)      <-- the blindness, reproduced deliberately
  INTEGRATION: × the ROUTE refuses a decision that names no principle
               × the ROUTE refuses fields no reader consumes
               × a refused submission writes NOTHING
               × the refusal message tells the caller where the content belongs
               Tests  4 failed | 2 passed (6)

REFUSAL 2 — swallow unknown fields instead of refusing
  × a field no reader consumes is REFUSED, not swallowed
  × missing-required outranks unknown-fields, and still reports both
  × (+3 integration)                       Tests  5 failed | 12 passed (17)

REFUSAL 3 — drop `principle` from the required set
  × a decision naming no guiding principle is REFUSED
  × a blank or whitespace principle does not satisfy the requirement
  × (+3)                                   Tests  5 failed | 12 passed (17)

REFUSAL 4 — revert stats to the ambiguous shape
  × entries with no principle are COUNTED, not silently absent   → expected +0 to be 2
  × an empty journal is DISTINGUISHABLE from an unprincipled one → expected +0 not to be +0
  × (+2)                                   Tests  4 failed | 13 passed (17)
```

Restored: **188 passed (188)** across the five affected files, `tsc --noEmit` exit 0.

**REFUSAL 1 is the finding, and it is the second occurrence tonight of the same class.** One feature
earlier (#1658) I emptied a route's registry and all 19 unit tests passed — module guarded, wiring
not. So here I went looking for it deliberately: unwiring the validator leaves **11/11 unit tests
green** while the route accepts everything it is supposed to refuse. The integration file exists for
exactly this assertion and nothing else.

## Decision-point inventory

| point | classification | note |
|---|---|---|
| missing required field → refuse | `invariant` | Deterministic key/type check. No model call. |
| unknown field → refuse | `invariant` | Allowlist comparison; allowlist asserted against the documented field set by test. |
| missing-required outranks unknown-fields | `invariant` | Both are still reported, so one round trip surfaces both problems. |
| machine dispatch path exempt | `invariant` | Scoped by callsite, not by inspecting content. |

No judgment points. No LLM. Nothing is inferred about the *quality* of a cited principle — only that
one was cited. Judging whether a decision genuinely followed the principle it names is the drift
detector's job and is deliberately not attempted here.

## 1. Over-block

**This is the section that shaped the design.** A blanket requirement would have been wrong.

`journal.log()` has two callers: the HTTP route (agent-authored) and `DispatchDecisionJournal
.logDispatchDecision` via `AutoDispatcher`, which writes auto-applied dispatch decisions whose own
documented shape is `{ dispatchDecision: 'accept', reasoning: 'auto-applied' }`. Those have no
principle to cite. **Enforcing inside `log()` would have broken automatic dispatch to buy nothing**,
so the refusal lives at the route and `log()` is untouched — asserted by a test that the module path
still accepts an entry with no principle.

Residual over-block risk on the agent path: a caller with a legitimate decision and genuinely no
guiding principle now gets a 400. I accept this deliberately — under the operator directive, a
decision made during operations without checking the stated goals is precisely what we are
eliminating. The failure is loud, names the missing field, and is fixed by adding one string.

Unknown-field rejection is a strict-schema change and could in principle break an existing caller.
The refusal names the offending keys and the correct destination, so a broken caller is told exactly
what to change rather than failing opaquely.

**CORRECTION — my first version of this section was too confident, and CI proved it.** I wrote that
"the journal had `count: 0` on this agent, so no caller has ever successfully written to it" and
treated that as evidence the back-compat risk was near-nil. That measurement was about the *live
agent's data file*; it says nothing about *callers in the codebase*. There was one:
`tests/integration/intent-routes.test.ts` POSTed three decisions with no `principle`, and my change
refused all three, so the journal file was never created and a later read failed `ENOENT`.

I did not catch it locally because I ran a targeted file set that did not include that test. CI did.
Two failures, both mine, neither a flake. Resolution: the tests now supply a `principle` — which is
the *correct* fix, since they were writing exactly the unreasoned decisions this gate exists to
refuse, and their failure is the refusal working on a real caller rather than a synthetic one.

The honest generalisation: "no rows in the data file" is not evidence of "no callers in the code".
Those are different questions and I conflated them. A repo-wide sweep afterwards found three files
POSTing to the route and six asserting on `stats()` shape; two needed changes, and both are fixed.

## 2. Under-block

**It does not force the check, only the citation.** Nothing here fires at the moment a decision is
made and puts the hierarchy in front of the agent. An agent can still decide without consulting
`GET /intent/org` and then name a principle after the fact. This PR makes it impossible to *record*
a decision that claims no guiding intent; it does not make it impossible to *make* one. The
consult-side trigger is genuinely separate work and is not bundled. <!-- tracked: CMT-1044 -->

**It does not judge the principle.** Any non-empty string satisfies the requirement. A caller citing
"because I felt like it" passes. Judging alignment is `IntentDriftDetector`'s job.

**The five existing entries are not repaired.** They keep their unread `reasoning`/`checkedAgainst`
keys. The new counters will report them as unprincipled, which is accurate. Rewriting my own history
to look better than it was is the opposite of this tier's purpose.

**`GET /intent/journal` (read) is unchanged** and will still return the legacy rows with their
unread fields. Nothing marks those fields as unread on read.

## 3. Level-of-abstraction fit

The validator is pure — no `fs`, no clock, no config, no server import — so the refusal is unit
testable without a server, and the route owns transport only. This mirrors the structure used one
feature earlier and, more importantly, is what made REFUSAL 1 possible to demonstrate: a pure
validator can be perfect while nothing calls it, which is precisely the failure mode being guarded.

The counters live on `stats()` rather than in a new surface, because the ambiguity being fixed is a
property of that existing return value. A new endpoint would have left the misleading one in place.

## 4. Signal vs authority compliance

This **is** an authority — it blocks a write — so `docs/signal-vs-authority.md` applies directly
rather than trivially. It qualifies because the logic is deterministic and total: an allowlist
comparison and a set of required-key checks, no heuristics, no model, no inference about content.
That is the category the principle permits to hold blocking authority. Every uncertain input
(`null`, `undefined`, a string, a number) resolves to a refusal with a named reason rather than a
throw or a pass — asserted by test.

The blocked path writes nothing: a refused submission leaves `count: 0`, asserted by integration
test. A refusal that still recorded the row would be worse than no refusal, because the journal
would carry entries the caller was told were rejected.

## 4b. Judgment-point check (Judgment Within Floors standard)

None introduced. Every branch is a deterministic key or type comparison.

## 5. Interactions

- **`DispatchDecisionJournal` / `AutoDispatcher`** — deliberately NOT gated (see §1). Asserted.
- **`IntentDriftDetector`** — reads the journal; gains higher-quality input (entries now carry
  `principle`) and is otherwise untouched. Its 16 tests pass unchanged.
- **`instar intent reflect` / `commands/intent.ts`** — calls `journal.log()` directly, module path,
  unaffected by the route gate.
- **`tests/unit/DecisionJournal.test.ts`** — one test pinned the exact empty-`stats()` object shape
  and now asserts the two new counters. This is a shape assertion updated to a new shape, not a
  behavioural assertion weakened; the comment records why the zero values matter.
- **`CapabilityIndex`** — no change needed. `intent` is already classified under
  `INTERNAL_PREFIXES` ("surfaced inside `evolution` subsystems"); this adds no new route prefix.

## 6. External surfaces

`POST /intent/journal` changes response behaviour: submissions that previously returned 201 may now
return 400 with `{ error, reason, unknownFields, missingFields }`. `GET /intent/journal/stats` gains
two fields (additive). No config key, no new route, no persisted-state migration, no message to any
user. No credentials or content beyond what the caller submitted appear in any response.

## 6b. Operator-surface quality

The refusal message names the offending fields AND the correct destination (`context` for reasoning,
`principle` for guiding intent) plus the full writable-field list. A refusal that only says "invalid"
relocates the failure rather than fixing it; asserted by a test that the message mentions `context`.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The journal is a per-machine JSONL under `stateDir`; the validator is
pure and stateless, so the refusal is identical on every machine with no coordination required.
There is no replication, no lease interaction, no generated URL, and no cross-machine read. Honest
limitation: an agent running on two machines keeps two separate decision journals, so
`principledCount` answers "on this machine". That predates this change and is not addressed here.
<!-- tracked: CMT-1044 -->

## 8. Rollback cost

Low. One pure function, two counters, one route guard, plus doc/migration lines. No persisted-state
change and no data migration — existing rows are read unchanged. Reverting restores the permissive
route; already-written entries remain valid under both versions.

## Phase 5 — Second-pass review

This change **does** hold block/allow authority on a write path, so the high-risk trigger list is
engaged. It does not touch session lifecycle, messaging, dispatch, trust levels, or recovery. Author
lenses, disclosed:

**Adversarial — "how would I make this useless?"** Three ways, all closed and asserted: let the
route skip the validator (REFUSAL 1 — the real one); accept unknown keys silently (REFUSAL 2); drop
the principle requirement (REFUSAL 3). A fourth — refuse but write the row anyway — is closed by the
`a refused submission writes NOTHING` test.

**"Would it have caught the incident?"** Yes, on the first attempt, which is the strongest thing I
can say for it. My literal opening submission is now a test fixture and returns 400 naming
`checkedAgainst` and `reasoning`. I would have lost seconds instead of finding out by reading my own
file afterwards and having already told my operator otherwise.

**"Symptom or cause?"** Partly cause, and I want this stated plainly rather than implied: it makes
an unreasoned decision unrecordable, which is a real structural gate. It does not make an unreasoned
decision unmakeable. The operator asked for decisions checked against the hierarchy; this delivers
the enforcement half of "log the reasoning" and none of the consult half.

**Weakest point:** the requirement is satisfiable by any non-empty string. Nothing distinguishes a
genuinely-consulted principle from a plausible-sounding one typed to clear the gate — and the agent
clearing it is the same one whose unreliability motivated the gate. That limit is inherent to a
deterministic check and is the reason the consult-side trigger is not optional future work.
