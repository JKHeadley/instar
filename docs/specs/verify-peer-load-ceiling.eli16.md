# Local Verify per-peer offer ceiling

A laptop can be busy with other work even when it is enrolled to run tests. The coordinator can now set a lower load limit just for that machine. Before sending it a new test run, the coordinator checks the latest available load reading. A missing measurement makes that machine wait. A run the machine already accepted can still deliver its result.

On the coordinator, edit the existing entry in `monitoring.localVerify.peers` and set `maxLoadPerCore` to a number above zero and at most one, such as `0.85`. Check the live configuration and the coordinator journal after the change.

The limit is strict. If the reading is exactly 0.85 and the limit is 0.85, the coordinator waits for a lower reading. Unset limits keep existing peer scheduling. A malformed value holds new offers to that peer and raises a diagnostic. The journal records each refusal reason without repeating it on every scheduling tick. These checks leave other machines available for work and leave the signing and delivery of accepted results alone.
