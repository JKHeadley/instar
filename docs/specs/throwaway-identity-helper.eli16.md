# ELI16 — a tool that mints throwaway test identities

## What this is, in plain English

To live-test something like the new Slack permission gate, you need several
*genuinely different* people sending messages — not one account wearing different
hats (that's the fake-multi-user mistake we already learned from). Real different
people normally means real different email accounts, which sounds like a wall.

This adds a small tool that makes that wall disappear for the *email* part. It uses a
free public "disposable mailbox" service (mail.tm): it can create a brand-new, real,
readable email inbox on demand, and read what arrives in it. So the agent can spin up
5 genuinely-distinct throwaway inboxes — 5 distinct addresses — with no real accounts
and nothing for a human to set up.

## What it does

- `mint` → creates a fresh throwaway inbox and prints its address + an access token.
- `wait <token>` → watches that inbox until an email arrives (e.g. a Slack
  confirmation), then hands back either the whole message, just the 6-digit code, or a
  link inside it.

That's exactly what you need to sign a throwaway identity up to a service and click the
verification it emails back.

## Why it's safe and small

It's a standalone script + its test. It changes no running code, no gate, no config —
nothing is wired into the live agent. It only talks to a public disposable-mail API and
reads inboxes it just created. The unit tests run with the network faked out, so they're
fast and don't depend on the service being up; a separate live check confirmed it really
mints a real inbox.

## The one thing it does NOT solve

Creating the workspace/account itself still hits an anti-bot CAPTCHA — a deliberate
"are you human" check. That stays a human's 30-second job (passing a CAPTCHA). This tool
covers everything around it: the distinct identities and reading their mail.
