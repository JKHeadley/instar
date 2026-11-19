# Save the relock record before submitting a password

When a person types their Mac password through the remote viewer, the native helper types the characters and then presses Enter. Before Enter, it records that a submission may be about to happen. The guard uses that record while keeping the promise to relock the Mac when access ends.

The old code tried to save this record but ignored failure. It could still press Enter if the record had disappeared, belonged to another producer, or could not be saved. This change makes that existing write a requirement: the exact request must still have an owed relock duty, no relock-now flag, and the same native producer process and start time. The transaction must both accept those facts and successfully replace the state file. Otherwise the helper uses the existing safe field-clearing path and reports that state is unavailable, without pressing Enter.

This does not add a new password source, permission, listener, timer or retry. It preserves the existing abort and secure-target checks. The store lock is released before keys are posted. That means the existing check-to-post race still exists; the guard still has to stop the producer before closing the duty. Atomic file replacement protects the existing same-boot process-crash case; this change does not add fsync or promise survival across power loss.

The tests compile the actual Swift boundary with inert callbacks, so no password or key reaches a real Mac. They verify failed ownership checks and failed writes suppress Enter, and valid same-duty retries preserve other state. A separate test verifies the viewer receives a refusal, not a submission acknowledgement. Hardware proof P15 is still required and remains unpassed. Missing Enter timestamps are not proof that a password was never submitted.

This is a narrow Tier 2 safety correction under the approved locked-screen specification. The parent coordinates independent review and publication. The native helper source hash changes, so the rollout owner must handle the existing retained-helper and macOS permission workflow. No live helper is installed or restarted by this task.
