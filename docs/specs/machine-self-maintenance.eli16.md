# Machine self-maintenance, explained simply

## What happened

On 1 November the Mac Studio could not be reached with AnyDesk. Instar said the screen was locked, but
pressing a key dismissed a screensaver with no password. The screen was covered in browser windows and
macOS popups, one of which would not close. Only a restart fixed it, and getting there took a lot of
clicking and force-quitting. We do not know why the machine got into that state, or why the locked
reading was wrong. Windows left open by agents might be part of it, but that is a guess, and this
design does not rely on it.

Justin asked for two things: manage the apps and browsers on each machine better, and restart machines
on a regular, automatic schedule, as a built-in part of what an agent does for itself.

## What changes

**A weekly clean start.** About once a week, between 3 and 6 in the morning machine time, a machine
restarts when nothing is running. If a build, a test run or a long job is going, it waits. Work that
we know how to pick back up waits three days at most, then the machine restarts in the next window
and that work resumes afterward. Work we cannot pick back up, like someone else's program, is never
interrupted automatically: the owner gets one question instead. It never restarts while someone is
using the machine. If anyone wants to delay it, there is a Hold button.

**One at a time.** Machines take turns, so there is always one left answering messages. The machine
currently in charge goes last and hands that job over first.

**Proof that it came back.** After restarting, the agent checks that the machine really rebooted and
that its server, messaging, tunnel, desktop access and logins all work, and it tells Justin in one
line. If a machine does not come back at all, another machine notices and says so.

**Rescue when a machine wedges.** The agent watches for several different kinds of trouble. One bad
reading never counts: it takes two different kinds, lasting at least 20 minutes. A model then chooses
from a short list of actions, inside limits it cannot cross. The agent tries the gentle fixes first,
such as closing its own browsers and clearing the known harmless kind of stuck popup. It never answers
a permission prompt. Then it restarts. This forced path starts in watch-only mode, and it acts only
after its judgment has been proven; until then Justin gets the notice with a Restart now button. The restart uses an
operating-system command that a frozen app cannot block. There are hard limits on how often this can
happen, so a machine can never get stuck restarting over and over.

**Tidier browsers.** Agents now record every browser they open and close it when finished. A sweep
closes any left behind, but only ones Instar opened, and the operator's own Chrome can never match.
Being old is not enough: a browser closes only if its task said it was done, its time limit ran out
with no renewal, or the session that opened it is confirmed gone. A browser with text typed into a
form, or one the check cannot read, is kept and reported. There is a limit on how many can be open.

**An honest "locked" answer.** The one flag that misled us becomes one input among several. The answer
is now locked, screensaver or sleeping display, unlocked, or "unknown" when the evidence disagrees.

## The limits, and the one tap

The feature is on by default, but nothing restarts until the machine's owner taps once for that
machine on the dashboard's Machine care page and approves in Telegram. On the Studio that is
everything. A Mac without passwordless admin rights also shows its own system password box once, on
its screen, which the owner can answer from a phone over the desktop link. Instar never sees the
password.

A machine that would stop at a password screen after restarting, such as a laptop with FileVault, is
never restarted by itself. The agent names the one setting involved, and otherwise just reminds the
owner to restart it. The Windows machine starts out in this reminder mode too, because nothing yet
brings its agent back after a Windows restart. A machine the agent does not own, like the shared M5 Pro, is refused. Other agents
on the same machine are told in advance, get ready, and come back afterward.

## What is still not solved

The review did not finish clean. It used all six allowed rounds, and the last one still raised safety
items. Those are fixed in this document. Two extra outside reads followed. The first found three
problems, now fixed here. If a restart command was sent and the machine stays up, we no longer assume
it was cancelled: automatic work stays paused, recovery stays ready, and the owner is asked right away.
A reservation now comes first in every restart, and only a restart that was really sent uses up the
weekly limit.

The second read found one design question still open: a browser doing background work for a live
session could still be closed when its default time limit runs out, unless the session renews it. The
fixes for its other findings were made after that read, so no reviewer has checked them yet.

Instar cannot see unsaved changes in ordinary apps, so an app left open with unsaved work could lose
it. The enrolment card says so before the owner taps.

Permissions on a Mac can also go wrong in ways we have not explained. On 1 November the Mac Mini showed
the system's prompt but never listed our desktop helper, and the M5 Pro listed five entries. Enrolment
has to check permissions live each time, and a guided repair is still needed. This design only notes that.

A machine frozen so deeply that its own software cannot run cannot restart itself. Another machine
will say so, but someone still has to press the button. A single-machine setup has nobody to raise
that alarm.

We also will not trust any of this on paper. The first restart of every machine is a test, watched by
the system, and a machine earns unattended restarts only by passing it.
