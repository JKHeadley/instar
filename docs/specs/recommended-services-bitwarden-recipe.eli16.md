# Your agent can keep a copy of its own secrets in Bitwarden (test agents only, for now)

## What this is

An agent holds secrets: the token that lets it talk to Telegram, its dashboard PIN, keys for services it uses. Today they live only on the machine the agent runs on. Lose that machine and they're gone, and the agent can't be brought back as itself. Bitwarden is one of the recommended services: with a yes, the agent copies its own secrets into a Bitwarden vault, in a folder of its own, so they survive the machine.

Each recommended service needs a recipe: the instructions a setup session follows after your yes, plus a check that decides whether the service really works. Jev and Tailscale have theirs. This change adds the third, for Bitwarden. Like the others before their live proof, it runs only on test agents until it has been proven for real.

## What the setup session does

First it looks whether Bitwarden's program is on the machine and installs it if not, without needing an administrator where that's possible. Then it asks whose account to use: your own Bitwarden account, or a free account of the agent's own. Both are good. For your account it asks you for your Bitwarden email and master password through one Secret Drop link, never in chat. For an account of its own it needs an email address the agent owns, and says so if there isn't one.

It logs in and opens the vault. The master password never goes on a command line, where any program on the machine could read it; it travels in the one command's environment and nowhere else. The session then stores the master password with your agent, so the agent can open the vault later on its own.

The copy itself is written by your agent's server, not by the session. The server reads its own stored secrets and puts each one, by name, as a Secure Note in the folder "instar/<agent name>". The session only hears the names of what was copied and tells you those. The confirm page shows the same list before you say yes: names only, never values. The check passes when the vault opens with the stored password and the agent's folder holds its marker.

From then on the server refreshes the copy once a day, so a secret stored later reaches the vault too. Nothing else in your vault is read or changed.

## If you say no later

A no stops the copying. If you also tick "switch it off on this machine", the agent forgets the master password on that machine and, if the login was one its setup made, signs the machine out. A Bitwarden you were already logged in to is left exactly as it was. The copies already in your folder stay, the agent says so, and offers to delete them if you ask.

## Safeguards

- Only the agent's own folder is ever written. Nothing of yours is read.
- The master password never appears in a process list, a log, a page or a message; the same change moves the agent's existing Bitwarden code off the command line too.
- The check says "unknown" rather than guessing when the program can't be reached or the folder can't be read, so nothing starts on a guess.
- The recipe is dark: available only to a test agent that lists it, until the live proof.

## What you need to decide

Nothing yet. This recipe is being proven on a test agent next; once proven, a separate change marks Bitwarden available on every agent, like Jev and Tailscale.
