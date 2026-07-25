# Convergence report — `inbound-message-recording-gap`

**Status: NOT CONVERGED.** No convergence tag has been written and none should be
until a round earns it. This report is written as the review runs, not
reconstructed afterwards, so the honest shape of the process is preserved
including the parts that reflect badly on the author.

---

## What the spec is

Close a live data-loss defect: the machine that composes replies records every
message it sends and none of the messages it receives. **Re-verified against live
state mid-review, and the re-check moved the headline in the worse direction:**
the last inbound row machine-wide is **2026-07-01 — 24 days**, not the
"since 2026-07-20" first recorded. That earlier figure was true and understated
the defect by three weeks, because it was measured over a window chosen for an
unrelated reason. On 2026-07-25 the working topic held 111 messages, none of them
received; that day alone, 67 outbound and 0 inbound. The recording code is not
broken; it sits on a path that is not being used.

The fix logs at the session-injection seam, the one point verified to be on every
currently-known delivery path.

## Headline honesty

- **64 rounds run, none clean.** Verdicts: SERIOUS at rounds 34, 45-56; MINOR before and after. The return to MINOR at round 57 is the first since 44. Every round has returned findings.
- **The verdict escalated once**, at round 34 (MINOR → SERIOUS), because the fold
  that added a normative boundary immediately violated it.
- **Roughly one finding per round is self-inflicted** — a contradiction created
  by the previous round's fold. That rate has not reached zero.
- **The spec is no longer small.** It opened as "one mechanism, one seam, one
  flag" and `single-run-completable` has been corrected to `false`.
- **Two reviewers independently recommend splitting it** (ACT-1219). The
  prioritisation is the operator's — it trades fixing the data loss sooner
  against carrying an unbounded log.

## The failure mode this review actually exposed

Not a bad design. **Contradictory prose.** Codex named it directly at round 31:

> The main risk is not the chosen design, but contradictory prose causing the old
> async design to be partially implemented.

Three consecutive rounds (31, 32, 33) opened with a leftover reference from the
previous fold. The mechanism is the one already recorded as ACT-1215 on the
2,700-line companion spec — restating a design in a second place creates a second
place to be wrong — reproduced here at a tenth the size, which means size was
never the whole explanation.

**Six consecutive rounds (29–35) asked for the same structural change**, from
both reviewer families independently: separate the contract from the
archaeology. The first five were answered with more prose about the problem
rather than the change itself. That is a documented failure to apply this
project's own foundational principle — a structural complaint answered by
willpower.

**Round 36 then found the process error underneath it:** the generated contract
had been declared normative while the *source* file continued to be sent to
reviewers. No reviewer had read the artifact the spec said to build from, and
some fraction of the "historical prose reads as normative" findings were
therefore findings about a document that no longer mattered. From round 37 the
review runs against the generated contract.

## Findings that changed the design (not editorial)

| Round | Finding | Effect |
|---|---|---|
| 27 | "Code landed" ≠ "bug fixed" — shipping default-off means the PR merges while zero extra messages are recorded | Acceptance redefined: flag ON for the affected machine, verified by reading back a real message |
| 27 | Dedupe key insert order unstated | Insert only *after* a successful append; insert-first would make a failed write permanently suppress its own retry |
| 28 | **Missing alternative**: an intake-edge event log covers strictly more | Recorded with honest reasons for not choosing it — including that the intake edge on this machine is exactly what is unknown |
| 29 | `appendFileSync` can block **indefinitely**; the "logging never stops delivery" invariant rests on the syscall returning | Residual named and accepted; local-storage requirement; no mechanism claimed |
| 32 | "Code merges, config does not persist" | Health reports flag state *and* recent inbound count |
| 33 | Retention, growth and privacy never asked in 32 rounds | Rotation/retention policy; resume history honestly bounded |
| 34 | Privacy posture undefined for indefinitely-retained plaintext personal messages | §4.0 written; no-encryption-at-rest stated as a *choice* to be argued with |
| 34/35 | **Both families independently**: the store should be SQLite, not JSONL | Recorded as expected next step (ACT-1218), deferred on sequencing only |
| 36 | Reviewing the source while declaring the contract normative | Review target changed |
| 37 | The generator's own banner claimed history was "deliberately absent" and it was not | Tool fixed; banner now reports what it *cannot* remove, with a count |
| 38 | **Rotation protocol deleted the newest file every time** and read history backwards | Monotonic-sequence scheme with the reasoning stated; invariant tests added |
| 40 | `messageId` had three wire shapes; "authoritative" overclaimed with no `fsync`; `enabled && !armed` had no runtime rule | All three pinned in the contract |
| 40 | Fleet default-on evidence measured on one machine | Gates re-scoped to the affected machine; fleet default requires staged per-host health |
| 41 | The state field name had been wrong **three times**, each by one notch of overclaim | `received` → `sessionReceived` → `injection_seam_received`: only the last states what the row can prove |
| 41 | ACT-1218 was vague future debt | Given four observable migration triggers; if none fires, JSONL was the right call |
| 42 | The contract specified `(timestamp, rowid)` for JSONL — **a store with no rowid** | JSONL ordering key defined as `(seamReceivedAt, fileSequence, lineNumber)` |
| 43 | The whole design rests on a file lock; "valid lock" was never defined | Stale-lock semantics pinned (pid + boot-id + host); network paths unsupported |
| 44 | **The round-43 lock fix recreated the outage** — a dead-pid lock after an ordinary crash meant never arming again | Same-host dead-pid locks reclaimed automatically; ambiguity narrowed to foreign host / bad boot-id / unreadable |
| 44 | Plaintext retention justified only on latency grounds | Encryption/field-capture made a **precondition of fleet default-on**, not a permanent stance |

## Tracked follow-ups

- **ACT-1217** — identify the actual Telegram intake edge on this machine. The
  routing mystery is not closed by choosing a verified seam.
- **ACT-1218** — evaluate migrating the message log to SQLite. Roughly four
  findings across rounds 27–34 exist *only* because the store is a text file.

## The one measurable result

**Rounds 33-39: every round carried a "still too archaeological" finding.
Round 40: none.**

The change between them was not editorial. The generator was inverted from a
denylist ("remove what is definitely history") to an allowlist ("keep only
contract-bearing sections"), and the review was pointed at that output instead of
the source spec. The contract went from 1,487 lines to 874; the companion spec's
went from 2,765 to 270.

Round 40's five findings were all about the *contract* — three different wire
shapes for one field, an overclaimed word, a missing runtime rule for a state the
spec had itself defined. Those are the findings a review is supposed to produce.
Seven rounds of "this document is hard to read" were, in retrospect, a reviewer
repeatedly telling me the artifact was wrong while I kept improving the prose
inside it.

**The lesson is not "write shorter specs".** It is that a review can spend seven
rounds on a real problem without the author hearing it, if the author keeps
answering a structural complaint with content. Both reviewer families said the
same thing, in the same words, from round 29 onward.

## An honest assessment at round 64

**Every recent round has found real defects — this is not churn.** Rounds 60-64
found, in order: the spec's central claim was wrong (it is best-effort recording,
not guaranteed); a retry budget whose arithmetic was off by 5×; a privacy control
whose name was false because it still routed text to the search index; a fix for a
circular detector that was itself circular; and an arming algorithm that could not
work on a first install.

**And a clean round has not happened in 64 attempts.** The reason is visible in
that list: most of those defects were introduced by the *previous* round's fold.
The fold rate and the introduction rate have not separated.

**What this says about the method.** Review is working — every one of those would
have been a real bug — but review alone cannot converge a hand-maintained document
of this size, because each correction is itself a hand edit with its own defect
rate. The structural answers found here (generation over restatement; replacing
sections rather than sweeping them; a normative checklist with no narration) each
reduced the rate, and none took it to zero.

**The honest recommendation is therefore not "keep reviewing".** It is: build
Increment A from the normative checklist, where a compiler and a test suite give
feedback that prose review cannot, and let the remaining spec defects surface as
implementation friction rather than as round 65.

## What would make this converge

A round that returns nothing new. That has not happened, and the self-inflicted
finding rate suggests it may not while the design is maintained as prose in two
places. The structural answer already identified — generation over restatement —
landed at round 35/36 and rounds 37+ are the test of whether it works.

## The pattern worth generalising: conservative guards that recreate the outage

**Twice, a guard written to be careful would have caused the exact failure the
spec exists to prevent** — and both times it took the next round to catch it:

| Round | The careful rule | What it would have done |
|---|---|---|
| 43 | A dead-pid lock is "ambiguous", never reclaimed | After any ordinary crash: `enabled && !armed`, silently not recording until a human noticed |
| 45 | Only `apfs/hfs/ext4/xfs/btrfs` are trusted local filesystems | Refuse to arm on overlayfs, zfs, tmpfs, encrypted volumes, containers, CI — all local |

Stated as a rule in the spec: **a guard whose failure mode is "stop recording"
must be biased toward arming, because not-recording is the thing it guards
against.** Both rules were written by the same author who had spent the whole
review insisting the defect was silent data loss.

## The resolution at round 46: two increments

Round 45 concluded the store choice might be wrong. Round 46 pointed out the
contract still mandated the whole hand-built log subsystem regardless — an
incoherence created by round 45's own honesty. The fix is the split two reviewers
had already recommended (ACT-1219):

- **Increment A** — the seam call and its immediate machinery. JSONL accepted;
  at that size the format genuinely is the smaller change. Does not rotate; the
  unbounded file is a named, one-machine, time-boxed exposure and is strictly
  better than losing every message.
- **Increment B** — rotation, retention, ordering, recovery. **The store choice is
  decided here** (ACT-1220), and if it lands as SQLite most of that machinery is
  never built.

Every contract row is now marked (A) or (B). **This is the first structural change
in the review that makes the fix shippable sooner rather than later.**

## The result that mattered: rounds 45-51 changed the design

The review's most valuable output was not a list of fixes. It was killing an
assumption the spec had carried unexamined from round 27 to round 50.

**The claim:** JSONL is the smaller change; SQLite would mean a migration.

**What review established, cumulatively:**

- Round 45 counted what "the smaller change" had grown to require by hand:
  rotation sequencing, a three-part ordering key, torn-line recovery, bounded
  seeding, lock semantics with boot-id and stale reclaim, corruption classes, a
  canonical dedupe key, and a helper that must be the sole reader. Every one
  arrived as a *review finding*, not a design decision.
- Round 50 found the objection was simply false. `better-sqlite3` is already a
  dependency; `TopicMemory` already opens it. A new table migrates nothing.
- Round 51 established the design could not stay ambiguous — two incompatible
  designs cannot both be normative.

**Result: the contract went from 52,095 characters to 6,385 — 88% smaller.**
Nothing was cut for brevity. Every deleted row described machinery that existed
only to make a text file behave like a database. Dedupe also became *stronger*:
storage-enforced by a `UNIQUE` index rather than best-effort via an in-memory set
plus a lock file.

**And the four-round A/B increment split (46-49) evaporated**, because every row
it deferred was deferred *because JSONL needed it*. Four rounds were spent
managing a boundary that the storage choice had created.

The lesson is not about SQLite. It is that **a justification stated once at round
27 was still being repeated at round 50 without ever being re-tested**, while the
thing it justified grew by an order of magnitude underneath it.

## The lesson from rounds 51-54: sweep-vs-replace

The storage rewrite at round 51 replaced §3.0 wholesale. The four rounds after it
were spent finding JSONL residue elsewhere in the document — and each round I
answered with a **grep-based sweep**, and each sweep left pockets:

| Round | Residue found after the previous sweep |
|---|---|
| 52 | Health reported rotation state; retention quoted a 160 MB window; tests covered rotation and a `-1` migration; acceptance verified a file lock |
| 53 | Append/rotation/lock language in test plan, acceptance, decision points, frontloaded decisions |
| 54 | Rotation protocols, suffix ordering, dedupe seeding, append helpers, file interleaving — still in §5 |

At round 54 the approach changed: **§5 was replaced wholesale**, 15,036 characters
to 5,099, the way §3.0 had been. **Partial sweeps are how residue survives** — a
grep finds the phrases you thought of, and a section written against a different
design has assumptions the phrases do not name.

Generalised: when a design changes, **replace the sections that describe it;
do not edit them.** Editing preserves the shape of the old design in the prose
structure even after every keyword is gone.

## Grounding found what 52 rounds of review did not

At round 53, reading `src/memory/TopicMemory.ts` — the file this spec extends —
showed the existing `messages` table already has `AUTOINCREMENT` ordering, a
uniqueness constraint, and every field the new table specifies. **A new table may
be unnecessary entirely.**

No reviewer found that in 52 rounds, because reviewers read the spec. The spec's
own §1 records that the original defect existed because nobody verified which code
path was actually in use. Recorded as an open question (§3.0b) rather than acted
on — two large unreviewed restructures tonight each introduced defects the next
round cleaned up.

## The most instructive thing in the whole review

**One decision — synchronous main-thread SQLite before injection — produced three
successive justifications from me, and the reviewer knocked down the first two.**

1. **Round 54:** "no new subsystem". Named the alternative without weighing it.
2. **Round 57:** weighed it — but against *in-memory* enqueue, a strawman. The
   real pattern is a durable outbox, and **that is what this design already is**.
   Conclusion drawn: "the stall lives in the requirement, not the implementation."
3. **Round 59:** that conclusion is **false**. Durability-before-injection is only
   synchronous *on the main thread*. A worker-owned SQLite connection waits for
   the commit while yielding the event loop — same guarantee, no whole-process
   stall.

What survives is much smaller than what I argued: main-thread `better-sqlite3` is
already the dependency and already `TopicMemory`'s pattern, so it is one call
rather than a worker plus a protocol plus a lifecycle. **A simplicity argument for
a local single-agent fix** — and the residual is correspondingly *worse* than I
had been stating, because a wedged device stalling every conversation is now
attributable to the implementation choice rather than to the guarantee.

**The pattern to notice is the author's, not the design's.** Each time a reviewer
pressed on the riskiest decision, I produced a *more satisfying* argument for the
thing I had already chosen. Twice those arguments were wrong in a way that made
the design look better than it was. Neither was a lie; both were reasoning that
stopped as soon as it reached a comfortable conclusion.

## The circular-detector mistake, made twice

**Round 47:** the stall detector was unreachable — in-process alarms cannot fire
when a wedged write blocks the event loop that runs them. Fixed by exposing a
loop-tick counter on `/health` for the out-of-process watchdog.

**Round 63:** that fix is *also* circular. A wedged event loop cannot serve the
`/health` request either, so the counter is unreachable in exactly the failure it
was added for.

The working answer was available at round 47 and is almost embarrassingly simple:
**no response is the signal.** The watchdog's existing request timeout already
produces it. Two rounds were spent adding a mechanism when the absence of a
mechanism's output was the evidence.

Worth keeping because the shape recurs: when a detector lives inside the thing it
detects, moving the *readout* outside is not enough — the *read path* has to be
outside too, and the strongest evidence is often the absence of a signal rather
than the presence of one.

## Findings that came from the review disagreeing with itself

Three rounds produced findings by weighing an alternative the spec had only
*named*:

- **Round 54** asked for a real comparison against a durable queue. I wrote one.
- **Round 57** showed that comparison had **strawmanned** the alternative —
  weighing in-memory enqueue rather than a durable outbox.
- Weighed honestly, **the durable outbox is what this design already is**: the
  synchronous `INSERT` is the outbox write, the deferred index write is the drain.

The useful part is the conclusion that fell out: **the stall risk lives in the
requirement, not the implementation.** "Make it durable before proceeding" is
synchronous in every design that satisfies it. Any variant that removes the stall
removes the durability — which is the defect this spec exists to fix. That
reframes the residual from "a weakness of this design" to "the cost of the
guarantee", and it took being wrong twice to get there.

## The self-inflicted rate, measured rather than asserted

Of 19 rounds folded tonight (26-44), **at least one finding in 8 of them was a
defect the previous fold introduced** — the retention-in-the-wrong-section
(34), the rotation scheme that deleted the newest file (38), the contract/prose
contradictions (30, 31, 32), and the lock rule that recreated the outage (44).

That is the honest reason this has not converged: the fold rate and the
introduction rate have not separated. It is also the strongest argument for the
split (ACT-1219) — a smaller surface has fewer places for a fold to break
something else.

**Nothing here should be read as approval-ready.** The design is sound enough
that no reviewer contests it; the *document* has repeatedly been the defect.


## Reviewer-availability caveat (2026-07-25)

**The gemini-cli arm has been failing since round 35.** It returned
`status: degraded, reason: timeout` on every subsequent attempt, including a
control test against a ~6KB document — so this is a broken reviewer, not a
size limit. Logged as a framework issue.

Consequence for reading any round after 35: **there was no second family.**
Findings from those rounds come from `codex-cli:gpt-5.5` alone. Where this report
says "both families independently", that claim applies only to rounds 34-35 and
earlier, and was checked before being written.
