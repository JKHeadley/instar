# Agent-Held Google Passkeys — the plain-English version

## What problem this solves

AI subscriptions like Claude and Codex sign out every so often, and someone has to sign them back in. Most of these accounts sign in through Google. Until now that meant a person had to do it, or the agent had to hold the person's Google password plus a way to answer their two-step check. Holding someone's password is risky: if it leaks, everything behind that password leaks too.

## The idea

A passkey is a small digital key a website accepts in place of a password. A Google account can have several. This feature lets the agent have **its own** passkey on each Google account it is allowed to use:

1. The person signs the agent into the account once, on each machine. That is the only thing they ever do.
2. While signed in, the agent creates its own passkey and locks it in its encrypted secret store.
3. From then on, whenever Claude or Codex needs signing in again, the agent opens a fresh browser, presents its passkey, and Google lets it in. Claude and Codex both accept "signed in with Google", so one passkey fixes both.

We proved this works on 7 real accounts across 3 machines before writing the spec. What's left is turning our one-off scripts into a proper, safe, built-in Instar feature any agent can use.

## The one trick that matters

When a website asks for a passkey, Chrome normally pops up the computer's fingerprint prompt, and while that prompt is showing the web page freezes. The agent can't answer a fingerprint prompt, so it looked like Google sign-in was "flaky". The fix is to give the browser a pretend passkey device before opening Google. Chrome then talks to that instead, the page never freezes, and that pretend device is exactly where the agent's passkey lives.

## Safety rules built in

- **Nothing by default.** A new agent can't use any account until the person grants it, one account and one machine at a time. Revoking deletes the agent's key rather than just flipping a switch.
- **One key per machine.** Keys are never copied between machines, so one machine can be cut off without touching the others, and a stolen key only works for one account.
- **The person's own login is never touched.** The agent adds its own key. It never changes their password, their passkeys or their two-step settings.
- **Honest about what the key is.** The agent's key is stored software, not a hardware chip, so anyone who stole it could sign in as that Google account, and not just to Claude and Codex. It is treated exactly as seriously as a password: kept encrypted, never copied between machines, and unreadable by the agent's ordinary tools. Only the part that signs in can use it.
- **Every sign-in still has to pass the existing "is this the right account?" check**, which can always say no.
- **No "it worked" on a leftover session.** An account is only marked ready after the agent proves it can sign in from a completely empty browser.
- Company (Google Workspace) accounts need an admin setting switched on first. The feature says so in plain words instead of failing mysteriously.

## Cleaning up today's setup

When we proved this, the keys made on the main machine were copied to the other two. The new version stops any further copying straight away, then asks the person, key by key, whether to keep each existing copy (it keeps working) or delete it. Nothing is removed without that choice. Giving every machine its own key later costs one sign-in per account per machine.

## What ships, and how carefully

It is first tried on a throwaway test agent with a disposable account, then on our own development agent, and only then offered to everyone. Once all our own accounts are repaired by the built-in version instead of the scripts, the scripts get deleted and the feature can be turned on more widely.
