# Explain why the app could not send a message

The app can say that messages are not being received even after a previous status check named the Studio as the lead computer. The send path checks whether the computer still has a valid serving lease at that moment. A stored lead name is not enough: a renewal can have expired, a process can be suspended, or another computer can have advanced ownership. Refusing in those cases is the existing safety behavior.

At 11:29 on November 23, the owner saw that refusal while the Studio was expected to be leading. The app send preflight did not record when it refused or the lease condition it observed. The retained evidence does not establish which condition applied at that moment. This change does not claim to reconstruct it.

The repair adds one small diagnostic record to the actual refusing app chat path. It records the server time, process ID, and a fresh observation from the existing lease coordinator: its fixed reason category, lease lifetime and time since the last confirmed renewal. It samples immediately after the original refusal and labels that timing honestly. If the second sample sees a healthy lease, the record says so; it does not invent a failed reason. Missing or broken diagnostic data is marked unavailable.

The record contains no message text, conversation identifier, device identifier, request identifier, credential or arbitrary exception. It goes to the existing server warning log. An error reading or writing diagnostics cannot grant permission, change the refusal, retry a message or notify anyone. Successful messages and saved request replays do not generate this refusal record.

The change leaves the lease fence and the app's existing response in place. It adds no setting, endpoint or durable queue. Tests cover the fixed fields, privacy, bad diagnostic data, the signed HTTP refusal, successful replays, and a production-constructed service connected to a real lease that expires. Complete verification and a normal release are required before the running service gains these records.
