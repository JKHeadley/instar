# Proving it's really you, in plain words

## What this is

Today your dashboard PIN is what proves a person approved something risky. But your agent can read that PIN, so it proves very little. This replaces it for risky actions with proof your agent holds no secret for.

## What already exists

- A six-digit PIN per machine, which also hands the browser the agent's master key.
- A key on each paired phone that can't leave its security chip.
- Passkey support for signing in to Google accounts, which doesn't protect the dashboard today.

## What is new

- **You become the owner during install.** In the common case that takes one tap: Touch ID, Windows Hello, a security key, or Face ID in the app. A long passphrase is there for machines with none of those.
- **Risky actions need your signature.** Your device signs the exact action. The agent can't write the wording you see, and it can't pester you: three declines pause its requests.
- **The PIN only unlocks viewing.** It no longer approves anything once you have a stronger proof, and it no longer hands over the master key.
- **One owner everywhere.** All your machines and agents trust the same proofs, and a phone paired once works on all of them.
- **Ask for your next agent.** Say "make me another agent" and it sets one up after you approve. A new computer takes one pasted line, one approval and a sign-in.

## Safeguards

- No phone and no hosted service are needed.
- You type a passphrase only on a page from your own machine or private network. On a relay address, secrets and approvals happen only in the app.
- A copied install command can't make someone else the owner.
- If something grabs ownership first, you can usually take it back: a reset takes 72 hours, tells you everywhere, and a newly set-up proof can't cancel it. The last resort is installing a new agent.
- An approval works once, on the exact machine and action you saw. If a crash leaves an action unclear, it isn't re-run; you're told and you decide.
- Existing agents keep working. The old PIN and Telegram approvals keep working until you set up a stronger proof.

## What it gives up

- The agent can no longer tell you your PIN. You reset it with a stronger proof.
- Telegram buttons no longer count for risky actions once you enroll, because the agent can read the bot's credentials.
- Resetting after losing everything needs access to the machine or its network. Allowing it from anywhere would let anyone take over.

## What it can't do

The agent runs as the same computer user as the code checking your signature. This stops mistakes, confusion and casual misuse, and any change to your owner record alerts you. It doesn't stop a deliberately hostile agent on its own machine. Stronger separation is later work.

## What needs deciding

Nothing from Justin. No constitution file changes.
