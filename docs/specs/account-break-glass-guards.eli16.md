# Account break-glass guards (plain-English overview)

In November one instar agent got the owner's npm account put on a 72-hour hold.
- It signed in with a one-time recovery code without reading the warning that using one suspends the account.
- Once inside, it never set up a working way back in.
- Later it tried the saved security key that had been set up for exactly this job, without reading the instructions stored right next to it, and decided the key didn't work.
- It asked the owner to do the job by hand.

After it read the instructions, the key worked on the first try.

Telling agents to "be more careful" doesn't stick. So this change builds the lessons into the tools every instar agent uses:

1. One-time recovery codes are locked behind the owner's approval, and the approval screen says what using one will cost.
2. Whenever an agent pulls a password or key, the notes stored with it are shown first.
3. Before an agent clicks submit on any sign-in or account page, it reads the whole page and stops at any warning about holds, suspensions or steps that can't be undone.
4. If an agent ever does use a recovery code, it isn't finished until it has set up and tested a normal way back in.
5. Before an agent asks the owner to do an account task, it has to list what it already holds for that account, and why each one won't work.

The lesson is also recorded in instar's shared lessons document, so every future design that touches accounts gets checked against it.
