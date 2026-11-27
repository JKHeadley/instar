---
title: Stop check replay input
---
On development agents (off on the fleet), each stop-check (UnjustifiedStopGate) decision row in the local judgment provenance log also keeps the credential-scrubbed stop reason, recent turns and trusted evidence the check judged, under the machine-local `_contentFull` field, plus content-free replay identity (`promptSha256`, `replayPromptSha256`, `scrubChanged`, `captureVersion: stop-replay-input-v1`).
A replay rebuilds the prompt and must match `replayPromptSha256`; it is byte-exact to what the model saw only when `scrubChanged` is false. `GET /judgment-provenance` never serves the captured text, and the row's `rawResponseHead` carries the verdict the model gave.
**When to use**: asked whether past stop decisions can be replayed or graded against a cheaper model, read the provenance rows for `captureVersion`; never claim a replay matched without the sha check. Switch: `monitoring.stopGateReplayInput`.
