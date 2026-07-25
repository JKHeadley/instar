# Convergence report — `inbound-message-recording-gap`

**Status: NOT CONVERGED.** No convergence tag has been written and none should be
until a round earns it. This report is written as the review runs, not
reconstructed afterwards, so the honest shape of the process is preserved
including the parts that reflect badly on the author.

---

## What the spec is

Close a live data-loss defect: the machine that composes replies records every
message it sends and none of the messages it receives. Verified twice against
live state — 71 stored messages for the working topic, all outbound, zero
inbound; zero inbound rows machine-wide since 2026-07-20; zero hits on the route
that does the recording. The recording code is not broken; it sits on a path that
is not being used.

The fix logs at the session-injection seam, the one point verified to be on every
currently-known delivery path.

## Headline honesty

- **37 rounds run, none clean.** Every round has returned findings.
- **The verdict escalated once**, at round 34 (MINOR → SERIOUS), because the fold
  that added a normative boundary immediately violated it.
- **Roughly one finding per round is self-inflicted** — a contradiction created
  by the previous round's fold. That rate has not reached zero.
- **The spec is no longer small.** It opened as "one mechanism, one seam, one
  flag" and `single-run-completable` has been corrected to `false`.

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

## Tracked follow-ups

- **ACT-1217** — identify the actual Telegram intake edge on this machine. The
  routing mystery is not closed by choosing a verified seam.
- **ACT-1218** — evaluate migrating the message log to SQLite. Roughly four
  findings across rounds 27–34 exist *only* because the store is a text file.

## What would make this converge

A round that returns nothing new. That has not happened, and the self-inflicted
finding rate suggests it may not while the design is maintained as prose in two
places. The structural answer already identified — generation over restatement —
landed at round 35/36 and rounds 37+ are the test of whether it works.

**Nothing here should be read as approval-ready.** The design is sound enough
that no reviewer contests it; the *document* has repeatedly been the defect.
