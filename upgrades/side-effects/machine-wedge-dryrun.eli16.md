# Watching for a stuck computer, without touching it (plain English)

Sometimes a computer gets stuck in a way that is hard to see from the outside. On 1 November the Mac Studio was like that: nobody could reach it remotely, apps refused to open, and only a restart fixed it. The plan is for Instar to notice this on its own and, one day, restart the machine safely. This change builds only the noticing part, and it is careful to do nothing else.

Every ten minutes, one agent on each computer looks at a few simple signs. Can the computer still list its running programs quickly? Are programs piling up stuck, waiting on the disk? Is the agent's own server struggling even though the processor is mostly idle? On Linux and on Windows, can the system still start a tiny program that does nothing? If any sign looks bad, it checks every two minutes instead.

One bad sign is not enough. A busy computer can look slow for a moment. So the rule is strict: the same two different signs have to be bad at every check for twenty minutes, with at least three checks in that time. If either sign looks fine even once, the clock starts over. If the checks stop for more than six minutes, the clock also starts over, so a gap can never be counted as "still stuck".

When that happens, the agent asks an AI judge one question: should we leave it alone, try gentle fixes, restart in the small hours, or restart now? The judge only sees numbers and short labels, never what is on the screen. Its answer is written down, together with the steps that would have followed. None of those steps run, because they are not built yet. If the computer was restarted less than six hours ago, the answer is capped at "tell the owner", because restarting again would not help.

If one sign stays bad for two hours on its own, nothing is asked, but the next night-time maintenance slot is marked as due early, only on paper for now.

There is also a real message to the owner saying "this machine looks stuck", but it is switched off in this version. When someone turns it on, it says plainly that nothing was done and that the restart button does not exist yet. It can only be sent once per stuck episode, and at most twice a day, so a computer that keeps flickering cannot flood anyone.

On a Mac, one of the four signs cannot be read yet, so a Mac can only be flagged by the other two. The status page says so in plain words rather than pretending that sign is fine. Anything that could not be read shows as "unknown", never as "healthy".
