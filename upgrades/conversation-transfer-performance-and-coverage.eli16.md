# Conversations: faster recovery and honest coverage

Conversations is the feature that groups an owner's conversations under efforts. It is still off by default, and this change does not turn it on.

When a machine is lost or replaced, the conversation history has to move safely to another machine. Testing that with 65 MB of history showed it took far too long and often failed. The server saved files it had already saved, checked the same signatures over and over, and re-read its whole history every 15 seconds while holding a lock that blocked incoming writes. A sender buffer also ran out after about six rows. The move now finishes in under seven minutes on a machine with room to spare.

Testing also showed a warning that never cleared: "Some original history is unavailable." A background job refused to run unless a phone had been paired, so it could never finish recording what the machine had. Once it ran, it saved new records every minute even when nothing had changed, which would have grown forever. It now saves on change plus once an hour.

Three privacy gaps found in review are closed too: private data could be left behind after a deletion in some cases, and a generic export path could skip the proper checks.

The safety checks all still run. What is skipped is only repeating work whose answer cannot have changed: a disk flush of a file that has not changed, or a signature that has already been proven against the same key and bytes.

One tradeoff to know: a machine that has died is now flagged after up to three hours rather than three minutes. Its history stays readable either way.
