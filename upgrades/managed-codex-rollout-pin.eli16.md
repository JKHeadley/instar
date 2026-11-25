# Managed continuation keeps checking the same Codex record

Codex writes a local record of each response. Instar uses that record to confirm that a worker actually reached the end of a turn. The worker creates the record during the first turn, so Instar saves the file identity when it first authorizes another turn. If a different file later appears at the same path, Instar allows the worker to stop without sending another continuation.

The identity is saved with the continuation decision. It survives a server restart and stays in place after the worker returns its receipt. This keeps a replacement file from being mistaken for new work by the original worker. Production still needs to prove that the worker owns the project and that the first record came from its protected launch directory. The change adds no live enrollment and keeps the feature disabled by default.
