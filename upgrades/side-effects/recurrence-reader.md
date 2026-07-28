# Side-Effects Review — RecurrenceReader (Tier 2 core, read-only)

**Version / slug:** `recurrence-reader`
**Date:** `2026-07-27`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `see Phase 5`

## Summary of the change

One pure module (`src/core/RecurrenceReader.ts`) that groups OPEN observations from the attention
queue, the evolution action queue and the sentinel log into recurrence clusters, plus a `coverage`
block naming every store it could not read.

Project `convergence-towards-coherence` Tier 2. The plan's diagnosis: instar notices constantly, in
three places, and nothing reads across them — so one problem is noticed dozens of times and closed
zero times (measured filing-to-completion ≈ 30:1).

**Measured on live data, 2026-07-27:**

```
open observations across 3 stores : 2,068
distinct problems                 :   836
noticing ratio                    :  2.47
noticed repeatedly, NEVER tracked :    69 problems / 1,242 noticings
top clusters:  278x idle-timeout detection
               238x escalation-suppressed (telegramEscalation disabled)
               177x credential rebalancer  ← 48% of the attention queue alone
```

## Refusal evidence (constraint 2)

The whole design risk is that a synthesiser becomes a MORE expensive version of the defect it
detects: reading 2 of 3 stores and reporting "nothing recurring" with the authority of having looked.

```
REFUSAL — action store made unreadable, on REAL data
  coverage      : partial
  could NOT read: [{"store":"actions","reason":"ENOENT: evolution store unreadable"}]
  clusters      : 59        ← still reports what it DID see
  verdict       : ABSENT — refuses to say no-recurrence

THE DISTINCTION THAT MATTERS
  genuinely nothing there → "no-recurrence"
  could not look         → undefined  (field absent, not hedged)
```

Unit suite: **11 passed (11)**; `tsc --noEmit` exit 0.

## Decision-point inventory

| point | classification | note |
|---|---|---|
| recurrence key (digits→N, hex→H) | `invariant` | Deterministic string normalization. No model. |
| cluster grouping | `invariant` | Map by key. |
| `verdict` emitted only on complete coverage | `invariant` | The load-bearing rule. |
| `significantClusters` minCount / untrackedOnly | `invariant` | Caller-supplied thresholds, defaulted, not inferred. |

No judgment points, no LLM, nothing gated. The module holds **no authority whatsoever** — it returns
a report.

## 1. Over-block

Nothing is blocked; the module is read-only and returns data. The realistic over-*grouping* risk is
the blunt key: two genuinely different problems whose titles differ only by digits would merge. That
is a deliberate trade, stated in the source — surfacing shape is the goal, and an over-eager grouping
a human instantly recognises as one problem beats a precise grouping that preserves the illusion of
371 separate things. `exemplar` and `sources` are carried on every cluster so a reader can spot a bad
merge immediately.

## 2. Under-block

**Title-only keying.** Two reports of the same underlying problem with genuinely different wording
will not merge. Accepted: the alternative is semantic matching, which means an LLM, which means a
judgment point in something that currently has none.

**`open` is caller-supplied.** The module trusts the caller's open/closed determination per store.
That is the correct seam — each store knows its own status vocabulary — but it means a caller that
mis-maps status inflates or deflates the counts. The live harness maps `status === 'OPEN'`,
`pending|in_progress`, and treats sentinel events as open.

**No route yet, no action yet.** This increment is the reader only. Driving action is Tier 2 item 4,
deliberately separate because it carries authority this does not.

## 3. Level-of-abstraction fit

A pure function over supplied observations, with I/O left entirely to the caller. That is
deliberate: it means the module **cannot** silently swallow a failed store read — the caller must
hand it a `coverage` block, so an unreadable store is structurally impossible to omit. Putting the
reads inside would have made "forgot to report the failure" a one-line mistake.

## 4. Signal vs authority compliance

Textbook signal-producer. It returns a report and holds zero blocking, gating or notifying authority.
`docs/signal-vs-authority.md` satisfied — and this is the exact seam the operator flagged: synthesis
must drive action through EXISTING gated paths, never become a new notification channel. Keeping the
reader authority-free is what makes that possible later.

## 5. Interactions

- **Attention queue / evolution actions / sentinel log** — read-only consumers, no writes, no schema
  change. Nothing else observes this module yet.
- **Nothing shadows or is shadowed.** New module, no existing caller.

## 6. External surfaces

**None in this increment.** No route, no config, no persisted state, no user-visible behaviour. A
route is the obvious next step and is deliberately not here.

## 6b. Operator-surface quality

`coverage.unreadable[].reason` carries the actual failure text so a caller can say *why* it could not
look, not merely that it could not. `noticingRatio` is `null` — never `0` — when there is no
denominator, so a client that ignores the contract gets an obviously-missing value rather than a
plausible wrong one.

## 7. Multi-machine posture

**Posture: `machine-local`.** `machine-local-justification: physical-credential-locality` — the three
stores are per-machine records of what THAT machine noticed, and observation titles routinely carry
machine ids, topic ids and account emails. Replicating them to synthesise centrally would multiply
at-rest exposure of that context across every machine. The correct cross-machine read is the existing
pool-scope fan-out (`?scope=pool`), which serves each machine's own data from that machine — a
follow-up for whoever adds the route, noted rather than assumed.

## 8. Rollback cost

**Zero.** One new module and one new test file, with no callers. Deleting them removes the feature
entirely; nothing else changes. No persisted state, no migration, no config.

## Phase 5 — Second-pass review

Not a gate, sentinel, guard or watchdog; no block/allow authority; no session lifecycle or trust
surface; no LLM. High-risk trigger list not engaged. Author lenses:

**Adversarial — "how would I make this useless?"** By letting it report a clean verdict over a
partial read. That is the one thing it structurally cannot do, asserted from both directions
(complete-and-empty → `no-recurrence`; incomplete → field absent) and demonstrated on real data.

**"Would it have caught the incident?"** The incident is the project's premise, and yes — 2,068
noticings collapsing to 836 problems with 69 untracked recurrers is precisely the shape nobody could
see. It found it on first run.

**"Symptom or cause?"** Cause, for the invisibility. NOT for the recurrence itself: this makes the
69 untracked recurrers visible, it does not close them. Closing them is item 4, and claiming
otherwise would be the filing-as-progress failure the project exists to remove.

**Weakest point:** the blunt recurrence key. It will occasionally merge two things a human would
separate. Mitigated by carrying `exemplar` + `sources`, and preferable to under-grouping — but it is
the assumption most likely to need revisiting once a human reads a real report.
