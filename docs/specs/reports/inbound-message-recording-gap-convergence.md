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

- **40 rounds run, none clean.** Every round has returned findings.
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

## What would make this converge

A round that returns nothing new. That has not happened, and the self-inflicted
finding rate suggests it may not while the design is maintained as prose in two
places. The structural answer already identified — generation over restatement —
landed at round 35/36 and rounds 37+ are the test of whether it works.

**Nothing here should be read as approval-ready.** The design is sound enough
that no reviewer contests it; the *document* has repeatedly been the defect.
