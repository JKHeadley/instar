# Installing Instar, in plain words

## What this is

Justin asked for the easiest possible way to install Instar: start from the iPhone app or an AI tool you already have, make very few choices, and let AI do the work. He also set a firm rule: nobody should ever depend on a service we run, and nobody should need a phone.

## What already exists

- A one-line command, which only works if you already have Node and an AI tool installed.
- A long setup conversation that never mentions the app and insists on a messaging service like Telegram.
- An iPhone app that can run its own conversations, but can only be paired with a Cloudflare address.
- A six-digit PIN stored where the agent itself can read it.

We ran the command in an empty home folder on a computer that already had the tools. Reaching the sign-in screen took about four minutes, and nothing along the way explained what an agent is.

## What is new

- **Three ways in, one installer.** Start from the app, paste a sentence into your AI tool, or run the command. It explains what an agent is first, then asks for a name and what you want help with.
- **Any AI.** Subscriptions, API keys and local models. Each one has to prove it works before we recommend it.
- **Several ways to reach your agent.** Our relay, Tailscale, your own domain, or no address at all through Telegram or Slack. The agent does the setup. You only sign in when needed.
- **A small relay we run, if you want it.** It helps with addresses, finding your phone during install, and phone alerts. It stores no conversations, it is open source, and you can run your own or skip it.
- **Real proof it's you.** Risky actions need a Face ID tap on your phone, or Touch ID, Windows Hello, or a security key on your computer, or a long passphrase. The PIN only unlocks viewing.
- **First tasks that need no new accounts.** A morning briefing, a memory check and a reminder. A scheduled email report comes next.
- **Ask for your next agent.** Your agent sets it up. A new computer takes one pasted line, one approval and a sign-in.

## Safeguards

- The relay can never become you. Your key goes straight from your phone to your computer inside the install command, and both screens show a matching code.
- If the relay goes down, your agent keeps running.
- The agent can't reset your proof on its own.
- Existing agents keep working, and the old PIN keeps working until you have something stronger.

## What it can't do

- **One dependency can't be removed.** Apple only accepts alerts for our App Store app when signed with our key. If you stay fully independent, the app still works but won't buzz, so alerts come through Telegram or Slack, or you build the app yourself. You're told this when you choose.
- **It doesn't stop a truly hostile agent.** The agent runs as the same computer user as the code checking your approvals. This stops mistakes and casual misuse, not an agent deliberately breaking in on its own machine. Stronger separation is later work.

## What still needs solving

- A passkey is tied to one web address, and an agent can have several. This is the hardest open problem.
- We haven't yet proven that API keys and local models can run agent sessions.
- We haven't run a complete install with a real sign-in and a phone. That run is what we'll measure every improvement against.

## What needs deciding

Justin has made the direction calls. The rest are design questions that review should settle first. Anything that needs his input will come to him as a short, specific question.
