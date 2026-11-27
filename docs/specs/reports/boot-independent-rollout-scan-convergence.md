# Rollout Scan Review History and Operator-Authorized Bounded Closure

Status: operator-authorized bounded closure under Chief8bd0d9d5, not full convergence. Both authorized reviewers cleared the three prepared corrections at SHA bb8991be7a8be1f7a71aecf14bb0e2ba7349d5dd72565c400d7a68e8b384eaf0. Source implementation may proceed; no test or deployment result is claimed.

## Authority and Scope

Chief70019126 authorizes asynchronous scanner repair only; current lease and restart policies remain unchanged. N81 separately owns boot-demotion/service-fencing work after this repair lands.

## Iteration Summary

- Round1: all six internal lenses (three independent agents, two named lenses each), actual external Codex review, nondegraded conformance102articles/5flags. Child ownership, service-fencing and arbitrary-limit issues found. Chief authorized replacing scanner-child design with existing async Git and file surfaces and separating restart suppression.
- Round2: six internal lenses, actual external, conformance102/4flags. Closed final shutdown, end-to-end responsiveness and incomplete canonical observation concerns.
- Round3: six internal lenses quiet; actual external still found shutdown-error handling and a test that demanded unnecessarily slow application. Conformance102/3flags. Corrected these and canonical pin wording.
- Round4: actual external precheck and conformance ran. No internal six-lens pass was performed on this intermediate body; this is an explicit process deviation, not a quiet internal round. External found shared FETCH_HEAD and renewal-bracket issues. Corrections included canonical ref pin, monotonic bracketing confirmations and externally scheduled health requests.
- Round5: six internal lenses quiet at f77febfd59c2aef1549858d79c40b95db25892140c6bcae50d66c01eabf0d7ab; actual external found stale tracking-ref coverage and missing local-fallback responsiveness. Conformance ran nondegraded102articles. Explicit fetch refspec added. The attempted local-fallback paragraph edit did not land; final internal reviewers correctly caught the omission.
- Round6: six internal lenses at85d9e6a1e379f9630e7d16b50255f15ec13a648dd58634b0f1e6acf12c78da52. Security/adversarial cleared; decision/performance and integration/lessons identified missing fallback text. Actual external found false non-fast-forward refusal assumption and potentially vacuous canonical-success evidence. Conformance ran nondegraded102articles. Cap reached; no seventh review started.

Actual external results /tmp/n79-external-round1.json through round6.json. These were real installed Codex CLI calls to gpt-6.2-astra. The author is also Codex; this establishes independently routed opinions, not diversity between model families. Gemini was detected unauthenticated. All gates are saved under /tmp/n79-conformance-roundN.json. Initial absolute specPath requests were refused because the worktree is outside the live specs directory; supported markdown input then ran successfully.

## Corrections Prepared After the Cap

The draft now states current canonical main may rewind and requires a real rewind fixture; separates mandatory successful canonical-only inventory from intentionally failed-fetch local-only fallback; and explicitly repeats the full health/lease harness for local fallback. Independent source measurement:2538files,29793727bytes,largest343475bytes. These final corrections have not received another review. No quiet-round or implementation claim is made.

## Historical Decision at the Cap

Resolved later by Chief8bd0d9d5, as recorded below.

The remaining review concerns include lease-responsiveness evidence. Because that evidence is safety-relevant to this outage repair, do not dismiss it as a cosmetic risk at the cap. Request Chief decision on one bounded verification of the prepared corrections, or further narrowing. No source implementation before the decision and required gate closure.

## Experience Fit and Conformance

Benefit is keeping the agent reachable while its existing observations load, with no second lease writer or permission expansion. Reviewers accepted unchanged command buffers/deadlines and six-hour cadence as inherited policy, not a reason to invent a new controller. The existing canonicalRefScan switch retains any independent registry coverage obligations. The fix remains in design; development-agent and fleet evidence do not yet exist.

## Left Behind

No safety finding accepted as resolved without evidence. Broader boot-demotion service fencing is explicitly N81 under Chief scope, not a hidden omission. Historical owner-message loss cannot be ruled out by the current N80 baseline snapshot or retained delivery metadata. An initial audit query incorrectly compared ISO text with integer-millisecond timestamps; a corrected read found 20 retained Codex records in effect-unknown/unknown states. This does not establish actual message loss and no custody was changed.

## Operator-Authorized Bounded Closure

Chief8bd0d9d5-3802-483d-a5dd-396f4077462e explicitly authorized one external and one internal check of the three exact prepared corrections, and building if both were clean. The internal lessons/integration reviewer returned CLEAN on all three. The independently routed Codex external call returned status ok and unstructured text beginning CLEAN, explicitly clearing all three at the exact SHA. Its generic verdict parser reports UNKNOWN because CLEAN is outside its standard broad-review vocabulary; the complete response was manually read, not relabeled as a structured APPROVE result. Evidence /tmp/n79-bounded-external-1.json. No repeat check was needed. No family-diversity claim: both author and external reviewer are Codex.

This closure supersedes the pending decision above only within the Chief-authorized bounds. It does not retroactively create a quiet full-review round or fill the round4 internal-pass gap. Implementation must still satisfy meaningful tests, independent code and side-effects review, normal hooks and exact-final-revision full verification.

## Implementation Source Correction

Reading the actual SafeGitExecutor execSync/readSync options at implementation time showed maxBuffer defaults to 10 MiB, not the generic Node API default of 1 MiB cited in review. The adapter and spec preserve the actual 10-MiB source policy. This corrects an author error in the review premise; the general requirement to preserve inherited command limits is unchanged. No claim that earlier reviewers verified this exact number is made. Independent code review must check actual executor defaults, not repeat the mistaken premise.

## Actual Rewind Diagnostic and Chief-Authorized Boundary Correction

The first real targeted unit run stopped40passed/1failed. The separately allocated diagnostic stopped12passed/1failed and captured the installed Git non-fast-forward rejection. Chief566c3db1 explicitly chose the scoped leading plus on the canonical main-to-remote-tracking refspec, never --force or a local branch/worktree change, with one bounded review and a real rewind regression. Source and test are amended only at that boundary; original failed evidence remains preserved. This is an additional actual operator scope decision, not a retroactive quiet review claim.

The one Chief-authorized refspec boundary reviewer returned CLEAN: only the exact remote-tracking destination is prefixed, with no --force/local branch/worktree operation; the real test checks both argument arrays and unchanged consumer state. No corrected test was run by the reviewer.

## Actual Corrected Execution

Exact candidate manifestf66692d0ca0ff5df30592f735a43bc780fa563060afbcbaa538a1ebfed2b48d1 passed the allocated corrected/remaining batch at23:25:39.214878Z:13unit tests,2HTTP responsiveness tests,16lifecycle tests, all exit0 with actual enforced admissions15151,19778,86725. The HTTP tier waited for ordinary admission, then executed in15.44seconds. Its synchronous control reproduced a health/lease failure; the async canonical and complete local fallback paths passed full-duration external-health and monotonic bracketing-renewal assertions. Individual numeric gap samples were asserted inside the isolated harness; no unrecorded incident timing value is claimed.

The single supported private-Node24 no-roundtrip startup check returned PASS and actual CLIexit0 at23:27:51.841804Z. The exact guarded throwaway process/listener/home are absent after independently verified cleanup; the six-step report was not treated as standalone teardown evidence. Throughputf18d9480 independently accepted this scope. Every source/test hash matches the tested candidate after metadata-only result documentation. Normal full verification must still pass on the eventual exact final revision before readiness; there is no production-live claim.
