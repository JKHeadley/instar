# Confined feedback fixes can no longer read the shared temp folder

<!-- bump: patch -->

## What Changed

SEC-098. The confined session that writes a fix from outside feedback could READ everything in the machine's shared temp folder (`/private/tmp` on macOS). Its own temp directory is placed there on purpose (the path must stay short), and the list of shared temp folders to deny was filtered to drop any folder that contains it. That filtering is needed for writes (in the sandbox a write deny beats a write allow), but the same filtered list also fed the read deny list, so every other file in the shared temp, such as throwaway agents' config files with live bot and auth tokens, was readable. Writes stayed closed.

Reads now deny every shared temp root, and only the attempt's own temp directory is re-allowed (in the sandbox a read allow beats a read deny). The write rules are unchanged. The confinement canary gains must-fail probes that read a nonce file planted in the shared temp: two for the runner (bash and node) and step 22 of the session canary. The canary version moves to `feedback-canary-v6`, so every agent runs a fresh full-gate canary before its next fix attempt. On Linux, where a read-denied folder becomes an empty, private, writable mount inside the sandbox, the shared-temp write probe is now judged by whether anything reached the host's temp.

## What to Tell Your User

- **Safer automatic fixes**: "The locked-down session I use to fix bugs from outside feedback could read the computer's shared temp folder, where test agents leave their keys. It can't anymore, and my pre-fix safety check now tests for exactly that."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Shared temp folder hidden from confined fix sessions | Automatic; proved by the canary before every fix attempt |

## Evidence

- Unit: `tests/unit/feedback-factory/execute-units.test.ts`: the read deny list holds every temp root while the attempt temp is re-allowed and the write side keeps its filtering (runner and session worker); the leaky-runner case now lists `bash-read-system-temp`; the Linux private-tmpfs write is judged by effect, a write that lands fails everywhere. The 53 feedback-factory unit files (822 tests) pass.
