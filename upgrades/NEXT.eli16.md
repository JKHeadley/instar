# vNEXT — plain English overview

## What this change is

Your agent has a bunch of helper scripts that need to talk to its own local
server. They authenticate using an "auth token" — basically a password the
server expects in every request.

Recently we added a feature that **moves that password out of the plain
config file into an encrypted store**, so the password no longer sits in
plain text on disk. That's a good security improvement.

But when we did that, we forgot to update *every* place the helpers read
the password from. So a bunch of helpers kept reading the plain config
file, found the placeholder marker (a tiny note that says "the real
password lives in the encrypted store now"), and used **that marker** as
the password. The server rejected every request. The helpers didn't
notice the rejection — they just quietly emitted nothing.

The user-visible result: your agent comes back from a memory compaction
and has no idea what conversation you were in. So it greets you like a
stranger.

## What already exists

- The `INSTAR_AUTH_TOKEN` environment variable. Every time the agent
  spawns a new session, it sets this env var with the real password.
- The encrypted secret store at `.instar/secrets/config.secrets.enc`,
  managed by `SecretMigrator` / `SecretStore`.
- A migration system (`PostUpdateMigrator`) that rewrites helper scripts
  on every auto-update. Some helpers were already on this track; others
  weren't.

## What's new

- **Every helper now reads `INSTAR_AUTH_TOKEN` env first.** The env var
  is always present in a session, so it's the canonical path.
- **The disk-fallback now has a "is this actually a password?" check.**
  If the config file says `{ "secret": true }` (the placeholder), the
  guard rejects it and falls through to no-auth instead of sending the
  placeholder as a password.
- **A second, unrelated bug** also got fixed in the same change: the
  helpers parsed the server port from the config file with a regex that
  refused to allow whitespace, so `"port": 4042` (the format we
  actually ship) was unparseable. The helpers exited silently with no
  port, hitting nothing. Replaced with a whitespace-tolerant pattern.
- **A new automated check** scans every helper for this broken pattern
  and refuses to commit any future change that reintroduces it.
- **An update routine** that fixes the helpers on existing deployed
  agents (without overwriting any custom scripts the user wrote
  themselves).

## What you need to decide

Nothing. This is a bug fix, no configuration involved. Auto-update will
heal every deployed agent on next version bump.

## How to verify it worked after deploy

After your agent updates past the version that includes this fix, send
yourself a Telegram message in any forum topic. The agent's response
should reference what you actually said — not greet you like it's the
first message. If it doesn't, something else is wrong; please flag.

## Why this matters more than it might look

This is a "silent failure" class — the helpers were broken but emitted
no error, so the bug only surfaced through the symptom (incoherent
agent replies after compaction). That makes the failure invisible until
a user notices the symptom. The structural lint added in this change
makes the class itself impossible to reintroduce silently.
