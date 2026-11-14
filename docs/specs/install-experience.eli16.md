# Installing Instar, in plain words

## What this is

Justin asked for the easiest possible way to install Instar: start from the iPhone app or an AI tool you already have, make very few choices, and let AI do the work. He also set a firm rule: nobody should ever depend on a service we run, and nobody should need a phone. This is the first of three parts, and it ships without the other two. The second covers proving you're the owner, and the third covers an optional relay.

## What already exists

- A one-line command, which only works if you already have Node and an AI tool installed.
- A long setup conversation that never mentions the app and insists on a messaging service like Telegram.
- An iPhone app that can run its own conversations, but can only be paired with a Cloudflare address.

We ran the command in an empty home folder on a computer that already had the tools. Reaching the sign-in screen took about four minutes, and nothing along the way explained what an agent is.

## What is new

- **Several ways in, one installer.** Run the command, paste a sentence into your AI tool, or use npm. It explains what an agent is first, then asks for a name and what you want help with. If you have the app, you connect it to your computer by scanning a code.
- **It installs what's missing.** It says what it will install and asks once, then handles Node and your chosen AI tool. If it gets interrupted, it picks up where it stopped.
- **Any AI.** Subscriptions first. API keys and local models come once they're proven, and API keys also need a spending limit.
- **Several ways to reach your agent, without Cloudflare.** Tailscale, your own domain, your local network, or no address at all through Telegram or Slack. The agent does the setup. You only sign in when needed.
- **It keeps running.** With your okay, it starts itself after a reboot. It works while your computer is on and awake, and it says so.
- **Messaging becomes optional.** You can talk to your agent in its dashboard, and it keeps a protected way to reach you.
- **First tasks that need no new accounts.** A morning briefing, a memory check and a reminder. A scheduled email report comes next.

## Safeguards

- When an AI tool runs the install, it can't answer for you on sign-in or addresses. Those open a window for you.
- Success means your message really arrived, not that a send looked fine.
- If its checks are slow, the agent sends a simple "I'm here, my checks are slow" line within five minutes and says it can't tell yet.
- The installer checks disk space first and only downloads the large browser when something needs it.

## What it can't do

- The app can't start a computer for you. You run one command on your computer.
- Before the relay exists, connecting a phone needs the same network or a private address like Tailscale.
- We haven't yet proven that API keys and local models can run agent sessions. Setup says "not yet" until they do.
- We haven't run a complete install with a real sign-in and a phone. That run is what we'll measure every improvement against.

## What needs deciding

Nothing from Justin for this part, except that offering API keys waits on him turning on the spending controls with his PIN.
