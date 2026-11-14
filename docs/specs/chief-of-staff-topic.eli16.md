# Chief of Staff — the plain-English version

## The problem

Right now Justin is the thing that keeps every effort moving. He starts a project in its own conversation, and then he has to keep coming back to it: poke it when it stalls, check it hasn't wandered off its goal, and restart a "24-hour autonomous session" so it keeps going but stops if he disappears. With dozens of projects, that follow-up job has itself become a full-time job.

The agent already keeps a list of projects. On the day this was written, Echo's list had 24 active projects, and 20 of them hadn't moved in weeks, some for nearly four months. A list only tells you what's stuck. Nothing on the list was anyone's job to get unstuck.

## The idea

Give every agent one special conversation called the **Chief of Staff**. Think of it as the agent's own follow-up person.

- **It's always at the top.** In the Instar app and on the dashboard it is pinned first. When you don't know where to say something, you say it here.
- **Everything else hangs under it.** Each project conversation sits beneath it, and sub-topics sit beneath their project. That tree is the official map of what the agent is working on. (Telegram can't nest topics, so there it is just the pinned topic at the top. The tree shows in the app and dashboard.)
- **Every project has to say what "done" means.** To get under the Chief of Staff, a project needs a one-paragraph goal and a checklist of things that prove it's finished: this PR merged, this page live with this text on it, and so on. Justin confirms it with one tap. A project with no definition of done can't be tracked, which is exactly the kind of project that rots today.

## What it does every day

On a schedule, the Chief of Staff looks at each project and asks: is this moving, stalled, drifting from its goal, waiting on Justin, or done?

To answer, it looks at facts first: merged code, checklist items, whether a session is actually running, overdue promises. Chat counts for very little. A project saying "I'm making great progress" is not progress. A merged change or a checklist item flipping to done is progress.

Then it acts:

- **Stalled** → it restarts the work. If a session is alive it tells it to continue toward the goal. If nothing is running, it starts a bounded work session (up to 4 hours by default). This is the job Justin does by hand today.
- **Drifting** → it reminds the project of its goal and what's left, and asks it to get back on track or explain.
- **Waiting on Justin** → it collects the question into one daily note with a tap-to-answer button where possible.
- **Says it's done** → it checks the claim against the checklist. Facts it can verify itself, it verifies. Anything that needs a human opinion goes to Justin as a one-tap confirm. Only then does the project close. One tap reopens it if that was wrong.
- **Can't tell** → it does nothing, and if that keeps happening it says so.

Justin gave the Chief of Staff authority to restart and redirect work on its own, as long as it stays inside each project's stated goal. It can never change a goal. Only he can.

## The brakes

A follow-up robot that restarts things forever would be worse than no robot. So:

- It never restarts a project while something else already owns the work (for example a running autonomous session). One owner at a time.
- Three restarts with no real progress and it parks the project and tells Justin, instead of trying a fourth time. More than five restarts in a week trips a breaker no matter what.
- Every restart goes through the existing quota and machine-load gates, and at most two restarts start per 15-minute tick, so a reboot never launches a storm.
- It only keeps going while Justin has checked in with it recently. If he goes quiet for three days (adjustable), it stops starting new work, lets running sessions finish, and waits. One message from him turns it back on. This is the same safety idea as his 24-hour sessions, moved up one level so he only has to maintain one of them.
- Only Justin himself can renew that check-in. A message from a teammate, a peer agent, or the agent's own bot doesn't count.

## How it talks to Justin

One short note a day, at 8am by default. It has at most three sections: what needs you, what changed (as counts, with detail only for failures), and what the Chief of Staff can't see. If nothing changed and nothing needs him, it sends nothing at all. The one exception is a single line the day before it would pause itself, because that line is actionable.

Urgent messages are limited to three a day and only for things like "I can't restart anything because the quota gate keeps refusing."

## Safety and privacy

The Chief of Staff conversation is for the owner only. Team members and guests never see it, its pin, or the project tree, because project titles can be sensitive. Project conversations are treated as untrusted text: nothing a project session says can, on its own, convince the Chief of Staff that work is done or that the goal has changed.

## Across machines

An Instar agent can run on more than one computer. All of the Chief of Staff's memory (the tree, the goals and checklists, what it restarted and when, the check-in timer) lives in a store that copies itself to every machine, so a hand-off between machines never restarts something twice or forgets the timer. Only the machine currently in charge runs the checks.

## How it rolls out

1. A throwaway test agent with fake projects proves every behaviour: restart, redirect, stand-down, verifying "done", the brakes, the pause and resume, and a machine hand-off.
2. Then a one-week pilot on Echo with 3 to 5 real projects. Step one of the pilot is a clean-up list over the current 24 active projects (keep with a goal, merge, or archive) that Justin approves in one go. Nothing with a live session or a recent message can be proposed for archive.
3. Pilot success is measured, not recalled: Justin didn't have to manually restart anything, most restarts were followed by real progress, and nothing closed had to be reopened.
4. After that, every agent gets it, dark first, then on by default once a scheduled day-14 check writes the graduation record.

## What review changed

The first draft assumed the existing project records could be used as-is. Review showed they don't sync between machines, so the design got its own replicated store. Review also tightened what counts as progress (chat doesn't), added the stand-down rule so two systems never restart the same work, added the hard restart brakes, made the check-in renewal strictly owner-only, cut the daily note down to near-silent, and turned every "we'll decide later" into a default Justin can change.
