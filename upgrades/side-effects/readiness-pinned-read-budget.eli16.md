# Pinned readiness quota check: the plain version

The feedback pipeline can be told to use one particular Codex account when it judges whether reports are ready. Before using that account, it asks Codex how much of the account's allowance is left. That question had only 5 seconds to finish. With no pin, the same question gets 30 seconds. Twice on 28 November the answer took slightly too long, the account was refused as "quota unreadable", and each refusal cost a full half-hour pass, even though the account was fine.

Now the pinned check gets the same 30 seconds, never more than the time the pass has left. It asks a second time if the first try failed in a way that might be temporary. And when it does refuse, it records why: a timeout, a reader error, a stale reading, a usage limit reached, and so on. So the next problem can be diagnosed from the record instead of guessed at. The pin, the 75% limit and the refusal name are unchanged.
