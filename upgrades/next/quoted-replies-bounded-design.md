# Reply to a specific App message

## What Changed

The App server can accept a signed reply to a specific message and store the link to the original. It checks access to the original at send time. Retrying the same request keeps the same target and does not send another reply.

## What to Tell Your User

Reply is off by default while the server and native menu are being verified. Where the client supports it, Reply lets you point to the exact message you are answering.

## Summary of New Capabilities

The default-off App Reply route accepts an exact original message and preserves that relationship in conversation history. If access to the original is lost, supported clients can show that the original is unavailable.
