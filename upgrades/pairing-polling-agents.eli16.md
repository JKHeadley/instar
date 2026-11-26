# ELI16: pairing works on an agent that reads Telegram itself

> The one-line version: some agents read Telegram directly instead of through a separate listener, and pairing used to switch its buttons off for them. Now it doesn't.

## The problem in one breath

On 2026-10-21 Justin paired PP twice, and both times PP said "use the dashboard". Luna looked at PP's machine and found why. PP has no separate Telegram listener: its own server reads Telegram directly. Pairing assumed every agent had the listener, and turned its buttons off for any agent without one.

## What changes

An agent that reads Telegram itself now takes a forwarded invite, and your Approve or Finish tap, straight from Telegram. Those messages come from Telegram itself, so they're as trustworthy as ones the listener passes on. The checks are the same as always: the tap has to be from you, in your chat, with that button's one-time code. Anyone else who taps is refused.
