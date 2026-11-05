# Side effects: Codex native canary works on Codex 0.166

Change: `OriginCodexModelCanary` raises its CLI size cap from 256 to 512 MiB and allows `ipc-posix-shm-read-data` for names starting `apple.cfprefs.` in its sandbox profile.

Measured on the Studio with Codex 0.166.0: the binary is 268,972,064 bytes, and `thread/start` under the profile failed with "Failed to synchronize managed preferences". Adding each candidate rule alone showed only POSIX shared memory fixes it; file reads and writes of the Preferences folder, `system*`, `iokit*` and `mach-register` do not. Read-only access to the cfprefs names alone is enough.

1. Over-block: removes one. New Codex builds no longer fail the canary.
2. Under-block: the sandbox can now read preference shared memory. No credential lives there; the file, network, fork and keychain denials are unchanged and the six isolation controls still run.
3. Level fit: the profile belongs to this canary; it is its only user.
4. Signal vs authority: the canary is a health signal only (`canaries.nativeModels`); it gates nothing.
5. Interactions: real Codex sessions do not use this profile and kept working through the update.
6. External surfaces: none.
7. Multi-machine posture: machine-local by nature, each machine probes its own installed CLI; no shared state.
8. Rollback: revert the commit.
