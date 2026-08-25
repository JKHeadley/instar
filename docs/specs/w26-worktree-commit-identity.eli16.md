# Worktree commit identity, in plain English

## The one-sentence version

When your agent makes a copy of the codebase to work in, that copy used to sign its commits with a
made-up email address that belongs to nobody — so GitHub refused to merge the work without a human
clicking approve. Now it uses an address you actually configured, and if you haven't configured one
it stops and says so instead of making one up.

## What was happening

Every time an agent set up a working copy of the instar code, it wrote a name and an email into that
copy's git settings. The email was always the same shape: the agent's name, then `@instar.local`.

`instar.local` is not a real place. No account exists there and nobody can receive mail at it. It was
a placeholder that quietly became the permanent answer.

That mattered because GitHub has a rule turned on for this project: if a pull request contains commits
whose author isn't linked to a real account, someone has to approve it by hand before it can merge.
So every release the agents produced stopped and waited for a person to click a button — not because
anyone reviewed anything, but because the author field was a placeholder.

In the previous window that was one of four separate moments where the work stopped and waited for
Justin. The goal for this window is zero.

## What already existed

- The tool that makes working copies, and the rule that they must live inside the agent's own folder
  (that part is untouched and still enforced — it exists because the operating system can cut off
  access to folders elsewhere partway through a session).
- GitHub's rule about unlinked authors. Nothing about that changed; it was doing its job correctly.
- A place in the agent's configuration where settings like this belong.

## What's new

The tool no longer contains any email address at all. Instead it looks in two places, in order:

1. **Your configuration** — if you've written down a name and email for the agent to commit as, it
   uses that.
2. **The agent's own copy of the code** — if git is already set up there with a name and email, it
   inherits those.

And if neither exists, it does the thing that matters most: **it stops.** It refuses to make the
working copy and tells you exactly which setting is missing.

That refusal is the actual point of the change, not a rough edge. Making up an address and carrying
on is how the original problem happened — something reported success while the thing it was supposed
to achieve (a commit anyone can trace to a person) never happened. Stopping is the honest answer to
"I don't know who this should be."

Worth naming: the obvious fix — swap the fake address for the real one — was considered and rejected.
It would have solved today's symptom while leaving the same shape of problem in place, because the
tool would still be inventing an identity rather than using one somebody chose.

## The safeguards, in plain terms

- **A half-finished setting doesn't break anything.** If your configuration has a name but no email,
  or the file is malformed, it quietly moves on to the second place to look instead of failing.
- **It can't be fooled into thinking it's configured.** There are environment settings that change
  who a commit is attributed to at the moment of committing. Those can't make an unconfigured
  machine look configured — there's a test that specifically checks this.
- **Signing is left alone.** If you sign your commits cryptographically, none of that configuration
  is touched. Changing the email without regard for signing is how commits start failing
  verification.
- **Existing working copies are unaffected.** They keep whatever they were set up with. This only
  changes copies made from now on.
- **Agents that already have the documentation get the correction.** The explanation of this
  behaviour ships inside each agent's instructions. Those instructions are only installed when
  missing, so agents that already had them would have kept reading the old, now-false description
  forever. A separate update rewrites that paragraph. It deliberately does not write an address of
  its own — it can't know yours, and inventing one is the exact thing being removed.

## What you actually need to decide

**Nothing is required of you if your agent's code copy already has a git name and email set** — which
is the normal state, because git itself asks for those the first time you commit. It will simply
inherit them.

**One thing to be aware of if you run more than one machine:** this is deliberately per-machine.
Setting the identity on your laptop does not set it on your Mac mini. Each machine looks at its own
configuration and its own copy of the code, and each will refuse independently until it has one. That
is on purpose — an identity is a choice you make per install, and silently copying one between
machines is a category of thing this project avoids. The refusal message tells you which machine is
missing what, so you find out by being told rather than by a mystery.

**If you'd rather the agent commit as something specific** — a particular display name, or an address
linked to a particular GitHub account — write it into the agent's configuration and it takes priority
over everything else.

## How you'd know it went wrong

You would try to create a working copy and get a refusal naming a missing setting. That is the
designed failure and the fix is to add the setting. The undesigned failure would be a commit showing
up authored by someone unexpected — if that happens, the identity being inherited from the second
source is not the one you meant, and setting it explicitly in the configuration overrides it.
