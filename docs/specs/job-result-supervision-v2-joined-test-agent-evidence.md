# Joined test-agent supervision evidence

Date: 2026-10-30 PDT. Scope: the approved `job-result-supervision-v2` test-agent gate.

The lifecycle test in `tests/e2e/job-supervision-joined-test-agent.test.ts` creates an
expiring throwaway agent with one synthetic script. Its test-only cohort override
opens the production scheduler and server worker path. The script emits a planted
secret, a structured problem signal, and a failed result. A mocked Jev endpoint
returns `needs-session`. The test checks the durable pre-call record, actual
model, prompt and evidence hashes, secret redaction, the authenticated triage
route, and zero investigation session spawns. It then triggers another synthetic
run whose mocked provider rejects on timeout and checks that the result stays
visibly `unchecked:provider-timeout` with a failed call record.

The expanded focused lifecycle run passed on October 30: one test, 50.2 seconds
of test execution after its shared-lane wait. The result is evidence for the joined scheduler/server path under a
mock provider. It is not a live TypeSafe call and does not authorize live jobs.

The same test has an opt-in operating-system sandbox mode. That mode checks
that outbound loopback connections are refused in both the parent test process
and child script process. The corrected sandbox run passed on October 30: one
test, 25.2 seconds of test execution. The first attempt had failed because the
test's `INSTAR_` setup switch was stripped by the hermetic test setup; the
retry used a test-only switch for the parent and a local marker file for the
child. The production script environment was not changed.

A joined late-response case and a post-startup certificate-revocation hold
case passed in that focused run. The late-response case
checks that an answer arriving after the provider lease is kept in the audit
but cannot become the current result's verdict. The revocation case writes a
synthetic revoked certificate result through the durable store, then checks
that the running scheduler closes the next script admission. The scheduler
now reads the store's hold before every script admission, including holds
written after startup.

An independent second pass found a timing gap: a new hold could arrive while
an asynchronous job gate ran, after the first hold check. The scheduler now
checks again after that gate. A second synthetic job puts a hold in this exact
window and asserts that its script never starts. The expanded focused run
passed in a network-restricted operating-system sandbox on October 30: one
test, 50.3 seconds of test execution.

The test also asserts that the throwaway scheduler loaded only its synthetic
job, that every recorded run belongs to that job, and that it spawned zero
investigation sessions. The full three-tier local suite passed on October 30:
53,037 unit tests, 4,937 integration tests, and 3,604 E2E tests. The expanded
joined lifecycle case also passed within that E2E run. These are local results
for this branch; the separate merge verifier is still required.

This does not yet prove pool-wide certificate revocation. The scheduler does
not call the fixed-certificate resolver on a normal result, and the server has
no pool-authoritative certificate registry wired in. Those remain open
test-agent gates. The code-owned rollout gate remains off in production.
