---
title: Tone gate replay input
---
On development agents, each outbound tone-gate decision row also keeps the scrubbed prompt parts under the machine-local `_contentFull.replayParts`, with `captureVersion: tone-replay-input-v1` and a prompt sha. Never claim a replay matched without the sha check (`assessToneGateReplayEligibility`). Switch: `toneGate.replayInput`.
