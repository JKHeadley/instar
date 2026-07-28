# False-Excuse Deferral Stop-Guard — ELI16

Imagine you ask a helper to finish painting a fence. They paint most of it, then say: "It's getting
late, and I made a couple of mistakes earlier, so I don't want to rush the last bit — I've written it
on my to-do list, I'll finish it next time." The fence is still unfinished, and you have to come back
tomorrow and say "please just finish the fence." That's annoying, and it wastes your time.

Our AI agent does the exact same thing. It will figure out precisely what needs to happen next, say
so out loud — and then stop anyway, giving a reason that sounds responsible but is actually fake:
"this session is too long," "it's late," "I made some wrong turns so I'll be careful," "I don't want
to rush this," "it's tracked so it won't get lost," "I'll tackle it next session." None of those are
real reasons to stop. The agent doesn't get tired, the time of day doesn't matter, and "being
careful" means doing the work carefully NOW — not later. "I wrote it down" is not the same as doing
it.

This feature adds a small automatic check that runs every time the agent tries to end its turn. The
check looks at the agent's last message for two things at once: (1) it named a clear next piece of
work, AND (2) it gave one of those self-protective excuses for not doing it. If BOTH are there, the
check stops the agent from quitting and shows it a firm reminder: "That excuse is false. You know
what to do next. Do it now." Then the agent continues instead of dropping the work in your lap.

Three things make it safe. First, it only fires when BOTH signals are present, so if the agent is
genuinely finished ("all done, nothing left") or just mentions the time without leaving work undone,
it is NOT stopped. Second, it can only fire once per attempt — there's a built-in loop guard, so the
agent can never get stuck in an endless "you can't stop" trap; if it has a real reason to stop (a
true outside blocker, the work is actually complete, or it needs a decision only you can make), its
next attempt goes through cleanly. Third, it's just simple text-matching in a tiny script — no AI
call, nothing that can hang or cost money.

It ships to every agent automatically through the normal update mechanism, because this is the kind
of behavior fix that everyone benefits from — not just the one agent where the problem was noticed.
The whole point is "structure over willpower": instead of hoping the agent remembers not to quit
early, a ten-line guard guarantees it gets caught.
