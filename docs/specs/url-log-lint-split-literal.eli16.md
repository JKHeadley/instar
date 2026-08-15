# ELI16 — a credential leak guard that a tidy-up could switch off

## The thing it protects

On 2026-05-27 one of our commands printed a git clone URL into its log, and that
URL had a live GitHub token inside it. Anyone reading the log had the token.

A check was added so that can't happen again. It scans our source for a URL with
a username and password baked into it — the `https://user:secret@host` shape —
and fails the build if it finds one being logged.

## What was wrong with it

The check looked at one line of code at a time and only recognised the URL when
it was written as a single piece of text. So this was caught:

    "https://user:token@github.com/x.git"

and this was not:

    "https://user:" + "token@github.com/x.git"

Those two lines build the identical string and leak the identical token. The
second one is invisible to the check.

The uncomfortable part is that nobody has to be sneaky to write the second form.
Splitting a long string in two is something people do to keep a line short, or
because a formatter did it for them. So the guard could be switched off by
accident, while the code looked tidier than before.

## What changed

Before the check looks at a line, it now joins text pieces that are glued
together with a plus sign, so it sees the string the code actually builds. The
two forms above are now treated the same, because they are the same.

It only joins pieces that are already written out. If one of the parts is a
variable, the joining stops there — the check never guesses what a variable
might hold, because guessing would mean failing builds over code that is fine.

## What did NOT change, on purpose

This check has a second half that works differently: it looks for five specific
variable names being printed. Rename your variable to something not on that
list, or print it a different way, and that half misses it. Both of those were
measured and both still get through.

That half was deliberately left alone. Adding more names to the list would catch
a few more cases while leaving the real weakness untouched — the check is
recognising a *habit of naming things* rather than the dangerous thing itself.
Making that half genuinely reliable means changing what it is allowed to decide,
which is a bigger change than a pattern edit and belongs in its own proposal.
It is written down in the check's own header so the next reader sees it.

## How we know it works

The three leaking forms fail the test suite when the fix is removed, and pass
with it. Ten other cases pass either way, which is what makes them controls
rather than decoration. Four pieces of correct-but-similar-looking code were run
against both the old and new versions and got identical verdicts, so the change
adds no new false alarms. The real codebase is clean before and after.

## A correction made after this was first written

The first version of the test proved the fix by dropping a small decoy file
into the project's own source folder, letting the checker find it, and then
deleting it. Continuous integration rejected that, and it was right to: this
project has a separate safety rule that refuses to delete anything inside its
own source folder, because deleting the wrong thing there once caused real
damage. Satisfying one safety rule had walked straight into another.

There was a second problem nobody had flagged, and it is the worse of the two.
Other tests run at the same time and can see that folder. A decoy file sitting
in it is something they could stumble over — so the test was not only unsafe,
it was quietly unfair to everyone else's tests.

The fix is not a workaround. The checker can now be pointed at a scratch folder
made for the moment and thrown away afterwards, so the test never touches the
real source folder at all. Left alone, the checker behaves exactly as before —
that was confirmed by running it both ways.

One honest reduction: the three leak cases now exercise the checker's decision
directly rather than by running it as a command, so the command's own
error-printing path is only covered in the "nothing wrong" direction. That
wrapper is eight lines and this change does not touch it. It is written down
rather than left for someone to discover.
