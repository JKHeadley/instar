<!-- bump: patch -->

## What Changed

A Slack conversation's session is no longer moved between machines, by you or by the agent's load balancing. A move used to half-happen and leave two sessions answering one Slack conversation. Now it is refused before anything changes: `POST /pool/transfer` answers 409 `slack-stays-with-connection` with a sentence, the drain refuses Slack keys for every mover, and the overload shed never picks one. The phone shows "This Slack conversation stays on the machine that holds your Slack connection." where Move would be.

## What to Tell Your User

Slack conversations stay on the machine that holds your Slack connection, since that's the only machine that can reply in Slack. Moving one used to leave two copies answering; that can't happen any more.

## Summary of New Capabilities

- `POST /pool/transfer` refuses Slack conversations in words (409 `slack-stays-with-connection`)

## Evidence

Unit and integration tests:
- The drain runner refuses raw and `slack:` keys with no ownership change, suspend or close; a Telegram topic drains as before.
- The route answers the sentence, naming the machine, without planning, proxying or writing.
