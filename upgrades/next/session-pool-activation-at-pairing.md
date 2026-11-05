<!-- bump: patch -->

## What Changed

When a new agent pairs its second machine for the first time, sharing now turns on by itself. Both machines get the same settings, the first restarts once, and the bot token reaches the new machine sealed inside the pairing, so it can answer on Telegram from its first start. After the pair has looked healthy for ten minutes, a new conversation can start on either machine. Nothing already running moves.

It stays off when the owner has already set anything about sharing, has set `multiMachine.sessionPool.autoActivate` to false, or uses paid routing. The pairing still works, and the readiness report says why. Agents that exist today do not change on update.

## What to Tell Your User

If you add a second machine, it will start sharing conversations with the first by itself. Nothing changes for an agent on one machine, or for an agent that already has several machines.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Sharing starts at the first pairing | automatic; `GET /session-pool/readiness` shows why it is or is not on |
| Opt out before pairing | set `multiMachine.sessionPool.autoActivate` to false |
| Recover a token that did not arrive | pair the same machine again |
