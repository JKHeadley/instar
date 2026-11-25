# Forward text between App chats

## What Changed

The signed App server can copy a selected text message into another App chat with current access to the source and permission to send to the destination. The copy appears in destination history and leaves the agent's session alone. A retry on the original paired machine can recover the same receipt.

## What to Tell Your User

Forwarding is still off while the native menu and compatible server versions are verified.

## Summary of New Capabilities

The server has a default-off Forward action under `mobilePairing.native.forwards.enabled` for plain-text App messages. This release candidate includes the signed route and history marker.
