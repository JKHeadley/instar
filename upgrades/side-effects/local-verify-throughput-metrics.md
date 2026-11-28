# Local Verify throughput measurement

Tier1, reversible additive observability. No admission, selection, cap, priority, verdict or merge rule changes. Exact-head GitHub publication time remains unavailable; first confirmed head observation is an explicit lower bound. Coverage compares actual expected/reported file sets and early-stop flags; legacy failed coverage remains unknown.

- Over-block: no new blocking path. Optional malformed coverage is ignored by measurements, not rejected by record validation. Store/audit failures are caught.
- Under-block: this is not a gate and detects no unsafe merge. Missing historic publication/coverage cannot be reconstructed; bounded retention means some older metrics are unavailable.
- Abstraction: coordinator observes request/admit/dispatch/journal phases. The run child supplies file coverage because it alone has the real inventory and reports.
- Signal versus authority: audit signal only, never consulted by any decision. Report has no mutation or network path.
- Interactions: exact repo/PR/head/base/ref key separates successors and base refreshes. First timestamps survive repeated requests and restart. Duplicate journal replay does not add a verdict. Already-queued base refreshes record a distinct observation. A running/reserved entry whose frozen base differs from the newly resolved base conservatively omits that request sample instead of inventing a waiting candidate. One coordinator writes its own atomic file. Peer dispatch is coordinator intent to send, not confirmation of remote start; report does not mislabel it as actual remote execution start.
- External surfaces: metadata-only report script output; no actual publication timestamp, secrets, logs, titles, bodies or test names. Clock rollback can make a lower-bound sample invalid, in which case the report omits it rather than report negative latency. No service activation in this candidate.
- Multi-machine: machine-local by design, because each lease-holder has its own observation history. A lease change does not inherit a false first observation; reports cover only that machine. Peer results attach to coordinator exact inputs.
- Rollback: revert files and stop scheduled use of the report. Existing metric file may remain unused; no queue/result/state repair needed.

Validation: actual corrected sequence passed173unit,1realHTTP and1production-construction lifecycle check, all exit0 and zero skips. The first unit sequence stopped at172pass/1fixturefailure because the shared fake automatically added its report path to the inventory; the unchanged assertion was retained and the fixture corrected under fresh allocation and independent review. All initial logs/results/manifest are preserved. Only external process/GitHub boundaries are simulated; actual routes, service, disk store and completion import execute. HTTP took2014.87seconds total but96milliseconds test execution; lifecycle took1516.93seconds total, mostly normal suite admission. No cap/priority override or automatic retry. Full exact-head verification remains with throughput after Chief publication.

Final report truthfulness correction: unresolved observations have no retained local verdict, but may be closed, superseded or completed elsewhere. The report labels elapsed observation age and last observation time, not proven live waiting. The separate final report unit file passed7/7,0skips,exit0 under its own normal allocation after the unchanged backend tests passed. This yields174unique current unit cases across metrics7/orchestrator132/record35; the final7-case run repeats six prior metrics cases and adds one truthfulness boundary. A new awareness entry documents the operator command and reaches existing agents through the existing registry/update path. Release notes use the normal runtime-change sections, not the internal-only exemption.

Ancestry: main65ea34c80ad303c935bd6eb1addce0942506a872 and tested parent01bd1cce6fc80f1d66eda2c27e3aaa761381cf83 have identical tree1450f3be5d448a2ededa4f0775f5479e97cc0372. The normal ancestry-only refresh avoids showing already-squashed main repairs as new PR changes. It does not change the tested backend/test bytes.

Report windows use coordinator journal writtenAt for accepted verdicts, avoiding peer clock/import lag; legacy missing writtenAt falls back to finish time and is explicitly counted.


## Proportion and review binding

Tier1,16in-scope files plus the trace. Source work is additive measurement, not a change to verification authority. The critical-pipeline risk floor is acknowledged; a revert removes observation without changing prior queue, verdict or trust state. Independent review found and corrected an actual inventory-fixture gap and two measurement ambiguities (base refresh observation and coordinator-versus-child verdict clocks). The initial fixture failure and correction remain explicit. Most elapsed verification time was admission, not test execution.

Independent source/side-effects second pass: /root/distributed_train concurred with the final report implementation and manifest07cc95d4f9248b8a96287291c7ec81ac3dc6a7e3e37b7e25a15dfde8b92075e3. The trace must not be written until this final actual-results artifact has fresh exact-byte concurrence retained in build evidence. No inherited main-repair artifacts or traces are edited.


## Second-pass review

**Reviewer:** /root/distributed_train.

The independent reviewer supplied this concurrence after reading the final actual results:

> I read source/hooks/coverage/report/fixtures/side-effects, verified unchanged backend bytes and actual173/1/1 plus separate7/7 results, no admission/verdict authority or live speed claim, no reviewer tests.

The final artifact digest is independently rechecked before its trace is written. No inherited main-repair artifact or trace is changed.
