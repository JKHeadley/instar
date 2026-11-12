# Account break-glass guards (plain-English overview)

In November one instar agent got the owner's npm account put on a 72-hour hold.
- It signed in with a one-time recovery code without reading the warning that using one suspends the account.
- Once inside, it never set up a working way back in.
- Later it tried the saved security key that had been set up for exactly this job, without reading the instructions stored right next to it, and decided the key didn't work.
- It asked the owner to do the job by hand.

After it read the instructions, the key worked on the first try.

Telling agents to "be more careful" doesn't stick. So this change builds the lessons into the tools every instar agent uses:

1. Typing a one-time recovery code into a website needs the owner's approval for that one use, and the approval screen says what it will cost (on npm, a 72-hour hold). The check sits on the website page itself, so it works whichever tool the agent uses.
2. Whenever an agent pulls a password or key that has instructions saved with it, those instructions are shown with it, in full. They are treated as information, never as permission.
3. On any sign-in or account page, a submit is held until the agent has read the whole page, and it stops at any warning about holds, suspensions or steps that can't be undone. This now covers hand-written browser scripts too, which is the route the npm mistake took.
4. If an agent ever does use a recovery code, a tracked to-do opens, and it stays open until a normal way back in has been tested in a fresh browser.
5. Before an agent hands an account task to the owner, the system lists what the agent already holds for that account, and the agent has to say why each one won't work. Asking for an approval or a 2FA code is not affected.

The lesson is also recorded in instar's shared lessons document, so every future design that touches accounts gets checked against it.
