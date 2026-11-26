# Codex usage records no longer interrupt message confirmation

Instar reads the Codex session log to see whether a message arrived and whether the session answered it. Codex also writes usage records into that log to track how much text the model processed. Two messages on the Studio were marked uncertain because the reader did not know how to interpret one of those usage records. The recovery check then held back a retry keypress because it could no longer tell if it was safe.

This change teaches the reader to recognize that exact record. It continues looking for the message and the answer in the same turn. It still requires evidence that the right message reached the right session. A record with a different, unknown type still stops automatic confirmation.

One recent Windows-app message went through and got an answer despite the warning. The repair helps Instar confirm that from the session log. A focused test uses a synthetic Codex turn with a usage record between the reply and the turn ending.

The live bootstrap also surfaced a developer record that describes extra tools available to Codex. It provides no message delivery evidence. The reader now passes over this exact developer record and still refuses unexpected roles. The live trial exposed this before certification, so the revised candidate needs its own fresh proof.
