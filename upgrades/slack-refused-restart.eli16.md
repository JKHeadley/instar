# A refused Slack conversation no longer leaves a person waiting

> The one-line version: when the agent can't start a conversation to answer someone on Slack, it now keeps the message, keeps trying for about two hours, and tells the person, instead of dropping the message and saying nothing.

## The problem

On 4 November a person sent three messages to an agent on Slack and got no answer for about two hours. The agent refused to start the conversation because its small reply helper did not match the version just installed, a safety check that exists so a session never starts without a way to answer. The refusal was written to a log and then ignored. The message was gone, and nobody was told, until another session happened to read the channel.

## What already exists

- **The readiness check**, which refuses to start a conversation with a reply helper that doesn't match. It stays.
- **The post-update step**, which rewrites the helper after an update, but only when that step runs.
- **The safe rewrite**, which only replaces versions we know we shipped and never touches hand-edited ones.

## What this adds

Before refusing, the agent now runs that same safe rewrite, so the 4 November case fixes itself and the person never notices. If it still can't start, for that reason or because a session failed to start, the message is kept and retried after about 30 seconds, then 2, 5, 15, 30 and 60 minutes.

The person is told right away that the message arrived and is being retried, once per thread. Once it gets through, the session answers as usual, and the message carries a note saying when it was sent, since it may already have been answered. If the last try fails, the person is asked to send it again and the kept copy is deleted. The operator is told only once the refusal has lasted past three tries, so a blip bothers nobody.

## The safeguards

- A retry goes the same way as a new message, through pool routing and every check, so a conversation that moved to another machine is answered there. Retries wait until the server has fully started.
- An emergency stop of all sessions empties the hold and tells those people, so nothing starts later.
- A hand-edited helper is never overwritten. That case keeps refusing and is reported.
- Tries are capped per conversation and survive a restart. Holding is limited to 20 messages a conversation and 100 conversations; past that the person is asked to resend.
- A refusal already explained to the person, such as the memory privacy one, is not held. The phone app reports its own refusal, so it isn't held either.
- Messages wait in a file only the agent's user can read, and are removed when handled or given up on.

## What this does not do

Held messages stay on the machine that received them, so losing that machine during the two hours loses them. A newer message can be answered before an older held one. It covers Slack, where the fault was found. Nothing has been run live yet: the proof on a cloud test agent follows the release.
