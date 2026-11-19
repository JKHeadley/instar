# Account break-glass guards (plain-English overview)

In November one instar agent got the owner's npm account put on a 72-hour hold.
- It signed in with a one-time recovery code without reading the warning that using one suspends the account.
- Once inside, it never set up a working way back in.
- Later it tried the saved security key that had been set up for exactly this job, without reading the instructions stored right next to it, and decided the key didn't work.
- It asked the owner to do the job by hand.

After it read the instructions, the key worked on the first try.

Telling agents to "be more careful" doesn't stick, because the warnings never reached the agent. This change puts the warnings where the agent cannot miss them:

1. **Recovery codes.** When an agent is about to send a one-time recovery code to a website, the page stops and shows a pop-up. The pop-up says what the code will cost (on npm, a 72-hour hold). It also reminds the agent that it needs the owner's approval and should check the saved instructions first. If the agent's script ignores the pop-up, the code is not sent.
2. **Saved instructions.** Whenever an agent pulls a password or key that has instructions saved with it, it gets the instructions too, in full. They are treated as information, never as permission.
3. **Every browser route.** The page check now runs in all the ways agents open web pages, including hand-written browser scripts. A hand-written script is the route the npm mistake took, and the old check never saw it.

What this does not do: it stops an agent that is confused, which is what happened here. It does not stop an agent that is deliberately working around it. Locking codes away so only the server can use them is a bigger follow-up. So are a tracked to-do after any recovery-code sign-in, a check before handing account work to the owner, and the same page check on Linux and Windows. Each will be tracked when this ships.

The lesson is also recorded in instar's shared lessons document, so every future design that touches accounts gets checked against it.
