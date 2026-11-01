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

**A weekly clean start, at a set time.** About once a week, a machine restarts at a set time, 4 in the morning machine time. The time is a promise, and work makes way for it. We used to say a machine would wait for work to finish, but work is always going on, so that wait would never end.

**Everything makes way, on one schedule.** An hour before, every Instar agent on that machine, including other people's agents on the same login, and every other machine in the group, learns about the restart from one shared record. New long work stops starting there. Where another machine can take over, the serving role, queued checks and recent conversations move to it. Twenty minutes before, running sessions are told to save their place and stop at the next step. Ten minutes before, test runs are cancelled and go back to the same place in line. Five minutes before, whatever is still going is paused. Then the machine restarts, and the work is brought back automatically. Nobody has to restart anything by hand. Any new kind of work has to say how it makes way, and if it does not, it counts as work that cannot be paused.

**Only a short list can delay it.** There are seven allowed reasons, each with its own limit of 30 to 90 minutes, such as the owner being at the machine, or a program that cannot be paused. Together they can move the restart two hours at most, and never past 6 in the morning. If one of the reasons that ends in a roll reaches its limit, the restart moves to the next night.

**It can only slip so far.** After 9 days without a restart, the owner gets one plain question during the day. It says what would be ended and offers Restart tonight, Restart now, or Skip 3 days. If he does not answer, the machine restarts that night, even over a program that cannot be paused. It only does this once the question has actually reached him.

**A few things it never restarts through.** An operating system update that is really installing, a disk repair or firmware update in progress, someone using the machine right now, or a battery under half. These have no time limit, because restarting through them can do real harm, and the agent reports them every night they stop a restart. Text typed into a browser the agent opened is a delay and not one of these. If it were, one forgotten form could stop every restart for good.

**The owner stays in charge.** Skip once, Change window and Restart now are on the dashboard and in the iPhone app.

**It practises first.** To begin with, the machine only rehearses each night, on paper. It records what it would have stopped and moved, and how long each kind of work takes to reach a stopping point. Real restarts start once those records look safe.

**One at a time.** Machines take turns, so there is always one left answering messages. The machine currently in charge goes last and hands that job over first.

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
on the same machine take part in the same schedule and come back afterward.

## What is still not solved

The design's review ran out of its allowed rounds, and later outside reads followed, so it was never formally finished. Justin accepted the design with the change above. One more outside read checked this version and found three real problems: an owner's restart could slip past an update that started during the short pause; calling a restart off did not bring back everything already stopped; and a missing check came too late to delay the restart. All three are fixed here, and no reviewer has read those fixes yet.

Instar cannot see unsaved changes in ordinary apps, so an app left open with unsaved work could lose
it. The enrolment card says so before the owner taps. If the owner does not answer the question, a
program that cannot be paused is ended by that night's restart. That is the choice Justin asked for.

Permissions on a Mac can also go wrong in ways we have not explained. On 1 November the Mac Mini showed
the system's prompt but never listed our desktop helper, and the M5 Pro listed five entries. Enrolment
has to check permissions live each time, and a guided repair is still needed. This design only notes that.

A machine frozen so deeply that its own software cannot run cannot restart itself. Another machine
will say so, but someone still has to press the button. A single-machine setup has nobody to raise
that alarm.

We also will not trust any of this on paper. The first restart of every machine is a test, watched by
the system, and a machine earns unattended restarts only by passing it.

## What is being built first

Justin replied "go" on 2026-11-01 at 14:55 PST, accepting the two rules and the core-first order. Review did not converge: nine rounds ran against a cap of six, and the last round's three fixes have not been read by a reviewer.

The first build only watches. Each night it practises a restart on paper and writes down what it would have done and how long work took to reach a stopping point. It has no way to restart a machine or stop any work, and a test of the source fails the build if that changes. Everything that acts comes later: the real restart, the owner's tap, browser cleanup, wedge restart and the app controls.
