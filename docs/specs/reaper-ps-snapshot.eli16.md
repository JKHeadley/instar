# The leftover-process check reads the process list once, not twice per process (ELI16)

## What this changes

Every so often the agent looks for leftover AI processes that no longer belong to any of its sessions, so it can clean them up. For each process it found, it asked the operating system two separate questions: who started this process, and what is that parent running? Each question started a small helper program and waited for its answer, and the agent could do nothing else while it waited.

On a quiet machine that takes a moment. On a busy machine, with dozens of processes and each helper slow to start, it added up to 3 or 4 seconds of the agent doing nothing else: no replies, no page loads, no answers to its other machines. On 2026-11-18 this caused two of the four longest pauses measured on the test agent.

Now the agent asks for the whole process list once per check and looks up each answer in that list.

## What stays the same

Every process is classified exactly as before. If a process is missing from the list (because it ended a moment earlier, or the list could not be read), the agent asks about it the old way, so it gets the same answer it always did.

## Safeguards

Nothing is killed or reported differently; only how the information is gathered changed. Tests check that one list replaces the per-process questions and that a missing process still gets the same answer. Undoing the one commit restores the old behaviour.

## What you need to decide

Nothing.
