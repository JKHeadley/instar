# Codex canary and Codex 0.166: plain overview

Instar has a small self-check that starts the real Codex program inside a tight sandbox, with no credentials, and confirms its output format still reads correctly. A test runs the same check before any change is merged.

At 00:42 on the Studio, Codex updated itself to 0.166.0, and the check broke in two ways. First, the program had grown just past the check's 256 MiB size limit. Second, the new Codex reads system preferences before it starts a conversation. macOS delivers those through a small read-only block of shared memory, and the sandbox refused it, so Codex stopped with "Failed to synchronize managed preferences".

Real Codex sessions were never affected: they do not run inside this sandbox and kept working. The harm was that every change tested on the Studio failed this check, which stalled merges for everyone.

The fix raises the size limit to 512 MiB and allows read-only access to just the preference memory, by name. Each other candidate was tried and did nothing, so this is the narrowest rule that works. All the sandbox's other blocks stay in place. There is nothing to decide.
