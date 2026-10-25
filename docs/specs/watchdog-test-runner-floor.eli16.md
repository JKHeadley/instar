# Watchdog test-runner floor — the plain version

## What was going wrong

Instar has a watchdog that looks at every command an agent is running. If a
command has been going for more than three minutes, the watchdog asks an AI
judge: "is this stuck, or is it just a long job?" If the judge says "stuck",
the watchdog presses the equivalent of Ctrl+C on it.

That is useful for a command that really is frozen, like one waiting forever
for typed input. But on 8 October it went wrong. The machine was very busy, so
the full test suite was printing slowly. The judge looked at it and said
"stuck". The watchdog stopped the test run at about three minutes — three times
in a row. The same thing had been happening for days to other test runs.

There was already a safe list for commands whose whole job is to wait, such as
the merge helper that waits for GitHub checks. Commands on that list skip the
AI judge for up to two hours. Test runs were not on that list.

## What changes

1. Test runs go on a safe list of their own. The watchdog recognises `npm test`,
   `npm run test:…`, `pnpm test`, `npx vitest`, and Vitest's own background
   processes. It recognises them by the command itself, not by spotting the word
   "test" somewhere: `echo npm test` is not a test run and is not protected.
   A command that has a real test run going on underneath it — a shell that
   ran `cd repo && npm test`, or a `git push` whose pre-push check is running
   tests — is protected too, but only while that test run is actually there.
   A plain `git push` with no tests underneath gets no special treatment.
2. The protection lasts 60 minutes. A full suite normally takes 5 to 15
   minutes and can take over 30 when the machine is overloaded, so an hour gives
   room. After an hour the normal AI judge decides again, so a test run that
   truly hangs still gets stopped the same day.
3. The 30-minute "last resort" limit, which kicks in when the AI judge cannot
   answer, no longer cuts a test run short before its hour is up.
4. The two timing settings (`stuckCommandSec` and `hardCeilingSec`) now take
   effect as soon as they are changed in the config file, without restarting
   the server. A bad value is ignored and the startup value is used instead.

## What it means for people

Agents can run the full test suite, or push code, without the watchdog cutting
it off part-way. Nothing new can be killed by this change: it only ever removes
an interruption. If something does go wrong, undoing it is a single revert.
