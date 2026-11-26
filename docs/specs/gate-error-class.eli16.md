# Why two safety checks failed every time on some agents, and the fix (plain-English overview)

## What this is

Instar agents run small automatic checks using a quick AI model. Two of them matter here. One, the stop check, decides whether an agent is quitting a task for a bad reason. The other, the prompt check, looks at a session's screen to spot when it is stuck waiting on a question. These checks can run on different AI services: Claude, Codex, Gemini or Pi. Instar picks the service automatically.

## What went wrong

For about a week, around 125 reports from several agents said both checks were failing on every single call. Nobody could see why, because the error was thrown away: the record only said "error", and the prompt check silently ignored the failure and asked the same question again on the next tick, failing again.

Evidence from one affected agent (Bob) showed every failing call had gone to Gemini, and that machine has no Gemini sign-in. Instar's default rule sends these quick checks to the fastest available service, and Gemini ranks ahead of Codex. But "available" only meant "the Gemini program is installed". Nothing checked that anyone was signed in. So on any machine with Gemini installed but not signed in, both checks were sent somewhere that could never answer.

## What changes

1. A service now counts as available for these automatic checks only if it is installed **and** signed in. For Gemini, that means the sign-in file the Gemini program itself uses is present and holds a usable token. If it isn't, the checks go to the next service (usually Codex, or Claude as the last step). Machines where Gemini is signed in behave exactly as before. If an operator chose services by hand, their choice is untouched.
2. Every failed AI call now records **why** it failed, as one word from a fixed list: rate limit, capacity full, not signed in, timeout, too many turns, program missing, no route, unreadable reply, program exited with an error, or other. The error text itself is never saved, because it can contain private details. The health page now shows this breakdown for any failing check.
3. The prompt check no longer hammers a broken service. After a failure it waits before asking about the same unchanged screen again: thirty seconds at first, doubling up to five minutes, and never more than one minute when the problem is one that clears by itself, such as a rate limit or a timeout. Anything new on the screen, any typed input, or a successful answer makes it check again straight away, and the simpler pattern-based detection keeps running the whole time. The failure is also reported, with only its type, at most every thirty minutes.

## Safeguards

- Nothing is blocked that was allowed before. The change only stops sending checks to a service that cannot answer, and adds information.
- Removing this change is a plain revert. The new database column is optional, and older versions simply ignore it.
- The sign-in test reads one local file and never prints or stores its contents.

## What you need to decide

Nothing. This fixes a defect: the checks were meant to work, and on those machines they could not.
