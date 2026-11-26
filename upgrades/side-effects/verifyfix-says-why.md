# Side-Effects Review — a failed check run records its own output

**Version / slug:** `verifyfix-says-why`
**Date:** `2026-10-25`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required — see §4 (no decision surface; the four verdicts are byte-identical, only the failure RECORD changes)`
**Tier:** `1` — 3 source files, 1 test file, ~60 added lines. Observability on existing failure paths plus one shared helper extracted from already-reviewed code. A revert fully undoes it; one additive meta row, no migration.
**Effort:** 0 spec rounds, 0 review rounds, 1 commit. Deliberately proportionate — the design reasoning (bounding before the scrubber, keeping the END, sharing one bound) was settled over three adversarial rounds on the canary capture this mirrors; re-litigating it here would be ceremony.

## Summary of the change

`verifyFix`'s four failure returns recorded a label and discarded the command's captured output:
`base-check:<reason>`, `head-check:test-fails-at-head`, `gate:lint`, `gate:related-tests`. The
three check clones are removed with the attempt, so the cause was unrecoverable after the fact.

This is the defect filed as `fb-ac4a1273-38a`, promoted to in-run work because it sits directly on
the path of the current autonomous goal (steps 5–6: the executor's first real fix attempt). It is
the same blindness that made `base-unit-smoke` cost three days one step earlier — the only
difference is that this one had not bitten yet.

- `executePolicy.ts`: new `commandFailureTail(r, { perStream, redact? })` — ONE bounded-tail helper
  for both places a confined command can fail. `confinementCanary.failureTail` now delegates to it,
  keeping its nonce redaction via the `redact` hook; behaviour there is unchanged.
- `FeedbackExecutorService.ts`: `verifyFix` returns an optional `detail` built from the failing
  command's output; a new `recordCheckFailure` persists it, scrubbed and clamped through the same
  `scrubForStore` + `clampProbeDetail` path the canary latch uses, into `exec:check_failed_last`,
  surfaced as `status.lastCheckFailure` beside the existing `lastPrepareFailure`. One audit row
  (`execute:check-failed`) carries the reason only.

**Why a separate row rather than a richer reason:** the reason is prefix-matched elsewhere (e.g.
`(row.reviewReason ?? '').endsWith('-unavailable')`), so appending free text to it would be a
quiet correctness hazard. `lastPrepareFailure` already established the separate-row pattern.

## Decision-point inventory

- `verifyFix`'s four verdicts — **pass-through**. Every `exitCode`/`verdict.ok` test is unchanged;
  the new `detail` rides alongside the same `reason` on the same failure branch.
- `recordCheckFailure` — **add**, observability only. Best-effort: wrapped so a recording failure
  cannot mask the check failure it describes.
- `status` payload — **add** one field.

---

## 1. Over-block

No block/allow surface. Nothing that passed now fails: the verdicts are computed identically and
the record is written after the decision, on the failure branch only.

## 2. Under-block

Stated explicitly:

- **Output beyond the per-stream bound is dropped**, and in the `outputCapped` case the kept "tail"
  is the end of a truncated prefix (`runCapped` keeps the FIRST bytes at its 5 MB cap). `outputCapped`
  is not labelled in the detail. Same residue as the canary capture; low likelihood at 5 MB.
- **Only the LATEST check failure is kept** (one row, overwritten). A burst of attempts failing
  differently keeps only the last. The audit row carries every reason, so the sequence is still
  recoverable — just not every output.
- **No redaction hook is passed here.** The canary plants a nonce and strips it; these runs plant
  nothing, so only `scrubForStore`'s credential-shape redaction applies. A secret that is neither a
  known shape nor planted by us would not be caught — the same honest residue as the canary path.
- **Lint and test output can quote repository content**, including instar's own adversarial test
  fixtures, into durable operator-read text. Bounded at ~2 KB, Bearer-gated route, no outbound
  message path. Named rather than smoothed over, as on the canary change.

## 3. Level-of-abstraction fit

Right layer, and the sharing is the point. `runCapped` already captures both streams; the defect
was discarding them between capture and storage. The helper lives in `executePolicy` because two
call sites need the identical bound — and the first review round of the canary change caught
exactly this class of mistake (a redirect added to the rehearsal and not the real run), so a second
copy of the bound here would have been repeating a defect I had already been shown.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It records why an existing authority refused. No verdict, gate, latch or ladder is touched.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point — the only new conditionals are "is
this stream empty" and "take the last N characters" on an already-decided failure.

## 5. Interactions

- **Shadowing:** `recordCheckFailure` runs before `endAttempt`, which is unchanged; the retry/hold
  path (`afterFailure`) is untouched.
- **Double-fire:** one row per failure, overwritten by the next.
- **Races:** `setMeta` is epoch-fenced like every other writer; a stale-epoch write is refused as
  it is everywhere else, and the surrounding try/catch means that refusal cannot mask the failure.
- **Shared helper:** `failureTail`'s output is byte-identical after delegation (redaction still runs
  before slicing, inside the helper) — proven by the canary's existing tests, which fail if the
  helper keeps the wrong end.
- **Feedback loops:** none. `lastCheckFailure` is read by a Bearer-gated status route only.

## 6. External surfaces

- **Install base:** the executor is dev-gated (`feedbackFactory.execute`, 503 on the fleet).
- **Persistent state:** one additive meta row (`exec:check_failed_last`). No migration; absent on
  installs that have never had a check failure, and the status field is then null.
- **Operator surface:** none added. The new field appears in the status response already read.
- **External systems:** none.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** A check failure describes an attempt that ran on this machine, in that
machine's own clones, under its own sandbox; the executor runs only on the operated host
(`feedbackFactory.operatedHostMachineId`). Mirrors `lastPrepareFailure`, which is already per-machine.
No notices, no topic-scoped state, no generated URLs.

## 8. Rollback cost

Revert and ship as the next patch. No migration (a reverted build simply stops writing the row and
reports the field as null), no agent state repair, and the only user-visible effect of reverting is
that the next check failure goes back to being a bare label.

## Conclusion

The useful output of this review is §2 and §3: the residues are the same ones already accepted on
the canary capture (capped-output tails, a single latest row, no planted-secret redaction), and the
sharing of one bound is a direct application of a defect a reviewer caught in the predecessor rather
than a fresh design choice.

The reason this was built now rather than left in the queue: it is not a found problem, it is the
next step's known blindness. The filed item (`fb-ac4a1273-38a`) explicitly noted it would be opaque
if step 5 or 6 died there, and this run's goal IS steps 5 and 6. Fixing it before the first real
attempt is the whole lesson of the preceding three days.

Clear to ship.

## Second-pass review (if required)

**Not required.** No block/allow decision, no session-lifecycle surface, no gate authority: the four
verdicts are byte-identical and only the failure record changes. The design questions a second pass
would raise here were settled across three adversarial rounds on the canary capture this mirrors,
and the shared helper means its guards cover this path too — demonstrated by the head-slice mutation
failing the canary's tests as well as this one's.

## Evidence pointers

- Mutation-verified three ways, each previously-passing: unwiring `recordCheckFailure` fails;
  dropping the `detail` fails; head-slicing instead of tailing fails **three** tests (this one plus
  both canary capture tests — the proof that the bound is genuinely shared, not duplicated).
- `tests/unit/feedback-factory/` 46 files / 644 tests green; `npm run lint` clean; `tsc` clean.
- One flake observed and run down rather than assumed: `execute-reroute-capacity.test.ts` failed
  once in a full-suite run and passes 7/7 in isolation **both with and without this change**, and
  the full suite is green on re-run. Suite-interaction flake, not this change.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in instar's own TypeScript (four
failure returns discarding captured output), not in an LLM prompt, hook, config, skill, or standards
text. No self-triggered controller is added or modified.
