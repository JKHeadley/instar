# Exact Green Merge Handoff Review

## Scope and proportion
Tier1/SMALL, narrow reversible read-path repair. Critical merge-pipeline risk floor acknowledged: this is not authorization widening, but the files participate in merge decisions and need an independent second pass. Production exact handoffs read one current candidate by number rather than depending on bounded discovery. Regular oldest-first discovery remains unchanged; no new persisted schema, credential, source trust, queue cap or full-green authority. Twelve in-scope files plus the trace: three runtime read/wiring files, unit/HTTP/lifecycle coverage and explanatory artifacts. One substantive source review round caught discovery-state overreach before GREEN; one final actual-results read followed.

## Over-block
An absent, malformed, wrong-number, non-open, non-main, unknown hold-relevant field, non-viewer-author or cross-repository target yields no candidate. A valid target can still wait for mergeability, reviews or existing holds. The direct read must establish facts, not infer readiness from its existence. Legacy injected dependency consumers without the optional read seam retain old bounded-list behavior; production construction wires the real seam.

## Under-block
The query does not authorize merging. Author/namespace eligibility, fork refusal, draft/title/label holds, pinned head and exact local record are evaluated through existing gather; existing lease, warm-up and latch gates plus act-time hold/head and code-owner/safe-merge checks remain. A failure cannot substitute another listed candidate. GraphQL author must equal authenticated viewer exactly, matching discovery; current watcher account guard still applies. Missing isCrossRepository or draft/title/label/head fields are not converted into permissive defaults.

## Layer and signal versus authority
Reference: docs/signal-vs-authority.md. The bounded discovery list is a discovery signal, not an authoritative statement that an exact verified target is absent. The new direct GitHub projection supplies current facts to the existing watcher authority. No detector independently grants a merge. Ordinary merge runner/safe-merge and existing local floor retain the final decision.

## Interactions
The regular discovery list/page bounds are untouched. Exact production handoffs perform one direct GraphQL read with the same candidate projection and avoid discovery latency/cutoff. Read failures feed existing breaker/error accounting and return a distinct handoff-read-failed result. A direct read does not update the last successful discovery-list timestamp or replace its snapshot, namespace/ownership diagnostics or red-alert memory. An exact-target response does not establish that unrelated candidates disappeared. Independent review caught and corrected this full-list/singleton conflation before GREEN. Existing single-flight handoff waiting, lease warm-up and latch checks remain; no queued ordinary candidate is merged in place of the requested head. The existing merge-line status reconciliation still runs before watcher handoff.

## External surfaces
One exact GitHub read replaces periodic-list reads for a known handoff. No new public endpoint or user flag. The feature does not push or merge during tests: GitHub/process boundaries are fixture-controlled. Audit names handoff-read and whether the candidate was found; no raw body/source/credentials are logged. Actual live claims wait for publication, complete verification and normal release.

## Multi-machine posture
Machine-local watcher and serving lease, by design. The exact source/read remains tied to the executing coordinator account; the adapter uses the existing authenticated runtime. No peer attestation trust, lease-transfer behavior or cross-machine merge authority changes. The Laptop remains excluded from testing per Justin/Chief instruction.

## Rollback
Revert source and redeploy normally. No data migration or external compensation. Existing holds and exact records remain. The old cutoff limitation returns, so a green target may again need a manual supported handoff; no safety rule must be weakened to roll back.

## Evidence
Actual baseline whole-file unit command reproduced one expected not-listed failure with40existing passes, zero skipped, exit1, while runtime was unchanged. Earlier selected -t waiter executed zero tests and was cancelled under explicit root allocation, exit143; both receipts/logs retained. The sole ordinary-enforcing GREEN sequence passed107unit checks (33reader/list,50watcherlocal-floor,24production wiring), one real HTTP integration check and one production-construction/start/rebuild lifecycle check, allzero failures/skips and allthree process exitszero. HTTP elapsed405.39seconds with83milliseconds test execution included ordinary suite admission; lifecycle4.51seconds with59milliseconds test execution. TypeScript and final normal build exitedzero. Runtime/test bytes remained frozen throughout; reviewer found and corrected singleton/full-discovery state conflation before GREEN. No full suite or live fix claimed.

## Second-pass review
**Reviewer:** /root/queue_fastlane.
Independent reviewer concurred with frozen source/test manifestd0246d4bfe16867dcbad45b269b2ec2f35a90f6fa067bb80e3461e063a10c9e9 after verifying all12file hashes and the discovery-state correction. No reviewer tests or author edits. Final actual-results review: the same independent reviewer read all final source/test/artifact hashes, raw107unit/1HTTP/1lifecycle pass logs and three exit-zero receipts, enforcing admission and build/type evidence. Concur with the review. Runtime/test hashes equal the executed frozen manifest. HTTP elapsed405.39seconds includes admission and startup;83milliseconds is test execution, not an exact wait calculation. No full-gate, publication or live claim is made. The reviewer ran no tests and made no author edits.
