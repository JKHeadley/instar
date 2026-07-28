# Per-account email on the Subscription Pool — Plain-English Overview

> The one-line version: each subscription account now carries its email, filled in automatically from the real login — so you can tell "SageMind - Justin" from "SageMind - Adriana" at a glance, and a wrong-account login can't hide.

## The problem in one breath

You'll have several accounts on the same org — "SageMind - Justin", "SageMind - Adriana", "SageMind - Dawn". A nickname alone isn't enough to be sure which real account is which; you asked that each be identified by nickname AND email.

## What this adds

- Each account in the pool now has an **email** alongside its nickname.
- I don't make you type it: when I read an account's quota, I also read the email straight from that account's own sign-in record and store it. So the email always reflects the account that actually logged in.
- The dashboard shows the email under the nickname.

## Why the auto-fill matters (the safety bit)

Because the email comes from the *real* login, not from what someone typed, it acts as a check: if a login ever signs into the wrong account, the email won't match what you expected — it shows the mistake instead of burying it. That's exactly the mislabeling risk you flagged.

## What does NOT change

- It's optional and additive — accounts without an email work exactly as before; nothing about how accounts are selected, swapped, or polled changes.
- The email is a public identifier, never a token or password.
- No new endpoints, no new powers.

## Proven

Unit tests cover storing/patching the email, reading it from a login record, and the poller auto-filling it from the real account; the dashboard render test confirms it shows. Type-check clean; existing pool/poller/route tests stay green.
