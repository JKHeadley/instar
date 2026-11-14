# Native Passwords & keys for the iPhone app

## What this is

The agent keeps passwords and API keys in an encrypted vault, and sometimes asks a person to hand one over through a one-time web link called a Secret Drop. Until now, seeing any of that meant opening the web console. This adds one read-only route so the owner's phone can show it natively: which requests are waiting, the names of the keys the agent holds, whether the vault opens, and whether keys sync to other machines.

## What already exists

The console already reads all this through three routes that only the agent's token can open. One of them hands back each request's one-time link. That link is the power to fill in the request, so it can't simply be opened up to phones.

## What's new

`GET /mobile/secrets` answers a trimmed summary for the owner's phone. It lists what's waiting on each machine that replies, and this machine's key names. If a machine doesn't reply, it says so rather than giving an all-clear. It lists names and state only. It never carries a value, a value's length, a one-time token or a link. A saved Secret Drop is stored under its token, so those become a plain count rather than a name.

## Safeguards

Only the owner's paired phone or the agent's token can read it. Other phones are refused, and the original routes stay closed to phones. A read that fails says "can't tell" and never "nothing waiting". The route writes nothing, so undoing it means reverting one commit.

## What you need to decide

Nothing. Filling in a request stays on the web page the person was sent. Asking for a key and cancelling one also stay in the console, because those change things and a phone change needs the Face ID check, so this is the read half of the row.
