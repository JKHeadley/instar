# Convergence Report — Job result supervision v2

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra reviewed the spec in successive passes. The final pass found an
uncertified bare-OK loophole. The author closed it with a code-owned
evidence-sufficiency floor, then all six internal perspectives verified that
specific fix. The six-round cap prevented another full external pass; the
external reviewer did not independently re-review that final edit.

## ELI10 Overview

Small scripts now do many scheduled jobs cheaply, but their results still need
checking. The proposed system gives every script run a durable entry. A proven,
exactly recognized result can be closed by a fixed rule. Jev checks new or
unclear results, and Haiku or Luna substitutes only when Jev is unavailable.
Serious alerts keep their immediate route. If a check cannot happen, the entry
says so and remains visible.

The fixed rules need real outcome evidence and a failure canary. Model calls
need benchmark and audit records. Rollout starts with a supervised test agent,
then a development shadow and active trial. Agents not enrolled keep their
existing jobs. A provider or queue failure has a bounded fallback budget;
suspect scripts pause, and unresolved incidents remain visible.

## Original vs Converged

The first implementation plan sent only five jobs' unusual results to Jev and
ignored plain OK lines. A later draft would send every identical OK line to
Jev. The converged design accounts for every result but uses Jev only when
the available evidence calls for judgment. Review added durable pre-execution
registration, an independent run census, safe cross-machine claims, provider
race fencing, verified certificate revocation, an isolated diagnosis step,
budgeted fallback, and explicit coverage formulas.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|---|---|---:|---:|---|
| 1 | Security, scale, integration, decision completeness, lessons aware, adversarial | At least 12 | 0 | Durable record/census, certification, budget and fairness, isolation, rollout gates. Standards-Conformance Gate: ran (2 flags), both resolved. |
| 2 | Security, scale, integration, decision completeness, lessons aware, adversarial | At least 11 | 0 | Side-run census, single-flight provider epochs, claim-bound route, revocation fallback, no duplicate shadow work. Standards-Conformance Gate: ran (1 flag), clarified job-result versus operator-command structure. |
| 3 | GPT-6 Astra and internal reviewers | At least 8 | 0 | Pre-execution registration, outcome-unknown recovery, runner precedence, pool budget and live queue trip, initial verdict versus investigation timing. Standards-Conformance Gate: ran (0 flags). |
| 4 | GPT-6 Astra and internal reviewers | At least 5 | 0 | Inactive fleet/active rollback separation, record-only spine, executor compatibility, ordinary novelty versus contract violation, and diagnostic versus prior-runner session terms. Standards-Conformance Gate: ran (1 flag), queue self-heal added. |
| 5 | GPT-6 Astra and internal reviewers | 1 | 0 | Continuing fixed-shape surveillance and suspension, explicit coverage numerator, trust/truncation evidence integrity. Standards-Conformance Gate: ran (0 flags). |
| 6 | GPT-6 Astra and internal reviewers | 2 | 0 | Transactional call audit and lifecycle, plus evidence-sufficiency floor for uncertified bare OK. Final standards gate: ran (1 possible conflict); explicit operator approval of narrow fixed result contract takes precedence. |

## Proportion

Tier 2, six specification files and a new report; six review iterations, at
the six-round cap. The breadth is justified by scheduler, model, multi-machine,
security and audit behavior in one production pipeline.

## Left behind

No design findings are deliberately left open. The final external finding was
fixed and checked by internal reviewers, without a post-fix external pass.
The Standards-Conformance Gate still sees a possible conflict between fixed
result closure and the constitution's sole structural authority for exact
operator-message stops. Justin explicitly approved the narrow fixed-result
path in topic 130742; it never classifies operator messages or starts new
side-effecting work. This scoped operator instruction takes precedence, and
the flag remains visible here. Fleet activation waits for the
specified measured week and a separate reviewed cohort gate. The design does
not claim a canary proves every real-world failure can be detected.

## Full Findings Catalog

| Round and perspective | Finding | Resolution |
|---|---|---|
| 1 security/data loss | A crash or failed append could leave a completed script invisible. | Register attempts before execution, reconcile against history and claims, count unknown outcomes as unchecked. |
| 1 scale/adversarial | An outage could grow an unbounded queue or let noisy results starve anomalies. | Durable backlog, bounded active set and retries, priority reservation, live age/drain trip and alert. |
| 1 security | The existing prompt/tool allowlist did not isolate an investigator. | Require an effective OS/container boundary; diagnose from a read-only snapshot, then separately authorize remediation. |
| 1 decision completeness | Fixed decisions lacked a certificate and robust false-healthy check. | Independent reviewed certificate with 300 gradable outcomes, two-sided tests, must-fail canary and pool revocation. |
| 1 integration | The audit gate could accidentally activate fleet behavior. | Separate code-owned audit and cohort gates with record-only coverage independent of model decisions. |
| 1 security | Model evidence might carry private user text or unexpected fields. | Per-job egress policy, bounded allowlisted projection, scrub refusal remains unchecked, and rejected field values never leave by default. |
| 1 decision completeness | A one-provider agent could be forced to use an unbenchmarked cheap substitute. | Replacement requires current job-shaped benchmark evidence; otherwise the old runner is used within admission limits. |
| 1 lessons aware | A normal-looking result might hide a failed check. | Separate must-fail canary; Jev seeing the same OK text cannot certify the checker. |
| 2 security | Shadow could run the same side-effecting job twice. | Use recorded production results or non-executing replay; one runner per fire. |
| 2 integration | Current canaries have run-history rows and manual/retry script triggers exist. | Exclude `isSideRun()` and count all production `runner: script` trigger families. |
| 2 adversarial | Timed-out Jev could return after replacement and override it. | Compare-and-set lease/epoch; late answers are audit-only. |
| 2 integration | Runner rollback and claim transfer could choose different runners on machines. | Persist route generation on claim; incompatible executors cannot acquire it. |
| 2 security | An unavailable revocation registry plus an identical OK could be falsely cleared by Jev. | Hold the suspect slug and use a reserved prior runner only where verified; do not rely on a blind model judgment. |
| 2 scale | An in-memory queue ceiling could silently omit the durable tail. | Active queue and durable backlog are separate; bounded scans re-admit entries. |
| 2 integration | A prior full-session definition might not exist for every new script. | Validate each fallback before rollout; otherwise hold and alert. |
| 2 decision completeness | A certificate based on 30 examples could understate rare misses. | Require 300 independently gradable outcomes for each certified shape. |
| 3 scale | Full-session fallback could exhaust subscription quota; the 60-second target had no live trip. | Pool reservation cap and live 30-second/predicted-drain gate. |
| 3 cross-model | History-only census misses execution-to-history crashes. | Durable pre-execution attempt registration and unknown-outcome reconciliation. |
| 3 cross-model | Degraded runner rules conflicted and coverage terms mixed verdict with outcome. | Authoritative runner table and separate decision/investigation/accuracy formulas. |
| 4 internal | Closed cohort/audit gate could enable new scripts when fallback budget ran out. | Never-activated fleet preserves legacy behavior; active rollback holds after budget. |
| 4 security | Old-version peers could evade the new pool fallback cap. | Active rollout requires all expected executors upgraded; legacy cost reported separately. |
| 4 cross-model | Incompatible peer could change an immutable runner choice after claim transfer. | Exclude it from claim ownership and forbid transfer after execution starts. |
| 4 cross-model | Ordinary uncertified results and contract violations had conflicting rollback wording. | Ordinary novel results route to judgment; integrity and trust violations close the affected slug's script route. |
| 4 cross-model | “Session” obscured the different powers of isolated diagnosis and old job execution. | Name the two session types and separate their caps and fire semantics. |
| 4 standards gate | Queue overload raised attention before bounded recovery. | Add thin SelfHealGate with idempotent lease recovery, bounded drain, P19 brakes, flapping and latency backstop. |
| 5 cross-model | Fixed certificates could remain live without fresh correctness evidence. | Require rolling stratified sample, 48-hour grading, suspension after missed/unknown evidence and revoked-shape fallback. |
| 5 cross-model | Decision coverage conflated initial model answer with completed investigation. | Enumerate numerator states and report initial-verdict coverage separately. |
| 5 integration | Trust rejection was both unchecked and unresolved; truncated output could be closed by Jev. | Keep integrity failures unchecked with a separate violation flag and bar incomplete evidence from Jev. |
| 6 integration | A separate best-effort JSONL call audit could miss a provider call. | Pre-call provenance row commits atomically with provider epoch before invocation; JSONL is derived only. |
| 6 security | Generic unchecked retry could send untrusted or incomplete evidence to Jev. | Restrict retry to transient provider/queue errors with verified evidence; preserve original reason on expiry. |
| 6 cross-model | Jev could close uncertified bare OK as routine without independent evidence. | Code-owned evidence sufficiency floor; status-only results stay unresolved and move future fires to prior runner until certified. Internal reviewers verified the fix. |

## Convergence verdict

Converged at round 6 with no known design-changing finding left open. All six
internal perspectives report the final safety fix closed. GPT-6 Astra ran on
the draft and found the bare-OK loophole; it did not re-review the post-fix
text. The last Standards-Conformance Gate pass checked 93 standards and
flagged the operator-ratified fixed-result exception described above.
