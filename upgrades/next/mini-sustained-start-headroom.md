## What Changed

The small-Mac verifier trial can require a separate available-memory threshold before launch. When configured, the peer takes four fresh samples over three seconds and requires normal memory pressure throughout. The existing runtime memory floor still protects the host once the runner starts.

## What to Tell Your User

The Mini will only start a verification run when it has held enough free memory to absorb startup. It can help when there is room and leave the work in the main queue when there is too little memory.

## Summary of New Capabilities

Operators can set `monitoring.localVerify.smallPeerTrial.startFloorBytes` to the same value on the coordinator and trial peer after both are upgraded.

## Rollout

The Mini keeps its existing stop threshold and memory reserve. The launch check applies only after the same new setting is installed on the coordinator and the Mini. For the first supervised retry, capture how much memory the host and verifier use during startup.
