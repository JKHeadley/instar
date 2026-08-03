# Local session cleanup on a non-serving machine

When one Instar agent runs on two computers, one machine holds the serving lease. That lease decides
which machine may act on shared routing and cross-machine state. It does not, however, make a process
on the other computer stop existing. A session running inside the laptop's own terminal multiplexer
can be inspected and terminated only by the laptop.

The old rule treated every autonomous cleanup as cross-machine authority. A non-serving machine could
correctly prove that one of its own sessions was far beyond its lifetime limit and positively idle,
ask the central termination authority to close it, and then be refused because it did not hold the
serving lease. The lease holder could not help: the process was not in its local process namespace.
The result was a permanent contradiction—one machine was the only machine capable of cleanup and was
also the one machine categorically forbidden from doing it.

The correction separates the two ownership domains. Shared and remote action remains lease-holder
only. The local age monitor gets one runtime-private capability to close an over-age session from its
own machine-local session registry. Neither that capability nor the internal options cross a runtime-
callable method. The termination authority accepts it only for the exact age-limit path, after the
safety guard is installed. For every real cleanup, continuity observers run independently while the
process is still inspectable; the final closed record is then saved and tmux is stopped immediately
under a hard bound. If ownership changes at that last boundary, the save is refused and the process
remains alive. Ordinary autonomous calls—including a public age-limit request—remain lease-refused.
If tmux itself refuses the stop, the terminal record is restored to “running” and no successful reap
is emitted. A broken lifecycle observer cannot interrupt the safe transition or suppress the later
audit.

This does not turn age into sufficient evidence. The monitor must still prove the session is idle,
and the authority still rechecks protected-session status, recent user interaction, open commitments,
active subagents, structural work, recovery-in-flight, process activity, compare-and-set state, and
the in-flight lock. The existing self-action governor and retry backoff are unchanged. The durable
reap record now names both the machine and the authority scope, so a future pool-side count can
distinguish normal lease-holder cleanup from this local-only exception without guessing from timing.

The laptop-side historical counts that prompted the investigation were not used as proof. The laptop
was offline and its cleanup log is machine-local, so those numbers could not be independently
re-derived. Instead, the regression test drives the real maintenance loop: before the correction it
proves age and idleness, receives `not-lease-holder`, and leaves the session running; after the
correction the same session is closed while all protective veto cases remain running.

An independent adversarial review found and forced closure of several successive draft holes:
TypeScript-only privacy exposed minters, caller-controlled internal inputs could forge targets or
bypasses, preflight followed by kill then save left an ownership-change race, listener failures could
suppress the audit, and the default timeout signal could leave a wedged tmux client blocking forever.
The final design uses
JavaScript runtime-private authority methods, hands the trusted termination closure to server boot
only while the manager is being constructed, makes reaper dependencies runtime-private and immutable,
drops every forged public bypass option, commits terminal state immediately before a SIGKILL-bounded
synchronous process action, compensates it on process-kill failure, isolates lifecycle observers, and
starts maintenance only after all authority dependencies are wired.
Dedicated tests preserve those exact attacks as regressions.
