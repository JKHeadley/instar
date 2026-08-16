# Tests must not create real GitHub repositories — Plain-English Overview

> The one-line version: one test has been quietly creating three real repositories on the operator's GitHub account every time it runs, and it has done that 377 times.

## The problem in one breath

Setting up a new agent includes a "back this up to the cloud" step, which creates a private repository on your GitHub account. There is a test that checks new agents are set up correctly, and to do that it really does set one up. It gives the throwaway agent a random name, runs the real setup routine, and then deletes the temporary folder it made. What it never knew is that the setup routine also reached out to GitHub and made a real repository — and deleting a folder does not delete that. It has been doing this since the middle of June.

## What already exists

- **The setup routine** — the code that creates a new agent: writes its files, gives it an identity, and offers to back it up to the cloud. It is one routine, used by real installs and by tests alike.
- **The cloud-backup step inside it** — starts a local repository, checks the GitHub command-line tool is present and signed in, then creates a private repository named after the agent. When nobody is at the keyboard to answer, it assumes yes, because that is the right default for a real person installing the software.
- **The tests that call it** — seven files. They are careful about the filesystem: each redirects the agent's home to a temporary folder and deletes it afterwards. None of them were careful about the network, because nothing told them there was a network.

## What this adds

The setup routine now recognises when it is being run by a test, and skips the cloud-backup step entirely in that case. It says so on screen rather than skipping silently, so nobody is left wondering why their backup did not appear.

That is the whole change. The important part is *where* it is: in the setup routine, not in the test.

## The new pieces

- **A "is this a test run?" check** — reads two well-known markers that testing tools set on the environment. It deliberately does **not** treat "this is running in CI" as a test, because someone's own automation might legitimately install an agent and would genuinely want the backup. Getting that distinction wrong would have quietly removed a real feature from real users.

## The safeguards

**Stops the leak at the only place it can happen.** Fixing the one test that was traced would have left the other six, and every test written afterwards, free to do exactly the same thing. There is one place in the code that reaches out to GitHub, so that is where the check goes. Nobody has to remember anything.

**Does not take backups away from real people.** The check is false in any normal run, so a real installation behaves exactly as it did before, down to the same output. The one environment that might have looked like a test — continuous integration — is explicitly excluded, and there is a test holding that exclusion in place.

**Proven to actually catch the problem.** The new test was deliberately run with the fix disabled to confirm it fails, and it does. That check was performed with the GitHub tool signed out, so the experiment itself could not create another repository — the account had 378 repositories before and 378 after.

## What ships when

One change, one pull request, no staged rollout and no setting to turn on. There is nothing to configure and nothing to migrate.

## What you actually need to decide

Two separate things. First: ship this fix, so no future test can create repositories on your account — yes or no. Second, and independently: whether to delete the 377 empty repositories that already exist. This change deliberately leaves them alone, because deleting repositories cannot be undone and the account is yours.
