# ELI16 — Playwright Profile Registry + Account-Access Awareness

## What this is, in plain words

I (the agent) unblock myself by driving a real web browser that's logged into real
accounts — your `justin@sagemindai.io` Google (which gets me into GitHub and other
Google sign-in sites), my own `echo@sagemindai.io` Google, a GitHub session, and so on.
The passwords for those accounts are kept in my encrypted vault. The actual browser
"who am I logged in as" lives in a folder on one specific computer (a Playwright
"profile").

The problem: I had **no organized record of which browser profile is logged into which
account**, and **nothing told me at the start of a session what browser access I
actually have**. That knowledge only existed as ~21 scattered, sometimes-contradictory
sticky-notes. So twice I failed: I didn't realize I could log into GitHub using the
Gmail account you'd already given me, and I had no idea a "profile registry" was even
supposed to exist. You flagged both on 2026-06-15.

This change builds the missing structure: a tidy, durable list of browser profiles,
each with a description of the accounts it owns (referenced by the *name* of the vault
secret, never the secret itself), plus a short summary that gets injected into my
context at the start of every session so I *know* what I can do. It adds simple commands
to create a new profile, attach an account to it, ask "which profile do I use for
GitHub?", and switch the browser onto a chosen profile.

## What already exists (that this reuses)

- My vault already holds the credentials (`google_password_justin`, `github_token`,
  `github_token_jkheadley_backup`, my own Google + 2FA, etc.).
- There's already a "self-knowledge" boot block that injects my vault secret *names* at
  session start. This registry copies that exact, proven pattern for browser profiles.
- The "dev-agent dark gate" lets a new feature run live on my dev agent while staying
  off for everyone else until it's proven.

## What's new

- A file that lists my browser profiles and the accounts each one holds.
- A boot summary so I start every session knowing my browser access.
- Commands to: list profiles, create a custom profile, attach an account, resolve the
  right profile for an account, and activate a profile (which restarts the session so
  the browser comes up on that profile).

## The safeguards, in plain terms

- **No passwords are ever stored or shown here** — only the *name* of the vault entry
  (e.g. "google_password_justin"). The real secret stays in the encrypted vault.
- **Ships dark for the fleet**, live only on my dev agent, so it's dogfooded before
  anyone else gets it. Turning it off makes every command return "not enabled" and the
  boot summary disappears — nothing breaks.
- **Switching profiles is reversible** — it just rewrites which folder the browser uses
  and restarts the session (the same safe restart we already use). Switch back to
  "default" to undo.
- **It's machine-specific on purpose** — a browser profile is a real folder on one
  computer; you can't copy a logged-in session to another machine by copying notes, so
  the registry honestly describes only the machine it's on.

## What the review changed (and what's left to decide)

A six-reviewer pass found one thing I'd gotten wrong: the "switch profiles" command
assumed the browser config already had a "which folder" setting to edit — it doesn't.
So the design now *adds* that setting correctly, and figures out which config file the
browser actually reads (there are two). The reviewers also made me add three honesty
rules so this registry doesn't rot into the same mess of contradictory notes it's meant
to replace: a login is shown with its age ("logged in, last checked 2 days ago") and
treated as a hint I must re-check, not a fact; every account is labeled as *yours* or
*mine* so I never act as you by accident; and the "switch profiles" command starts in a
safe **dry-run** mode (it tells me what it *would* change and restarts nothing) until
it's explicitly turned on — the same safety every other sensitive command here uses.

What's left for you: really just whether the **scope** is right. The registry owns the
data, the awareness, picking the right profile, and switching to it; the actual act of
typing a password or handling a phone code stays my job (using the registry's info),
because that step is interactive and can't live in a fixed command. Everything that can
be a clean command is in this change, it ships off-by-default for everyone but my dev
agent, and switching is reversible. There are no open questions blocking the build.
