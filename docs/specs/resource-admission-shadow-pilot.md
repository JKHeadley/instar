---
title: Shadow pilot for resource-based session admission
parent-principle: "Signal vs. Authority"
review-convergence: "2026-11-25T03:18:18.318Z"
review-iterations: 5
review-completed-at: "2026-11-25T03:18:18.318Z"
review-report: "docs/specs/reports/resource-admission-shadow-pilot-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
cross-model-review-reason: "Final external invocation timed out; independent confirmation reviewed closure"
approved: true
approved-by: Machine Stewardship, advisory first slice after confirmation review
---

# Shadow pilot for resource-based session admission

Measure when the current session count and measured resources disagree. This first slice observes normal launch decisions on a test or development host. It has no authority to admit, queue, stop, transfer or start work.

Reuse the normal and interactive SessionManager entry points. At the existing count check, record a bounded advisory comparison with cached HostPressureSampler data and host startup accounting. Leave the actual code path and any thrown refusal unchanged. An observation fault must be caught and counted outside the admission result. Use no synchronous shell or network calls on the launch path.

A snapshot carries host identity, sample age, native memory pressure, available memory and active startup debits. CPU and swap readings are optional context. The ordered decision rules below are the only eligibility predicates.

Use a host-qualified bounded journal with one row per launch attempt. Record which actual count policy ran, whether it refused, the proposed decision and reason, and whether a real launch was observed. Do not store prompts, names, account identities or input content. Expose aggregate disagreement and unknown counts through the existing authenticated host status surface. The public health response and owner notification behavior stay as they are.

Test a healthy host whose normal count policy would refuse, a pressured host with a low count, a missing estimate, and both actual admission paths with the observer throwing. The healthy count refusal must still fail and the low-count launch must retain its existing behavior. A comparison on a refused start has no measured launch outcome. Use a controlled test-agent replay to calibrate first, then validate the comparison on a development agent before proposing resource enforcement. Future enforcement, transfer and pause follow the parent resource-aware session admission spec.

## Multi-machine posture

Observations retain host identity and can be read alongside other hosts through the existing pool status path. The local observer cannot make a decision for another host or consume its capacity.

## Decision points touched

- Comparison outcomes — invariant; basis: enumerable-domain; evidence: the pilot reports the specified evidence predicates and has no runtime authority.
- Pilot calibration — judgment-candidate; floor: fresh complete data and measured headroom after accounted reservations; arbiter: the runtime owner reviewing observed startup peaks; fallback: unknown.

## Observation and comparison rules

Join the count observation and launch outcome by an opaque attempt ID. A count refusal has no applicable launch outcome. A count pass starts as pending and later records verified launch success, failure or unresolved outcome. Missing outcome evidence never counts as a failed launch. Keep these states separate in aggregate comparisons.

Evaluate in this order: stale or absent pressure evidence is unknown; a fresh native warning or critical pressure level gives pressure-policy-excluded even if demand is unknown; otherwise a missing required input or calibration gives unknown; finally compare measured available memory with calibrated demand, recovery reserve and remaining startup growth. CPU utilization and swap trend are contextual in this slice and cannot independently refuse a hypothetical fit. Show that limit in the report. Test elevated pressure with missing demand.

Subtract only the estimated startup allocation still ahead of the host sample. If attempt-level evidence cannot determine which allocation the sample already reflects, return unknown instead of double-counting it. Test a second request assessed midway through the first startup. Calibrate with controlled workloads, then validate against held-out and overlapping starts. Report observed pressure and recovery reserve separately from disagreement counts.

## Maturation plan

- **test-agent-live:** exercise both existing admission paths with controlled cached readings, observed launch outcomes and injected observer faults.
- **dev-agent-live:** enable observation through one full representative operating cycle and compare disagreement counts with separately measured controlled launches.
- **fleet:** propose advisory observation only after development evidence verifies negligible launch overhead and unchanged decisions. Resource enforcement requires its own acceptance.
- **graduation criterion:** every injected decision matches the ordered table, legacy behavior matches with the observer on and off, and unresolved launches remain distinct from failures.
- **dark-window:** default off until the test-agent checks pass. Disable the observer if the development pilot changes any live decision or breaches its launch budget.
- **ladder:** controlled test-agent run, development observation and explicit fleet review.

For a fresh warning or critical level, return pressure-policy-excluded before testing demand or startup attribution, including during an overlapping start. Only the normal-pressure branch can return fit. That branch requires available memory, calibrated launch demand, recovery reserve and startup attribution for the sample. Missing CPU or swap context is recorded but does not change the result.

Bind each active attempt's memory observations to its process identity and the host sample's capture interval. Subtract its calibrated peak growth less the growth already visible in that sample, clamped at zero. If identity or timing cannot establish what the sample reflects, return unknown on normal pressure. For example, if a starter has a calibrated 2 GiB peak increase and 1 GiB is already reflected in 8 GiB of available memory, charge its remaining 1 GiB, not 2 GiB. Test this case, missing attribution, and the warning-first branch independently.

For controlled validation, start the outcome window at process creation and observe through the workload's calibrated startup window and verified readiness, whichever ends later. Record peak pressure and minimum available memory in that interval. Report predicted fits that breach the recovery reserve separately from starts that failed. Assess overlapping starts as a host episode when individual effects cannot be separated. Refused attempts do not enter the measured-outcome denominator.


Use the existing framework startup deadline as the readiness bound. Record a confirmed process-creation failure with no pressure interval. At the readiness deadline, resolve the launch outcome only if success or failure is verified. Measure pressure through the full calibrated startup window independently. A truncated pressure window is incomplete capacity evidence even if launch succeeded. Include unresolved rates in the pilot report.

Use process-tree resident memory changes from the attempt's first verified pre-growth baseline as the attribution estimate. Bind measurements to the same capture interval as host available memory. Resident memory is an estimate rather than proof of host accounting. In isolated replay, compare it with the host's measured change and record the maximum attribution error for that calibrated class. If the measurement is not repeatable or that error could change the fit decision, report unknown.

Compare observer-on and observer-off p95 added admission latency separately on normal, interactive and count-refusal paths. Before the test run, record the host’s existing launch latency baseline and the responsiveness budget accepted by the runtime owner. Allocate an observer overhead allowance within that measured budget and record it with the test fixtures. Exceeding the allowance or the end-to-end budget blocks graduation. On controlled held-out cases, require no predicted fit to breach the recovery reserve or reach critical pressure and at least one correctly predicted fit beyond the old count limit. Report the denominator and unresolved cases before proposing enforcement; zero observed fits is inconclusive. This serves Observability by measuring whether the old count actually disagrees with safe observed capacity.

Keep pressure-policy exclusions separate from measured capacity shortages in the report. A warning can exclude a request under the conservative pilot policy without proving that the machine could not run that request.


Keep a completed startup debit until a newer complete host sample covers its growth, or report unknown across the transition. Read the sample and accounting generation consistently. Test a second request immediately after a starter signals readiness while the pre-readiness sample is still fresh.

To validate a count-refused prediction, pair it with an independently authorized launch on a disposable test agent. Match the workload, live count, memory pressure and existing startup debits within a tolerance declared before the replay. Use the same calibrated observation window. Count the authorized test launch once. The original refusal remains a disagreement only and stays out of the outcome denominator.

Before collecting held-out evidence, record the minimum number of complete observations for each enrolled workload class and overlapping-start case, and the maximum unresolved share the reviewer will accept. Base the plan on measured test capacity and document the choice. Do not choose these values after seeing the results. Missing class coverage or an excessive unresolved share is inconclusive, even if no reserve breach was observed.


The warning-level label describes the selected conservative comparison policy, not a machine capacity verdict. The reviewer may analyze safe headroom under warnings separately without changing any live decision. For graduation, treat predeclared coverage and matching tolerances as the primary analysis. The independent reviewer may accept a sensitivity analysis when the conclusion survives the measured error range, with the exception and evidence recorded. If uncertainty can change the conclusion, keep it inconclusive.

## Open questions

*(none)*
