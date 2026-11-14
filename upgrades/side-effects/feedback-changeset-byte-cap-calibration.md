# Side-Effects Review — Feedback change set byte cap calibration

**Version / slug:** `feedback-changeset-byte-cap-calibration`
**Date:** 2026-11-04
**Author:** Echo
**Second-pass reviewer:** independent decision reviewer

## Summary of the change

Raise the feedback executor's full-file byte ceiling from 4 to 5 MiB so edits to the measured `server.ts` and `routes.ts` pair can enter review. Above 4 MiB, every added or modified file must be valid UTF-8 text without NUL bytes. Keep the 200-file cap, confinement and secret gates, 192 KiB independent diff-review ceiling, and downstream test/CI gates. Parent spec, code comments and unit boundaries are updated in the same patch.

## Decision-point inventory

- `buildChangeSet` byte ceiling — modify — deterministic resource/safety limit becomes 5 MiB.
- `buildChangeSet` over-4 MiB binary rule — add — opaque content stays under the former aggregate limit.
- Existing special-file, `.claude`, credential, diff and file-count gates — pass-through.

## 1. Over-block

A valid change above 4 MiB containing an added binary fixture, a NUL-bearing source file, or non-UTF-8 text still fails. This preserves the former allowance for opaque files because the independent PR diff may omit their bytes. Legitimate text changes above 5 MiB also fail; the worker can split the fix or the cap can be recalibrated with measured evidence.

## 2. Under-block

A valid UTF-8 file without NUL could still encode opaque content, so this is not a semantic text proof. Secret scanning still sees the full bytes, and independent review sees the PR diff; the 192 KiB diff refusal limits changed text. The rejected a1 candidate has no recorded total byte size and is not proven to fit the new cap.

## 3. Level-of-abstraction fit

`buildChangeSet` owns trusted extraction from the confined workspace and already enforces aggregate size. The adjacent text check protects the only newly admitted size range. It does not decide whether the patch is useful or correct; the existing independent review and tests do that.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md). This is a hard resource and opaque-content invariant on an untrusted worker payload before copying it to a trusted clone. The exact byte, NUL and UTF-8 facts are deterministic and complete for this narrow rule. A model cannot safely waive the resource bound; it still judges the patch afterward.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The bounded payload allowance is an invariant; usefulness and risk remain with independent review.

## 5. Interactions

The 5 MiB aggregate cap runs during trusted workspace extraction. The binary rule runs after aggregate accounting and before the change set returns. The secret gate later scans full bytes, and independent review retains the diff ceiling. No concurrent state or cleanup behavior changes; a failed attempt is already disposed and needs a fresh run.

## 6. External surfaces

The executor may now create a reviewable PR from a text-only change between 4 and 5 MiB where it previously failed `changeset-too-large`. No new operator action, API shape, user notice, persistent record format, or migration is introduced. Existing agents receive the changed compiled code on update.

## 6b. Operator-surface quality

No operator surface is touched.

## 7. Multi-machine posture

The gate is the same code invariant on each installed machine. Existing canonical-owner selection chooses where feedback execution runs; this patch adds no replicated state, phone action, URL, or notice.

## 8. Rollback cost

Revert the constant and binary condition in a normal release. No data migration or state repair is needed. Any PR already created remains under review, exact-head tests and CI; rollback does not merge it.

## Second-pass response

Concur with the review. The artifact matches the current diff; the 5 MiB text allowance, retained 4 MiB binary ceiling, 200-file cap, secret scan and independent review gates are accurately described. No migration or operator surface is introduced. (Independent decision reviewer, 2026-11-04.)
