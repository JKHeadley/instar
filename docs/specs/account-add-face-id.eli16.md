# Adding a Claude or Codex account from your phone — the plain version

## What this is

Justin asked for an easy way to add Claude or Codex accounts. Today adding one needs details only a
developer has: an internal name, which program it is for, and the exact folder on the computer where
its login lives, and that folder must already be signed in. Nobody can do that from a phone. This
change adds a way to do it from the Instar app: pick Claude or Codex, optionally give it a name, type
the email of the account, confirm with Face ID, and the app opens the provider's sign-in page right
away.

## What already exists

The agent already knows how to sign an account in on a machine: it makes a fresh login folder for it,
starts the provider's sign-in, and the app shows the page and lets you paste the code. When the
sign-in finishes, the agent checks that the account that signed in is the one with the email it
expected. If it is, the account is added. If not, it is held and you are told, so the wrong account is
never added by accident. The app already knows how to show this page and send the code.

## What is new

A new route that, after Face ID, picks a safe internal name for the account (based on the nickname or
the email, plus a short random ending, never one that is already used), picks the right program and
login folder for Claude or Codex, and starts the sign-in on the machine that answered. The answer is
the same one the app already uses for "Sign in", so the app goes straight to the sign-in page.

## The safeguards, in plain terms

- Only the owner's phone can do this. Team members' phones and the agent itself are refused.
- Face ID names what you are adding: a proof for a Claude account cannot add a Codex account, and
  each proof works once.
- The app can send only the kind, a nickname and the email. Anything else, like a password, a key or
  a folder path, is refused. The agent never asks for or keeps a password or key.
- The account is not added until its sign-in finishes and the email matches. If you typed the wrong
  email, nothing is added.
- If the account is already added, the app is told which one, so you sign it in from its row instead
  of adding it twice. Tapping twice gives you the same sign-in, not two.

## What stays the same

The dashboard's own way of adding accounts is unchanged. The way sign-ins finish, and how a new account
is shared with your other machines, is the same as today.

## What you need to decide

One thing differs from the request as written: the email is required, not optional. Without it the
agent cannot check that the right account signed in, and would hold every sign-in. It is one field.

**Two small fixes (2026-11-10):** a mistyped email now gets one plain, fixed message, never the server's internal error text, and the places where the add step deliberately carries on after a small failure are marked with the reason, as the repo requires.
