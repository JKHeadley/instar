## What Changed

- Added `instar install`, the first part of a simpler installer: it explains what an agent is, asks for a name and purpose, lists what it will do once, installs what's missing, checks the AI tool is really signed in, and can pick up where it stopped. It isn't the default yet, and `npx instar` is unchanged.
- Claude Code's first-run screens are answered before the first session, on every machine: the welcome flow, folder trust, the project tool picker and the bypass-permissions warning. On a machine that had never run Claude Code, sessions used to end at the last of these, whose default is "No, exit". `instar init` answers them, and so does every session launch (once per server start for the default login, every time for a pool login). Only those settings are written; nothing else in your Claude Code settings changes.
- On Linux the installer also adds the `sqlite3` command, offers the exact Node 22 install when Node is too old, and grants this user Tailscale operator rights so the phone app can reach the agent over Tailscale. None of these stops an install if it can't be done.
- On a computer with no browser, the installer can take a token made with `claude setup-token` on any computer that has one, instead of signing in there. It is written to `sessions.credentials.anthropic`.
- Setup no longer loops when your Telegram account already has the 20 bots Telegram allows: it says so plainly and finishes without Telegram, and the agent works from its dashboard and the Instar app.

## What to Tell Your User

- **New machines start cleanly**: "If I run on a computer that has never used Claude Code before, I now answer its first-run questions myself, so my first conversation there doesn't stop before it starts."
- **Telegram bot limit**: "If your Telegram account already has the most bots Telegram allows, setup now tells you so and finishes without Telegram. You can still talk to me from the dashboard and the Instar app."

The installer itself is groundwork and isn't what new people get until the rest is ready.

## Evidence

- Real runs on a throwaway agent on 2026-11-02 reached a working dashboard in about 25 seconds with Claude Code already present, with no public tunnel and no sign-in link in the log. A clean machine and a Mac aren't tested yet.

## Summary of New Capabilities

| Capability | How to use |
|---|---|
| First-run screens answered | automatic at session launch |
| Telegram bot-limit fallback | type skip at the token prompt, or automatic in browser setup |
