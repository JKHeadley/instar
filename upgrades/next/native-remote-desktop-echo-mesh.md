# Native desktop on the Echo mesh

<!-- bump: minor -->

## What Changed

The existing PIN-gated desktop page can list the registered Echo machines by name and open a ready target through the designated dashboard front. The front carries only bounded encrypted screen and input bytes; each target verifies a one-use signed operator assertion and owns its own controller lock, ten-minute grant, permissions, and Stop. macOS targets use the packaged helper. Mama PC's WSL agent uses an authenticated companion running in the interactive Windows session. A scoped activation route requests the existing supervised restart after an agent saves desktop settings.

## What to Tell Your User

Open Echo's Desktop page, enter the usual dashboard PIN, and choose a ready machine. Stop ends control on that machine. A machine that is asleep, locked, missing screen or input permission, or unreachable appears unavailable with a reason. Mama PC requires a live Windows login session; the agent handles companion installation.

## Summary of New Capabilities

- One PIN dashboard entry for the five registered Echo machines.
- Signed target delegation and encrypted screen and input relay, with the target retaining Stop authority.
- Interactive Windows desktop support for the Echo agent running under WSL on Mama PC.

## Evidence

The TypeScript and macOS helper build and package-content check pass locally. A live Mac Studio browser check received a 1920 × 1080 H.264 frame, moved the host cursor, handled wheel input, and confirmed Stop and post-Stop refusal. Focused unit, HTTP integration, production-boot, Windows executable self-test, full suite, and the other per-machine live screen/input/Stop results are required before advertising those targets as ready; the PR and rollout log carry their exact outcomes.
