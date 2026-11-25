# Keep a scheduled round queued while a worker holds it

When the scheduler sees that a continuation worker already holds a round, it now leaves the ordinary round scheduled. It does not use up a launch attempt. The same hold applies while the server cannot read an existing work store. Once the hold clears, the next regular check can start the round.

The launcher still checks the saved claims when it starts. If a competing worker obtains the claim after the scheduler’s check, an attempt can still be counted, though the ordinary worker cannot start. The focused test creates a real stored hold, verifies that the scheduled time and attempt count stay intact, and confirms the next check starts the round after that hold clears. This change does not enroll managed projects or turn on continuation.
