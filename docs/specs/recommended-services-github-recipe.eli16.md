# Your agent can keep a private backup of itself on GitHub (test agents only, for now)

## What this is

An agent's memory, settings and identity live on the machine it runs on. Lose that machine and the agent is gone. GitHub private backup is one of the recommended services: with a yes, the agent keeps a copy of its state folder in a private repository on GitHub, so it can be brought back on another machine. Its secrets are never part of that copy; the state folder's ignore list keeps them out.

Each recommended service needs a recipe: the instructions a setup session follows after your yes, plus a check that decides whether the service really works. Jev, Tailscale and Bitwarden have theirs. This change adds the fourth, for GitHub. Like the others before their live proof, it runs only on test agents until it has been proven for real.

## What the setup session does

It asks whose account to use: your own GitHub account, or an account of the agent's own if it already has one. For your account it needs a token that can create a repository and push to it; it asks for that through one secure form, never in chat, and says in one sentence what kind of token. It stores the token with your agent.

The repository itself is created and pushed by your agent's server, not by the session. The server creates a private repository named after the agent under the token's account, if there isn't one yet, refuses to push to any repository that is not private, pushes the state folder, and then checks: GitHub must say the repository is private, and the copy on GitHub must match what the machine has. From then on the server pushes again daily.

If a backup repository ever becomes public, the check fails, nothing more is pushed to it, and you get one notice with the fix (make it private again in the repository's settings). When it is private again, the backup resumes on the next check.

## If you say no later

A no stops the backup. If you also tick "switch it off on this machine", the agent forgets the token on that machine and turns its own backup switch off, the same switch older versions read, so no machine keeps pushing. The repository and what is in it stay yours; the agent says so and offers to delete it if you ask.

## Safeguards

- Only a private repository is ever pushed to; a public one gets a notice, never a push.
- The token travels in the one command's environment, never in a remote address, a command line, a log or a message.
- The check says "unknown" when GitHub does not answer, so nothing starts on a guess.
- The recipe is dark: available only to a test agent that lists it, until the live proof.

## What you need to decide

Nothing yet. This recipe is being proven on a test agent next; once proven, a change marks GitHub private backup available on every agent, like the three before it.
