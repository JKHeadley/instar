# Echo Bugs reply recovery visibility

## What Changed

Recovered Telegram session replies now get a topic history row from the confirmed receipt. A before-network connect failure that holds a session reply creates one operator attention item for that destination. Advisory preflight records now state that delivery is not confirmed.

## Evidence

A Mac Studio origin outbox receipt for Echo Bugs topic 10000001534 had Telegram message 1550 after recovery, while the topic history had no row. The focused regression failed before the adapter method and passed after it; the advisory E2E check passed.

## What to Tell Your User

A delayed reply stays in the server's retry queue. Its delivery state is visible, and a recovered message appears in topic history once Telegram accepts it.

## Summary of New Capabilities

Recovered Telegram replies are recorded in topic history; held session replies raise an operator attention item, and advisory rows clearly distinguish preflight from delivery.
