# ELI16 — the guard that could be defeated by running a code formatter

## What it protects

Instar types into terminal sessions to talk to them. There is a command for sending literal text, and
it passes the whole message as a single argument — which the operating system caps at about 16 KB.

Below that cap everything works. Above it, the send fails with a bare "command too long" that says
nothing about what went wrong.

On 4 August that happened for real. A large prompt crossed the ceiling, the component watching for
failures misread the meaningless error as "the AI provider is rate-limiting us", and it shut itself off
— fourteen times in a row, fifteen minutes apart. Ten different parts of the system that depend on AI
calls sat at between three-quarters and total failure while it did.

The fix was to route every such send through one helper that splits the text into safe-sized pieces.
This build check is what stops the problem coming back: it fails the build if anyone writes a raw send
that skips the helper.

## What was wrong

The check read the code one line at a time, and only complained when it saw the command name and its
flag **on the same line**.

So it saw nothing here:

```js
const args = [
  "send-keys",
  "-l",
  payload,
];
```

That is the identical command. It is also just what any code formatter produces when a list gets too
long for one line — which is the part worth pausing on. **You could defeat this guard by running
prettier.** Nobody would be trying to get around anything; the list would simply grow, get reformatted,
and the protection would quietly stop applying.

Three more plain forms slipped through the same way: putting the flag in a named constant, putting the
command name in a named constant, and — the worst one — *mentioning the helper's name in a comment*.
The check treated "this line mentions the helper" as "this line uses the helper", so writing
`// TODO: use buildLiteralSendArgs here` next to a raw send switched off the very guard the note was
admitting you needed.

I measured all four against the shipped check before changing anything, with the one-line form running
in the same pass as a control — so I could prove the check was working and still missing these.

## What changed

The check now looks at the whole **list**, not one line — it matches the brackets to find where the
list starts and ends, so a list spread over five lines is read as one thing. Before that, it removes
comments (properly, without touching text inside quotes) and works out what named constants actually
hold.

## Why it won't start failing builds it shouldn't

This check blocks commits, so wrongly flagging correct code costs more than missing a case — a noisy
check gets switched off, and then it protects nothing. Six things are deliberate, each with a test:

1. **A send without that flag is fine** — it is only the literal-text form that has the size ceiling.
2. **A genuinely routed call is fine.**
3. **Two separate lists are never joined.** An unrelated list containing `-l` somewhere else in the file
   cannot complete a send command. This is the main reason the unit is the bracket-matched list rather
   than "a few lines near each other".
4. **A constant holding something else is fine.**
5. **An example living entirely inside a comment is fine** — this is what makes it safe to *document*
   the bad pattern, including in this file.
6. **An ambiguous name is left alone.** If one name is set to two different things in the same file, it
   is treated as unresolvable rather than guessed at — guessing wrong fails somebody's build.

Unbalanced brackets also produce no result rather than a bad one, so a syntax error somewhere else can
never turn into a false accusation here.

## What it still can't see — and a correction to what it used to claim

The old note said only that "a wrapper that builds the argv array dynamically could still evade it."
That was true but it **understated the gap**, because the four forms above are not dynamic and not
wrappers — they are the plainest possible way to write the command. The note has been corrected to say
what was actually missing.

What genuinely remains: a list assembled while the program runs — built up piece by piece, joined from
another list, or returned by a helper. Catching that needs real analysis of how values flow through the
program, not more pattern matching, and guessing would flag correct code.

## One more thing this fixes quietly

Loading this check used to run the entire scan, and it stops the whole process the moment it finds a
real problem — so importing it to test its own logic would kill the test run. It now only scans when
you run it directly. Four other checks hit exactly this trap this week.

## How you know it works

The tests were written first and run against the old behaviour: **six of the eighteen fail** without
this change. The other twelve pass either way — those are the controls, and half of them exist purely
to prove the check stays quiet where it should. Against the real codebase it scans 1,631 files and
reports clean both before and after, so nothing that exists today is newly blocked.
