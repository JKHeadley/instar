# Sandboxed fix sessions work when the agent runs on its subscription (plain-English overview)

## The problem

The feedback system writes fixes from user reports. Because those reports come from outside, each fix is written by a Claude Code session locked in a sandbox: no network, no credentials, and no reading outside its own folder. A second, shorter locked session checks the sandbox before every attempt.

Separately, this agent is set to run Claude only through its subscription, never through the pay-per-call path. To do that it starts Claude in its normal interactive mode instead of the one-shot mode. The lock was only ever built for the one-shot mode. So when the two settings meet, Instar refuses to start the locked session at all, which is correct because it would rather start nothing than start it unlocked. The result is that every fix attempt stops before it begins, even after the operator approves the executor.

## What changes

The interactive mode gets the same lock: the same sandbox policy file, the same "never ask, refuse instead" permission mode, the same short tool list, no plug-in servers, an empty environment apart from a short allowlist, none of the agent's own keys, and the attempt's own temp folder. Each item is checked in code, and a launch missing any of them is refused.

Interactive mode shows two start-up questions that one-shot mode skips: "do you trust this folder?" and "use your Chrome browser?". The lock answers exactly those two:
- "Yes, trust this folder", but only when the question names the exact folder the executor just built itself. That folder's own settings, hooks and plug-in servers are already switched off by the lock, which is the thing the question protects against.
- "No browser tools", which is the safe default.

Any other question, or a question that looks slightly different, means nothing is typed and the session is stopped with a clear error. It never guesses. From the moment a locked session starts, nothing in Instar can press a key or type into it except that start-up script, and only while it is running; afterwards the session can only be stopped. A test lists every place Instar presses tmux keys and checks each one either asks that rule first or is named with a reason.

One limit, said plainly: a question could appear in the few milliseconds between the last look at the screen and a key press. The locks set at launch cannot be changed that way; Claude's own file permissions could be, in principle. Right after the task is submitted, the screen is checked again and the session is stopped if anything changed, so this is caught, not prevented. The other choice was to keep refusing, which means no locked session ever runs on this agent.

## What does not change

- The sandbox rules themselves.
- The subscription-only setting: nothing switches to the pay-per-call path.
- Every session that is not locked, which launches exactly as before.

## What you need to decide

Nothing.
