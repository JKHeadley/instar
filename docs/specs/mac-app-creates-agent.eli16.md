# The Mac app creates your agent, in plain words

## What this is

Justin approved "easy setup for new people" on 16 November 2026. The goal is that someone who isn't technical downloads the Instar app on their Mac, presses **Create my agent**, and ends up chatting with a working agent. No terminal, no settings to fill in, no paid service, no Telegram. This part covers the Mac app doing the install and becoming the agent's first trusted device. The agent's first hello and first useful result are the next part.

## What already exists

- An installer that another program can drive. It takes answers from a file, records each step in a small progress file, waits for the person when it needs them, and picks up where it stopped.
- A Mac app that connects to an agent that already exists. Every copy of it runs in Apple's sandbox, which stops it from installing anything.
- Pairing a phone or app needs a web address the phone can reach (usually Tailscale), a code from a page locked by a PIN, and an approval. That makes sense for a phone somewhere else. It's a lot of steps for the app on the very same Mac.

## What is new

- **The downloaded Mac app can install.** The version from the Instar website runs outside the sandbox, so it can set things up in the person's own folder. The App Store or TestFlight version keeps the sandbox, and its Create button opens the download page.
- **It brings its own tools.** It downloads Node from the official site and checks it against a fingerprint built into the app. It carries tmux inside itself. If the Mac doesn't have Apple's developer tools for git yet, it asks macOS to add them and tells the person to click Install. Nothing needs an admin password or Homebrew.
- **It runs the existing installer** with the person's answers. It shows each step as one plain line, sends them to the browser to sign in to Claude or ChatGPT, and continues by itself once they have.
- **The app becomes the agent's first trusted device.** When the install finishes, the installer leaves a one-time ticket in a file only the Mac's owner can read. The app reads it and asks the agent to add the app as its owner device, proving it holds its own device key. That works only from the same Mac, only within 30 minutes, and only if the agent has no owner device yet. The app then talks to the agent over the Mac's own internal address, and the window becomes the chat.

## Safeguards

- The new way in only accepts requests from the same Mac. Anything that came through a tunnel or Tailscale is refused, even with the right ticket. On any agent that wasn't just installed by the app, the way in doesn't exist at all.
- It works once. As soon as an agent has an owner device, it refuses, and new devices go through normal pairing and approval.
- It's limited to a few tries every ten minutes.
- It changes no trust or independence level. The person still sets those.
- The app's device only works from the same Mac. Even if its key were copied, it couldn't be used from anywhere else.
- Anything that can read the ticket file can already change the agent's files directly. This gives the app a checked, recorded path instead of a hidden edit.
- If the app or the install is interrupted at the wrong moment, pressing Continue finishes the same enrollment with the same key instead of getting stuck.
- If something goes wrong, a setting turns the new way in off, and existing agents aren't affected.

## What it can't do yet

- Windows and phone-only setups are separate work.
- The agent's first hello and first useful result come in the next part.
- The person still needs a Claude or ChatGPT account.

## What needs deciding

Nothing from Justin. This uses the same owner approval the installer already relies on and doesn't change the constitution. The decision about approving trust from the app alone comes later, as its own yes/no.
