# Verification Head Observation

## Summary of the change
The coordinator stores the first time it sees each GitHub pull request revision and carries that observation through queue admission to the recorded verdict.

## Decision-point inventory
The watcher and the coordinator's GitHub reads supply the observation. An admission may copy it only for the same pull request and revision. A verdict omits a timestamp later than its finish.

## 1. Over-block
An observation write failure is audited. Verification can still proceed.

## 2. Under-block
Missing timestamps carry no permission to run, approve, skip, or merge work.

## 3. Level-of-abstraction fit
One coordinator-owned observation store serves both discovery paths. The separate stability clock continues to serve its existing purpose.

## 4. Signal vs authority compliance
The timestamp is evidence for reporting. The verifier still owns its verdict.

## 4b. Judgment-point check
Existing admission limits, eligibility tests, human holds and merger checks keep their existing authority.

## 5. Interactions
A revision can disappear from the watcher's bounded listing and return. Its observation survives on disk. Replacement heads have independent clocks. A copied verification result uses the requesting pull request's own clock.

## 6. External surfaces
Admission events, queued entries and verdicts may expose firstObservedAt as Unix milliseconds. Older records remain readable. No new endpoint is required.

## 6b. Operator-surface quality
The measure starts at the coordinator's observation and ends at the recorded verdict. Polling introduces a delay between publication and first sighting. A missing timestamp means the elapsed time is unknown.

## 7. Multi-machine posture
Each coordinator owns its local observations. Worker clocks do not supply the publication signal. Atomically replaced per-PR files grow with the number of distinct revisions of that PR. The in-memory index has a cap.

## 8. Rollback cost
A revert stops new observation writes. The previous verifier can ignore the optional fields. The observations can be retained for later reporting.

## Conclusion
This affects measurement and preserves the verification decision path.

## Second-pass review
Independent source review raised interrupted writes and restore paths. Atomic replacement and coordinator-side observation on restore resolved both findings. The reviewer concurred after inspecting the corrections.

## Evidence pointers
The focused tests cover the watcher, service, HTTP records and production lifecycle. TypeScript compilation passed. The focused check used one worker, with the limiter reporting dry-run WOULD-BLOCK.

## Class-Closure Declaration
Observational change only. Correctness is bounded by sighting on the active coordinator and by the observation surviving on its storage.
