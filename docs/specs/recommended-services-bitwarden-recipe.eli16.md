# Your agent can keep a copy of its own secrets in Bitwarden

## What this is

An agent holds secrets: the token that lets it talk to Telegram, its dashboard PIN, keys for services it uses. Today they live only on the machine the agent runs on. Lose that machine and they're gone, and the agent can't be brought back as itself. Bitwarden is one of the recommended services: with a yes, the agent copies its own secrets into a Bitwarden vault, in a folder of its own, so they survive the machine.

Each recommended service needs a recipe: the instructions a setup session follows after your yes, plus a check that decides whether the service really works. Jev and Tailscale have theirs. This change adds the third, for Bitwarden, and marks it available on every agent, because it was proven live on a test agent on 2026-11-07: the agent took a yes, received the login through one secure form, had its server write the copy, and its check passed; a confirmed no with "switch it off" then removed the stored password and signed the machine out, leaving the copies in the vault.

## What the setup session does

First it looks whether Bitwarden's program is on the machine and installs it if not, without needing an administrator where that's possible. Then it asks whose account to use: your own Bitwarden account, or a free account of the agent's own. Both are good. For your account it asks you for your Bitwarden email and master password through one Secret Drop link, never in chat. For an account of its own it needs an email address the agent owns, and says so if there isn't one.

It logs in and opens the vault. The master password never goes on a command line, where any program on the machine could read it; it travels in the one command's environment and nowhere else. The session then stores the master password with your agent, so the agent can open the vault later on its own.

The copy itself is written by your agent's server, not by the session. The server reads its own stored secrets, including the first ones a new agent still keeps in its settings file before pairing moves them into its vault (its own key, your dashboard PIN, its messaging token), and puts each one, by name, as a Secure Note in the folder "instar/<agent name>". The session only hears the names of what was copied and tells you those. The confirm page shows the same list before you say yes: names only, never values. The check passes when the vault opens with the stored password and the agent's folder holds its marker.

From then on the server refreshes the copy once a day, so a secret stored later reaches the vault too. Nothing else in your vault is read or changed.

## If you say no later

A no stops the copying. If you also tick "switch it off on this machine", the agent forgets the master password on that machine and, if the login was one its setup made, signs the machine out. A Bitwarden you were already logged in to is left exactly as it was. The copies already in your folder stay, the agent says so, and offers to delete them if you ask.

## Safeguards

- Only the agent's own folder is ever written. Nothing of yours is read.
- The master password never appears in a process list, a log, a page or a message; the same change moves the agent's existing Bitwarden code off the command line too.
- The check says "unknown" rather than guessing when the program can't be reached or the folder can't be read, so nothing starts on a guess.
- Only what the recipe's live proof showed is promised: a copy in the agent's own folder, refreshed daily, switched off cleanly on a no.

## What you need to decide

Nothing. Bitwarden joins Jev and Tailscale as a service your agent can set up after your yes. The agent still offers nothing on its own; that is the next piece of work.
