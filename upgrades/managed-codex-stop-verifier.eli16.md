# Verify which Codex worker can continue

A Stop callback says which turn just reached its stopping point. Instar still needs to check that the callback belongs to the worker assigned to the project and that the local Codex record contains the response. This change adds the verifier for that check. It takes the work and ownership information from the server, reads only the recorded Codex home, and refuses when the file or response cannot be verified.

The next instruction records a boundary in that same file. A later callback can confirm the instruction only with a matching native record after the boundary. The tests exercise a current receipt, an old callback, a replacement worker and a file outside the expected location. The real Codex test now runs through this verifier. Normal project launches still require an authorized production admission before they can use it.
