# Prepare the server to distinguish managed project work

Codex already asks Instar whether it should continue an ordinary task list. A managed project worker will need a different answer because its current work, owner and stop state come from the project. This step prepares the existing request handler to use that project answer when a verified managed decision is available. When it is allowed to stop, an ordinary task list cannot override that answer.

The server does not supply a managed decision provider in this commit. The existing hook and existing task lists continue using their current behavior. A later change will connect the provider to launch enrollment, durable work ownership and the native receipt. The integration test supplies a test provider and verifies both a continue response and an allow response with an ordinary task list present.
